const rateLimit = require("express-rate-limit");

/** Global API rate limit (per IP). Tuned for FYP / small deployments. */
const globalApiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.API_RATE_LIMIT_MAX || 500),
  standardHeaders: "draft-7",
  legacyHeaders: false,
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

module.exports = { globalApiLimiter, translationRuntimeLimiter, uploadLimiter };
