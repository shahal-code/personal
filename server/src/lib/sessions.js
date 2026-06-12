import fs from "node:fs/promises";
import path from "node:path";
import { DATA_DIR } from "../config/env.js";

const SESSION_FILE = path.join(DATA_DIR, "revoked-jwts.json");

let loaded = false;
let revoked = new Map();

async function ensureStore() {
  await fs.mkdir(DATA_DIR, { recursive: true });

  if (loaded) {
    return;
  }

  try {
    const raw = await fs.readFile(SESSION_FILE, "utf8");
    const parsed = JSON.parse(raw);
    const entries = Array.isArray(parsed?.revoked) ? parsed.revoked : [];
    revoked = new Map(
      entries
        .filter((entry) => entry && typeof entry.jti === "string" && Number(entry.exp) > 0)
        .map((entry) => [entry.jti, Number(entry.exp)])
    );
  } catch {
    revoked = new Map();
  }

  loaded = true;
}

async function persist() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const payload = {
    revoked: [...revoked.entries()].map(([jti, exp]) => ({ jti, exp })),
  };
  const tempFile = `${SESSION_FILE}.tmp`;
  await fs.writeFile(tempFile, JSON.stringify(payload, null, 2), "utf8");
  await fs.rename(tempFile, SESSION_FILE);
}

export async function revokeToken(jti, exp) {
  if (!jti || !exp) {
    return;
  }

  await ensureStore();
  revoked.set(jti, exp);
  await persist();
}

export async function isTokenRevoked(jti) {
  await ensureStore();
  return revoked.has(jti);
}

export async function pruneExpiredTokens(now = Math.floor(Date.now() / 1000)) {
  await ensureStore();
  let changed = false;

  for (const [jti, exp] of revoked.entries()) {
    if (exp <= now) {
      revoked.delete(jti);
      changed = true;
    }
  }

  if (changed) {
    await persist();
  }
}
