const crypto = require("crypto");
const bcrypt = require("bcrypt");
const { validationResult } = require("express-validator");
const { sendSuccess, sendError } = require("../utils/apiResponse");
const authOtpCodeRepo = require("../repositories/authOtpCodeRepo");
const { sendOtpEmail, validateOutboundMailConfig } = require("../services/emailService");

const OTP_TTL_MS = 5 * 60 * 1000;
const SEND_COOLDOWN_MS = 60 * 1000;
const MAX_VERIFY_ATTEMPTS = 5;

function validationErrorResponse(req, res) {
  const result = validationResult(req);
  if (result.isEmpty()) return null;
  const errors = result.array();
  const details = errors.map((e) => ({ path: e.path, message: e.msg }));
  return sendError(
    res,
    400,
    errors[0]?.msg || "Validation error",
    { fields: errors.map((e) => e.path) },
    "VALIDATION_ERROR",
    { errors: details }
  );
}

function generateSixDigitCode() {
  return String(crypto.randomInt(100000, 1000000));
}

async function assertSendCooldown(res, email) {
  try {
    const last = await authOtpCodeRepo.getLastSentTime(email);
    if (!last) return true;
    const elapsed = Date.now() - last.getTime();
    if (elapsed < SEND_COOLDOWN_MS) {
      const retrySec = Math.ceil((SEND_COOLDOWN_MS - elapsed) / 1000);
      return sendError(res, 429, `Please wait ${retrySec}s before requesting another code`, {
        retryAfterSeconds: retrySec
      });
    }
    return true;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[authOtpAuth] assertSendCooldown error", err?.message || err);
    return sendError(res, 500, "Could not check send cooldown", null, "SERVER_ERROR");
  }
}

async function sendAuthOtp(req, res) {
  try {
    const maybeError = validationErrorResponse(req, res);
    if (maybeError) return maybeError;

    const email = String(req.body.email || "").trim().toLowerCase();

    const gate = await assertSendCooldown(res, email);
    if (gate !== true) return gate;

    const pre = validateOutboundMailConfig();
    if (!pre.ok) {
      // eslint-disable-next-line no-console
      console.error("[authOtpAuth.sendAuthOtp] SMTP not ready", { email, reason: pre.reason });
      return sendError(
        res,
        503,
        "Email delivery is not configured on the server",
        { reason: pre.reason },
        "SMTP_NOT_READY"
      );
    }

    const plain = generateSixDigitCode();
    const otpHash = await bcrypt.hash(plain, 10);
    const expiresAt = new Date(Date.now() + OTP_TTL_MS);

    await authOtpCodeRepo.expireOldOtps(email);
    const inserted = await authOtpCodeRepo.insertOtp(email, otpHash, expiresAt);
    if (!inserted) {
      return sendError(res, 500, "Could not store OTP", null, "SERVER_ERROR");
    }

    try {
      await sendOtpEmail(email, plain, "auth_verify");
    } catch (smtpErr) {
      // eslint-disable-next-line no-console
      console.error("[authOtpAuth.sendAuthOtp] SMTP failed", {
        email,
        classified: smtpErr?.smtpDeliveryReason,
        responseCode: smtpErr?.responseCode,
        message: smtpErr?.message
      });
      return sendError(
        res,
        502,
        "Could not send verification email",
        { reason: smtpErr?.smtpDeliveryReason || "send_failed" },
        "SMTP_SEND_FAILED"
      );
    }

    if (process.env.NODE_ENV !== "production") {
      // eslint-disable-next-line no-console
      console.info(`[authOtpAuth.sendAuthOtp][dev] raw OTP for ${email}: ${plain}`);
    }

    return sendSuccess(
      res,
      200,
      { sent: true, expiresInSeconds: Math.floor(OTP_TTL_MS / 1000) },
      "Verification code sent"
    );
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[authOtpAuth.sendAuthOtp] unexpected", err?.message || err);
    return sendError(res, 500, "Could not send verification code", null, "SERVER_ERROR");
  }
}

async function verifyAuthOtp(req, res) {
  try {
    const maybeError = validationErrorResponse(req, res);
    if (maybeError) return maybeError;

    const email = String(req.body.email || "").trim().toLowerCase();
    const code = String(req.body.code || "").trim();

    const row = await authOtpCodeRepo.findLatestActive(email);
    if (!row) {
      return sendError(res, 400, "No active verification code for this email", null, "INVALID_OTP");
    }

    if (new Date(row.expires_at).getTime() < Date.now()) {
      return sendError(res, 400, "Code expired. Request a new one.", null, "OTP_EXPIRED");
    }

    if (Number(row.attempt_count) >= MAX_VERIFY_ATTEMPTS) {
      return sendError(res, 429, "Too many attempts. Request a new code.", null, "INVALID_OTP");
    }

    let match = false;
    try {
      match = await bcrypt.compare(code, row.otp_hash);
    } catch (cmpErr) {
      // eslint-disable-next-line no-console
      console.error("[authOtpAuth.verifyAuthOtp] bcrypt.compare error", cmpErr?.message || cmpErr);
      match = false;
    }

    if (!match) {
      await authOtpCodeRepo.incrementAttempts(email);
      return sendError(res, 400, "Invalid code", null, "INVALID_OTP");
    }

    const updated = await authOtpCodeRepo.markVerified(email);
    if (!updated) {
      return sendError(res, 409, "Could not finalize verification", null, "SERVER_ERROR");
    }

    return sendSuccess(res, 200, { verified: true, email }, "Email verified");
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[authOtpAuth.verifyAuthOtp] unexpected", err?.message || err);
    return sendError(res, 500, "Verification failed", null, "SERVER_ERROR");
  }
}

async function resendAuthOtp(req, res) {
  try {
    return await sendAuthOtp(req, res);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[authOtpAuth.resendAuthOtp] unexpected", err?.message || err);
    return sendError(res, 500, "Could not resend verification code", null, "SERVER_ERROR");
  }
}

module.exports = {
  sendAuthOtp,
  verifyAuthOtp,
  resendAuthOtp
};
