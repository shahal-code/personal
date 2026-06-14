import { Router } from "express";
import { requireAdmin } from "../middleware/auth.js";
import { noStore } from "../middleware/security.js";
import { ensureDirectory, calculateStorageUsage } from "../lib/files.js";
import { getActiveStorageRoot, getStorageRootState, selectStorageRoot } from "../lib/storage-roots.js";
import { parseJsonBody } from "../utils/validation.js";

const router = Router();

router.use("/storage", requireAdmin, noStore);

router.get("/storage", async (req, res) => {
  const storageRoot = getActiveStorageRoot();
  await ensureDirectory(storageRoot);
  const [storage, rootState] = await Promise.all([
    calculateStorageUsage(storageRoot, Number(req.query.totalBytes || 0)),
    getStorageRootState(),
  ]);
  return res.json({ ...storage, roots: rootState });
});

router.put("/storage/root", async (req, res) => {
  const body = parseJsonBody(req);
  const roots = await selectStorageRoot(body.rootId);
  return res.json({ message: "Storage root changed", roots });
});

export default router;
