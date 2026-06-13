import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import crypto from "node:crypto";
import { Router } from "express";
import {
  ADMIN_EMAIL,
  ADMIN_PASSWORD,
  ADMIN_PASSWORD_HASH,
  COOKIE_NAME,
  COOKIE_SECURE,
  COOKIE_SAME_SITE,
  JWT_SECRET,
  TOKEN_TTL,
} from "../config/env.js";
import { revokeToken } from "../lib/sessions.js";
import { getRequestToken } from "../middleware/auth.js";
import { noStore, rateLimit } from "../middleware/security.js";
import { isValidEmail, parseJsonBody } from "../utils/validation.js";

const router = Router();
const loginAttempts = new Map();
const WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 5;

function getAttemptBucket(ip) {
  const key = ip || "unknown";
  const now = Date.now();
  const bucket = loginAttempts.get(key);

  if (!bucket || bucket.expiresAt <= now) {
    const freshBucket = { count: 0, expiresAt: now + WINDOW_MS };
    loginAttempts.set(key, freshBucket);
    return freshBucket;
  }

  return bucket;
}

function setAuthCookie(res, token, expiresAt) {
  const secureFlag = COOKIE_SECURE || process.env.NODE_ENV === "production";
  const cookieParts = [
    `${COOKIE_NAME}=${encodeURIComponent(token)}`,
    "HttpOnly",
    "Path=/",
    `SameSite=${COOKIE_SAME_SITE}`,
    secureFlag ? "Secure" : null,
    expiresAt ? `Expires=${new Date(expiresAt * 1000).toUTCString()}` : null,
  ].filter(Boolean);

  res.setHeader("Set-Cookie", cookieParts.join("; "));
}

function clearAuthCookie(res) {
  const secureFlag = COOKIE_SECURE || process.env.NODE_ENV === "production";
  const cookieParts = [
    `${COOKIE_NAME}=`,
    "HttpOnly",
    "Path=/",
    `SameSite=${COOKIE_SAME_SITE}`,
    "Max-Age=0",
    secureFlag ? "Secure" : null,
  ].filter(Boolean);

  res.setHeader("Set-Cookie", cookieParts.join("; "));
}

router.use(noStore);

router.post("/login", rateLimit({ windowMs: WINDOW_MS, max: 20, message: "Too many login attempts. Try again later." }), async (req, res) => {
  const bucket = getAttemptBucket(req.ip);

  if (bucket.count >= MAX_ATTEMPTS) {
    return res.status(429).json({
      message: "Too many login attempts. Try again later.",
    });
  }

  const body = parseJsonBody(req);
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const password = typeof body.password === "string" ? body.password : "";

  if (!isValidEmail(email) || !password) {
    bucket.count += 1;
    return res.status(400).json({ message: "Email and password are required." });
  }

  if (email !== ADMIN_EMAIL.toLowerCase()) {
    bucket.count += 1;
    return res.status(401).json({ message: "Invalid credentials." });
  }

  const passwordMatches = ADMIN_PASSWORD
    ? password === ADMIN_PASSWORD
    : await bcrypt.compare(password, ADMIN_PASSWORD_HASH);
  if (!passwordMatches) {
    bucket.count += 1;
    return res.status(401).json({ message: "Invalid credentials." });
  }

  const now = Math.floor(Date.now() / 1000);
  const jti = crypto.randomUUID();
  const token = jwt.sign(
    {
      sub: "admin",
      email: ADMIN_EMAIL,
      role: "admin",
      jti,
    },
    JWT_SECRET,
    {
      expiresIn: TOKEN_TTL,
      algorithm: "HS256",
      audience: "phone-cloud-admin",
      issuer: "phone-cloud",
    }
  );
  const decoded = jwt.decode(token);
  const expiresAt = typeof decoded?.exp === "number" ? decoded.exp : now + 12 * 60 * 60;

  setAuthCookie(res, token, expiresAt);
  loginAttempts.delete(req.ip || "unknown");

  return res.json({
    authenticated: true,
    email: ADMIN_EMAIL,
    expiresAt,
  });
});

router.post("/logout", async (req, res) => {
  const token = getRequestToken(req);

  if (token) {
    try {
      const decoded = jwt.verify(token, JWT_SECRET, {
        algorithms: ["HS256"],
        audience: "phone-cloud-admin",
        issuer: "phone-cloud",
      });
      if (decoded?.jti && decoded?.exp) {
        await revokeToken(decoded.jti, decoded.exp);
      }
    } catch {
      // Ignore invalid or expired tokens. Logout still clears the client cookie.
    }
  }

  clearAuthCookie(res);
  return res.json({ authenticated: false });
});

export default router;
