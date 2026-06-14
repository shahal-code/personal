import { Router } from "express";
import { STORAGE_DRIVER } from "../config/env.js";
import { requireAdmin } from "../middleware/auth.js";
import { noStore } from "../middleware/security.js";
import { ensureDirectory, calculateStorageUsage } from "../lib/files.js";
import { getActiveStorageRoot, getStorageRootState, selectStorageRoot } from "../lib/storage-roots.js";
import { parseJsonBody } from "../utils/validation.js";
import { s3CalculateStorageUsage } from "../lib/s3-storage.js";

const router = Router();

router.use("/storage", requireAdmin, noStore);

router.get("/storage", async (req, res) => {
  if (STORAGE_DRIVER === "s3") {
    const storage = await s3CalculateStorageUsage(Number(req.query.totalBytes || 0));
    return res.json({
      ...storage,
      roots: {
        activeRootId: "s3",
        options: [{ id: "s3", label: "AWS S3", available: true, displayPath: "Private S3 bucket" }],
      },
    });
  }

  const storageRoot = getActiveStorageRoot();
  await ensureDirectory(storageRoot);
  const [storage, rootState] = await Promise.all([
    calculateStorageUsage(storageRoot, Number(req.query.totalBytes || 0)),
    getStorageRootState(),
  ]);
  return res.json({ ...storage, roots: rootState });
});

router.put("/storage/root", async (req, res) => {
  if (STORAGE_DRIVER === "s3") {
    return res.json({
      message: "S3 storage is active",
      roots: {
        activeRootId: "s3",
        options: [{ id: "s3", label: "AWS S3", available: true, displayPath: "Private S3 bucket" }],
      },
    });
  }

  const body = parseJsonBody(req);
  const roots = await selectStorageRoot(body.rootId);
  return res.json({ message: "Storage root changed", roots });
});

export default router;
