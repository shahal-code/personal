
  import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import express, { Router } from "express";
import multer from "multer";
import { pipeline } from "node:stream/promises";
import { TEMP_DIR } from "../config/env.js";
import { requireAdmin } from "../middleware/auth.js";
import { noStore } from "../middleware/security.js";
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
import { getActiveStorageRoot, getStorageRootById, getStorageRootState } from "../lib/storage-roots.js";
import { createTransferJob, getTransferJobs } from "../lib/transfer-jobs.js";

const router = Router();
const upload = multer({ dest: TEMP_DIR, limits: { fileSize: 1024 * 1024 * 1024 * 10 } });
const chunkUpload = express.raw({ type: "application/octet-stream", limit: "128mb" });
const chunkSessionRoot = path.join(TEMP_DIR, "chunk-sessions");
const streamUploadRoot = path.join(TEMP_DIR, "stream-uploads");
const resumableUploadRoot = path.join(TEMP_DIR, "resumable-uploads");
const UPLOAD_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;

function ensureSafeUploadId(uploadId) {
  const safeUploadId = ensureSafeName(uploadId);
  if (!UPLOAD_ID_PATTERN.test(safeUploadId)) {
    throw Object.assign(new Error("Invalid upload session id"), { statusCode: 400 });
  }
  return safeUploadId;
}

function inlineDisposition(filePath) {
  return `inline; filename="${path.basename(filePath).replaceAll('"', "")}"`;
}

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

function getResumableSessionPath(uploadId) {
  return path.join(resumableUploadRoot, uploadId);
}

function getResumableMetaPath(uploadId) {
  return path.join(getResumableSessionPath(uploadId), "meta.json");
}

function getResumableDataPath(uploadId) {
  return path.join(getResumableSessionPath(uploadId), "upload.partial");
}

async function readResumableMeta(uploadId) {
  try {
    const raw = await fs.readFile(getResumableMetaPath(uploadId), "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function writeResumableMeta(uploadId, meta) {
  await fs.mkdir(getResumableSessionPath(uploadId), { recursive: true });
  await fs.writeFile(getResumableMetaPath(uploadId), JSON.stringify(meta, null, 2), "utf8");
}

async function getResumableOffset(uploadId) {
  const stats = await fs.stat(getResumableDataPath(uploadId)).catch(() => null);
  return stats?.isFile() ? stats.size : 0;
}

function buildUploadSessionPayload(uploadId, meta, offset, completed = false) {
  return {
    uploadId,
    fileName: meta.fileName,
    destinationRelative: meta.destinationRelative,
    totalSize: meta.totalSize,
    offset,
    completed,
  };
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
  await ensureDirectory(getActiveStorageRoot());
  await ensureDirectory(TEMP_DIR);
  await ensureDirectory(streamUploadRoot);
  await ensureDirectory(resumableUploadRoot);
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

router.use(
  [
    "/files",
    "/gallery",
    "/folders",
    "/upload",
    "/video",
    "/download",
    "/preview",
    "/delete",
    "/items",
    "/transfer",
    "/storage-folders",
    "/global-search",
  ],
  requireAdmin,
  noStore
);

router.get("/files", async (req, res) => {
  await ensureRootReady();
  const STORAGE_ROOT = getActiveStorageRoot();
  const currentPath = parseRelativePath(req.query.path || "");
  const payload = await listDirectory(STORAGE_ROOT, currentPath);
  return res.json(payload);
});

router.get("/gallery", async (req, res) => {
  await ensureRootReady();
  const STORAGE_ROOT = getActiveStorageRoot();
  const payload = await listAllItems(STORAGE_ROOT);
  return res.json(payload);
});

router.post("/folders", async (req, res) => {
  await ensureRootReady();
  const STORAGE_ROOT = getActiveStorageRoot();
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
  const STORAGE_ROOT = getActiveStorageRoot();
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
  const STORAGE_ROOT = getActiveStorageRoot();
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

router.post("/upload/session", async (req, res) => {
  await ensureRootReady();
  const STORAGE_ROOT = getActiveStorageRoot();
  const body = parseJsonBody(req);
  const targetPath = parseRelativePath(body.path || "");
  const fileName = ensureSafeName(body.name || "");
  const totalSize = Number(body.size);
  const uploadId = ensureSafeUploadId(body.uploadId || randomUUID());
  const fastUpload = body.fast === true;

  if (!fileName) {
    return res.status(400).json({ message: "File name is required" });
  }

  if (!Number.isFinite(totalSize) || totalSize <= 0) {
    return res.status(400).json({ message: "File size is required" });
  }

  const destinationRelative = joinRelativePath(targetPath, fileName);
  const destinationAbsolute = resolveStoragePath(STORAGE_ROOT, destinationRelative).absolutePath;
  const finalStats = await fs.stat(destinationAbsolute).catch(() => null);

  if (finalStats?.isFile()) {
    if (finalStats.size === totalSize) {
      const uploadedItem = await buildUploadedItem(destinationAbsolute, destinationRelative);
      return res.status(200).json({
        ...buildUploadSessionPayload(uploadId, { fileName, destinationRelative, totalSize }, totalSize, true),
        uploaded: [uploadedItem],
      });
    }

    return res.status(409).json({ message: `File already exists: ${fileName}` });
  }

  const existingMeta = await readResumableMeta(uploadId);
  const meta =
    existingMeta?.destinationRelative === destinationRelative && Number(existingMeta.totalSize) === totalSize
      ? existingMeta
      : {
          fileName,
          destinationRelative,
          totalSize,
          fastUpload,
          createdAt: new Date().toISOString(),
        };

  await writeResumableMeta(uploadId, {
    ...meta,
    updatedAt: new Date().toISOString(),
  });

  const offset = await getResumableOffset(uploadId);
  return res.status(201).json(buildUploadSessionPayload(uploadId, meta, offset));
});

router.get("/upload/session/:uploadId", async (req, res) => {
  await ensureRootReady();
  const STORAGE_ROOT = getActiveStorageRoot();
  const uploadId = ensureSafeUploadId(req.params.uploadId || "");
  const meta = await readResumableMeta(uploadId);

  if (!meta) {
    return res.status(404).json({ message: "Upload session not found" });
  }

  const destinationAbsolute = resolveStoragePath(STORAGE_ROOT, meta.destinationRelative).absolutePath;
  const finalStats = await fs.stat(destinationAbsolute).catch(() => null);
  if (finalStats?.isFile() && finalStats.size === Number(meta.totalSize)) {
    const uploadedItem = await buildUploadedItem(destinationAbsolute, meta.destinationRelative);
    return res.json({
      ...buildUploadSessionPayload(uploadId, meta, Number(meta.totalSize), true),
      uploaded: [uploadedItem],
    });
  }

  const offset = await getResumableOffset(uploadId);
  return res.json(buildUploadSessionPayload(uploadId, meta, offset));
});

router.patch("/upload/session/:uploadId", async (req, res) => {
  await ensureRootReady();
  const uploadId = ensureSafeUploadId(req.params.uploadId || "");
  const meta = await readResumableMeta(uploadId);

  if (!meta) {
    return res.status(404).json({ message: "Upload session not found" });
  }

  const requestedOffset = Number(req.header("Upload-Offset"));
  const currentOffset = await getResumableOffset(uploadId);

  if (!Number.isInteger(requestedOffset) || requestedOffset !== currentOffset) {
    res.set("Upload-Offset", String(currentOffset));
    return res.status(409).json({ message: "Upload offset mismatch", offset: currentOffset });
  }

  const contentLength = Number(req.header("Content-Length"));
  if (!Number.isFinite(contentLength) || contentLength <= 0) {
    res.set("Upload-Offset", String(currentOffset));
    return res.status(411).json({ message: "Content-Length is required", offset: currentOffset });
  }

  const nextOffset = currentOffset + contentLength;
  if (nextOffset > Number(meta.totalSize)) {
    res.set("Upload-Offset", String(currentOffset));
    return res.status(413).json({ message: "Upload exceeds expected file size", offset: currentOffset });
  }

  await fs.mkdir(getResumableSessionPath(uploadId), { recursive: true });
  const writeStream = fsSync.createWriteStream(getResumableDataPath(uploadId), { flags: "a" });

  try {
    await pipeline(req, writeStream);
  } catch (error) {
    writeStream.destroy();
    throw error;
  }

  const savedOffset = await getResumableOffset(uploadId);
  if (savedOffset !== nextOffset) {
    res.set("Upload-Offset", String(savedOffset));
    return res.status(500).json({ message: "Upload slice was not fully saved", offset: savedOffset });
  }

  await writeResumableMeta(uploadId, {
    ...meta,
    updatedAt: new Date().toISOString(),
  });

  res.set("Upload-Offset", String(savedOffset));
  return res.status(204).send();
});

router.post("/upload/session/:uploadId/complete", async (req, res) => {
  await ensureRootReady();
  const STORAGE_ROOT = getActiveStorageRoot();
  const uploadId = ensureSafeUploadId(req.params.uploadId || "");
  const meta = await readResumableMeta(uploadId);

  if (!meta) {
    return res.status(404).json({ message: "Upload session not found" });
  }

  const offset = await getResumableOffset(uploadId);
  if (offset !== Number(meta.totalSize)) {
    return res.status(409).json({ message: "Upload incomplete", offset, totalSize: meta.totalSize });
  }

  const destinationAbsolute = resolveStoragePath(STORAGE_ROOT, meta.destinationRelative).absolutePath;
  const finalStats = await fs.stat(destinationAbsolute).catch(() => null);
  if (finalStats?.isFile() && finalStats.size !== Number(meta.totalSize)) {
    return res.status(409).json({ message: `File already exists: ${meta.fileName}` });
  }

  await fs.mkdir(path.dirname(destinationAbsolute), { recursive: true });
  await moveFileSafe(getResumableDataPath(uploadId), destinationAbsolute);
  await fs.rm(getResumableSessionPath(uploadId), { recursive: true, force: true }).catch(() => {});

  if (!meta.fastUpload && shouldGenerateHls(meta.fileName)) {
    startHlsTranscode({
      relativePath: meta.destinationRelative,
      sourcePath: destinationAbsolute,
      fileName: meta.fileName,
    }).catch(() => {});
  }

  const uploadedItem = await buildUploadedItem(destinationAbsolute, meta.destinationRelative);
  return res.status(201).json({
    message: "Upload complete",
    uploaded: [uploadedItem],
  });
});

router.post("/upload/chunk", chunkUpload, async (req, res) => {
  await ensureRootReady();
  const STORAGE_ROOT = getActiveStorageRoot();

  const targetPath = parseRelativePath(req.query.path || "");
  const fileName = ensureSafeName(req.query.name || "");
  const uploadId = ensureSafeUploadId(req.query.uploadId || "");
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
  const STORAGE_ROOT = getActiveStorageRoot();

  const targetPath = parseRelativePath(req.query.path || "");
  const fileName = ensureSafeName(req.query.name || "");
  const uploadId = ensureSafeUploadId(req.query.uploadId || randomUUID());
  const totalSize = Number(req.query.totalSize);
  const fastUpload = req.query.fast === "true";
  const destinationRelative = joinRelativePath(targetPath, fileName);
  const destinationAbsolute = resolveStoragePath(STORAGE_ROOT, destinationRelative).absolutePath;
  const tempPath = path.join(path.dirname(destinationAbsolute), `.${path.basename(destinationAbsolute)}.${uploadId}.partial`);
  const statePath = getStreamUploadStatePath(uploadId);
  const existingState = await readStreamUploadState(uploadId);

  console.info("Stream upload started", {
    fileName,
    destinationRelative,
    uploadId,
    expectedBytes: Number.isFinite(totalSize) ? totalSize : 0,
  });

  const finalStats = await fs.stat(destinationAbsolute).catch(() => null);
  if (finalStats?.isFile()) {
    if (existingState?.destinationRelative === destinationRelative || (Number.isFinite(totalSize) && finalStats.size === totalSize)) {
      const uploadedItem = await buildUploadedItem(destinationAbsolute, destinationRelative);
      return res.status(200).json({
        message: "Upload complete",
        uploaded: [uploadedItem],
      });
    }

    return res.status(409).json({ message: `File already exists: ${fileName}` });
  }

  await fs.mkdir(path.dirname(destinationAbsolute), { recursive: true });

  const writeStream = fsSync.createWriteStream(tempPath, { flags: "w" });

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
    console.info("Stream upload complete", {
      fileName,
      destinationRelative,
      uploadId,
      size: uploadedItem.size,
    });

    return res.status(201).json({
      message: "Upload complete",
      uploaded: [uploadedItem],
    });
  } catch (error) {
    const partialStats = await fs.stat(tempPath).catch(() => null);
    console.error("Stream upload failed", {
      fileName,
      destinationRelative,
      uploadId,
      code: error?.code,
      message: error?.message,
      partialBytes: partialStats?.size || 0,
      expectedBytes: Number.isFinite(totalSize) ? totalSize : 0,
    });

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

  const uploadId = ensureSafeUploadId(req.query.uploadId || "");
  const sessionPath = path.join(chunkSessionRoot, uploadId);
  const state = await getChunkSessionState(sessionPath);

  return res.json(state);
});

router.get("/video/transcode/status", async (req, res) => {
  await ensureRootReady();
  const STORAGE_ROOT = getActiveStorageRoot();
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
  const STORAGE_ROOT = getActiveStorageRoot();
  const relativePath = parseRelativePath(req.query.path || "");
  const { absolutePath } = resolveStoragePath(STORAGE_ROOT, relativePath);
  const stats = await fs.stat(absolutePath);

  if (!stats.isFile()) {
    return res.status(400).json({ message: "Only files can be downloaded" });
  }

  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Cache-Control", "private, no-store");
  return res.download(absolutePath, path.basename(absolutePath));
});

router.get("/preview", async (req, res) => {
  await ensureRootReady();
  const STORAGE_ROOT = getActiveStorageRoot();
  const relativePath = parseRelativePath(req.query.path || "");
  const { absolutePath } = resolveStoragePath(STORAGE_ROOT, relativePath);
  const stats = await fs.stat(absolutePath);

  if (!stats.isFile()) {
    return res.status(400).json({ message: "Only files can be previewed" });
  }

  return res.sendFile(absolutePath, {
    headers: {
      "Cache-Control": "private, no-store",
      "Content-Disposition": inlineDisposition(absolutePath),
      "X-Content-Type-Options": "nosniff",
    },
  });
});

router.get("/preview/live", async (req, res) => {
  await ensureRootReady();
  const STORAGE_ROOT = getActiveStorageRoot();
  const relativePath = parseRelativePath(req.query.path || "");
  const { absolutePath: finalPath } = resolveStoragePath(STORAGE_ROOT, relativePath);

  const finalStats = await fs.stat(finalPath).catch(() => null);
  if (finalStats?.isFile()) {
    return res.sendFile(finalPath, {
      headers: {
        "Cache-Control": "private, no-store",
        "Content-Disposition": inlineDisposition(finalPath),
        "X-Content-Type-Options": "nosniff",
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
        "Cache-Control": "private, no-store",
        "Content-Disposition": inlineDisposition(finalPath),
        "X-Content-Type-Options": "nosniff",
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

  return res.sendFile(segmentPath, {
    headers: {
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
});

router.delete("/delete", async (req, res) => {
  await ensureRootReady();
  const STORAGE_ROOT = getActiveStorageRoot();
  const body = parseJsonBody(req);
  const targetPath = parseRelativePath(body.path || req.query.path || "");
  if (!targetPath || targetPath === "/") {
    return res.status(400).json({ message: "Deleting the storage root is not allowed" });
  }
  await removeEntry(STORAGE_ROOT, targetPath);
  return res.json({ message: "Item deleted" });
});

router.post("/transfer", async (req, res) => {
  const body = parseJsonBody(req);
  const sourceRelative = parseRelativePath(body.path || "");
  const destinationFolder = parseRelativePath(body.destinationPath || "");

  if (!sourceRelative) {
    return res.status(400).json({ message: "Source path is required" });
  }

  await getStorageRootById(body.sourceRootId);
  await getStorageRootById(body.destinationRootId);
  const job = await createTransferJob({ ...body, path: sourceRelative, destinationPath: destinationFolder });
  return res.status(202).json({ message: "Transfer queued", job });
});

router.get("/transfer/jobs", async (req, res) => {
  return res.json({ jobs: await getTransferJobs(req.query.limit) });
});

router.get("/storage-folders", async (req, res) => {
  const rootId = String(req.query.rootId || "");
  const storageRoot = await getStorageRootById(rootId);
  const currentPath = parseRelativePath(req.query.path || "");
  const { absolutePath, relativePath } = resolveStoragePath(storageRoot, currentPath);
  const entries = await fs.readdir(absolutePath, { withFileTypes: true });
  const folders = entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => ({ name: entry.name, path: relativePath ? `${relativePath}/${entry.name}` : entry.name }))
    .sort((left, right) => left.name.localeCompare(right.name, undefined, { numeric: true }));
  return res.json({ rootId, currentPath: relativePath, folders });
});

router.get("/global-search", async (req, res) => {
  const query = String(req.query.q || "").trim().toLowerCase();
  if (query.length < 2) return res.json({ items: [] });
  const results = [];
  const rootState = await getStorageRootState();

  for (const option of rootState.options.filter((root) => root.available)) {
    const storageRoot = await getStorageRootById(option.id);
    async function walk(relativePath = "") {
      if (results.length >= 200) return;
      const absolute = resolveStoragePath(storageRoot, relativePath).absolutePath;
      const entries = await fs.readdir(absolute, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (results.length >= 200) break;
        if (entry.name.startsWith(".") || entry.name.endsWith(".partial")) continue;
        const childRelative = relativePath ? `${relativePath}/${entry.name}` : entry.name;
        if (entry.name.toLowerCase().includes(query)) {
          const stats = await fs.stat(path.join(absolute, entry.name));
          results.push({
            rootId: option.id,
            rootLabel: option.label,
            name: entry.name,
            path: childRelative,
            displayPath: `/${childRelative}`,
            type: entry.isDirectory() ? "folder" : "file",
            size: entry.isFile() ? stats.size : 0,
            modifiedAt: stats.mtime.toISOString(),
            extension: entry.isFile() ? path.extname(entry.name).slice(1).toLowerCase() : "",
          });
        }
        if (entry.isDirectory()) await walk(childRelative);
      }
    }
    await walk();
  }
  return res.json({ items: results });
});

router.get("/items", async (req, res) => {
  await ensureRootReady();
  const STORAGE_ROOT = getActiveStorageRoot();
  const currentPath = parseRelativePath(req.query.path || "");
  const { absolutePath } = resolveStoragePath(STORAGE_ROOT, currentPath);
  const stats = await readEntryStats(absolutePath).catch((error) => {
    if (error?.code === "ENOENT") {
      return null;
    }

    throw error;
  });

  if (!stats) {
    return res.status(404).json({ message: "Item not found" });
  }

  return res.json({
    path: currentPath,
    type: stats.isDirectory ? "folder" : "file",
    size: stats.size,
    extension: stats.isDirectory ? "" : path.extname(currentPath).slice(1).toLowerCase(),
    createdAt: stats.createdAt.toISOString(),
    updatedAt: stats.updatedAt.toISOString(),
  });
});

export default router;
