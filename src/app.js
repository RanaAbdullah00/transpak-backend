const path = require("path");
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");

const { version: APP_VERSION } = require(path.join(__dirname, "..", "package.json"));
const { BUILD_ID, BUILD_COMMIT, getDeployIdentity, getDeploymentStatus } = require("../utils/deployIdentity");

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
      allowedHeaders: [
        "Content-Type",
        "Authorization",
        "X-Requested-With",
        "X-TransPak-Workspace"
      ],
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

  app.get("/health", async (req, res) => {
    const { resolveDatabaseHealth } = require("../utils/healthStatus");
    const dbHealth = await resolveDatabaseHealth(dbState, process.uptime());
    res.status(200).json({
      ok: true,
      service: "transpak-backend",
      version: APP_VERSION,
      build: BUILD_ID,
      commit: BUILD_ID,
      uptime: process.uptime(),
      db: dbHealth.db,
      databaseUrlConfigured: isDatabaseUrlConfigured(),
      schema: dbHealth.schema
    });
  });

  app.use("/api", globalApiLimiter);

  app.get("/api/health", async (req, res) => {
    const { resolveDatabaseHealth } = require("../utils/healthStatus");
    const { getOpsSnapshot } = require("../utils/opsTelemetry");
    const realtimeHub = require("../services/realtimeHub");
    const uptime = process.uptime();
    const dbHealth = await resolveDatabaseHealth(dbState, uptime);

    if (!dbHealth.booting) {
      if (dbHealth.dbReady && !dbState.ready) {
        dbState.ready = true;
        dbState.schema = dbHealth.schema;
        dbState.error = null;
      } else if (dbHealth.schema) {
        dbState.schema = dbHealth.schema;
      }
    }

    const deploy = { ...getDeployIdentity(), migrationSafe: true };
    const schema = dbHealth.schema || {
      ok: false,
      version: "023",
      schemaVersion: "023",
      missing: [],
      requiredMigration: null,
      message: null,
      booting: Boolean(dbHealth.booting)
    };
    const deploymentStatus = dbHealth.booting
      ? "OK"
      : getDeploymentStatus({
          dbReady: dbHealth.db === "ready",
          schemaOk: schema.ok === true
        });

    return res.json({
      success: true,
      message: "ok",
      data: {
        status: dbHealth.booting
          ? "starting"
          : dbHealth.dbReady
            ? "ok"
            : dbHealth.db === "connecting"
              ? "starting"
              : "degraded",
        healthPhase: dbHealth.healthPhase || (dbHealth.booting ? "booting" : "ready"),
        version: APP_VERSION,
        build: BUILD_ID,
        commit: BUILD_ID,
        commitFull: BUILD_COMMIT,
        uptime,
        db: dbHealth.db || "unavailable",
        dbPing: dbHealth.dbPing || "skipped",
        schema: {
          ok: Boolean(schema.ok),
          version: schema.version || schema.schemaVersion || "023",
          schemaVersion: schema.schemaVersion || schema.version || "023",
          missing: Array.isArray(schema.missing) ? schema.missing : [],
          requiredMigration: schema.requiredMigration || null,
          message: schema.message || null,
          booting: Boolean(schema.booting)
        },
        schemaVersion: dbHealth.schemaVersion || schema.version || "023",
        migrationRequired: dbHealth.migrationRequired,
        deploymentStatus,
        deploy,
        sockets: realtimeHub.getConnectedSocketCount(),
        ops: getOpsSnapshot({ includeRecent: false })
      }
    });
  });

  const { rejectForbiddenBodyFields } = require("../middleware/rejectForbiddenBodyFields");
  app.use("/api", rejectForbiddenBodyFields);

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
      message: isProd
        ? "Service temporarily unavailable"
        : "Database unavailable. Set DATABASE_URL on Render (Supabase Session pooler URI) and run: npm run db:migrate",
      code: "DATABASE_UNAVAILABLE",
      data: isProd
        ? null
        : {
            databaseUrlConfigured: isDatabaseUrlConfigured(),
            hint: "transpak-backend: npm run db:migrate",
            lastError: lastErr?.message || String(lastErr || "")
          }
    });
  });

  app.use("/api/public", require("../routes/publicRoutes"));
  app.use("/api/auth", authRoutes);
  const { forbidAdminOnlyCommercial } = require("../middleware/forbidAdminOnlyCommercial");
  app.use("/api/profile", forbidAdminOnlyCommercial, profileRoutes);
  app.use("/api/shipments", forbidAdminOnlyCommercial, shipmentRoutes);
  app.use("/api/loads", forbidAdminOnlyCommercial, loadRoutes);
  app.use("/api/bids", forbidAdminOnlyCommercial, bidRoutes);
  app.use("/api/fare", forbidAdminOnlyCommercial, require("../routes/fareRoutes"));
  app.use("/api/maps", forbidAdminOnlyCommercial, require("../routes/mapRoutes"));
  app.use("/api/carrier-space", forbidAdminOnlyCommercial, require("../routes/carrierSpaceRoutes"));
  app.use("/api/carrier-space", forbidAdminOnlyCommercial, require("../routes/spaceBookingRoutes"));
  app.use("/api/operations", forbidAdminOnlyCommercial, require("../routes/operationsRoutes"));
  app.use("/api/admin", adminRoutes);
  app.use("/api/reviews", forbidAdminOnlyCommercial, reviewRoutes);
  app.use("/api/ratings", forbidAdminOnlyCommercial, reviewRoutes);
  app.use("/api/notifications", notificationRoutes);
  app.use("/api/feedback", forbidAdminOnlyCommercial, require("../routes/feedbackRoutes"));
  app.use("/api/chat", forbidAdminOnlyCommercial, chatRoutes);
  app.use("/api/trucks", forbidAdminOnlyCommercial, truckRoutes);
  app.use("/api/demo-video", demoVideoRoutes);
  app.use("/api/disputes", forbidAdminOnlyCommercial, disputeRoutes);
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
      message: "Not found",
      code: "NOT_FOUND",
      data: null
    });
  });

  app.use(globalErrorMiddleware);

  const socketCorsOrigin =
    allowReflectAnyOrigin && !isProd ? true : createCorsOriginCallback(allowedOriginsList);

  return { app, socketCorsOrigin };
}

module.exports = { createApp };
