import fs from "node:fs/promises";
import path from "node:path";
import express, { Router } from "express";
import multer from "multer";
import { STORAGE_ROOT, TEMP_DIR } from "../config/env.js";
import { requireAdmin } from "../middleware/auth.js";
import {
  createFolder,
  ensureDirectory,
  fileExists,
  listDirectory,
  readEntryStats,
  removeEntry,
  renameEntry,
} from "../lib/files.js";
import { joinRelativePath, resolveStoragePath, ensureSafeName } from "../lib/path.js";
import { parseJsonBody, parseRelativePath } from "../utils/validation.js";

const router = Router();
const upload = multer({ dest: TEMP_DIR, limits: { fileSize: 1024 * 1024 * 1024 * 2 } });
const chunkUpload = express.raw({ type: "application/octet-stream", limit: "128mb" });
const chunkSessionRoot = path.join(TEMP_DIR, "chunk-sessions");

async function ensureChunkSession(uploadId) {
  const sessionPath = path.join(chunkSessionRoot, uploadId);
  await fs.mkdir(sessionPath, { recursive: true });
  return sessionPath;
}

async function cleanupChunkSession(sessionPath) {
  await fs.rm(sessionPath, { recursive: true, force: true }).catch(() => {});
}

async function tryFinalizeChunkSession(sessionPath, destinationAbsolute, totalChunks) {
  const lockPath = path.join(sessionPath, ".finalizing");

  try {
    await fs.mkdir(lockPath);
  } catch (error) {
    if (error?.code === "EEXIST") {
      return false;
    }

    throw error;
  }

  try {
    const entries = await fs.readdir(sessionPath, { withFileTypes: true });
    const chunkFiles = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".part"))
      .sort((left, right) => left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: "base" }));

    if (chunkFiles.length !== totalChunks) {
      return false;
    }

    const assemblyPath = `${destinationAbsolute}.uploading`;
    const handle = await fs.open(assemblyPath, "w");

    try {
      for (const chunkFile of chunkFiles) {
        const chunkPath = path.join(sessionPath, chunkFile.name);
        const chunkBuffer = await fs.readFile(chunkPath);
        await handle.write(chunkBuffer);
      }
    } finally {
      await handle.close();
    }

    await fs.rename(assemblyPath, destinationAbsolute);
    await cleanupChunkSession(sessionPath);
    return true;
  } finally {
    await fs.rm(lockPath, { recursive: true, force: true }).catch(() => {});
  }
}

async function ensureRootReady() {
  await ensureDirectory(STORAGE_ROOT);
  await ensureDirectory(TEMP_DIR);
}

router.use(requireAdmin);

router.get("/files", async (req, res) => {
  await ensureRootReady();
  const currentPath = parseRelativePath(req.query.path || "");
  const payload = await listDirectory(STORAGE_ROOT, currentPath);
  return res.json(payload);
});

router.post("/folders", async (req, res) => {
  await ensureRootReady();
  const body = parseJsonBody(req);
  const parentPath = parseRelativePath(body.path || "");
  const folderName = body.name;

  const created = await createFolder(STORAGE_ROOT, parentPath, folderName);
  return res.status(201).json({
    message: "Folder created",
    folder: created,
  });
});

router.patch("/files", async (req, res) => {
  await ensureRootReady();
  const body = parseJsonBody(req);
  const targetPath = parseRelativePath(body.path || "");
  const newName = body.newName;

  const renamed = await renameEntry(STORAGE_ROOT, targetPath, newName);
  return res.json({
    message: "Item renamed",
    item: renamed,
  });
});

router.post("/upload", upload.array("files"), async (req, res) => {
  await ensureRootReady();
  const targetPath = parseRelativePath(req.body?.path || "");
  const { absolutePath: targetDirectory } = resolveStoragePath(STORAGE_ROOT, targetPath);
  await fs.mkdir(targetDirectory, { recursive: true });

  const uploaded = [];

  try {
    for (const file of req.files || []) {
      const originalName = ensureSafeName(file.originalname);
      const destinationRelative = joinRelativePath(targetPath, originalName);

      if (await fileExists(STORAGE_ROOT, destinationRelative)) {
        throw Object.assign(new Error(`File already exists: ${originalName}`), { statusCode: 409 });
      }

      const destinationAbsolute = resolveStoragePath(STORAGE_ROOT, destinationRelative).absolutePath;
      await fs.mkdir(path.dirname(destinationAbsolute), { recursive: true });
      await fs.copyFile(file.path, destinationAbsolute);
      await fs.rm(file.path, { force: true });
      uploaded.push({
        name: originalName,
        path: destinationRelative,
      });
    }
  } catch (error) {
    for (const file of req.files || []) {
      await fs.rm(file.path, { force: true }).catch(() => {});
    }
    throw error;
  }

  return res.status(201).json({
    message: "Upload complete",
    uploaded,
  });
});

router.post("/upload/chunk", chunkUpload, async (req, res) => {
  await ensureRootReady();

  const targetPath = parseRelativePath(req.query.path || "");
  const fileName = ensureSafeName(req.query.name || "");
  const uploadId = ensureSafeName(req.query.uploadId || "");
  const chunkIndex = Number(req.query.chunkIndex);
  const totalChunks = Number(req.query.totalChunks);
  const isFinalChunk = req.query.final === "true";

  if (!Number.isInteger(chunkIndex) || chunkIndex < 0) {
    return res.status(400).json({ message: "Invalid chunk index" });
  }

  if (!Number.isInteger(totalChunks) || totalChunks <= 0) {
    return res.status(400).json({ message: "Invalid chunk count" });
  }

  if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
    return res.status(400).json({ message: "Chunk body is required" });
  }

  const destinationRelative = joinRelativePath(targetPath, fileName);
  const destinationAbsolute = resolveStoragePath(STORAGE_ROOT, destinationRelative).absolutePath;
  const sessionPath = await ensureChunkSession(uploadId);
  const chunkFileName = `${String(chunkIndex).padStart(8, "0")}.part`;
  const chunkAbsolute = path.join(sessionPath, chunkFileName);

  if (await fileExists(STORAGE_ROOT, destinationRelative)) {
    await cleanupChunkSession(sessionPath);
    return res.status(409).json({ message: `File already exists: ${fileName}` });
  }

  await fs.writeFile(chunkAbsolute, req.body);

  const finalized = await tryFinalizeChunkSession(sessionPath, destinationAbsolute, totalChunks);
  if (finalized) {
    return res.status(201).json({
      message: "Upload complete",
      uploaded: [
        {
          name: fileName,
          path: destinationRelative,
        },
      ],
    });
  }

  return res.status(202).json({
    message: "Chunk received",
    uploadId,
    chunkIndex,
  });
});

router.get("/download", async (req, res) => {
  await ensureRootReady();
  const relativePath = parseRelativePath(req.query.path || "");
  const { absolutePath } = resolveStoragePath(STORAGE_ROOT, relativePath);
  const stats = await fs.stat(absolutePath);

  if (!stats.isFile()) {
    return res.status(400).json({ message: "Only files can be downloaded" });
  }

  return res.download(absolutePath, path.basename(absolutePath));
});

router.get("/preview", async (req, res) => {
  await ensureRootReady();
  const relativePath = parseRelativePath(req.query.path || "");
  const { absolutePath } = resolveStoragePath(STORAGE_ROOT, relativePath);
  const stats = await fs.stat(absolutePath);

  if (!stats.isFile()) {
    return res.status(400).json({ message: "Only files can be previewed" });
  }

  return res.sendFile(absolutePath, {
    headers: {
      "Content-Disposition": `inline; filename="${path.basename(absolutePath)}"`,
    },
  });
});

router.delete("/delete", async (req, res) => {
  await ensureRootReady();
  const body = parseJsonBody(req);
  const targetPath = parseRelativePath(body.path || req.query.path || "");
  await removeEntry(STORAGE_ROOT, targetPath);
  return res.json({ message: "Item deleted" });
});

router.get("/items", async (req, res) => {
  await ensureRootReady();
  const currentPath = parseRelativePath(req.query.path || "");
  const { absolutePath } = resolveStoragePath(STORAGE_ROOT, currentPath);
  const stats = await readEntryStats(absolutePath);

  return res.json({
    path: currentPath,
    type: stats.isDirectory ? "folder" : "file",
    size: stats.size,
    createdAt: stats.createdAt.toISOString(),
    updatedAt: stats.updatedAt.toISOString(),
  });
});

export default router;
