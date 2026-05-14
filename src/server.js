const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });
const fs = require("fs");
const http = require("http");
const { Server } = require("socket.io");

const { verifySmtpConnection } = require("../services/emailService");
const connectDB = require("../config/db");
const realtimeHub = require("../services/realtimeHub");
const registerSocketHandlers = require("../sockets");
const { createApp } = require("./app");

const PORT = process.env.PORT || 5000;
const DB_RETRY_BASE_MS = Number(process.env.DB_RETRY_BASE_MS || 5000);
const DB_RETRY_MAX_QUICK = Number(process.env.DB_RETRY_MAX_QUICK || 8);
const DB_RETRY_SLOW_MS = Number(process.env.DB_RETRY_SLOW_MS || 120000);

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
    // eslint-disable-next-line no-console
    console.log(`Admin ensured: ${cfg.email}`);
  } catch (err) {
    // eslint-disable-next-line no-console
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
    // eslint-disable-next-line no-console
    console.log("Admin user ensured");
  } catch (err) {
    // eslint-disable-next-line no-console
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
      // eslint-disable-next-line no-console
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
        // eslint-disable-next-line no-console
        console.error(`[db] connection failed (quick retry ${quickAttempts}/${DB_RETRY_MAX_QUICK}) ${safeDetail}; next in ${backoff}ms`);
        setTimeout(connectWithRetry, backoff);
        return;
      }
      // eslint-disable-next-line no-console
      console.error(`[db] quick retries exhausted; backing off ${DB_RETRY_SLOW_MS}ms — ${safeDetail}`);
      quickAttempts = 0;
      setTimeout(connectWithRetry, DB_RETRY_SLOW_MS);
    }
  }

  // Start DB connection loop (do not block server boot).
  connectWithRetry();

  const uploadsDir = ensureUploadsDir();
  const { app, socketCorsOrigin } = createApp({ uploadsDir, dbState });

  const basePort = Number(PORT) || 5000;
  const maxAttempts = 20;
  const allowPortFallback = String(process.env.ALLOW_PORT_FALLBACK || "").toLowerCase() === "true";

  const tryListen = (port, attempt = 0) => {
    const httpServer = http.createServer(app);
    const io = new Server(httpServer, {
      cors: { origin: socketCorsOrigin, credentials: true }
    });

    realtimeHub.setIO(io);
    registerSocketHandlers(io);

    httpServer.listen(port, () => {
      // eslint-disable-next-line no-console
      console.log(`TransPak backend (HTTP + Socket.io) on port ${port}`);
      if (String(process.env.SMTP_VERIFY_ON_START || "").toLowerCase() === "true") {
        verifySmtpConnection().catch((e) => {
          // eslint-disable-next-line no-console
          console.error("[server] SMTP_VERIFY_ON_START:", e?.message || e);
        });
      }
    });

    httpServer.on("error", (err) => {
      if (err && err.code === "EADDRINUSE") {
        if (allowPortFallback && attempt < maxAttempts) {
          // eslint-disable-next-line no-console
          console.warn(`Port ${port} already in use. Trying ${port + 1}...`);
          try {
            io.close();
            httpServer.close();
          } catch {
            // ignore
          }
          return tryListen(port + 1, attempt + 1);
        }
        // eslint-disable-next-line no-console
        console.error(`[server] Port ${port} is already in use (EADDRINUSE).`);
        if (allowPortFallback && attempt >= maxAttempts) {
          // eslint-disable-next-line no-console
          console.error(`[server] No free port found after ${maxAttempts} attempts from ${basePort}.`);
        }
        if (!allowPortFallback) {
          // eslint-disable-next-line no-console
          console.error(
            "[server] Another process is bound to this port (often a duplicate `npm run dev`). Stop it, or set ALLOW_PORT_FALLBACK=true and VITE_PROXY_TARGET to the same port."
          );
          // eslint-disable-next-line no-console
          console.error(`[server] Windows: netstat -ano | findstr :${basePort}`);
        }
        process.exit(1);
      }
      // eslint-disable-next-line no-console
      console.error("Server listen failed:", err.message || err);
      process.exit(1);
    });

    return httpServer;
  };

  tryListen(basePort);
}

module.exports = { start };

