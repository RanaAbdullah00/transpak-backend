const crypto = require("crypto");
const bcrypt = require("bcrypt");
const { validationResult } = require("express-validator");
const { sendSuccess, sendError } = require("../utils/apiResponse");
const authOtpCodeRepo = require("../repositories/authOtpCodeRepo");
const {
  sendOtpEmail,
  validateOutboundMailConfig,
  classifySmtpSendError
} = require("../services/emailService");
const { isDevAuthRelaxEnabled, isAllowlistedDevTestEmail } = require("../utils/devAuthMode");
const devAuthTestState = require("../services/devAuthTestState");
const { buildOtpDeliveryData, errorCodeForFailure, statusForErrorCode } = require("../utils/otpDelivery");

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
    if (isDevAuthRelaxEnabled() && isAllowlistedDevTestEmail(email)) {
      return true;
    }
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
    return sendError(res, 503, "Service temporarily unavailable", null, "DATABASE_UNAVAILABLE");
  }
}

async function sendAuthOtp(req, res) {
  try {
    const maybeError = validationErrorResponse(req, res);
    if (maybeError) return maybeError;

    const email = String(req.body.email || "").trim().toLowerCase();

    if (isDevAuthRelaxEnabled() && isAllowlistedDevTestEmail(email)) {
      await devAuthTestState.clearAuthOtpCodesForEmail(undefined, email);
    }

    const gate = await assertSendCooldown(res, email);
    if (gate !== true) return gate;

    const pre = validateOutboundMailConfig();
    const plain = generateSixDigitCode();
    const otpHash = await bcrypt.hash(plain, 10);
    const expiresAt = new Date(Date.now() + OTP_TTL_MS);

    await authOtpCodeRepo.expireOldOtps(email);
    const inserted = await authOtpCodeRepo.insertOtp(email, otpHash, expiresAt);
    if (!inserted) {
      return sendError(res, 503, "Service temporarily unavailable", null, "DATABASE_UNAVAILABLE");
    }

    const isNonProd = process.env.NODE_ENV !== "production";
    const devReturn =
      isNonProd && String(process.env.OTP_DEV_RETURN || "").toLowerCase() === "true";

    let delivery = { delivered: false, reason: pre.ok ? null : pre.reason };

    if (pre.ok) {
      try {
        await sendOtpEmail(email, plain, "auth_verify");
        delivery = { delivered: true, reason: null };
      } catch (mailErr) {
        // eslint-disable-next-line no-console
        console.error("[authOtpAuth.sendAuthOtp] email send failed", {
          email,
          classified: mailErr?.smtpDeliveryReason || classifySmtpSendError(mailErr),
          message: mailErr?.message
        });
        delivery = {
          delivered: false,
          reason: mailErr?.smtpDeliveryReason || classifySmtpSendError(mailErr) || "send_failed"
        };
        if (isNonProd) {
          // eslint-disable-next-line no-console
          console.info(`[authOtpAuth.sendAuthOtp][dev] raw OTP for ${email}: ${plain}`);
        }
      }
    } else {
      // eslint-disable-next-line no-console
      console.error("[authOtpAuth.sendAuthOtp] email not ready (OTP stored)", { email, reason: pre.reason });
      if (isNonProd) {
        // eslint-disable-next-line no-console
        console.info(`[authOtpAuth.sendAuthOtp][dev] raw OTP for ${email}: ${plain}`);
      }
    }

    const payload = buildOtpDeliveryData({
      delivered: delivery.delivered,
      reason: delivery.reason,
      devOtp: devReturn ? plain : null,
      context: "generic",
      extra: { expiresInSeconds: Math.floor(OTP_TTL_MS / 1000) }
    });

    return sendSuccess(
      res,
      200,
      payload,
      delivery.delivered
        ? "Verification code sent"
        : "Verification code created; email could not be delivered"
    );
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[authOtpAuth.sendAuthOtp] unexpected", err?.message || err);
    const code = errorCodeForFailure(err);
    return sendError(res, statusForErrorCode(code), "Could not send verification code", null, code);
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
