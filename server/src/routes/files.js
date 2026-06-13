import fs from "node:fs/promises";
import path from "node:path";
import multer from "multer";
import { Router } from "express";
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
