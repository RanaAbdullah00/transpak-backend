const express = require("express");
const cors = require("cors");
const helmet = require("helmet");

const { isDatabaseUrlConfigured } = require("../db/pool");

const { globalApiLimiter } = require("../middleware/apiRateLimit");

const authRoutes = require("../routes/authRoutes");
const profileRoutes = require("../routes/profileRoutes");
const shipmentRoutes = require("../routes/shipmentRoutes");
const loadRoutes = require("../routes/loadRoutes");
const bidRoutes = require("../routes/bidRoutes");
const adminRoutes = require("../routes/adminRoutes");
const reviewRoutes = require("../routes/reviewRoutes");
const notificationRoutes = require("../routes/notificationRoutes");
const chatRoutes = require("../routes/chatRoutes");
const truckRoutes = require("../routes/truckRoutes");
const demoVideoRoutes = require("../routes/demoVideoRoutes");
const disputeRoutes = require("../routes/disputeRoutes");
const translationRoutes = require("../routes/translationRoutes");
const uploadRoutes = require("../routes/uploadRoutes");

function parseCorsOriginsFromEnv() {
  const raw = [
    process.env.CORS_ORIGIN,
    process.env.FRONTEND_URL,
    process.env.VITE_APP_ORIGIN,
    process.env.CORS_EXTRA_ORIGINS
  ]
    .filter(Boolean)
    .join(",");
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((o) => {
      try {
        return new URL(o).origin;
      } catch {
        return o.replace(/\/$/, "");
      }
    });
}

/** Cloudflare Pages preview/production hosts (hash changes per deployment). */
function isCloudflarePagesOrigin(origin) {
  try {
    const { protocol, hostname } = new URL(origin);
    if (protocol !== "https:") return false;
    return hostname.endsWith(".pages.dev") || hostname.endsWith(".cloudflarepages.app");
  } catch {
    return false;
  }
}

function isAllowedCorsOrigin(origin, allowedOriginsList, isProd) {
  if (!origin) return true;
  if (allowedOriginsList.includes(origin)) return true;
  if (isCloudflarePagesOrigin(origin)) return true;
  if (!isProd && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return true;
  return false;
}

function createCorsOriginCallback(allowedOriginsList, isProd) {
  return (origin, callback) => {
    if (isAllowedCorsOrigin(origin, allowedOriginsList, isProd)) {
      return callback(null, true);
    }
    // eslint-disable-next-line no-console
    console.warn("[cors] blocked origin:", origin || "(none)");
    return callback(null, false);
  };
}

function createApp({ uploadsDir, dbState = { ready: true, error: null } }) {
  const app = express();

  app.set("trust proxy", 1);

  app.use(
    helmet({
      crossOriginResourcePolicy: { policy: "cross-origin" }
    })
  );
  app.use(express.json({ limit: "10kb" }));
  app.use(express.urlencoded({ extended: false }));

  if (uploadsDir) {
    app.use("/uploads", express.static(uploadsDir, { fallthrough: false }));
  }

  const isProd = process.env.NODE_ENV === "production";
  const envOrigins = parseCorsOriginsFromEnv();
  const defaultLocalOrigins = isProd
    ? []
    : [
        "http://localhost:5173",
        "http://localhost:5174",
        "http://localhost:5175",
        "http://127.0.0.1:5173",
        "http://127.0.0.1:5174",
        "http://127.0.0.1:5175"
      ];
  const allowedOriginsList = [...new Set([...defaultLocalOrigins, ...envOrigins])];
  const allowReflectAnyOrigin = !isProd && allowedOriginsList.length === 0;

  if (isProd && allowedOriginsList.length === 0) {
    console.warn(
      "[cors] NODE_ENV=production but CORS_ORIGIN / FRONTEND_URL / VITE_APP_ORIGIN / CORS_EXTRA_ORIGINS are empty — browser clients will be rejected unless Origin is absent."
    );
  }

  const corsOriginCheck =
    allowReflectAnyOrigin && !isProd
      ? (origin, callback) => callback(null, true)
      : createCorsOriginCallback(allowedOriginsList, isProd);

  app.use(
    cors({
      origin: corsOriginCheck,
      credentials: true,
      methods: ["GET", "HEAD", "PUT", "PATCH", "POST", "DELETE", "OPTIONS"],
      allowedHeaders: ["Content-Type", "Authorization", "X-Requested-With"]
    })
  );

  app.get("/", (req, res) => {
    res.status(200).json({
      ok: true,
      service: "transpak-backend",
      health: "/health",
      apiHealth: "/api/health"
    });
  });

  app.get("/health", (req, res) => {
    res.status(200).json({
      ok: true,
      uptime: process.uptime(),
      db: dbState?.ready ? "ready" : "unavailable",
      databaseUrlConfigured: isDatabaseUrlConfigured()
    });
  });

  app.use("/api", globalApiLimiter);

  app.get("/api/health", (req, res) =>
    res.json({
      success: true,
      message: "ok",
      data: { status: "ok", db: dbState?.ready ? "ready" : "unavailable" }
    })
  );

  app.use("/api", (req, res, next) => {
    if (req.path === "/health") return next();
    if (dbState?.ready) return next();
    const lastErr = dbState?.error;
    const isProd = process.env.NODE_ENV === "production";
    if (!isProd && lastErr) {
      // eslint-disable-next-line no-console
      console.error("[db] request blocked (DB not ready):", req.method, req.originalUrl, lastErr?.message || lastErr);
    }
    return res.status(503).json({
      success: false,
      message: "Database unavailable. Set DATABASE_URL on Render (Supabase Session pooler URI) and run: npm run db:migrate:otp",
      code: "DATABASE_UNAVAILABLE",
      data: {
        databaseUrlConfigured: isDatabaseUrlConfigured(),
        hint: "transpak-backend: npm run db:migrate:otp",
        ...(isProd ? {} : { lastError: lastErr?.message || String(lastErr || "") })
      }
    });
  });

  app.use("/api/auth", authRoutes);
  app.use("/api/profile", profileRoutes);
  app.use("/api/shipments", shipmentRoutes);
  app.use("/api/loads", loadRoutes);
  app.use("/api/bids", bidRoutes);
  app.use("/api/admin", adminRoutes);
  app.use("/api/reviews", reviewRoutes);
  app.use("/api/notifications", notificationRoutes);
  app.use("/api/chat", chatRoutes);
  app.use("/api/trucks", truckRoutes);
  app.use("/api/demo-video", demoVideoRoutes);
  app.use("/api/disputes", disputeRoutes);
  app.use("/api/translations", translationRoutes);
  app.use("/api/upload", uploadRoutes);

  if (process.env.ENABLE_EXAMPLE_UPLOAD === "true") {
    const exampleUploadRoutes = require("../routes/exampleUploadRoutes");
    app.use("/api/example-upload", exampleUploadRoutes);
  }

  app.use((req, res) => {
    // eslint-disable-next-line no-console
    console.warn("[api] 404", req.method, req.originalUrl);
    res.status(404).json({
      success: false,
      message: "Route not found",
      code: "NOT_FOUND",
      data: { method: req.method, path: req.originalUrl }
    });
  });

  app.use((err, req, res, next) => {
    const status = err.statusCode || 500;
    const isProdEnv = process.env.NODE_ENV === "production";
    const safeMessage = isProdEnv && status >= 500 ? "Server error" : err.message || "Server error";
    res.status(status).json({ success: false, message: safeMessage, data: null });
  });

  const socketCorsOrigin =
    allowReflectAnyOrigin && !isProd ? true : createCorsOriginCallback(allowedOriginsList, isProd);

  return { app, socketCorsOrigin };
}

module.exports = { createApp };
