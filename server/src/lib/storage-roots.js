import fs from "node:fs/promises";
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

async function isDirectoryAvailable(rootPath) {
  if (!rootPath) return false;

  try {
    return (await fs.stat(rootPath)).isDirectory();
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

  if (!(await isDirectoryAvailable(roots[activeRootId].path))) {
    activeRootId = "internal";
  }
}

export function getActiveStorageRoot() {
  return roots[activeRootId].path;
}

export async function getStorageRootState() {
  const options = await Promise.all(
    Object.values(roots).map(async ({ id, label, path: rootPath }) => ({
      id,
      label,
      configured: Boolean(rootPath),
      available: await isDirectoryAvailable(rootPath),
    }))
  );

  return { activeRootId, options };
}

export async function selectStorageRoot(rootId) {
  const root = roots[rootId];
  if (!root) {
    throw Object.assign(new Error("Unknown storage root"), { statusCode: 400 });
  }
  if (!root.path) {
    throw Object.assign(new Error("Set SD_STORAGE_ROOT on the server before using the SD card"), { statusCode: 400 });
  }
  if (!(await isDirectoryAvailable(root.path))) {
    throw Object.assign(new Error(`${root.label} is not mounted or accessible`), { statusCode: 409 });
  }

  activeRootId = rootId;
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(selectionPath, JSON.stringify({ activeRootId }, null, 2), "utf8");
  return getStorageRootState();
}
