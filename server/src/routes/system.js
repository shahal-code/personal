import { Router } from "express";
import { requireAdmin } from "../middleware/auth.js";
import { noStore } from "../middleware/security.js";
import { getCpuStatus, getSystemStatus } from "../lib/system.js";

const router = Router();

router.use(["/system-status", "/cpu-status"], requireAdmin, noStore);

router.get("/system-status", async (req, res) => {
  const status = await getSystemStatus();
  return res.json(status);
});

router.get("/cpu-status", async (req, res) => {
  const cpu = await getCpuStatus();
  return res.json(cpu);
});

export default router;
