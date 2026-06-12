import path from "node:path";

export function normalizeRelativePath(input) {
  if (typeof input !== "string") {
    return "";
  }

  const cleaned = input.trim().replaceAll("\\", "/");
  if (!cleaned || cleaned === "/") {
    return "";
  }

  const withoutLeadingSlash = cleaned.startsWith("/") ? cleaned.slice(1) : cleaned;
  const normalized = path.posix.normalize(withoutLeadingSlash);

  if (normalized === "." || normalized === "/") {
    return "";
  }

  const parts = normalized.split("/").filter(Boolean);
  if (parts.some((segment) => segment === "..")) {
    throw new Error("Path traversal is not allowed");
  }

  return parts.join("/");
}

export function resolveStoragePath(storageRoot, relativePath = "") {
  const safeRelative = normalizeRelativePath(relativePath);
  const resolved = path.resolve(storageRoot, safeRelative.split("/").join(path.sep));
  const rootWithSeparator = storageRoot.endsWith(path.sep)
    ? storageRoot
    : `${storageRoot}${path.sep}`;

  if (resolved !== storageRoot && !resolved.startsWith(rootWithSeparator)) {
    throw new Error("Resolved path escapes the storage root");
  }

  return { absolutePath: resolved, relativePath: safeRelative };
}

export function ensureSafeName(name) {
  if (typeof name !== "string") {
    throw new Error("Name is required");
  }

  const trimmed = name.trim();
  if (!trimmed) {
    throw new Error("Name is required");
  }

  if (trimmed === "." || trimmed === "..") {
    throw new Error("Invalid name");
  }

  if (trimmed.includes("/") || trimmed.includes("\\") || trimmed.includes("\0")) {
    throw new Error("Name cannot contain path separators");
  }

  return trimmed;
}

export function getParentRelativePath(relativePath) {
  const normalized = normalizeRelativePath(relativePath);
  if (!normalized) {
    return "";
  }

  const parent = path.posix.dirname(normalized);
  return parent === "." ? "" : parent;
}

export function joinRelativePath(basePath, childName) {
  const base = normalizeRelativePath(basePath);
  const child = ensureSafeName(childName);
  return base ? `${base}/${child}` : child;
}

export function toDisplayPath(relativePath) {
  const normalized = normalizeRelativePath(relativePath);
  return normalized ? `/${normalized}` : "/";
}
