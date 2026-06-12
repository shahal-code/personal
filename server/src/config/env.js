import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

dotenv.config();

const currentFile = fileURLToPath(import.meta.url);
const currentDir = path.dirname(currentFile);

export const SERVER_ROOT = path.resolve(currentDir, "..", "..");
export const DATA_DIR = path.join(SERVER_ROOT, "data");
export const TEMP_DIR = path.join(DATA_DIR, "tmp");

export const STORAGE_ROOT = path.resolve(
  process.env.STORAGE_ROOT || path.join(SERVER_ROOT, "storage")
);

export const ADMIN_EMAIL = process.env.ADMIN_EMAIL || "";
export const ADMIN_PASSWORD_HASH = process.env.ADMIN_PASSWORD_HASH || "";
export const JWT_SECRET = process.env.JWT_SECRET || "";

export const PORT = Number(process.env.PORT || 3000);
export const CLIENT_ORIGINS = (process.env.CLIENT_ORIGINS ||
  "http://localhost:5173,http://127.0.0.1:5173")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

export const COOKIE_NAME = "phone_cloud_token";
export const TOKEN_TTL = process.env.JWT_EXPIRES_IN || "12h";
export const COOKIE_SECURE = process.env.COOKIE_SECURE === "true";
export const STORAGE_TOTAL_BYTES = Number(process.env.TOTAL_STORAGE_BYTES || 0);

export function assertRequiredEnv() {
  const missing = [];

  if (!ADMIN_EMAIL) missing.push("ADMIN_EMAIL");
  if (!ADMIN_PASSWORD_HASH) missing.push("ADMIN_PASSWORD_HASH");
  if (!JWT_SECRET) missing.push("JWT_SECRET");

  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(", ")}`);
  }
}
