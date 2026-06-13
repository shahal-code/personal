import path from "node:path";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import authRoutes from "./routes/auth.js";
import fileRoutes from "./routes/files.js";
import systemRoutes from "./routes/system.js";
import storageRoutes from "./routes/storage.js";
import { CLIENT_ORIGINS, DATA_DIR, STORAGE_ROOT } from "./config/env.js";
import { assertRequiredEnv } from "./config/env.js";
import { notFoundHandler, errorHandler } from "./middleware/error.js";
import { ensureDirectory } from "./lib/files.js";
import { pruneExpiredTokens } from "./lib/sessions.js";

export async function createApp() {
  assertRequiredEnv();
  await ensureDirectory(DATA_DIR);
  await ensureDirectory(STORAGE_ROOT);
  await pruneExpiredTokens();

  const app = express();
  app.set("trust proxy", 1);

  app.use(
    helmet({
      contentSecurityPolicy: false,
      crossOriginResourcePolicy: { policy: "cross-origin" },
    })
  );
  app.use(
    cors({
      exposedHeaders: ["Content-Disposition"],
      origin(origin, callback) {
        if (!origin) {
          return callback(null, true);
        }

        if (CLIENT_ORIGINS.includes(origin)) {
          return callback(null, true);
        }

        return callback(new Error("Origin not allowed by CORS"));
      },
      credentials: true,
    })
  );
  app.use(express.json({ limit: "10mb" }));
  app.use(express.urlencoded({ extended: true, limit: "10mb" }));

  app.get("/health", (req, res) => {
    res.json({
      ok: true,
      storageRoot: STORAGE_ROOT,
    });
  });

  app.use(authRoutes);
  app.use(fileRoutes);
  app.use(systemRoutes);
  app.use(storageRoutes);

  const appFile = fileURLToPath(import.meta.url);
  const appDir = path.dirname(appFile);
  const clientDist = path.resolve(appDir, "..", "..", "client", "dist");
  try {
    await fs.access(clientDist);
    app.use(express.static(clientDist, { index: false, maxAge: "1h" }));
    app.get(/.*/, async (req, res) => {
      if (
        ["/preview", "/video", "/download", "/files", "/folders", "/upload", "/delete", "/items", "/storage", "/system-status"].some(
          (prefix) => req.path === prefix || req.path.startsWith(`${prefix}/`)
        )
      ) {
        return res.status(404).json({ message: "API route not found" });
      }

      return res.sendFile(path.join(clientDist, "index.html"));
    });
  } catch {
    // Client build not present in dev.
  }

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
