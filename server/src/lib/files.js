import fs from "node:fs/promises";
import path from "node:path";
import { ensureSafeName, getParentRelativePath, normalizeRelativePath, resolveStoragePath, toDisplayPath } from "./path.js";

function bytesToNumber(value) {
  return Number.isFinite(value) ? value : 0;
}

export async function ensureDirectory(targetPath) {
  await fs.mkdir(targetPath, { recursive: true });
}

export async function readEntryStats(absolutePath) {
  const stats = await fs.stat(absolutePath);
  return {
    isDirectory: stats.isDirectory(),
    isFile: stats.isFile(),
    size: stats.size,
    createdAt: stats.birthtime,
    updatedAt: stats.mtime,
  };
}

export async function listDirectory(storageRoot, relativePath = "") {
  const { absolutePath, relativePath: safeRelative } = resolveStoragePath(storageRoot, relativePath);
  const entries = await fs.readdir(absolutePath, { withFileTypes: true });

  const items = await Promise.all(
    entries.map(async (entry) => {
      if (entry.name.startsWith(".") || entry.name.endsWith(".partial")) {
        return null;
      }

      const childRelative = safeRelative ? `${safeRelative}/${entry.name}` : entry.name;
      const childAbsolute = path.join(absolutePath, entry.name);
      const stats = await fs.stat(childAbsolute);

      return {
        name: entry.name,
        path: childRelative,
        displayPath: toDisplayPath(childRelative),
        type: entry.isDirectory() ? "folder" : "file",
        size: entry.isDirectory() ? 0 : stats.size,
        modifiedAt: stats.mtime.toISOString(),
        createdAt: stats.birthtime.toISOString(),
        extension: entry.isDirectory() ? "" : path.extname(entry.name).slice(1).toLowerCase(),
      };
    })
  );

  const visibleItems = items.filter(Boolean);

  visibleItems.sort((left, right) => {
    if (left.type !== right.type) {
      return left.type === "folder" ? -1 : 1;
    }

    return left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: "base" });
  });

  return {
    currentPath: toDisplayPath(safeRelative),
    parentPath: toDisplayPath(getParentRelativePath(safeRelative)),
    items: visibleItems,
  };
}

export async function listAllItems(storageRoot) {
  const items = [];

  async function walk(relativePath = "") {
    const { absolutePath, relativePath: safeRelative } = resolveStoragePath(storageRoot, relativePath);
    const entries = await fs.readdir(absolutePath, { withFileTypes: true });

    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.name.endsWith(".partial")) {
        continue;
      }

      const childRelative = safeRelative ? `${safeRelative}/${entry.name}` : entry.name;
      const childAbsolute = path.join(absolutePath, entry.name);
      const stats = await fs.stat(childAbsolute);
      const isDirectory = entry.isDirectory();

      items.push({
        name: entry.name,
        path: childRelative,
        displayPath: toDisplayPath(childRelative),
        type: isDirectory ? "folder" : "file",
        size: isDirectory ? 0 : stats.size,
        modifiedAt: stats.mtime.toISOString(),
        createdAt: stats.birthtime.toISOString(),
        extension: isDirectory ? "" : path.extname(entry.name).slice(1).toLowerCase(),
      });

      if (isDirectory) {
        await walk(childRelative);
      }
    }
  }

  await walk("");

  items.sort((left, right) => {
    if (left.type !== right.type) {
      return left.type === "folder" ? -1 : 1;
    }

    return String(left.modifiedAt || "").localeCompare(String(right.modifiedAt || ""));
  });

  return { items: items.reverse() };
}

export async function createFolder(storageRoot, relativePath, folderName) {
  const safeName = ensureSafeName(folderName);
  const baseRelative = normalizeRelativePath(relativePath);
  const targetRelative = baseRelative ? `${baseRelative}/${safeName}` : safeName;
  const { absolutePath } = resolveStoragePath(storageRoot, targetRelative);
  await fs.mkdir(absolutePath, { recursive: false });
  return {
    path: toDisplayPath(targetRelative),
    name: safeName,
  };
}

export async function renameEntry(storageRoot, relativePath, newName) {
  const safeName = ensureSafeName(newName);
  const { absolutePath, relativePath: safeRelative } = resolveStoragePath(storageRoot, relativePath);
  const parentRelative = getParentRelativePath(safeRelative);
  const nextRelative = parentRelative ? `${parentRelative}/${safeName}` : safeName;
  const { absolutePath: nextAbsolute } = resolveStoragePath(storageRoot, nextRelative);

  await fs.rename(absolutePath, nextAbsolute);

  return {
    path: toDisplayPath(nextRelative),
    name: safeName,
  };
}

export async function removeEntry(storageRoot, relativePath) {
  const { absolutePath } = resolveStoragePath(storageRoot, relativePath);
  const stats = await fs.stat(absolutePath);

  if (stats.isDirectory()) {
    await fs.rm(absolutePath, { recursive: true, force: false });
  } else {
    await fs.unlink(absolutePath);
  }
}

export async function fileExists(storageRoot, relativePath) {
  try {
    const { absolutePath } = resolveStoragePath(storageRoot, relativePath);
    await fs.access(absolutePath);
    return true;
  } catch {
    return false;
  }
}

export async function calculateStorageUsage(storageRoot, configuredTotalBytes = 0) {
  let totalBytes = bytesToNumber(configuredTotalBytes);
  let usedBytes = 0;
  let fileCount = 0;
  let directoryCount = 0;

  async function walk(currentAbsolutePath) {
    const entries = await fs.readdir(currentAbsolutePath, { withFileTypes: true });

    for (const entry of entries) {
      const entryAbsolute = path.join(currentAbsolutePath, entry.name);
      const stats = await fs.stat(entryAbsolute);

      if (entry.isDirectory()) {
        directoryCount += 1;
        await walk(entryAbsolute);
      } else if (entry.isFile()) {
        fileCount += 1;
        usedBytes += stats.size;
      }
    }
  }

  await walk(storageRoot);

  if (!totalBytes) {
    try {
      const statfs = await fs.statfs(storageRoot);
      totalBytes = statfs.bsize * statfs.blocks;
    } catch {
      totalBytes = usedBytes;
    }
  }

  let freeBytes = totalBytes - usedBytes;
  if (freeBytes < 0) {
    freeBytes = 0;
  }

  return {
    totalBytes,
    usedBytes,
    freeBytes,
    fileCount,
    directoryCount,
  };
}
