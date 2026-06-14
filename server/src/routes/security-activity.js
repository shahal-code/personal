import { Router } from "express";
import { requireAdmin } from "../middleware/auth.js";
import { noStore } from "../middleware/security.js";
import { getSecurityActivity } from "../lib/audit.js";

const router = Router();
router.get("/security-activity", requireAdmin, noStore, async (req, res) => {
  return res.json(await getSecurityActivity(req.query.limit));
});
export default router;
