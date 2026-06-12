import { Router } from "express";
import { requireAdmin } from "../middleware/auth.js";
import { ensureDirectory, calculateStorageUsage } from "../lib/files.js";
import { STORAGE_ROOT } from "../config/env.js";

const router = Router();

router.use(requireAdmin);

router.get("/storage", async (req, res) => {
  await ensureDirectory(STORAGE_ROOT);
  const storage = await calculateStorageUsage(STORAGE_ROOT, Number(req.query.totalBytes || 0));
  return res.json({
    storageRoot: STORAGE_ROOT,
    ...storage,
  });
});

export default router;
