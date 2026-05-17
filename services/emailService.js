const axios = require("axios");

const BREVO_SEND_URL = "https://api.brevo.com/v3/smtp/email";
const BREVO_ACCOUNT_URL = "https://api.brevo.com/v3/account";
const BREVO_HTTP_TIMEOUT_MS = 10000;
const OTP_SENDER_NAME = "TransPAK";
const OTP_SUBJECT = "Your OTP Code";

function trimEnv(name) {
  return String(process.env[name] || "").trim();
}

function getBrevoApiKey() {
  return trimEnv("BREVO_API_KEY");
}

function getSenderEmail() {
  return trimEnv("BREVO_SENDER_EMAIL");
}

function isOutboundMailReady() {
  return Boolean(getBrevoApiKey() && getSenderEmail());
}

/** @deprecated alias — use isOutboundMailReady */
function smtpConfigured() {
  return isOutboundMailReady();
}

/**
 * @returns {{ ok: true, reason: null } | { ok: false, reason: 'smtp_not_configured' | 'mail_from_missing' }}
 */
function validateOutboundMailConfig() {
  if (!getBrevoApiKey()) {
    return { ok: false, reason: "smtp_not_configured" };
  }
  if (!getSenderEmail()) {
    return { ok: false, reason: "mail_from_missing" };
  }
  return { ok: true, reason: null };
}

function getMailFrom() {
  return getSenderEmail();
}

function isEmailDebugLog() {
  return String(process.env.BREVO_DEBUG_LOG || "").toLowerCase() === "true";
}

function brevoErrorMeta(err) {
  const data = err?.response?.data;
  return {
    status: err?.response?.status ?? null,
    code: err?.code || null,
    message: String(err?.message || err).slice(0, 400),
    brevo: typeof data === "object" ? JSON.stringify(data).slice(0, 500) : String(data || "").slice(0, 500)
  };
}

/**
 * @returns {'authentication_failed'|'sender_not_verified'|'rate_limited'|'send_failed'}
 */
function classifyEmailDeliveryError(err) {
  const status = Number(err?.response?.status) || 0;
  const body = err?.response?.data;
  const msg = typeof body === "object" ? JSON.stringify(body) : String(body || "");
  const combined = `${msg} ${String(err?.message || "")}`.toLowerCase();

  if (status === 401 || status === 403 || combined.includes("unauthorized") || combined.includes("api key")) {
    return "authentication_failed";
  }
  if (status === 429 || combined.includes("rate limit") || combined.includes("too many")) {
    return "rate_limited";
  }
  if (
    status === 400 &&
    (combined.includes("sender") || combined.includes("not verified") || combined.includes("invalid"))
  ) {
    return "sender_not_verified";
  }
  if (combined.includes("sender") && (combined.includes("verify") || combined.includes("not allowed"))) {
    return "sender_not_verified";
  }
  if (err?.code === "ECONNABORTED" || err?.code === "ETIMEDOUT" || combined.includes("timeout")) {
    return "send_failed";
  }
  return "send_failed";
}

function classifySmtpSendError(err) {
  return classifyEmailDeliveryError(err);
}

function getOtpExpiryMinutes() {
  const raw = Number(process.env.OTP_EXPIRY_MINUTES);
  if (!Number.isFinite(raw)) return 8;
  return Math.min(10, Math.max(5, Math.round(raw)));
}

function getOtpExpiryMinutesForPurpose(purpose) {
  if (purpose === "auth_verify") return 5;
  return getOtpExpiryMinutes();
}

function escapeHtml(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function buildOtpHtml(otp, expiryMinutes) {
  const code = escapeHtml(otp);
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"></head>
<body style="margin:0;padding:24px;background:#f4f6f8;font-family:Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1a1a1a;">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr><td align="center">
<table role="presentation" width="480" cellspacing="0" cellpadding="0" style="background:#fff;border-radius:12px;padding:32px;">
<tr><td style="font-size:18px;font-weight:600;">${OTP_SENDER_NAME}</td></tr>
<tr><td style="padding-top:16px;font-size:15px;">Your one-time verification code:</td></tr>
<tr><td align="center" style="padding:24px 0;font-size:32px;font-weight:700;letter-spacing:0.25em;color:#0d6efd;">${code}</td></tr>
<tr><td style="font-size:13px;color:#6c757d;">Expires in <strong>${expiryMinutes} minutes</strong>. Do not share this code.</td></tr>
</table></td></tr></table>
</body></html>`;
}

async function postBrevoEmail({ to, subject, html, text }) {
  const toAddr = String(to || "").trim().toLowerCase();
  const payload = {
    sender: { name: OTP_SENDER_NAME, email: getSenderEmail() },
    to: [{ email: toAddr }],
    subject: String(subject || OTP_SUBJECT),
    htmlContent: html,
    textContent: text || undefined
  };

  const res = await axios.post(BREVO_SEND_URL, payload, {
    headers: {
      "api-key": getBrevoApiKey(),
      "Content-Type": "application/json",
      accept: "application/json"
    },
    timeout: BREVO_HTTP_TIMEOUT_MS
  });

  return {
    messageId: res.data?.messageId || null,
    accepted: [toAddr],
    response: res.status
  };
}

/**
 * Optional startup check (BREVO_VERIFY_ON_START=true). Non-fatal.
 * @returns {Promise<boolean>}
 */
async function verifyBrevoApi() {
  try {
    const pre = validateOutboundMailConfig();
    if (!pre.ok) {
      // eslint-disable-next-line no-console
      console.warn("[emailService] Brevo verify skipped:", pre.reason);
      return false;
    }
    await axios.get(BREVO_ACCOUNT_URL, {
      headers: { "api-key": getBrevoApiKey(), accept: "application/json" },
      timeout: BREVO_HTTP_TIMEOUT_MS
    });
    if (isEmailDebugLog()) {
      // eslint-disable-next-line no-console
      console.log("[emailService] Brevo API verify OK");
    }
    return true;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[emailService] Brevo API verify FAILED (non-fatal)", {
      ...brevoErrorMeta(err),
      classified: classifyEmailDeliveryError(err)
    });
    return false;
  }
}

function verifySmtpConnection() {
  return verifyBrevoApi();
}

/**
 * Generic transactional send (e.g. /otp/email-ping diagnostic). OTP uses sendOtpEmail.
 */
async function sendMail({ to, subject, text, html }) {
  const pre = validateOutboundMailConfig();
  if (!pre.ok) {
    const err = new Error(
      pre.reason === "mail_from_missing" ? "MAIL_FROM_MISSING" : "EMAIL_NOT_CONFIGURED"
    );
    err.code = pre.reason === "mail_from_missing" ? "MAIL_FROM_MISSING" : "SMTP_NOT_CONFIGURED";
    throw err;
  }

  const toAddr = String(to || "").trim().toLowerCase();
  try {
    const info = await postBrevoEmail({
      to: toAddr,
      subject,
      html: html || `<p>${escapeHtml(text || "")}</p>`,
      text
    });
    if (isEmailDebugLog()) {
      // eslint-disable-next-line no-console
      console.log("[emailService] sendMail ok", { to: toAddr, messageId: info.messageId });
    }
    return info;
  } catch (err) {
    const classified = classifyEmailDeliveryError(err);
    err.smtpDeliveryReason = classified;
    // eslint-disable-next-line no-console
    console.error("[emailService] sendMail FAILED", { to: toAddr, ...brevoErrorMeta(err), classified });
    throw err;
  }
}

const OTP_EMAIL_MAX_ATTEMPTS = 3;

/**
 * @param {string} toEmail
 * @param {string} otp
 * @param {'register_verify'|'password_reset'|'auth_verify'} [purpose]
 */
async function sendOtpEmail(toEmail, otp, purpose = "register_verify") {
  const pre = validateOutboundMailConfig();
  if (!pre.ok) {
    const err = new Error(pre.reason === "mail_from_missing" ? "MAIL_FROM_MISSING" : "SMTP_NOT_CONFIGURED");
    err.code = pre.reason === "mail_from_missing" ? "MAIL_FROM_MISSING" : "SMTP_NOT_CONFIGURED";
    throw err;
  }

  const to = String(toEmail || "").trim().toLowerCase();
  const code = String(otp || "").trim();
  const mins = getOtpExpiryMinutesForPurpose(purpose);
  const html = buildOtpHtml(code, mins);
  const text = `Your ${OTP_SENDER_NAME} verification code is ${code}. It expires in ${mins} minutes.`;

  let lastErr;
  for (let attempt = 1; attempt <= OTP_EMAIL_MAX_ATTEMPTS; attempt++) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const info = await postBrevoEmail({ to, subject: OTP_SUBJECT, html, text });
      if (isEmailDebugLog()) {
        // eslint-disable-next-line no-console
        console.log("[emailService] sendOtpEmail ok", { to, messageId: info.messageId });
      }
      return info;
    } catch (err) {
      lastErr = err;
      lastErr.smtpDeliveryReason = classifyEmailDeliveryError(err);
      // eslint-disable-next-line no-console
      console.error("[emailService] sendOtpEmail attempt failed", {
        attempt,
        max: OTP_EMAIL_MAX_ATTEMPTS,
        to,
        ...brevoErrorMeta(err),
        classified: lastErr.smtpDeliveryReason
      });
      if (attempt < OTP_EMAIL_MAX_ATTEMPTS) {
        // eslint-disable-next-line no-await-in-loop
        await new Promise((r) => setTimeout(r, 400 * attempt));
      }
    }
  }
  throw lastErr;
}

module.exports = {
  smtpConfigured,
  isOutboundMailReady,
  validateOutboundMailConfig,
  classifySmtpSendError,
  classifyEmailDeliveryError,
  sendMail,
  sendOtpEmail,
  getMailFrom,
  verifySmtpConnection,
  verifyBrevoApi
};
