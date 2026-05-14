const nodemailer = require("nodemailer");

/**
 * From header: SMTP_FROM (preferred), then MAIL_FROM (legacy), then SMTP_USER in non-production
 * if SMTP_ALLOW_USER_AS_FROM=true only.
 */
function getEffectiveFromAddress() {
  const explicit = trimEnv("SMTP_FROM") || trimEnv("MAIL_FROM") || trimEnv("BREVO_EMAIL");
  if (explicit) return explicit;
  const isProd = process.env.NODE_ENV === "production";
  const allowUserAsFrom = String(process.env.SMTP_ALLOW_USER_AS_FROM || "").toLowerCase() === "true";
  if (isProd && !allowUserAsFrom) return "";
  return smtpUser();
}

function trimEnv(name) {
  return String(process.env[name] || "").trim();
}

function smtpUser() {
  return trimEnv("SMTP_USER") || trimEnv("BREVO_EMAIL");
}

function smtpPass() {
  return trimEnv("SMTP_PASS") || trimEnv("BREVO_SMTP_KEY");
}

function smtpHost() {
  const h = trimEnv("SMTP_HOST");
  if (h) return h;
  if (trimEnv("BREVO_EMAIL") && smtpPass()) return "smtp-relay.brevo.com";
  return "";
}

function smtpConfigured() {
  return Boolean(smtpHost() && smtpUser() && smtpPass());
}

/**
 * Preflight (no TCP): use before send and in OTP layer for explicit API reasons.
 * @returns {{ ok: true, reason: null } | { ok: false, reason: 'smtp_not_configured' | 'mail_from_missing' }}
 */
function validateOutboundMailConfig() {
  if (!smtpConfigured()) {
    return { ok: false, reason: "smtp_not_configured" };
  }
  if (!getEffectiveFromAddress()) {
    return { ok: false, reason: "mail_from_missing" };
  }
  return { ok: true, reason: null };
}

/**
 * Connection / socket timeout for SMTP (ms). Clamped 5s–120s; default 20s.
 */
function getSmtpTimeoutMs() {
  const n = Number(process.env.SMTP_CONNECTION_TIMEOUT_MS);
  if (Number.isFinite(n) && n >= 5000 && n <= 120000) return n;
  return 20000;
}

/** Safe log fields when send/verify fails (no passwords). */
function smtpErrorMeta(err) {
  const o = err || {};
  return {
    code: o.code || o.errno || null,
    command: o.command || null,
    responseCode: o.responseCode || null,
    response: typeof o.response === "string" ? o.response.slice(0, 500) : o.response || null,
    message: String(o.message || o).slice(0, 400)
  };
}

/**
 * Map Nodemailer / SMTP rejection to a stable delivery reason for OTP API hints.
 * Brevo: use SMTP **key** (dashboard → SMTP & API → SMTP) — not the REST v3 API key.
 * @param {Error & { responseCode?: number, response?: string }} err
 * @returns {'authentication_failed'|'sender_not_verified'|'rate_limited'|'send_failed'}
 */
function classifySmtpSendError(err) {
  const o = err || {};
  const code = Number(o.responseCode) || 0;
  const resp = String(o.response || "").toLowerCase();
  const msg = String(o.message || "").toLowerCase();
  const combined = `${resp} ${msg}`;

  if (
    o.code === "EAUTH" ||
    code === 535 ||
    code === 534 ||
    code === 530 ||
    combined.includes("authentication failed") ||
    combined.includes("auth failed") ||
    combined.includes("invalid login") ||
    combined.includes("credentials")
  ) {
    return "authentication_failed";
  }

  if (
    code === 421 ||
    code === 450 ||
    code === 452 ||
    combined.includes("rate limit") ||
    combined.includes("too many") ||
    combined.includes("try again later") ||
    combined.includes("throttl")
  ) {
    return "rate_limited";
  }

  if (code === 550 || code === 553 || code === 554) {
    if (
      combined.includes("mailbox") ||
      combined.includes("user unknown") ||
      combined.includes("recipient") ||
      combined.includes("no such user")
    ) {
      return "send_failed";
    }
    if (
      combined.includes("sender") ||
      combined.includes("from address") ||
      combined.includes("not verified") ||
      combined.includes("verify") ||
      combined.includes("not permitted") ||
      combined.includes("spf") ||
      combined.includes("dmarc") ||
      combined.includes("relay not permitted") ||
      combined.includes("unauthorized")
    ) {
      return "sender_not_verified";
    }
  }

  if (
    combined.includes("sender") && (combined.includes("verify") || combined.includes("not allowed")) ||
    combined.includes("domain not verified") ||
    combined.includes("sender identity")
  ) {
    return "sender_not_verified";
  }

  return "send_failed";
}

/**
 * Build Nodemailer transport from env.
 * Brevo: typically SMTP_HOST=smtp-relay.brevo.com, PORT=587, SMTP_SECURE=false.
 */
function buildTransportOptions() {
  const host = smtpHost();
  const port = Number(trimEnv("SMTP_PORT")) || 587;
  const explicitSecure = trimEnv("SMTP_SECURE").toLowerCase();
  let secure = explicitSecure === "true";
  if (explicitSecure !== "false" && explicitSecure !== "true" && port === 465) {
    secure = true;
  }

  const timeoutMs = getSmtpTimeoutMs();
  const rejectUnauthorized = trimEnv("SMTP_TLS_REJECT_UNAUTHORIZED").toLowerCase() !== "false";

  const opts = {
    host,
    port,
    secure,
    requireTLS: !secure && port !== 465,
    connectionTimeout: timeoutMs,
    greetingTimeout: timeoutMs,
    socketTimeout: timeoutMs,
    auth: {
      user: smtpUser(),
      pass: smtpPass()
    }
  };

  if (!rejectUnauthorized) {
    opts.tls = { rejectUnauthorized: false };
  }

  return opts;
}

function createTransporter() {
  return nodemailer.createTransport(buildTransportOptions());
}

function isSmtpDebugLog() {
  return String(process.env.SMTP_DEBUG_LOG || "").toLowerCase() === "true";
}

/**
 * Optional startup check (set SMTP_VERIFY_ON_START=true).
 * @returns {Promise<boolean>}
 */
async function verifySmtpConnection() {
  const pre = validateOutboundMailConfig();
  if (!pre.ok) {
    // eslint-disable-next-line no-console
    console.warn("[emailService] SMTP verify skipped:", pre.reason);
    return false;
  }
  const from = getEffectiveFromAddress();
  const port = Number(trimEnv("SMTP_PORT")) || 587;
  try {
    const transporter = createTransporter();
    await transporter.verify();
    // eslint-disable-next-line no-console
    console.log("[emailService] SMTP verify OK", {
      host: smtpHost(),
      port,
      from: from.replace(/<[^>]+>/, "<…>")
    });
    return true;
  } catch (err) {
    const classified = classifySmtpSendError(err);
    // eslint-disable-next-line no-console
    console.error("[emailService] SMTP verify FAILED", { ...smtpErrorMeta(err), classified });
    return false;
  }
}

/**
 * @returns {Promise<import("nodemailer").SentMessageInfo>}
 */
async function sendMail({ to, subject, text, html }) {
  const pre = validateOutboundMailConfig();
  if (!pre.ok) {
    const err = new Error(pre.reason === "mail_from_missing" ? "MAIL_FROM_OR_SMTP_FROM_REQUIRED" : "SMTP_NOT_CONFIGURED");
    err.code = pre.reason === "mail_from_missing" ? "MAIL_FROM_MISSING" : "SMTP_NOT_CONFIGURED";
    throw err;
  }

  const from = getEffectiveFromAddress();
  const transporter = createTransporter();
  const toAddr = String(to || "").trim().toLowerCase();
  const isProd = process.env.NODE_ENV === "production";

  try {
    const info = await transporter.sendMail({
      from,
      to: toAddr,
      subject,
      text,
      html
    });

    const baseLog = {
      to: toAddr,
      messageId: info?.messageId || null,
      responseCode: info?.responseCode ?? null,
      response: typeof info?.response === "string" ? info.response.slice(0, 500) : info?.response || null
    };

    if (isSmtpDebugLog() || !isProd) {
      // eslint-disable-next-line no-console
      console.log("[emailService] sendMail ok (detail)", {
        ...baseLog,
        accepted: info?.accepted,
        rejected: info?.rejected,
        pending: info?.pending,
        envelope: info?.envelope
      });
    } else {
      // eslint-disable-next-line no-console
      console.log("[emailService] sendMail ok", baseLog);
    }

    // SMTP 2xx = accepted for relay; inbox placement is provider/recipient policy (see Brevo logs if missing in Gmail).
    return info;
  } catch (err) {
    const classified = classifySmtpSendError(err);
    err.smtpDeliveryReason = classified;
    const meta = { to: toAddr, ...smtpErrorMeta(err), classified };
    if (isSmtpDebugLog()) {
      // eslint-disable-next-line no-console
      console.error("[emailService] sendMail FAILED (SMTP_DEBUG_LOG)", meta);
    } else {
      // eslint-disable-next-line no-console
      console.error("[emailService] sendMail FAILED", meta);
    }
    throw err;
  }
}

/** OTP mail lifetime (minutes), same clamp as emailOtpController. */
function getOtpExpiryMinutes() {
  const raw = Number(process.env.OTP_EXPIRY_MINUTES);
  if (!Number.isFinite(raw)) return 8;
  return Math.min(10, Math.max(5, Math.round(raw)));
}

function getOtpExpiryMinutesForPurpose(purpose) {
  if (purpose === "auth_verify") return 5;
  return getOtpExpiryMinutes();
}

/** Initial send + up to 2 retries (3 attempts total). */
const OTP_EMAIL_MAX_ATTEMPTS = 3;

function buildOtpMailContent(otp, purpose) {
  const mins = getOtpExpiryMinutesForPurpose(purpose);
  const code = String(otp || "").trim();
  if (purpose === "auth_verify") {
    const esc = code.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    return {
      subject: "TransPak — your verification code",
      text: `Your TransPak verification code is: ${code}\n\nIt expires in ${mins} minutes. If you did not request this, ignore this email.`,
      html: `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body style="margin:0;padding:24px;background:#f4f6f8;font-family:Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1a1a1a;">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr><td align="center">
<table role="presentation" width="480" cellspacing="0" cellpadding="0" style="background:#fff;border-radius:12px;padding:32px;box-shadow:0 2px 8px rgba(0,0,0,.06);">
<tr><td style="font-size:18px;font-weight:600;">TransPak</td></tr>
<tr><td style="padding-top:16px;font-size:15px;line-height:1.5;">Use this code to verify your email:</td></tr>
<tr><td align="center" style="padding:24px 0;font-size:28px;font-weight:700;letter-spacing:0.2em;color:#0d6efd;">${esc}</td></tr>
<tr><td style="font-size:13px;color:#6c757d;">This code expires in <strong>${mins} minutes</strong>. Do not share it with anyone.</td></tr>
</table></td></tr></table></body></html>`
    };
  }
  const isRegister = purpose === "register_verify";
  if (isRegister) {
    return {
      subject: "TransPak — verify your email",
      text: `Your TransPak verification code is: ${code}\n\nIt expires in ${mins} minutes. If you did not create an account, ignore this email.`,
      html: `<p>Your TransPak verification code is:</p><p style="font-size:22px;font-weight:700;letter-spacing:0.15em">${code}</p><p>This code expires in ${mins} minutes.</p>`
    };
  }
  return {
    subject: "TransPak — reset your password",
    text: `Your TransPak password reset code is: ${code}\n\nIt expires in ${mins} minutes. If you did not request a reset, ignore this email.`,
    html: `<p>Your TransPak password reset code is:</p><p style="font-size:22px;font-weight:700;letter-spacing:0.15em">${code}</p><p>This code expires in ${mins} minutes.</p>`
  };
}

/**
 * Send OTP email using env SMTP only (no hardcoded credentials).
 * Retries up to 2 times after failure (3 attempts). Never logs the OTP in production.
 * @param {string} toEmail
 * @param {string} otp
 * @param {'register_verify'|'password_reset'|'auth_verify'} [purpose]
 * @returns {Promise<import("nodemailer").SentMessageInfo>}
 */
async function sendOtpEmail(toEmail, otp, purpose = "register_verify") {
  const parts = buildOtpMailContent(otp, purpose);
  const to = String(toEmail || "").trim().toLowerCase();
  let lastErr;
  for (let attempt = 1; attempt <= OTP_EMAIL_MAX_ATTEMPTS; attempt++) {
    try {
      // eslint-disable-next-line no-await-in-loop
      return await sendMail({ to, subject: parts.subject, text: parts.text, html: parts.html });
    } catch (err) {
      lastErr = err;
      const meta = { attempt, max: OTP_EMAIL_MAX_ATTEMPTS, to, ...smtpErrorMeta(err), classified: err?.smtpDeliveryReason };
      // eslint-disable-next-line no-console
      console.error("[emailService] sendOtpEmail attempt failed", meta);
      if (attempt < OTP_EMAIL_MAX_ATTEMPTS) {
        const delayMs = 400 * attempt;
        // eslint-disable-next-line no-await-in-loop
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }
  }
  throw lastErr;
}

module.exports = {
  smtpConfigured,
  validateOutboundMailConfig,
  classifySmtpSendError,
  sendMail,
  sendOtpEmail,
  getMailFrom: getEffectiveFromAddress,
  verifySmtpConnection,
  isSmtpDebugLog
};
