import { Router } from "express";
import { requireAdmin } from "../middleware/auth.js";
import { noStore } from "../middleware/security.js";
import { getSystemStatus } from "../lib/system.js";

const router = Router();

router.use("/system-status", requireAdmin, noStore);

router.get("/system-status", async (req, res) => {
  const status = await getSystemStatus();
  return res.json(status);
});

export default router;
