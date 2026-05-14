const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });
const fs = require("fs");
const http = require("http");
const { Server } = require("socket.io");

const { verifySmtpConnection, validateOutboundMailConfig } = require("../services/emailService");
const { isDatabaseUrlConfigured } = require("../db/pool");
const connectDB = require("../config/db");
const realtimeHub = require("../services/realtimeHub");
const registerSocketHandlers = require("../sockets");
const { createApp } = require("./app");

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

const DB_RETRY_BASE_MS = Number(process.env.DB_RETRY_BASE_MS || 5000);
const DB_RETRY_MAX_QUICK = Number(process.env.DB_RETRY_MAX_QUICK || 8);
const DB_RETRY_SLOW_MS = Number(process.env.DB_RETRY_SLOW_MS || 120000);
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

const TRANSPAK_DEMO_ADMIN_EMAIL = "mrabdullah0456@gmail.com";
const TRANSPAK_DEMO_ADMIN_NAME = "Demo Admin";
const TRANSPAK_DEMO_ADMIN_PASSWORD = "12345678";

async function ensureTranspakDemoAdmin() {
  const bcrypt = require("bcrypt");
  const userRepo = require("../repositories/userRepo");
  const email = TRANSPAK_DEMO_ADMIN_EMAIL.trim().toLowerCase();
  const phone = String(process.env.TRANSPAK_DEMO_ADMIN_PHONE || "+923001234568").trim();
  const cnic = String(process.env.TRANSPAK_DEMO_ADMIN_CNIC || "00000-0000000-0").trim();

  try {
    const passwordHash = await bcrypt.hash(TRANSPAK_DEMO_ADMIN_PASSWORD, 10);
    await userRepo.upsertDemoAdmin({
      email,
      passwordHash,
      roles: ["admin", "shipper", "carrier"],
      activeRole: "admin",
      phone,
      cnicNumber: cnic,
      fullName: TRANSPAK_DEMO_ADMIN_NAME
    });
    console.log("Admin user ensured");
  } catch (err) {
    console.error("TransPak: ensureTranspakDemoAdmin failed:", err.message || err);
  }
}

function formatDbError(err) {
  const code = err && err.code ? String(err.code) : "UNKNOWN";
  const msg = err && err.message ? String(err.message) : String(err);
  return { code, msg };
}

async function start() {
  const dbState = { ready: false, error: null };
  let quickAttempts = 0;

  async function connectWithRetry() {
    try {
      await connectDB();
      dbState.ready = true;
      dbState.error = null;
      quickAttempts = 0;
      console.log("[db] connected");
      await seedAdminIfNeeded();
      await ensureTranspakDemoAdmin();
    } catch (err) {
      dbState.ready = false;
      dbState.error = err;
      const { code, msg } = formatDbError(err);
      const isProd = process.env.NODE_ENV === "production";
      const safeDetail = isProd ? `${code}` : `${code}: ${msg}`;
      quickAttempts += 1;
      if (quickAttempts <= DB_RETRY_MAX_QUICK) {
        const backoff = Math.min(DB_RETRY_BASE_MS * 2 ** Math.min(quickAttempts - 1, 5), 60000);
        console.error(`[db] connection failed (quick retry ${quickAttempts}/${DB_RETRY_MAX_QUICK}) ${safeDetail}; next in ${backoff}ms`);
        setTimeout(connectWithRetry, backoff);
        return;
      }
      console.error(`[db] quick retries exhausted; backing off ${DB_RETRY_SLOW_MS}ms — ${safeDetail}`);
      quickAttempts = 0;
      setTimeout(connectWithRetry, DB_RETRY_SLOW_MS);
    }
  }

  connectWithRetry();

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

  const smtpPre = validateOutboundMailConfig();
  const smtpLabel = smtpPre.ok ? "enabled" : `disabled (${smtpPre.reason})`;

  console.log("[server] boot", {
    NODE_ENV: process.env.NODE_ENV || "undefined",
    PORT: initialListenPort,
    BIND_HOST,
    paasPortLock,
    allowPortFallback,
    DATABASE_URL: isDatabaseUrlConfigured() ? "set" : "missing",
    SMTP: smtpLabel,
    DB: dbState.ready ? "ready" : "pending_first_connection"
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
        SMTP: smtpLabel,
        DB: dbState.ready ? "ready" : "connecting"
      });
      console.log(`TransPak backend (HTTP + Socket.io) on port ${listenAttemptPort}`);

      if (String(process.env.SMTP_VERIFY_ON_START || "").toLowerCase() === "true") {
        verifySmtpConnection().catch((e) => {
          console.error("[server] SMTP_VERIFY_ON_START (non-fatal):", e?.message || e);
        });
      }
    });
  }

  startListen(0);
}

module.exports = { start };
