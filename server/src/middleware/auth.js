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

export async function requireAdmin(req, res, next) {
  try {
    const token = getRequestToken(req);

    if (!token) {
      return res.status(401).json({ message: "Authentication required" });
    }

    const payload = jwt.verify(token, JWT_SECRET);
    if (payload.email !== ADMIN_EMAIL || payload.role !== "admin") {
      return res.status(401).json({ message: "Invalid session" });
    }

    if (payload.jti && (await isTokenRevoked(payload.jti))) {
      return res.status(401).json({ message: "Session has been revoked" });
    }

    req.user = {
      email: payload.email,
      jti: payload.jti,
      role: payload.role,
      exp: payload.exp,
    };

    return next();
  } catch {
    return res.status(401).json({ message: "Authentication required" });
  }
}
