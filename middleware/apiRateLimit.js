const rateLimit = require("express-rate-limit");

function skipForIntegrationTestRun() {
  return (
    process.env.NODE_ENV !== "production" &&
    process.env.INTEGRATION_SERVER_READY === "1" &&
    process.env.DISABLE_LOGIN_RATE_LIMIT === "1"
  );
}

/** Global API rate limit (per IP). Tuned for FYP / small deployments. */
const globalApiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.API_RATE_LIMIT_MAX || 500),
  standardHeaders: "draft-7",
  legacyHeaders: false,
  skip: (req) => req.method === "OPTIONS" || skipForIntegrationTestRun(),
  message: {
    success: false,
    message: "Too many requests, please try again later",
    data: null
  }
});

/** Stricter cap for optional LibreTranslate proxy (per user id when authenticated). */
const translationRuntimeLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: Number(process.env.TRANSLATION_RATE_LIMIT_PER_MIN || 45),
  standardHeaders: "draft-7",
  legacyHeaders: false,
  keyGenerator: (req) => {
    const uid = req.auth?.userId || req.user?.id;
    if (uid) return `t:${uid}`;
    return `t:${req.ip}`;
  },
  message: {
    success: false,
    message: "Translation rate limit exceeded. Try again shortly.",
    data: null
  }
});

/** Upload endpoints (per user). */
const uploadLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: Number(process.env.UPLOAD_RATE_LIMIT_PER_MIN || 30),
  standardHeaders: "draft-7",
  legacyHeaders: false,
  keyGenerator: (req) => {
    const uid = req.auth?.userId || req.user?.id;
    if (uid) return `up:${uid}`;
    return `up:${req.ip}`;
  },
  message: {
    success: false,
    message: "Upload rate limit exceeded. Try again shortly.",
    data: null
  }
});

const mapsRouteLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: Number(process.env.MAPS_RATE_LIMIT_PER_MIN || 40),
  standardHeaders: "draft-7",
  legacyHeaders: false,
  keyGenerator: (req) => {
    const uid = req.auth?.userId;
    return uid ? `map:${uid}` : `map:${req.ip}`;
  },
  message: {
    success: false,
    message: "Map route rate limit exceeded. Try again shortly.",
    code: "RATE_LIMIT",
    data: null
  }
});

const shipmentsRouteLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: Number(process.env.SHIPMENTS_RATE_LIMIT_PER_MIN || 120),
  standardHeaders: "draft-7",
  legacyHeaders: false,
  keyGenerator: (req) => {
    const uid = req.auth?.userId;
    return uid ? `ship:${uid}` : `ship:${req.ip}`;
  },
  message: {
    success: false,
    message: "Shipment API rate limit exceeded.",
    code: "RATE_LIMIT",
    data: null
  }
});

const notificationsRouteLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: Number(process.env.NOTIFICATIONS_RATE_LIMIT_PER_MIN || 100),
  standardHeaders: "draft-7",
  legacyHeaders: false,
  keyGenerator: (req) => {
    const uid = req.auth?.userId;
    return uid ? `notif:${uid}` : `notif:${req.ip}`;
  },
  message: {
    success: false,
    message: "Notification API rate limit exceeded.",
    code: "RATE_LIMIT",
    data: null
  }
});

const bidsRouteLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: Number(process.env.BIDS_RATE_LIMIT_PER_MIN || 80),
  standardHeaders: "draft-7",
  legacyHeaders: false,
  keyGenerator: (req) => {
    const uid = req.auth?.userId;
    return uid ? `bid:${uid}` : `bid:${req.ip}`;
  },
  message: {
    success: false,
    message: "Bid API rate limit exceeded.",
    code: "RATE_LIMIT",
    data: null
  }
});

module.exports = {
  globalApiLimiter,
  translationRuntimeLimiter,
  uploadLimiter,
  mapsRouteLimiter,
  shipmentsRouteLimiter,
  notificationsRouteLimiter,
  bidsRouteLimiter
};
