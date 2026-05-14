const express = require("express");
const cors = require("cors");
const helmet = require("helmet");

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

function createApp({ uploadsDir, dbState = { ready: true, error: null } }) {
  const app = express();

  // If you deploy behind a proxy (Render/Heroku/Nginx), enable this so rate limiting & IPs work correctly.
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

  const defaultDevOrigins = [
    "http://localhost:5173",
    "http://localhost:5174",
    "http://127.0.0.1:5173",
    "http://127.0.0.1:5174"
  ];
  const envOrigins = (process.env.CORS_ORIGIN || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const allowedOrigins = envOrigins.length > 0 ? [...new Set([...defaultDevOrigins, ...envOrigins])] : null;

  app.use(
    cors({
      origin: (origin, callback) => {
        if (!origin) return callback(null, true);
        if (!allowedOrigins) return callback(null, true);
        if (allowedOrigins.includes(origin)) return callback(null, true);
        return callback(null, false);
      },
      credentials: true
    })
  );

  app.use("/api", globalApiLimiter);

  app.get("/api/health", (req, res) =>
    res.json({
      success: true,
      message: "ok",
      data: { status: "ok", db: dbState?.ready ? "ready" : "unavailable" }
    })
  );

  // Degraded-mode gate: if DB is down, return a consistent 503 instead of connection resets.
  app.use("/api", (req, res, next) => {
    if (req.path === "/health") return next();
    if (dbState?.ready) return next();
    return res.status(503).json({
      success: false,
      message: "Database unavailable. Start the backend database and retry.",
      data: null
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
    res.status(404).json({ success: false, message: "Route not found", data: null });
  });

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const status = err.statusCode || 500;
    const isProd = process.env.NODE_ENV === "production";
    const safeMessage = isProd && status >= 500 ? "Server error" : err.message || "Server error";
    res.status(status).json({ success: false, message: safeMessage, data: null });
  });

  return { app, socketCorsOrigin: allowedOrigins === null ? true : allowedOrigins };
}

module.exports = { createApp };

