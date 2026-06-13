import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { spawn, execFile } from "node:child_process";
import { TEMP_DIR } from "../config/env.js";

const HLS_ROOT = path.join(TEMP_DIR, "hls");
const STATUS_IDLE = "idle";
const STATUS_QUEUED = "queued";
const STATUS_PROCESSING = "processing";
const STATUS_READY = "ready";
const STATUS_FAILED = "failed";
const STATUS_UNSUPPORTED = "unsupported";

let ffmpegAvailablePromise = null;

function isVideoForHls(fileName) {
  const ext = path.extname(fileName).toLowerCase();
  return ext === ".mp4" || ext === ".webm";
}

function getJobId(relativePath) {
  return crypto.createHash("sha1").update(relativePath).digest("hex");
}

function getJobDir(relativePath) {
  return path.join(HLS_ROOT, getJobId(relativePath));
}

function getPlaylistPath(relativePath) {
  return path.join(getJobDir(relativePath), "playlist.m3u8");
}

function getStatusPath(relativePath) {
  return path.join(getJobDir(relativePath), "status.json");
}

async function ensureHlsRoot() {
  await fs.mkdir(HLS_ROOT, { recursive: true });
}

async function readJson(targetPath) {
  try {
    const raw = await fs.readFile(targetPath, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function writeJson(targetPath, value) {
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.writeFile(targetPath, JSON.stringify(value, null, 2), "utf8");
}

async function isFfmpegAvailable() {
  if (!ffmpegAvailablePromise) {
    ffmpegAvailablePromise = new Promise((resolve) => {
      execFile("ffmpeg", ["-version"], { timeout: 4000 }, (error) => {
        resolve(!error);
      });
    });
  }

  return ffmpegAvailablePromise;
}

export function shouldGenerateHls(fileName) {
  return isVideoForHls(fileName);
}

export function getHlsJobInfo(relativePath) {
  return {
    jobId: getJobId(relativePath),
    jobDir: getJobDir(relativePath),
    playlistPath: getPlaylistPath(relativePath),
    statusPath: getStatusPath(relativePath),
  };
}

export async function readHlsStatus(relativePath) {
  await ensureHlsRoot();
  const status = await readJson(getStatusPath(relativePath));
  if (!status) {
    return {
      status: STATUS_IDLE,
      relativePath,
      hlsReady: false,
      playlistUrl: "",
    };
  }

  const playlistPath = getPlaylistPath(relativePath);
  const playlistExists = await fs
    .access(playlistPath)
    .then(() => true)
    .catch(() => false);

  return {
    ...status,
    relativePath,
    hlsReady: status.status === STATUS_READY && playlistExists,
    playlistUrl: playlistExists ? playlistPath : "",
  };
}

export async function startHlsTranscode({ relativePath, sourcePath, fileName }) {
  await ensureHlsRoot();

  if (!shouldGenerateHls(fileName)) {
    return {
      status: STATUS_UNSUPPORTED,
      relativePath,
      hlsReady: false,
    };
  }

  const jobDir = getJobDir(relativePath);
  const statusPath = getStatusPath(relativePath);
  const playlistPath = getPlaylistPath(relativePath);
  await fs.mkdir(jobDir, { recursive: true });

  const currentStatus = await readJson(statusPath);
  if (currentStatus && [STATUS_PROCESSING, STATUS_READY, STATUS_QUEUED].includes(currentStatus.status)) {
    return currentStatus;
  }

  const ffmpegAvailable = await isFfmpegAvailable();
  if (!ffmpegAvailable) {
    const unsupported = {
      status: STATUS_UNSUPPORTED,
      relativePath,
      message: "ffmpeg is not installed on the server",
      hlsReady: false,
      updatedAt: new Date().toISOString(),
    };
    await writeJson(statusPath, unsupported);
    return unsupported;
  }

  const queued = {
    status: STATUS_QUEUED,
    relativePath,
    fileName,
    sourcePath,
    jobDir,
    playlistPath,
    hlsReady: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  await writeJson(statusPath, queued);

  const args = [
    "-y",
    "-i",
    sourcePath,
    "-map",
    "0:v:0",
    "-map",
    "0:a?",
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-crf",
    "28",
    "-c:a",
    "aac",
    "-b:a",
    "128k",
    "-f",
    "hls",
    "-hls_time",
    "4",
    "-hls_playlist_type",
    "event",
    "-hls_flags",
    "independent_segments+append_list+omit_endlist",
    "-hls_segment_filename",
    path.join(jobDir, "segment-%05d.ts"),
    playlistPath,
  ];

  const child = spawn("ffmpeg", args, {
    detached: true,
    stdio: "ignore",
  });

  const processing = {
    ...queued,
    status: STATUS_PROCESSING,
    pid: child.pid,
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  await writeJson(statusPath, processing);

  child.on("exit", async (code) => {
    const nextStatus =
      code === 0
        ? {
            ...processing,
            status: STATUS_READY,
            finishedAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            hlsReady: true,
          }
        : {
            ...processing,
            status: STATUS_FAILED,
            error: `ffmpeg exited with code ${code}`,
            finishedAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            hlsReady: false,
          };

    await writeJson(statusPath, nextStatus).catch(() => {});
  });

  child.on("error", async (error) => {
    await writeJson(statusPath, {
      ...processing,
      status: STATUS_FAILED,
      error: error.message || "ffmpeg failed to start",
      finishedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      hlsReady: false,
    }).catch(() => {});
  });

  child.unref();
  return processing;
}

export async function getHlsPlaylist(relativePath) {
  const playlistPath = getPlaylistPath(relativePath);
  try {
    return await fs.readFile(playlistPath, "utf8");
  } catch {
    return "";
  }
}

export async function getHlsSegmentPath(relativePath, fileName) {
  const { jobDir } = getHlsJobInfo(relativePath);
  return path.join(jobDir, fileName);
}

export function rewriteHlsPlaylist(relativePath, playlistText) {
  const baseUrl = `/preview/hls/segment?path=${encodeURIComponent(relativePath)}&file=`;
  return playlistText
    .split(/\r?\n/)
    .map((line) => {
      if (!line || line.startsWith("#")) {
        return line;
      }

      return `${baseUrl}${encodeURIComponent(line)}`;
    })
    .join("\n");
}
