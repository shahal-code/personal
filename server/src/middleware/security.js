import crypto from "node:crypto";
import { CLIENT_ORIGINS } from "../config/env.js";

const DEFAULT_WINDOW_MS = 15 * 60 * 1000;

function clientKey(req) {
  return req.ip || req.socket?.remoteAddress || "unknown";
}

export function rateLimit({ windowMs = DEFAULT_WINDOW_MS, max = 300, message = "Too many requests. Try again later." } = {}) {
  const buckets = new Map();

  return (req, res, next) => {
    const key = clientKey(req);
    const now = Date.now();
    const bucket = buckets.get(key);

    if (!bucket || bucket.resetAt <= now) {
      buckets.set(key, { count: 1, resetAt: now + windowMs });
      return next();
    }

    bucket.count += 1;
    res.setHeader("RateLimit-Limit", String(max));
    res.setHeader("RateLimit-Remaining", String(Math.max(0, max - bucket.count)));
    res.setHeader("RateLimit-Reset", String(Math.ceil(bucket.resetAt / 1000)));

    if (bucket.count > max) {
      return res.status(429).json({ message });
    }

    return next();
  };
}

export function requireTrustedOrigin(req, res, next) {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) {
    return next();
  }

  const origin = req.headers.origin;
  const referer = req.headers.referer;

  if (origin) {
    return CLIENT_ORIGINS.includes(origin) ? next() : res.status(403).json({ message: "Untrusted request origin" });
  }

  if (referer) {
    try {
      const refererOrigin = new URL(referer).origin;
      return CLIENT_ORIGINS.includes(refererOrigin) ? next() : res.status(403).json({ message: "Untrusted request origin" });
    } catch {
      return res.status(403).json({ message: "Untrusted request origin" });
    }
  }

  return next();
}

export function noStore(req, res, next) {
  res.setHeader("Cache-Control", "no-store");
  return next();
}

export function securityRequestId(req, res, next) {
  const requestId = req.headers["x-request-id"] || crypto.randomUUID();
  req.requestId = String(requestId).slice(0, 80);
  res.setHeader("X-Request-Id", req.requestId);
  return next();
}
