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
import securityActivityRoutes from "./routes/security-activity.js";
import { AWS_REGION, CLIENT_ORIGINS, DATA_DIR, S3_BUCKET, STORAGE_DRIVER, STORAGE_ROOT } from "./config/env.js";
import { assertRequiredEnv } from "./config/env.js";
import { notFoundHandler, errorHandler } from "./middleware/error.js";
import { requireAdminPage } from "./middleware/auth.js";
import { noStore, rateLimit, requireTrustedOrigin, securityRequestId } from "./middleware/security.js";
import { ensureDirectory } from "./lib/files.js";
import { pruneExpiredTokens } from "./lib/sessions.js";
import { initializeStorageRoots } from "./lib/storage-roots.js";
import { auditCompletedMutations } from "./lib/audit.js";
import { initializeTransferJobs } from "./lib/transfer-jobs.js";

export async function createApp() {
  assertRequiredEnv();
  await ensureDirectory(DATA_DIR);
  await ensureDirectory(STORAGE_ROOT);
  await initializeStorageRoots();
  await pruneExpiredTokens();
  await initializeTransferJobs();

  const app = express();
  app.set("trust proxy", 1);
  app.disable("x-powered-by");
  const connectSources = ["'self'", ...CLIENT_ORIGINS];
  const s3Sources = [];
  if (STORAGE_DRIVER === "s3" && S3_BUCKET && AWS_REGION) {
    s3Sources.push(
      `https://${S3_BUCKET}.s3.${AWS_REGION}.amazonaws.com`,
      `https://${S3_BUCKET}.s3.amazonaws.com`,
      "https://*.s3.amazonaws.com"
    );
    connectSources.push(...s3Sources);
  }

  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: true,
        directives: {
          "default-src": ["'self'"],
          "base-uri": ["'self'"],
          "frame-ancestors": ["'none'"],
          "img-src": ["'self'", "data:", "blob:", ...s3Sources],
          "media-src": ["'self'", "blob:", ...s3Sources],
          "connect-src": connectSources,
          "script-src": ["'self'"],
          "style-src": ["'self'", "'unsafe-inline'"],
        },
      },
      crossOriginEmbedderPolicy: false,
      crossOriginResourcePolicy: { policy: "cross-origin" },
      referrerPolicy: { policy: "no-referrer" },
    })
  );
  app.use(securityRequestId);
  app.use(rateLimit({ windowMs: 15 * 60 * 1000, max: 1200 }));
  app.use(
    cors({
      exposedHeaders: ["Content-Disposition", "Upload-Offset"],
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
  app.use(requireTrustedOrigin);
  app.use(express.json({ limit: "10mb" }));
  app.use(express.urlencoded({ extended: true, limit: "10mb" }));
  app.use(auditCompletedMutations);

  app.get("/health", noStore, (req, res) => {
    res.json({
      ok: true,
    });
  });

  app.use(authRoutes);
  app.use(fileRoutes);
  app.use(systemRoutes);
  app.use(storageRoutes);
  app.use(securityActivityRoutes);

  const appFile = fileURLToPath(import.meta.url);
  const appDir = path.dirname(appFile);
  const clientDist = path.resolve(appDir, "..", "..", "client", "dist");
  try {
    await fs.access(clientDist);
    app.get(/^\/app(?:\/.*)?$/, requireAdminPage, noStore, (req, res) => {
      return res.sendFile(path.join(clientDist, "index.html"));
    });
    app.use(express.static(clientDist, { index: false, maxAge: "1h" }));
    app.get(/.*/, async (req, res) => {
      if (
        ["/preview", "/video", "/download", "/files", "/gallery", "/folders", "/upload", "/delete", "/items", "/transfer", "/storage-folders", "/global-search", "/storage", "/security-activity", "/system-status", "/cpu-status"].some(
          (prefix) => req.path === prefix || req.path.startsWith(`${prefix}/`)
        )
      ) {
        return res.status(404).json({ message: "API route not found" });
      }

      return res.sendFile(path.join(clientDist, "index.html"));
    });
  } catch {
    app.get(["/", "/login", /^\/app(?:\/.*)?$/], noStore, (req, res) => {
      return res.json({
        success: true,
        message: "Phone Cloud API is running"
      });
    });
  }

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
