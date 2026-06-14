const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });
const fs = require("fs");
const http = require("http");
const { Server } = require("socket.io");

const { verifyBrevoApi, validateOutboundMailConfig } = require("../services/emailService");
const { isDatabaseUrlConfigured, query } = require("../db/pool");
const connectDB = require("../config/db");
const { createDbState, startDbInit } = require("../config/dbBootstrap");
const { getSanitizedDatabaseInfo, formatSanitizedDatabaseLog } = require("../utils/dbSanitizedInfo");
const { logDeployIdentity, BUILD_ID, BUILD_COMMIT } = require("../utils/deployIdentity");
const realtimeHub = require("../services/realtimeHub");
const registerSocketHandlers = require("../sockets");
const { createApp } = require("./app");
const { registerProcessSafetyHandlers } = require("../utils/globalErrorHandler");

const { version: APP_VERSION } = require(path.join(__dirname, "..", "package.json"));

registerProcessSafetyHandlers();
const { validateProductionEnv } = require("../utils/validateProductionEnv");
validateProductionEnv();
logDeployIdentity();
global.__TRANSPAK_SERVER_STARTED_AT = new Date().toISOString();

const BIND_HOST = String(process.env.BIND_HOST || "0.0.0.0").trim() || "0.0.0.0";

/**
 * True when this process runs on a PaaS that assigns a single HTTP port (Render, Railway, Fly, Cloud Run).
 * Never try PORT+1 fallback here — the reverse proxy only routes to the assigned PORT.
 */
function isPaasPortLock() {
  if (String(process.env.FORCE_PLATFORM_PORT || "").toLowerCase() === "true") return true;
  const renderExt = String(process.env.RENDER_EXTERNAL_URL || "");
  if (renderExt.includes("onrender.com")) return true;
  if (String(process.env.RENDER || "").toLowerCase() === "true") return true;
  if (String(process.env.RAILWAY_ENVIRONMENT || "").trim()) return true;
  if (String(process.env.FLY_APP_NAME || "").trim()) return true;
  if (String(process.env.K_SERVICE || "").trim()) return true;
  return false;
}

const paasPortLock = isPaasPortLock();
const envPortRaw = String(process.env.PORT || "").trim();
const initialListenPort = paasPortLock
  ? Number(envPortRaw)
  : Number(envPortRaw || 5000) || 5000;

if (paasPortLock && (!Number.isFinite(initialListenPort) || initialListenPort <= 0)) {
  console.error(
    "[server] Invalid or missing PORT on this host. On Render, do not set PORT in Environment — the platform injects it."
  );
  process.exit(1);
}

const allowPortFallbackEnv = String(process.env.ALLOW_PORT_FALLBACK || "").toLowerCase();
const denyPortFallback = allowPortFallbackEnv === "false";
/** Laptop: try next ports if busy. Render: never (single assigned PORT only). */
const allowPortFallback =
  !paasPortLock &&
  !denyPortFallback &&
  (allowPortFallbackEnv === "true" ||
    process.env.NODE_ENV !== "production" ||
    !String(process.env.RENDER || "").trim());

const MAX_PORT_FALLBACK_ATTEMPTS = 25;

function ensureUploadsDir() {
  const uploadsDir = path.join(__dirname, "..", "uploads");
  if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
  return uploadsDir;
}

function getDevSeedAdminConfig() {
  if (process.env.NODE_ENV !== "development") return null;
  const email = String(process.env.DEV_ADMIN_EMAIL || "").trim().toLowerCase();
  const password = String(process.env.DEV_ADMIN_PASSWORD || "").trim();
  const phone = String(process.env.DEV_ADMIN_PHONE || "").trim();
  const cnic = String(process.env.DEV_ADMIN_CNIC || "").trim();
  if (!email || !password || !phone || !cnic) return null;
  return {
    name: String(process.env.DEV_ADMIN_NAME || "Admin User").trim() || "Admin User",
    email,
    password,
    phone,
    cnic
  };
}

async function seedAdminIfNeeded() {
  const cfg = getDevSeedAdminConfig();
  if (!cfg) return;
  try {
    const bcrypt = require("bcrypt");
    const userRepo = require("../repositories/userRepo");
    const passwordHash = await bcrypt.hash(cfg.password, 10);
    await userRepo.upsertDemoAdmin({
      email: cfg.email,
      passwordHash,
      roles: ["admin"],
      activeRole: "admin",
      phone: cfg.phone,
      cnicNumber: cfg.cnic,
      fullName: cfg.name
    });
    console.log(`Admin ensured: ${cfg.email}`);
  } catch (err) {
    console.warn("Seed admin skipped:", err.message);
  }
}

function formatDbError(err) {
  const code = err && err.code ? String(err.code) : "UNKNOWN";
  const msg = err && err.message ? String(err.message) : String(err);
  return { code, msg };
}

function isSupabaseCircuitBreaker(err) {
  const m = String(err?.message || "").toLowerCase();
  return m.includes("ecircuitbreaker") || m.includes("too many authentication");
}

function isPasswordAuthFailure(err) {
  const c = String(err?.code || "");
  if (c === "28P01") return true;
  const m = String(err?.message || "").toLowerCase();
  return m.includes("password authentication failed");
}

function isDnsNotFound(err) {
  const c = String(err?.code || "");
  if (c === "ENOTFOUND") return true;
  return String(err?.message || "").includes("ENOTFOUND");
}

async function start() {
  const dbState = createDbState();
  let dbNotReadyLogged = false;

  const dbInitPromise = startDbInit(dbState, async () => {
    try {
      await connectDB(dbState);
      if (dbState.ready) {
        await seedAdminIfNeeded();
      } else if (!dbNotReadyLogged) {
        dbNotReadyLogged = true;
        // eslint-disable-next-line no-console
        console.error("[db] DB NOT READY - RUN npm run db:migrate");
      }
    } catch (err) {
      dbState.ready = false;
      dbState.error = err;
      if (err.schema) dbState.schema = err.schema;
      if (!dbNotReadyLogged) {
        dbNotReadyLogged = true;
        const { code, msg } = formatDbError(err);
        // eslint-disable-next-line no-console
        console.error("[db] DB NOT READY - RUN npm run db:migrate");
        if (isDnsNotFound(err)) {
          // eslint-disable-next-line no-console
          console.error(
            "[db] DNS ENOTFOUND: use Supabase Session pooler (*.pooler.supabase.com) in DATABASE_URL."
          );
        } else if (isSupabaseCircuitBreaker(err) || isPasswordAuthFailure(err)) {
          // eslint-disable-next-line no-console
          console.error(
            "[db] Check DATABASE_URL credentials (Session pooler URI). No automatic retry — fix env and redeploy."
          );
        } else {
          // eslint-disable-next-line no-console
          console.error(`[db] ${code}: ${msg}`);
        }
      }
    }
  });

  const uploadsDir = ensureUploadsDir();
  const { app, socketCorsOrigin } = createApp({ uploadsDir, dbState });

  const httpServer = http.createServer(app);
  const io = new Server(httpServer, {
    cors: { origin: socketCorsOrigin, credentials: true },
    transports: ["websocket", "polling"],
    allowEIO3: true,
    pingTimeout: 60000,
    pingInterval: 25000
  });

  realtimeHub.setIO(io);
  registerSocketHandlers(io);

  if (process.env.NODE_ENV === "production" && !realtimeHub.isEngineReady()) {
    console.error("[server] Socket.io engine failed to initialize — aborting deploy boot");
    process.exit(1);
  }

  const mailPre = validateOutboundMailConfig();
  const mailLabel = mailPre.ok ? "enabled" : `disabled (${mailPre.reason})`;

  console.log("[server] boot", {
    NODE_ENV: process.env.NODE_ENV || "undefined",
    PORT: initialListenPort,
    BIND_HOST,
    paasPortLock,
    allowPortFallback,
    DATABASE_URL: isDatabaseUrlConfigured() ? "set" : "missing",
    database: formatSanitizedDatabaseLog(getSanitizedDatabaseInfo()),
    email: mailLabel,
    DB: dbState.ready ? "ready" : dbState.needsMigration ? "needs_migration" : "initializing",
    schema: dbState.schema?.ok ? "ok" : dbState.needsMigration ? "needs_migration" : "initializing"
  });

  let listenAttemptPort = initialListenPort;
  let listenAnnounced = false;

  function startListen(attempt) {
    httpServer.once("error", (err) => {
      if (err && err.code === "EADDRINUSE" && allowPortFallback && attempt < MAX_PORT_FALLBACK_ATTEMPTS) {
        listenAttemptPort += 1;
        console.warn(`[server] Port ${listenAttemptPort - 1} busy (EADDRINUSE); trying ${listenAttemptPort}...`);
        startListen(attempt + 1);
        return;
      }
      if (err && err.code === "EADDRINUSE") {
        console.error(`[server] Port ${listenAttemptPort} is already in use (EADDRINUSE).`);
        if (paasPortLock) {
          console.error(
            "[server] PORT is fixed by your hosting provider (Render/Railway/Fly, etc.); only one process may bind it."
          );
        } else if (!allowPortFallback) {
          console.error("[server] Stop the other process or set ALLOW_PORT_FALLBACK=true for local multi-instance dev.");
          console.error(
            `[server] Inspect listeners on :${initialListenPort} (e.g. netstat, ss, or Get-NetTCPConnection on Windows).`
          );
        } else {
          console.error(`[server] No free port after ${MAX_PORT_FALLBACK_ATTEMPTS} attempts from ${initialListenPort}.`);
        }
        process.exit(1);
        return;
      }
      console.error("Server listen failed:", err.message || err);
      process.exit(1);
    });

    httpServer.listen(listenAttemptPort, BIND_HOST, () => {
      if (listenAnnounced) return;
      listenAnnounced = true;
      if (!paasPortLock && listenAttemptPort !== initialListenPort) {
        console.warn(
          `[server] Bound on port ${listenAttemptPort} (first choice was ${initialListenPort}). Set transpak-frontend VITE_PROXY_TARGET=http://127.0.0.1:${listenAttemptPort} while using npm run dev.`
        );
      }
      console.log("[server] listening", {
        url: `http://${BIND_HOST}:${listenAttemptPort}`,
        boundPort: listenAttemptPort,
        NODE_ENV: process.env.NODE_ENV || "development",
        email: mailLabel,
        DB: dbState.ready ? "ready" : dbState.initSettled ? "unavailable" : "initializing",
        commit: BUILD_ID,
        commitFull: BUILD_COMMIT
      });
      console.log(
        `TransPak backend running - version ${APP_VERSION} - build ${BUILD_ID} - build OK - port ${listenAttemptPort}`
      );

      if (!paasPortLock) {
        try {
          const portFile = path.join(__dirname, "..", "..", ".dev-backend-port");
          fs.writeFileSync(portFile, String(listenAttemptPort), "utf8");
        } catch {
          /* non-fatal — discovery falls back to port probe */
        }
      }

      if (process.env.NODE_ENV === "production" && !realtimeHub.isEngineReady()) {
        console.error("[server] Socket.io not ready after listen — failing deploy health");
        process.exit(1);
      }

      const { startMarketplaceExpiryScheduler } = require("../utils/loadExpiry");
      startMarketplaceExpiryScheduler({ dbReady: () => dbState.ready });

      if (String(process.env.BREVO_VERIFY_ON_START || "").toLowerCase() === "true") {
        verifyBrevoApi().catch((e) => {
          console.error("[server] BREVO_VERIFY_ON_START (non-fatal):", e?.message || e);
        });
      }
    });
  }

  startListen(0);
}

module.exports = { start };
