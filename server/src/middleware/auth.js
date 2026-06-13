import jwt from "jsonwebtoken";
import { ADMIN_EMAIL, COOKIE_NAME, JWT_SECRET } from "../config/env.js";
import { isTokenRevoked } from "../lib/sessions.js";

export function getBearerToken(req) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) {
    return "";
  }

  return header.slice("Bearer ".length).trim();
}

export function getCookieToken(req) {
  const cookieHeader = req.headers.cookie;
  if (!cookieHeader) {
    return "";
  }

  const cookiePairs = cookieHeader.split(";").map((part) => part.trim());
  const match = cookiePairs.find((part) => part.startsWith(`${COOKIE_NAME}=`));
  if (!match) {
    return "";
  }

  return decodeURIComponent(match.slice(COOKIE_NAME.length + 1));
}

export function getRequestToken(req) {
  return getBearerToken(req) || getCookieToken(req);
}

async function authenticateAdmin(req) {
  const token = getRequestToken(req);

  if (!token) {
    return null;
  }

  const payload = jwt.verify(token, JWT_SECRET, {
    algorithms: ["HS256"],
    audience: "phone-cloud-admin",
    issuer: "phone-cloud",
  });
  if (payload.email !== ADMIN_EMAIL || payload.role !== "admin") {
    return null;
  }

  if (payload.jti && (await isTokenRevoked(payload.jti))) {
    return null;
  }

  return {
    email: payload.email,
    jti: payload.jti,
    role: payload.role,
    exp: payload.exp,
  };
}

export async function requireAdmin(req, res, next) {
  try {
    const user = await authenticateAdmin(req);
    if (!user) {
      return res.status(401).json({ message: "Authentication required" });
    }

    req.user = user;
    return next();
  } catch {
    return res.status(401).json({ message: "Authentication required" });
  }
}

export async function requireAdminPage(req, res, next) {
  try {
    const user = await authenticateAdmin(req);
    if (!user) {
      return res.redirect(302, "/login");
    }

    req.user = user;
    return next();
  } catch {
    return res.redirect(302, "/login");
  }
}
