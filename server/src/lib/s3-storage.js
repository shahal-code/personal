import path from "node:path";
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  UploadPartCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { AWS_REGION, S3_BUCKET, S3_PREFIX } from "../config/env.js";
import { ensureSafeName, getParentRelativePath, joinRelativePath, normalizeRelativePath, toDisplayPath } from "./path.js";

const s3 = new S3Client({ region: AWS_REGION });

function keyFor(relativePath = "") {
  const safeRelative = normalizeRelativePath(relativePath);
  return [S3_PREFIX, safeRelative].filter(Boolean).join("/");
}

function relativeFromKey(key) {
  const prefix = S3_PREFIX ? `${S3_PREFIX}/` : "";
  return key.startsWith(prefix) ? key.slice(prefix.length) : key;
}

function folderKey(relativePath = "") {
  const key = keyFor(relativePath);
  return key ? `${key.replace(/\/+$/, "")}/` : "";
}

function itemFromObject(object) {
  const relativePath = relativeFromKey(object.Key || "").replace(/\/+$/, "");
  const name = path.posix.basename(relativePath);
  return {
    name,
    path: relativePath,
    displayPath: toDisplayPath(relativePath),
    type: "file",
    size: Number(object.Size || 0),
    modifiedAt: object.LastModified?.toISOString?.() || new Date().toISOString(),
    createdAt: object.LastModified?.toISOString?.() || new Date().toISOString(),
    extension: path.posix.extname(name).slice(1).toLowerCase(),
  };
}

export function isS3Ready() {
  return Boolean(AWS_REGION && S3_BUCKET);
}

export async function s3FileExists(relativePath) {
  try {
    await s3.send(new HeadObjectCommand({ Bucket: S3_BUCKET, Key: keyFor(relativePath) }));
    return true;
  } catch (error) {
    if (error?.$metadata?.httpStatusCode === 404 || error?.name === "NotFound") {
      return false;
    }
    throw error;
  }
}

export async function s3GetFileInfo(relativePath) {
  const safeRelative = normalizeRelativePath(relativePath);
  const response = await s3.send(new HeadObjectCommand({ Bucket: S3_BUCKET, Key: keyFor(safeRelative) }));
  const name = path.posix.basename(safeRelative);
  return {
    path: safeRelative,
    type: "file",
    size: Number(response.ContentLength || 0),
    extension: path.posix.extname(name).slice(1).toLowerCase(),
    createdAt: response.LastModified?.toISOString?.() || new Date().toISOString(),
    updatedAt: response.LastModified?.toISOString?.() || new Date().toISOString(),
  };
}

export async function s3ListDirectory(relativePath = "") {
  const safeRelative = normalizeRelativePath(relativePath);
  const prefix = folderKey(safeRelative);
  const response = await s3.send(
    new ListObjectsV2Command({
      Bucket: S3_BUCKET,
      Prefix: prefix,
      Delimiter: "/",
      MaxKeys: 1000,
    })
  );

  const folders = (response.CommonPrefixes || []).map((entry) => {
    const childRelative = relativeFromKey(entry.Prefix || "").replace(/\/+$/, "");
    return {
      name: path.posix.basename(childRelative),
      path: childRelative,
      displayPath: toDisplayPath(childRelative),
      type: "folder",
      size: 0,
      modifiedAt: null,
      createdAt: null,
      extension: "",
    };
  });

  const files = (response.Contents || [])
    .filter((object) => object.Key !== prefix && !String(object.Key || "").endsWith("/"))
    .map(itemFromObject);

  const items = [...folders, ...files].sort((left, right) => {
    if (left.type !== right.type) return left.type === "folder" ? -1 : 1;
    return left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: "base" });
  });

  return {
    currentPath: toDisplayPath(safeRelative),
    parentPath: toDisplayPath(getParentRelativePath(safeRelative)),
    items,
  };
}

export async function s3ListAllItems() {
  const items = [];
  let ContinuationToken;

  do {
    const response = await s3.send(
      new ListObjectsV2Command({
        Bucket: S3_BUCKET,
        Prefix: S3_PREFIX ? `${S3_PREFIX}/` : "",
        ContinuationToken,
      })
    );
    items.push(
      ...(response.Contents || [])
        .filter((object) => object.Key && !object.Key.endsWith("/"))
        .map(itemFromObject)
    );
    ContinuationToken = response.NextContinuationToken;
  } while (ContinuationToken);

  items.sort((left, right) => String(right.modifiedAt || "").localeCompare(String(left.modifiedAt || "")));
  return { items };
}

export async function s3CalculateStorageUsage(configuredTotalBytes = 0) {
  const { items } = await s3ListAllItems();
  const fileTypes = {};
  let usedBytes = 0;
  let largestFile = null;
  let latestModifiedAt = null;

  for (const item of items) {
    usedBytes += Number(item.size || 0);
    const extension = item.extension || "other";
    fileTypes[extension] = (fileTypes[extension] || 0) + 1;
    if (!largestFile || Number(item.size || 0) > largestFile.size) {
      largestFile = { name: item.name, size: Number(item.size || 0) };
    }
    if (!latestModifiedAt || new Date(item.modifiedAt) > new Date(latestModifiedAt)) {
      latestModifiedAt = item.modifiedAt;
    }
  }

  const totalBytes = Number(configuredTotalBytes || 0) || Math.max(usedBytes, 1024 * 1024 * 1024 * 1024);
  const freeBytes = Math.max(0, totalBytes - usedBytes);
  const freePercent = totalBytes > 0 ? (freeBytes / totalBytes) * 100 : 0;
  const health =
    freePercent <= 5
      ? { status: "critical", label: "Critical", message: "Storage is almost full" }
      : freePercent <= 15
        ? { status: "warning", label: "Low", message: "Storage space is running low" }
        : { status: "healthy", label: "Healthy", message: "Storage capacity is available" };

  return {
    totalBytes,
    usedBytes,
    freeBytes,
    fileCount: items.length,
    directoryCount: 0,
    fileTypes,
    largestFile,
    lastSyncAt: latestModifiedAt,
    health,
  };
}

export async function s3CreateFolder(relativePath, folderName) {
  const targetRelative = joinRelativePath(relativePath, folderName);
  await s3.send(new PutObjectCommand({ Bucket: S3_BUCKET, Key: folderKey(targetRelative), Body: "" }));
  return { path: toDisplayPath(targetRelative), name: ensureSafeName(folderName) };
}

export async function s3DeleteEntry(relativePath) {
  const safeRelative = normalizeRelativePath(relativePath);
  const key = keyFor(safeRelative);
  const folderPrefix = folderKey(safeRelative);
  const listed = await s3.send(new ListObjectsV2Command({ Bucket: S3_BUCKET, Prefix: folderPrefix, MaxKeys: 1000 }));

  if (listed.Contents?.length) {
    for (const object of listed.Contents) {
      await s3.send(new DeleteObjectCommand({ Bucket: S3_BUCKET, Key: object.Key }));
    }
    return;
  }

  await s3.send(new DeleteObjectCommand({ Bucket: S3_BUCKET, Key: key }));
}

export async function s3CreateUploadUrl(relativePath, contentType) {
  const command = new PutObjectCommand({
    Bucket: S3_BUCKET,
    Key: keyFor(relativePath),
    ContentType: contentType || "application/octet-stream",
  });
  return getSignedUrl(s3, command, { expiresIn: 60 * 15 });
}

export async function s3CreateMultipartUpload(relativePath, contentType) {
  const response = await s3.send(
    new CreateMultipartUploadCommand({
      Bucket: S3_BUCKET,
      Key: keyFor(relativePath),
      ContentType: contentType || "application/octet-stream",
    })
  );

  return {
    uploadId: response.UploadId,
    key: response.Key,
  };
}

function contentTypeForPath(relativePath) {
  const extension = path.posix.extname(normalizeRelativePath(relativePath)).slice(1).toLowerCase();
  return {
    mp4: "video/mp4",
    m4v: "video/mp4",
    mov: "video/quicktime",
    webm: "video/webm",
    mp3: "audio/mpeg",
    m4a: "audio/mp4",
    wav: "audio/wav",
    ogg: "audio/ogg",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    gif: "image/gif",
    webp: "image/webp",
    pdf: "application/pdf",
  }[extension];
}

export async function s3CreateMultipartPartUrl(relativePath, uploadId, partNumber) {
  const command = new UploadPartCommand({
    Bucket: S3_BUCKET,
    Key: keyFor(relativePath),
    UploadId: uploadId,
    PartNumber: partNumber,
  });
  return getSignedUrl(s3, command, { expiresIn: 60 * 15 });
}

export async function s3CompleteMultipartUpload(relativePath, uploadId, parts) {
  await s3.send(
    new CompleteMultipartUploadCommand({
      Bucket: S3_BUCKET,
      Key: keyFor(relativePath),
      UploadId: uploadId,
      MultipartUpload: {
        Parts: parts
          .map((part) => ({
            ETag: part.ETag || part.etag,
            PartNumber: Number(part.PartNumber || part.partNumber),
          }))
          .sort((left, right) => left.PartNumber - right.PartNumber),
      },
    })
  );
}

export async function s3AbortMultipartUpload(relativePath, uploadId) {
  await s3.send(
    new AbortMultipartUploadCommand({
      Bucket: S3_BUCKET,
      Key: keyFor(relativePath),
      UploadId: uploadId,
    })
  );
}

export async function s3CreateReadUrl(relativePath, download = false) {
  const fileName = path.posix.basename(normalizeRelativePath(relativePath));
  const command = new GetObjectCommand({
    Bucket: S3_BUCKET,
    Key: keyFor(relativePath),
    ResponseContentDisposition: download ? `attachment; filename="${fileName.replaceAll('"', "")}"` : undefined,
    ResponseContentType: download ? undefined : contentTypeForPath(relativePath),
  });
  return getSignedUrl(s3, command, { expiresIn: 60 * 10 });
}
