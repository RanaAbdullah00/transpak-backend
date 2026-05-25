const path = require("path");
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");

const { version: APP_VERSION } = require(path.join(__dirname, "..", "package.json"));
const BUILD_ID = String(process.env.RENDER_GIT_COMMIT || process.env.BUILD_ID || "local").slice(0, 12);

const { isDatabaseUrlConfigured, query } = require("../db/pool");
const { isHostedOnPaas } = require("../utils/paasRuntime");

const { globalApiLimiter } = require("../middleware/apiRateLimit");
const { requestLogger } = require("../middleware/requestLogger");
const { deployHeaders } = require("../middleware/deployHeaders");
const { globalErrorMiddleware } = require("../utils/globalErrorHandler");

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

function isAllowedCorsOrigin(origin, allowedOriginsList) {
  if (!origin) return true;
  if (allowedOriginsList.includes(origin)) return true;
  // Local laptop dev: any Vite port when API is not running on Render/Railway/Fly.
  if (!isHostedOnPaas() && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin)) {
    return true;
  }
  return false;
}

function createCorsOriginCallback(allowedOriginsList) {
  return (origin, callback) => {
    if (isAllowedCorsOrigin(origin, allowedOriginsList)) {
      return callback(null, true);
    }
    // eslint-disable-next-line no-console
    console.warn("[cors] blocked origin:", origin || "(none)", "allowed:", allowedOriginsList.length);
    return callback(null, false);
  };
}

function createApp({ uploadsDir, dbState = { ready: true, error: null } }) {
  const app = express();

  app.set("trust proxy", 1);
  app.use(deployHeaders);
  app.use(requestLogger);

  app.use(
    helmet({
      crossOriginResourcePolicy: { policy: "cross-origin" }
    })
  );
  const jsonLimit = process.env.JSON_BODY_LIMIT || "5mb";
  app.use(express.json({ limit: jsonLimit }));
  app.use(express.urlencoded({ extended: false }));

  if (uploadsDir) {
    app.use("/uploads", express.static(uploadsDir, { fallthrough: false }));
  }

  const isProd = process.env.NODE_ENV === "production";
  const envOrigins = parseCorsOriginsFromEnv();
  const localDevOrigins = [
    "http://localhost:5173",
    "http://localhost:5174",
    "http://localhost:5175",
    "http://localhost:5176",
    "http://127.0.0.1:5173",
    "http://127.0.0.1:5174",
    "http://127.0.0.1:5175",
    "http://127.0.0.1:5176"
  ];
  const defaultLocalOrigins = isProd && isHostedOnPaas() ? [] : localDevOrigins;
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
      : createCorsOriginCallback(allowedOriginsList);

  app.use(
    cors({
      origin: corsOriginCheck,
      credentials: true,
      methods: ["GET", "HEAD", "PUT", "PATCH", "POST", "DELETE", "OPTIONS"],
      allowedHeaders: ["Content-Type", "Authorization", "X-Requested-With"],
      exposedHeaders: ["X-TransPak-Version", "X-TransPak-Build"]
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
      service: "transpak-backend",
      version: APP_VERSION,
      build: BUILD_ID,
      commit: BUILD_ID,
      uptime: process.uptime(),
      db: dbState?.ready ? "ready" : "unavailable",
      databaseUrlConfigured: isDatabaseUrlConfigured()
    });
  });

  app.use("/api", globalApiLimiter);

  app.get("/api/health", async (req, res) => {
    let dbPing = "skipped";
    if (dbState?.ready) {
      try {
        await query("SELECT 1");
        dbPing = "ok";
      } catch (pingErr) {
        dbPing = "error";
        if (process.env.NODE_ENV !== "production") {
          // eslint-disable-next-line no-console
          console.error("[health] db ping failed:", pingErr?.message || pingErr);
        }
      }
    }
    return res.json({
      success: true,
      message: "ok",
      data: {
        status: "ok",
        version: APP_VERSION,
        build: BUILD_ID,
        commit: BUILD_ID,
        uptime: process.uptime(),
        db: dbState?.ready ? "ready" : "unavailable",
        dbPing
      }
    });
  });

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

  app.use("/api/public", require("../routes/publicRoutes"));
  app.use("/api/auth", authRoutes);
  app.use("/api/profile", profileRoutes);
  app.use("/api/shipments", shipmentRoutes);
  app.use("/api/loads", loadRoutes);
  app.use("/api/bids", bidRoutes);
  app.use("/api/fare", require("../routes/fareRoutes"));
  app.use("/api/maps", require("../routes/mapRoutes"));
  app.use("/api/carrier-space", require("../routes/carrierSpaceRoutes"));
  app.use("/api/carrier-space", require("../routes/spaceBookingRoutes"));
  app.use("/api/operations", require("../routes/operationsRoutes"));
  app.use("/api/admin", adminRoutes);
  app.use("/api/reviews", reviewRoutes);
  app.use("/api/ratings", reviewRoutes);
  app.use("/api/notifications", notificationRoutes);
  app.use("/api/feedback", require("../routes/feedbackRoutes"));
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

  app.use(globalErrorMiddleware);

  const socketCorsOrigin =
    allowReflectAnyOrigin && !isProd ? true : createCorsOriginCallback(allowedOriginsList);

  return { app, socketCorsOrigin };
}

module.exports = { createApp };
