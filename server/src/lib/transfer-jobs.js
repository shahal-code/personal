import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { DATA_DIR } from "../config/env.js";
import { ensureSafeName, joinRelativePath, resolveStoragePath } from "./path.js";
import { getStorageRootById } from "./storage-roots.js";

const JOBS_FILE = path.join(DATA_DIR, "transfer-jobs.json");
const MAX_JOBS = 200;
let jobs = [];
let loaded = false;
let processing = false;

async function persist() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const temp = `${JOBS_FILE}.tmp`;
  await fs.writeFile(temp, JSON.stringify({ jobs: jobs.slice(0, MAX_JOBS) }, null, 2), "utf8");
  await fs.rename(temp, JOBS_FILE);
}

async function ensureLoaded() {
  if (loaded) return;
  try {
    const parsed = JSON.parse(await fs.readFile(JOBS_FILE, "utf8"));
    jobs = Array.isArray(parsed?.jobs) ? parsed.jobs : [];
  } catch {
    jobs = [];
  }
  jobs = jobs.map((job) => job.status === "running" ? { ...job, status: "queued" } : job);
  loaded = true;
  await persist();
}

async function uniqueDestination(root, folder, sourceName) {
  const extension = path.extname(sourceName);
  const stem = path.basename(sourceName, extension);
  for (let index = 1; index < 10000; index += 1) {
    const name = `${stem} (${index})${extension}`;
    const relative = joinRelativePath(folder, name);
    if (!(await fs.stat(resolveStoragePath(root, relative).absolutePath).catch(() => null))) return relative;
  }
  throw new Error("Unable to create a unique destination name");
}

async function runJob(job) {
  const sourceRoot = await getStorageRootById(job.sourceRootId);
  const destinationRoot = await getStorageRootById(job.destinationRootId);
  const sourceAbsolute = resolveStoragePath(sourceRoot, job.path).absolutePath;
  const sourceName = ensureSafeName(path.basename(job.path));
  let destinationRelative = joinRelativePath(job.destinationPath, job.renameTo || sourceName);
  let destinationAbsolute = resolveStoragePath(destinationRoot, destinationRelative).absolutePath;
  const sameRoot = sourceRoot === destinationRoot;

  if (sameRoot && sourceAbsolute === destinationAbsolute && !["keep-both", "rename"].includes(job.conflictPolicy)) {
    throw new Error("Source and destination are the same");
  }

  const sourceStats = await fs.stat(sourceAbsolute);
  const sourcePrefix = sourceAbsolute.endsWith(path.sep) ? sourceAbsolute : `${sourceAbsolute}${path.sep}`;
  if (sourceStats.isDirectory() && sameRoot && destinationAbsolute.startsWith(sourcePrefix)) {
    throw new Error("A folder cannot be copied or moved inside itself");
  }

  const existing = await fs.stat(destinationAbsolute).catch(() => null);

  if (existing) {
    if (job.conflictPolicy === "skip") return { skipped: true, destinationRelative };
    if (job.conflictPolicy === "keep-both") {
      destinationRelative = await uniqueDestination(destinationRoot, job.destinationPath, job.renameTo || sourceName);
      destinationAbsolute = resolveStoragePath(destinationRoot, destinationRelative).absolutePath;
    } else if (job.conflictPolicy === "replace") {
      await fs.rm(destinationAbsolute, { recursive: existing.isDirectory(), force: true });
    } else {
      throw Object.assign(new Error("Destination already exists"), { code: "CONFLICT" });
    }
  }

  await fs.mkdir(path.dirname(destinationAbsolute), { recursive: true });
  if (sourceStats.isDirectory()) {
    await fs.cp(sourceAbsolute, destinationAbsolute, { recursive: true, errorOnExist: true });
  } else {
    await fs.copyFile(sourceAbsolute, destinationAbsolute);
  }
  if (job.operation === "move") {
    await fs.rm(sourceAbsolute, { recursive: sourceStats.isDirectory(), force: false });
  }
  return { skipped: false, destinationRelative };
}

async function processQueue() {
  if (processing) return;
  processing = true;
  try {
    while (true) {
      const job = jobs.find((item) => item.status === "queued");
      if (!job) break;
      Object.assign(job, { status: "running", startedAt: new Date().toISOString(), error: "" });
      await persist();
      try {
        const result = await runJob(job);
        Object.assign(job, {
          status: result.skipped ? "skipped" : "completed",
          destinationRelative: result.destinationRelative,
          completedAt: new Date().toISOString(),
        });
      } catch (error) {
        Object.assign(job, { status: "failed", error: error?.message || "Transfer failed", completedAt: new Date().toISOString() });
      }
      await persist();
    }
  } finally {
    processing = false;
  }
}

export async function initializeTransferJobs() {
  await ensureLoaded();
  void processQueue();
}

export async function createTransferJob(input) {
  await ensureLoaded();
  const job = {
    id: randomUUID(),
    status: "queued",
    operation: input.operation === "move" ? "move" : "copy",
    conflictPolicy: ["replace", "skip", "keep-both", "rename"].includes(input.conflictPolicy) ? input.conflictPolicy : "keep-both",
    sourceRootId: input.sourceRootId,
    destinationRootId: input.destinationRootId,
    path: input.path,
    destinationPath: input.destinationPath || "",
    renameTo: input.conflictPolicy === "rename" ? ensureSafeName(input.renameTo || "") : "",
    createdAt: new Date().toISOString(),
  };
  jobs.unshift(job);
  await persist();
  void processQueue();
  return job;
}

export async function getTransferJobs(limit = 50) {
  await ensureLoaded();
  return jobs.slice(0, Math.max(1, Math.min(200, Number(limit) || 50)));
}
