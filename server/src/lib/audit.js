import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { DATA_DIR } from "../config/env.js";

const AUDIT_FILE = path.join(DATA_DIR, "security-activity.json");
const MAX_EVENTS = 1000;
let writeChain = Promise.resolve();

function getIp(req) {
  const forwarded = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  return forwarded || req.ip || req.socket?.remoteAddress || "Unknown";
}

function getCountry(req, ip) {
  const country = req.headers["x-vercel-ip-country"] || req.headers["cf-ipcountry"];
  if (country) return String(country);
  if (/^(::1|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip)) return "Local network";
  return "Unknown";
}

function parseDevice(userAgent = "") {
  const ua = String(userAgent);
  const os = /Android\s+([^;)]+)/i.exec(ua)?.[1]
    ? `Android ${/Android\s+([^;)]+)/i.exec(ua)[1]}`
    : /iPhone/i.test(ua) ? "iPhone"
      : /iPad/i.test(ua) ? "iPad"
        : /Windows NT/i.test(ua) ? "Windows"
          : /Mac OS X/i.test(ua) ? "macOS"
            : /Linux/i.test(ua) ? "Linux"
              : "Unknown device";
  const browser = /Edg\/([\d.]+)/.test(ua) ? "Edge"
    : /Chrome\/([\d.]+)/.test(ua) ? "Chrome"
      : /Firefox\/([\d.]+)/.test(ua) ? "Firefox"
        : /Safari\/([\d.]+)/.test(ua) ? "Safari"
          : "Unknown browser";
  return { device: os, browser, userAgent: ua.slice(0, 500) };
}

async function readEvents() {
  try {
    const parsed = JSON.parse(await fs.readFile(AUDIT_FILE, "utf8"));
    return Array.isArray(parsed?.events) ? parsed.events : [];
  } catch {
    return [];
  }
}

export async function recordAuditEvent(req, event) {
  const ip = getIp(req);
  const client = parseDevice(req.headers["user-agent"]);
  const entry = {
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    ip,
    country: getCountry(req, ip),
    email: event.email || req.user?.email || "",
    requestId: req.requestId || "",
    ...client,
    ...event,
  };

  writeChain = writeChain
    .catch(() => {})
    .then(async () => {
      const events = await readEvents();
      events.unshift(entry);
      await fs.mkdir(DATA_DIR, { recursive: true });
      const tempFile = `${AUDIT_FILE}.tmp`;
      await fs.writeFile(tempFile, JSON.stringify({ events: events.slice(0, MAX_EVENTS) }, null, 2), "utf8");
      await fs.rename(tempFile, AUDIT_FILE);
    });
  await writeChain.catch((error) => console.error("Unable to persist security activity", error));
  return entry;
}

export async function getSecurityActivity(limit = 200) {
  const events = (await readEvents()).slice(0, Math.max(1, Math.min(500, Number(limit) || 200)));
  const closedSessions = new Set(
    events.filter((event) => event.type === "logout" && event.sessionId).map((event) => event.sessionId)
  );
  const now = Math.floor(Date.now() / 1000);
  const activeSessions = events
    .filter((event) => event.type === "login_success" && event.sessionId && !closedSessions.has(event.sessionId) && Number(event.expiresAt) > now)
    .filter((event, index, list) => list.findIndex((item) => item.sessionId === event.sessionId) === index);

  return { events, activeSessions };
}

export function auditCompletedMutations(req, res, next) {
  const route = req.path;
  const type =
    route.startsWith("/upload") ? "upload"
      : route === "/delete" ? "delete"
        : route === "/transfer" ? "transfer"
          : route === "/folders" ? "folder_created"
            : route === "/files" && req.method === "PATCH" ? "rename"
              : "";

  if (!type) return next();

  res.on("finish", () => {
    if (res.statusCode < 200 || res.statusCode >= 400) return;
    const body = req.body && typeof req.body === "object" && !Buffer.isBuffer(req.body) ? req.body : {};
    const detail = type === "transfer"
      ? `${body.operation || "copy"} ${body.path || ""} to ${body.destinationRootId || ""}:${body.destinationPath || "/"}`
      : type === "upload"
        ? req.query.name || body.name || `${req.files?.length || 1} file(s)`
        : body.path || req.query.path || body.name || "";
    void recordAuditEvent(req, { type, outcome: "success", detail });
  });

  return next();
}
