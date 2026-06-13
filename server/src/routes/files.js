
  import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import express, { Router } from "express";
import multer from "multer";
import { pipeline } from "node:stream/promises";
import { STORAGE_ROOT, TEMP_DIR } from "../config/env.js";
import { requireAdmin } from "../middleware/auth.js";
import {
  createFolder,
  ensureDirectory,
  fileExists,
  listAllItems,
  listDirectory,
  readEntryStats,
  removeEntry,
  renameEntry,
} from "../lib/files.js";
import { joinRelativePath, resolveStoragePath, ensureSafeName } from "../lib/path.js";
import { getHlsPlaylist, readHlsStatus, rewriteHlsPlaylist, shouldGenerateHls, startHlsTranscode, getHlsSegmentPath } from "../lib/hls.js";
import { parseJsonBody, parseRelativePath } from "../utils/validation.js";

const router = Router();
const upload = multer({ dest: TEMP_DIR, limits: { fileSize: 1024 * 1024 * 1024 * 10 } });
const chunkUpload = express.raw({ type: "application/octet-stream", limit: "128mb" });
const chunkSessionRoot = path.join(TEMP_DIR, "chunk-sessions");
const streamUploadRoot = path.join(TEMP_DIR, "stream-uploads");

async function ensureChunkSession(uploadId) {
  const sessionPath = path.join(chunkSessionRoot, uploadId);
  await fs.mkdir(sessionPath, { recursive: true });
  return sessionPath;
}

async function cleanupChunkSession(sessionPath) {
  await fs.rm(sessionPath, { recursive: true, force: true }).catch(() => {});
}

function getStreamUploadStatePath(uploadId) {
  return path.join(streamUploadRoot, `${uploadId}.json`);
}

async function readStreamUploadState(uploadId) {
  try {
    const raw = await fs.readFile(getStreamUploadStatePath(uploadId), "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function writeStreamUploadState(uploadId, state) {
  await fs.mkdir(streamUploadRoot, { recursive: true });
  await fs.writeFile(getStreamUploadStatePath(uploadId), JSON.stringify(state, null, 2), "utf8");
}

async function moveFileSafe(sourcePath, destinationPath) {
  try {
    await fs.rm(destinationPath, { force: true });
    await fs.rename(sourcePath, destinationPath);
  } catch (error) {
    if (error?.code !== "EXDEV") {
      throw error;
    }

    await fs.rm(destinationPath, { force: true });
    await fs.copyFile(sourcePath, destinationPath);
    await fs.rm(sourcePath, { force: true });
  }
}

async function readCursor(sessionPath) {
  try {
    const raw = await fs.readFile(path.join(sessionPath, ".cursor"), "utf8");
    const parsed = Number.parseInt(raw, 10);
    return Number.isInteger(parsed) && parsed >= 0 ? parsed : 0;
  } catch {
    return 0;
  }
}

async function writeCursor(sessionPath, cursor) {
  await fs.writeFile(path.join(sessionPath, ".cursor"), String(cursor), "utf8");
}

async function ensureLiveFile(sessionPath) {
  const livePath = path.join(sessionPath, ".live");
  await fs.mkdir(path.dirname(livePath), { recursive: true });
  return livePath;
}

async function writeSessionMeta(sessionPath, meta) {
  await fs.writeFile(path.join(sessionPath, ".meta.json"), JSON.stringify(meta), "utf8");
}

async function readSessionMeta(sessionPath) {
  try {
    const raw = await fs.readFile(path.join(sessionPath, ".meta.json"), "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// ✅ FIXED — streams chunks directly to disk, no RAM loading
async function flushContiguousChunks(sessionPath) {
  const livePath = await ensureLiveFile(sessionPath);
  let cursor = await readCursor(sessionPath);

  while (true) {
    const chunkName = `${String(cursor).padStart(8, "0")}.part`;
    const chunkPath = path.join(sessionPath, chunkName);

    try {
      await fs.access(chunkPath);
    } catch (error) {
      if (error?.code === "ENOENT") break;
      throw error;
    }

    try {
      const readStream = fsSync.createReadStream(chunkPath);
      const writeStream = fsSync.createWriteStream(livePath, { flags: "a" });
      await pipeline(readStream, writeStream);
      await fs.rm(chunkPath, { force: true });
      cursor += 1;
    } catch (error) {
      throw error;
    }
  }

  await writeCursor(sessionPath, cursor);
  return cursor;
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
    const cursor = await flushContiguousChunks(sessionPath);
    if (cursor !== totalChunks) {
      return false;
    }

    const livePath = await ensureLiveFile(sessionPath);
    await moveFileSafe(livePath, destinationAbsolute);
    await cleanupChunkSession(sessionPath);
    return true;
  } finally {
    await fs.rm(lockPath, { recursive: true, force: true }).catch(() => {});
  }
}

async function getChunkSessionState(sessionPath) {
  try {
    const entries = await fs.readdir(sessionPath, { withFileTypes: true });
    const chunkFiles = entries.filter((entry) => entry.isFile() && entry.name.endsWith(".part"));
    const meta = await readSessionMeta(sessionPath);
    return {
      exists: true,
      chunkCount: chunkFiles.length,
      chunkIndexes: chunkFiles.map((entry) => Number.parseInt(entry.name, 10)).filter((value) => Number.isInteger(value)),
      meta,
    };
  } catch (error) {
    if (error?.code === "ENOENT") {
      return {
        exists: false,
        chunkCount: 0,
        chunkIndexes: [],
        meta: null,
      };
    }

    throw error;
  }
}

async function ensureRootReady() {
  await ensureDirectory(STORAGE_ROOT);
  await ensureDirectory(TEMP_DIR);
  await ensureDirectory(streamUploadRoot);
}

async function buildUploadedItem(absolutePath, relativePath) {
  const stats = await fs.stat(absolutePath);
  return {
    name: path.basename(absolutePath),
    path: relativePath,
    size: stats.size,
    modifiedAt: stats.mtime.toISOString(),
    createdAt: stats.birthtime.toISOString(),
    type: "file",
    extension: path.extname(absolutePath).slice(1).toLowerCase(),
  };
}

router.use(requireAdmin);

router.get("/files", async (req, res) => {
  await ensureRootReady();
  const currentPath = parseRelativePath(req.query.path || "");
  const payload = await listDirectory(STORAGE_ROOT, currentPath);
  return res.json(payload);
});

router.get("/gallery", async (req, res) => {
  await ensureRootReady();
  const payload = await listAllItems(STORAGE_ROOT);
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
  const totalSize = Number(req.query.totalSize);
  const isFinalChunk = req.query.final === "true";
  const fastUpload = req.query.fast === "true";

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

  if (chunkIndex === 0) {
    await writeSessionMeta(sessionPath, {
      destinationRelative,
      fileName,
      totalChunks,
      totalSize: Number.isFinite(totalSize) ? totalSize : 0,
    });
  }

  if (await fileExists(STORAGE_ROOT, destinationRelative)) {
    if (chunkIndex > 0 && Number.isFinite(totalSize) && totalSize > 0) {
      const stats = await fs.stat(destinationAbsolute).catch(() => null);
      if (stats?.isFile() && stats.size === totalSize) {
        const uploadedItem = await buildUploadedItem(destinationAbsolute, destinationRelative);
        return res.status(200).json({
          message: "Upload complete",
          uploaded: [uploadedItem],
        });
      }
    }

    await cleanupChunkSession(sessionPath);
    return res.status(409).json({ message: `File already exists: ${fileName}` });
  }

  const cursor = await readCursor(sessionPath);
  if (chunkIndex < cursor) {
    return res.status(202).json({
      message: "Chunk already received",
      uploadId,
      chunkIndex,
    });
  }

  if (chunkIndex > cursor) {
    return res.status(409).json({
      message: `Expected chunk ${cursor}, received ${chunkIndex}`,
      uploadId,
      expectedChunkIndex: cursor,
    });
  }

  const livePath = await ensureLiveFile(sessionPath);
  await fs.appendFile(livePath, req.body);
  const nextCursor = cursor + 1;
  await writeCursor(sessionPath, nextCursor);

  if (isFinalChunk && nextCursor === totalChunks) {
    await moveFileSafe(livePath, destinationAbsolute);
    await cleanupChunkSession(sessionPath);

    if (!fastUpload && shouldGenerateHls(fileName)) {
      startHlsTranscode({
        relativePath: destinationRelative,
        sourcePath: destinationAbsolute,
        fileName,
      }).catch(() => {});
    }

    const uploadedItem = await buildUploadedItem(destinationAbsolute, destinationRelative);

    return res.status(201).json({
      message: "Upload complete",
      uploaded: [uploadedItem],
    });
  }

  return res.status(202).json({
    message: "Chunk received",
    uploadId,
    chunkIndex,
  });
});

router.post("/upload/stream", async (req, res) => {
  await ensureRootReady();

  const targetPath = parseRelativePath(req.query.path || "");
  const fileName = ensureSafeName(req.query.name || "");
  const uploadId = ensureSafeName(req.query.uploadId || randomUUID());
  const fastUpload = req.query.fast === "true";
  const destinationRelative = joinRelativePath(targetPath, fileName);
  const destinationAbsolute = resolveStoragePath(STORAGE_ROOT, destinationRelative).absolutePath;
  const tempPath = path.join(path.dirname(destinationAbsolute), `.${path.basename(destinationAbsolute)}.${uploadId}.partial`);
  const statePath = getStreamUploadStatePath(uploadId);
  const existingState = await readStreamUploadState(uploadId);

  if (existingState?.destinationRelative === destinationRelative) {
    const finalExists = await fileExists(STORAGE_ROOT, destinationRelative);
    if (finalExists) {
      const uploadedItem = await buildUploadedItem(destinationAbsolute, destinationRelative);
      return res.status(200).json({
        message: "Upload complete",
        uploaded: [uploadedItem],
      });
    }
  }

  await fs.mkdir(path.dirname(destinationAbsolute), { recursive: true });

  const writeStream = fsSync.createWriteStream(tempPath, { flags: "wx" });

  try {
    await pipeline(req, writeStream);
    await moveFileSafe(tempPath, destinationAbsolute);

    if (!fastUpload && shouldGenerateHls(fileName)) {
      startHlsTranscode({
        relativePath: destinationRelative,
        sourcePath: destinationAbsolute,
        fileName,
      }).catch(() => {});
    }

    await fs.writeFile(
      statePath,
      JSON.stringify(
        {
          destinationRelative,
          completedAt: new Date().toISOString(),
        },
        null,
        2
      ),
      "utf8"
    );

    const uploadedItem = await buildUploadedItem(destinationAbsolute, destinationRelative);
    return res.status(201).json({
      message: "Upload complete",
      uploaded: [uploadedItem],
    });
  } catch (error) {
    await fs.rm(tempPath, { force: true }).catch(() => {});
    if (error?.code === "ECONNABORTED" || error?.code === "ERR_STREAM_PREMATURE_CLOSE") {
      return res.status(499).json({ message: "Request aborted" });
    }

    throw error;
  } finally {
    writeStream.destroy();
  }
});

router.get("/upload/chunk/status", async (req, res) => {
  await ensureRootReady();

  const uploadId = ensureSafeName(req.query.uploadId || "");
  const sessionPath = path.join(chunkSessionRoot, uploadId);
  const state = await getChunkSessionState(sessionPath);

  return res.json(state);
});

router.get("/video/transcode/status", async (req, res) => {
  await ensureRootReady();
  const relativePath = parseRelativePath(req.query.path || "");
  let status = await readHlsStatus(relativePath);

  if (status.status === "idle") {
    const fileName = path.basename(relativePath);
    const { absolutePath: sourcePath } = resolveStoragePath(STORAGE_ROOT, relativePath);

    startHlsTranscode({
      relativePath,
      sourcePath,
      fileName,
    }).catch(() => {});

    status = await readHlsStatus(relativePath);
  }

  return res.json(status);
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

router.get("/preview/live", async (req, res) => {
  await ensureRootReady();
  const relativePath = parseRelativePath(req.query.path || "");
  const { absolutePath: finalPath } = resolveStoragePath(STORAGE_ROOT, relativePath);

  const finalStats = await fs.stat(finalPath).catch(() => null);
  if (finalStats?.isFile()) {
    return res.sendFile(finalPath, {
      headers: {
        "Content-Disposition": `inline; filename="${path.basename(finalPath)}"`,
      },
    });
  }

  const sessions = await fs.readdir(chunkSessionRoot, { withFileTypes: true }).catch(() => []);
  for (const entry of sessions) {
    if (!entry.isDirectory()) {
      continue;
    }

    const sessionPath = path.join(chunkSessionRoot, entry.name);
    const meta = await readSessionMeta(sessionPath);
    if (!meta || meta.destinationRelative !== relativePath) {
      continue;
    }

    const livePath = path.join(sessionPath, ".live");
    const liveStats = await fs.stat(livePath).catch(() => null);
    if (!liveStats?.isFile()) {
      continue;
    }

    return res.sendFile(livePath, {
      headers: {
        "Content-Disposition": `inline; filename="${path.basename(finalPath)}"`,
      },
    });
  }

  return res.status(404).json({ message: "Live preview unavailable" });
});

router.get("/preview/hls", async (req, res) => {
  await ensureRootReady();
  const relativePath = parseRelativePath(req.query.path || "");
  const status = await readHlsStatus(relativePath);

  if (!status.hlsReady) {
    return res.status(404).json({ message: "HLS playlist not ready" });
  }

  const playlistText = await getHlsPlaylist(relativePath);
  if (!playlistText) {
    return res.status(404).json({ message: "HLS playlist not ready" });
  }

  return res
    .type("application/vnd.apple.mpegurl")
    .send(rewriteHlsPlaylist(relativePath, playlistText));
});

router.get("/preview/hls/segment", async (req, res) => {
  await ensureRootReady();
  const relativePath = parseRelativePath(req.query.path || "");
  const fileName = ensureSafeName(req.query.file || "");
  const segmentPath = await getHlsSegmentPath(relativePath, fileName);

  return res.sendFile(segmentPath);
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
