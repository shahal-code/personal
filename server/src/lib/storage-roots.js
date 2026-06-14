import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DATA_DIR, SD_STORAGE_ROOT, STORAGE_ROOT } from "../config/env.js";

const selectionPath = path.join(DATA_DIR, "active-storage.json");
const roots = {
  internal: {
    id: "internal",
    label: "Phone storage",
    path: STORAGE_ROOT,
  },
  sd: {
    id: "sd",
    label: "SD card",
    path: SD_STORAGE_ROOT,
  },
};

let activeRootId = "internal";

function getCandidatePaths(rootId, rootPath) {
  const candidates = [];
  if (rootPath) candidates.push(rootPath);

  if (rootId === "sd") {
    const mountId = String(rootPath || "").match(/(?:^|\/)([0-9A-Fa-f]{4}-[0-9A-Fa-f]{4})(?:\/|$)/)?.[1];
    if (mountId) {
      candidates.push(`/storage/${mountId}`);
    }
    candidates.push(
      path.join(os.homedir(), "storage", "external-1"),
      path.join(os.homedir(), "storage", "external")
    );
  }

  return [...new Set(candidates)];
}

async function inspectRoot(rootId, rootPath) {
  if (!rootPath && rootId !== "sd") {
    return { available: false, resolvedPath: "", error: "not configured" };
  }

  let lastError = rootPath ? "path is not accessible" : "not configured";
  const availableCandidates = [];

  for (const candidate of getCandidatePaths(rootId, rootPath)) {
    try {
      const stats = await fs.stat(candidate);
      if (!stats.isDirectory()) {
        lastError = "path is not a directory";
        continue;
      }

      await fs.access(candidate);
      const resolvedPath = await fs.realpath(candidate).catch(() => candidate);
      const entries = await fs.readdir(candidate, { withFileTypes: true });
      const visibleEntryCount = entries.filter((entry) => !entry.name.startsWith(".")).length;
      availableCandidates.push({
        path: candidate,
        resolvedPath,
        visibleEntryCount,
      });
    } catch (error) {
      lastError = error?.code || error?.message || "path is not accessible";
    }
  }

  if (availableCandidates.length > 0) {
    const selected = [...availableCandidates].sort(
      (left, right) => right.visibleEntryCount - left.visibleEntryCount
    )[0];

    return {
      available: true,
      resolvedPath: selected.resolvedPath,
      displayPath: selected.path,
      visibleEntryCount: selected.visibleEntryCount,
      candidates: availableCandidates,
      error: "",
    };
  }

  return { available: false, resolvedPath: rootPath || "", error: lastError };
}

async function isDirectoryAvailable(rootId, rootPath) {
  try {
    const inspection = await inspectRoot(rootId, rootPath);
    if (inspection.available) roots[rootId].resolvedPath = inspection.resolvedPath;
    return inspection.available;
  } catch {
    return false;
  }
}

export async function initializeStorageRoots() {
  try {
    const saved = JSON.parse(await fs.readFile(selectionPath, "utf8"));
    if (roots[saved.activeRootId]) activeRootId = saved.activeRootId;
  } catch {
    activeRootId = "internal";
  }

  if (!(await isDirectoryAvailable(activeRootId, roots[activeRootId].path))) {
    activeRootId = "internal";
  }
}

export function getActiveStorageRoot() {
  return roots[activeRootId].resolvedPath || roots[activeRootId].path;
}

export async function getStorageRootById(rootId) {
  const root = roots[rootId];
  if (!root) {
    throw Object.assign(new Error("Unknown storage root"), { statusCode: 400 });
  }

  const inspection = await inspectRoot(rootId, root.path);
  if (!inspection.available) {
    throw Object.assign(new Error(`${root.label} is not accessible`), { statusCode: 409 });
  }

  root.resolvedPath = inspection.resolvedPath;
  return root.resolvedPath;
}

export async function getStorageRootState() {
  const options = await Promise.all(
    Object.values(roots).map(async ({ id, label, path: rootPath }) => {
      const inspection = await inspectRoot(id, rootPath);
      if (inspection.available) roots[id].resolvedPath = inspection.resolvedPath;

      return {
        id,
        label,
        configured: Boolean(rootPath),
        configuredPath: rootPath,
        ...inspection,
      };
    })
  );

  return { activeRootId, options };
}

export async function selectStorageRoot(rootId) {
  const root = roots[rootId];
  if (!root) {
    throw Object.assign(new Error("Unknown storage root"), { statusCode: 400 });
  }
  const inspection = await inspectRoot(rootId, root.path);
  if (!inspection.available) {
    throw Object.assign(
      new Error(`${root.label} is not accessible (${inspection.error}). Checked: ${inspection.resolvedPath || root.path || "Termux storage aliases"}`),
      { statusCode: 409 }
    );
  }

  root.resolvedPath = inspection.resolvedPath;
  activeRootId = rootId;
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(selectionPath, JSON.stringify({ activeRootId }, null, 2), "utf8");
  return getStorageRootState();
}
