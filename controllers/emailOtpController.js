const crypto = require("crypto");
const bcrypt = require("bcrypt");
const { validationResult } = require("express-validator");
const { sendSuccess, sendError } = require("../utils/apiResponse");
const { signToken } = require("../utils/jwt");
const { authData } = require("../utils/authPayload");
const userRepo = require("../repositories/userRepo");
const emailOtpRepo = require("../repositories/emailOtpRepo");
const pendingRegistrationRepo = require("../repositories/pendingRegistrationRepo");
const { sendOtpEmail, sendMail, smtpConfigured, validateOutboundMailConfig, classifySmtpSendError } = require("../services/emailService");
const { isDevAuthRelaxEnabled, isAllowlistedDevTestEmail } = require("../utils/devAuthMode");
const devAuthTestState = require("../services/devAuthTestState");

const { PURPOSES } = emailOtpRepo;

/** OTP lifetime in minutes (env OTP_EXPIRY_MINUTES), clamped 5–10; default 8. */
function getOtpExpiryMinutes() {
  const raw = Number(process.env.OTP_EXPIRY_MINUTES);
  if (!Number.isFinite(raw)) return 8;
  return Math.min(10, Math.max(5, Math.round(raw)));
}

const OTP_EXPIRY_MS = getOtpExpiryMinutes() * 60 * 1000;
const RESEND_COOLDOWN_MS = 45 * 1000;
const MAX_OTP_ATTEMPTS = 6;

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

/** Human-readable hint for clients when outbound mail did not send (English; UI may map by deliveryReason). */
function otpDeliveryHint(reason) {
  switch (reason) {
    case "smtp_not_configured":
      return "Email was not sent: SMTP is not fully configured (SMTP_HOST, SMTP_USER, SMTP_PASS).";
    case "mail_from_missing":
      return "Email was not sent: set SMTP_FROM (or legacy MAIL_FROM). In production, From must be explicit unless SMTP_ALLOW_USER_AS_FROM=true.";
    case "authentication_failed":
      return "Email was not sent: SMTP login failed. For Brevo use the SMTP key from SMTP & API (not the REST API key). Check SMTP_USER / SMTP_PASS.";
    case "sender_not_verified":
      return "Email was not sent: the From address or domain is not allowed by your provider. In Brevo, verify the sender/domain under Senders & IP.";
    case "rate_limited":
      return "Email was not sent: the SMTP provider temporarily rate-limited this server. Wait and retry, or check Brevo quotas.";
    case "send_failed":
      return "Email was not sent: the SMTP server rejected the message. Check Brevo logs for this submission (response code and text).";
    default:
      return "Email was not sent. Please try again or contact support.";
  }
}

async function tryDeliverOtp(email, purpose, plainCode) {
  const pre = validateOutboundMailConfig();
  const isNonProd = process.env.NODE_ENV !== "production";

  if (!pre.ok) {
    /*
     * ----- DEVELOPMENT ONLY -----
     * Logs the raw OTP only when NODE_ENV !== "production" so local flows work without SMTP.
     * Never log raw OTP in production.
     */
    if (isNonProd) {
      // eslint-disable-next-line no-console
      console.info(`[emailOtp][dev] outbound preflight failed for ${email} (${purpose}):`, pre.reason);
      // eslint-disable-next-line no-console
      console.info(`[emailOtp][dev] raw OTP for ${email}: ${plainCode}`);
    } else {
      // eslint-disable-next-line no-console
      console.error("[emailOtp] outbound preflight failed (production)", {
        email,
        purpose,
        reason: pre.reason
      });
    }
    return { delivered: false, reason: pre.reason };
  }

  try {
    await sendOtpEmail(email, plainCode, purpose);
    return { delivered: true, reason: null };
  } catch (err) {
    const errCode = err?.code || err?.message;

    if (isNonProd) {
      // eslint-disable-next-line no-console
      console.info(`[emailOtp][dev] SMTP send failed for ${email} (${purpose}):`, errCode || err);
      // eslint-disable-next-line no-console
      console.info(`[emailOtp][dev] raw OTP for ${email}: ${plainCode}`);
    } else {
      // eslint-disable-next-line no-console
      console.error("[emailOtp] outbound email failed (production)", {
        email,
        purpose,
        errCode: errCode || "unknown",
        responseCode: err?.responseCode,
        response: typeof err?.response === "string" ? err.response.slice(0, 200) : err?.response
      });
    }

    if (errCode === "SMTP_NOT_CONFIGURED") return { delivered: false, reason: "smtp_not_configured" };
    if (errCode === "MAIL_FROM_MISSING") return { delivered: false, reason: "mail_from_missing" };
    const classified = err?.smtpDeliveryReason || classifySmtpSendError(err);
    return { delivered: false, reason: classified };
  }
}

/**
 * Called after a brand-new user row exists. Never throws — logs on failure.
 * @returns {Promise<{ devOtp: string|null, delivery: object }>}
 */
async function issueRegisterOtpForNewUser(email) {
  const normalized = String(email || "").trim().toLowerCase();
  if (isDevAuthRelaxEnabled() && isAllowlistedDevTestEmail(normalized)) {
    await devAuthTestState.clearOtpTablesForEmail(normalized);
  }
  const plain = generateSixDigitCode();
  const codeHash = await bcrypt.hash(plain, 8);
  const expiresAt = new Date(Date.now() + OTP_EXPIRY_MS);
  await emailOtpRepo.invalidateOpen(normalized, PURPOSES.REGISTER);
  await emailOtpRepo.insertChallenge({
    email: normalized,
    purpose: PURPOSES.REGISTER,
    codeHash,
    expiresAt
  });
  const delivery = await tryDeliverOtp(normalized, PURPOSES.REGISTER, plain);
  const devReturn =
    process.env.NODE_ENV !== "production" && String(process.env.OTP_DEV_RETURN || "").toLowerCase() === "true";
  return {
    delivery,
    devOtp: devReturn ? plain : null
  };
}

/**
 * New signup: store hashed password + profile on pending_registrations and email OTP.
 * Overwrites any previous pending row for the same email (new code, attempts reset).
 */
async function upsertPendingRegistrationAndSendOtp({ email, phone, cnicNumber, fullName, passwordHash, role }) {
  const normalized = String(email || "").trim().toLowerCase();
  /*
   * DEV_MODE + DEV_AUTH_TEST_EMAILS: wipe pending + OTP rows for this email before each new
   * signup OTP so the same address can be exercised repeatedly without duplicate / stale rows.
   * Production: no-op (isDevAuthRelaxEnabled is false).
   */
  if (isDevAuthRelaxEnabled() && isAllowlistedDevTestEmail(normalized)) {
    await devAuthTestState.clearOtpAndPendingForEmail(normalized);
  }
  const plain = generateSixDigitCode();
  const codeHash = await bcrypt.hash(plain, 8);
  const expiresAt = new Date(Date.now() + OTP_EXPIRY_MS);
  await emailOtpRepo.invalidateOpen(normalized, PURPOSES.REGISTER);
  await pendingRegistrationRepo.upsert({
    email: normalized,
    phone,
    cnicNumber,
    fullName,
    passwordHash,
    role,
    codeHash,
    expiresAt
  });
  const delivery = await tryDeliverOtp(normalized, PURPOSES.REGISTER, plain);
  const devReturn =
    process.env.NODE_ENV !== "production" && String(process.env.OTP_DEV_RETURN || "").toLowerCase() === "true";
  return {
    delivery,
    devOtp: devReturn ? plain : null
  };
}

async function assertResendCooldownFromTimestamp(req, res, lastAt, emailForDevBypass) {
  if (isDevAuthRelaxEnabled() && emailForDevBypass && isAllowlistedDevTestEmail(emailForDevBypass)) {
    return true;
  }
  if (!lastAt) return true;
  const elapsed = Date.now() - new Date(lastAt).getTime();
  if (elapsed < RESEND_COOLDOWN_MS) {
    const retrySec = Math.ceil((RESEND_COOLDOWN_MS - elapsed) / 1000);
    return sendError(
      res,
      429,
      `Please wait ${retrySec}s before requesting another code`,
      { retryAfterSeconds: retrySec },
      "OTP_COOLDOWN"
    );
  }
  return true;
}

async function assertResendCooldown(req, res, email, purpose) {
  if (isDevAuthRelaxEnabled() && isAllowlistedDevTestEmail(email)) {
    return true;
  }
  const last = await emailOtpRepo.lastSentAt(email, purpose);
  if (!last) return true;
  const elapsed = Date.now() - new Date(last).getTime();
  if (elapsed < RESEND_COOLDOWN_MS) {
    const retrySec = Math.ceil((RESEND_COOLDOWN_MS - elapsed) / 1000);
    return sendError(
      res,
      429,
      `Please wait ${retrySec}s before requesting another code`,
      { retryAfterSeconds: retrySec },
      "OTP_COOLDOWN"
    );
  }
  return true;
}

async function verifyRegisterOtp(req, res) {
  const maybeError = validationErrorResponse(req, res);
  if (maybeError) return maybeError;

  const email = String(req.body.email || "").trim().toLowerCase();
  const code = String(req.body.code || "").trim();

  let pending = await pendingRegistrationRepo.findByEmail(email);
  /*
   * Development: a user row may exist (unverified) while a stale pending_registrations row remains
   * from an earlier signup attempt — verify would otherwise return LEGACY_PENDING_CLASH. In
   * non-production with DEV_MODE, drop the stale pending row so verification can use the
   * email_otp_challenges path for the existing account. Production unchanged.
   */
  if (isDevAuthRelaxEnabled() && pending) {
    const existingEarly = await userRepo.findByEmail(email);
    if (existingEarly && !existingEarly.verified) {
      await pendingRegistrationRepo.deleteByEmail(email);
      pending = await pendingRegistrationRepo.findByEmail(email);
    }
  }

  if (pending) {
    const existingUser = await userRepo.findByEmail(email);
    if (existingUser?.verified) {
      await pendingRegistrationRepo.deleteByEmail(email);
      return sendError(res, 409, "This email is already registered. Sign in instead.", null, "EMAIL_ALREADY_EXISTS");
    }
    if (existingUser && !existingUser.verified) {
      await pendingRegistrationRepo.deleteByEmail(email);
      return sendError(
        res,
        400,
        "An incomplete account already exists for this email. Sign in with your password to finish verification.",
        null,
        "LEGACY_PENDING_CLASH"
      );
    }

    if (new Date(pending.expires_at).getTime() < Date.now()) {
      return sendError(res, 400, "Code expired. Request a new one.", null, "OTP_EXPIRED");
    }
    if (Number(pending.attempt_count) >= MAX_OTP_ATTEMPTS) {
      return sendError(res, 429, "Too many attempts. Request a new code.", null, "INVALID_OTP");
    }

    let match = false;
    try {
      match = await bcrypt.compare(code, pending.code_hash);
    } catch {
      match = false;
    }
    if (!match) {
      await pendingRegistrationRepo.incrementAttempts(email);
      return sendError(res, 400, "Invalid code", null, "INVALID_OTP");
    }

    const cnicUser = await userRepo.findByCnicNumber(pending.cnic_number);
    if (cnicUser && String(cnicUser.email).toLowerCase() !== email) {
      return sendError(
        res,
        409,
        "This CNIC is already registered with another email",
        { field: "CNIC" },
        "EMAIL_ALREADY_EXISTS"
      );
    }
    const phoneOwner = await userRepo.findPhoneOwner(pending.phone);
    if (phoneOwner && String(phoneOwner.email).toLowerCase() !== email) {
      return sendError(
        res,
        409,
        "Phone number is already registered to another account",
        { field: "phone" },
        "EMAIL_ALREADY_EXISTS"
      );
    }

    let user;
    try {
      user = await userRepo.createUser({
        email: pending.email,
        passwordHash: pending.password_hash,
        roles: [pending.role],
        activeRole: pending.role,
        phone: pending.phone,
        cnicNumber: pending.cnic_number,
        fullName: pending.full_name,
        verified: true
      });
    } catch (err) {
      if (err && err.code === "23505") {
        await pendingRegistrationRepo.deleteByEmail(email).catch(() => {});
        return sendError(
          res,
          409,
          "Email, phone, or CNIC already in use",
          null,
          "EMAIL_ALREADY_EXISTS"
        );
      }
      throw err;
    }

    await pendingRegistrationRepo.deleteByEmail(email);
    await emailOtpRepo.invalidateOpen(email, PURPOSES.REGISTER);

    const token = signToken(user);
    return sendSuccess(res, 200, authData(user, token), "Email verified");
  }

  const existingUser = await userRepo.findByEmail(email);
  if (!existingUser) {
    return sendError(res, 400, "Invalid email or verification code", null, "INVALID_OTP");
  }
  if (existingUser.verified) {
    const token = signToken(existingUser);
    return sendSuccess(res, 200, authData(existingUser, token), "Email already verified");
  }

  const row = await emailOtpRepo.findLatestOpen(email, PURPOSES.REGISTER);
  if (!row) {
    return sendError(res, 400, "No active verification code for this email", null, "INVALID_OTP");
  }
  if (new Date(row.expires_at).getTime() < Date.now()) {
    await emailOtpRepo.consume(row.id);
    return sendError(res, 400, "Code expired. Request a new one.", null, "OTP_EXPIRED");
  }
  if (Number(row.attempt_count) >= MAX_OTP_ATTEMPTS) {
    await emailOtpRepo.consume(row.id);
    return sendError(res, 429, "Too many attempts. Request a new code.", null, "INVALID_OTP");
  }

  let match = false;
  try {
    match = await bcrypt.compare(code, row.code_hash);
  } catch {
    match = false;
  }
  if (!match) {
    await emailOtpRepo.incrementAttempts(row.id);
    return sendError(res, 400, "Invalid code", null, "INVALID_OTP");
  }

  await emailOtpRepo.consume(row.id);
  const user = await userRepo.setVerifiedByEmail(email, true);
  if (!user) return sendError(res, 404, "Account not found", null, "SERVER_ERROR");

  const token = signToken(user);
  return sendSuccess(res, 200, authData(user, token), "Email verified");
}

async function resendRegisterOtp(req, res) {
  const maybeError = validationErrorResponse(req, res);
  if (maybeError) return maybeError;

  const email = String(req.body.email || "").trim().toLowerCase();

  const pending = await pendingRegistrationRepo.findByEmail(email);
  if (pending) {
    const lastAt = await pendingRegistrationRepo.lastUpdatedAt(email);
    const gate = await assertResendCooldownFromTimestamp(req, res, lastAt, email);
    if (gate !== true) return gate;

    const { delivery, devOtp } = await upsertPendingRegistrationAndSendOtp({
      email,
      phone: pending.phone,
      cnicNumber: pending.cnic_number,
      fullName: pending.full_name,
      passwordHash: pending.password_hash,
      role: pending.role
    });
    const outbound = validateOutboundMailConfig();
    const payload = {
      sent: delivery.delivered || Boolean(devOtp),
      smtpConfigured: smtpConfigured(),
      mailOutboundReady: outbound.ok,
      deliveryFailed: !delivery.delivered && !devOtp,
      deliveryReason: !delivery.delivered ? delivery.reason || undefined : undefined,
      deliveryHint: !delivery.delivered && !devOtp ? otpDeliveryHint(delivery.reason) : undefined
    };
    if (devOtp) payload.devOtp = devOtp;
    return sendSuccess(res, 200, payload, "If this account is eligible, a verification code was sent.");
  }

  const user = await userRepo.findByEmail(email);
  if (!user) {
    return sendSuccess(res, 200, { sent: false }, "If an account exists, a code may be sent");
  }
  if (user.verified) {
    return sendSuccess(res, 200, { sent: false, alreadyVerified: true }, "Email already verified");
  }

  const gate = await assertResendCooldown(req, res, email, PURPOSES.REGISTER);
  if (gate !== true) return gate;

  const { delivery, devOtp } = await issueRegisterOtpForNewUser(email);
  const outbound = validateOutboundMailConfig();
  const payload = {
    sent: delivery.delivered || Boolean(devOtp),
    smtpConfigured: smtpConfigured(),
    mailOutboundReady: outbound.ok,
    deliveryFailed: !delivery.delivered && !devOtp,
    deliveryReason: !delivery.delivered ? delivery.reason || undefined : undefined,
    deliveryHint: !delivery.delivered && !devOtp ? otpDeliveryHint(delivery.reason) : undefined
  };
  if (devOtp) payload.devOtp = devOtp;
  return sendSuccess(
    res,
    200,
    payload,
    "If this account is eligible, a verification code was sent."
  );
}

async function sendForgotPasswordOtp(req, res) {
  const maybeError = validationErrorResponse(req, res);
  if (maybeError) return maybeError;

  const email = String(req.body.email || "").trim().toLowerCase();
  const rowUser = await userRepo.findRowByEmailWithPassword(email);
  const msg = "If an account exists for this email, a reset code was sent.";

  if (!rowUser || !rowUser.password_hash) {
    return sendSuccess(res, 200, { sent: false }, msg);
  }

  const gate = await assertResendCooldown(req, res, email, PURPOSES.PASSWORD_RESET);
  if (gate !== true) return gate;

  const plain = generateSixDigitCode();
  const codeHash = await bcrypt.hash(plain, 8);
  const expiresAt = new Date(Date.now() + OTP_EXPIRY_MS);
  if (isDevAuthRelaxEnabled() && isAllowlistedDevTestEmail(email)) {
    await devAuthTestState.clearOtpTablesForEmail(email);
  }
  await emailOtpRepo.invalidateOpen(email, PURPOSES.PASSWORD_RESET);
  await emailOtpRepo.insertChallenge({
    email,
    purpose: PURPOSES.PASSWORD_RESET,
    codeHash,
    expiresAt
  });
  const delivery = await tryDeliverOtp(email, PURPOSES.PASSWORD_RESET, plain);
  const outbound = validateOutboundMailConfig();
  const devReturn =
    process.env.NODE_ENV !== "production" && String(process.env.OTP_DEV_RETURN || "").toLowerCase() === "true";
  const data = {
    sent: delivery.delivered || devReturn,
    smtpConfigured: smtpConfigured(),
    mailOutboundReady: outbound.ok,
    deliveryReason: !delivery.delivered ? delivery.reason || undefined : undefined,
    deliveryHint: !delivery.delivered && !devReturn ? otpDeliveryHint(delivery.reason) : undefined
  };
  if (devReturn) data.devOtp = plain;
  return sendSuccess(res, 200, data, msg);
}

/**
 * Diagnostic: submit a minimal message through the same SMTP path as OTP.
 * Production: requires header `x-smtp-test-secret` matching env SMTP_TEST_SECRET.
 * Development: allowed without secret (still rate-limited). Body.to optional; defaults to SMTP_USER.
 */
async function smtpPing(req, res) {
  const secret = String(process.env.SMTP_TEST_SECRET || "").trim();
  const header = String(req.headers["x-smtp-test-secret"] || "").trim();
  const dev = process.env.NODE_ENV !== "production";
  if (!dev && (!secret || header !== secret)) {
    return sendError(res, 404, "Not found", null, "NOT_FOUND");
  }

  const rawTo = String(req.body?.to || "").trim().toLowerCase();
  const fallback = String(process.env.SMTP_USER || "").trim().toLowerCase();
  const to = rawTo || fallback;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
    return sendError(
      res,
      400,
      "Provide a valid { to } email or set SMTP_USER as default recipient",
      null,
      "VALIDATION_ERROR"
    );
  }

  try {
    const info = await sendMail({
      to,
      subject: "TransPak SMTP test",
      text:
        "TransPak SMTP test: if you see this, the server accepted the message from this app. Gmail inbox vs spam is separate; check Brevo transactional logs if it does not arrive.",
      html: "<p>TransPak SMTP test OK.</p><p>If Gmail does not show this, check spam and Brevo logs.</p>"
    });
    return sendSuccess(
      res,
      200,
      {
        to,
        messageId: info?.messageId || null,
        response: typeof info?.response === "string" ? info.response.slice(0, 400) : info?.response || null,
        accepted: info?.accepted,
        rejected: info?.rejected
      },
      "SMTP accepted the test message (inbox delivery is provider/recipient dependent)"
    );
  } catch (e) {
    const classified = e?.smtpDeliveryReason || classifySmtpSendError(e);
    // eslint-disable-next-line no-console
    console.error("[emailOtp] smtpPing failed", {
      to,
      classified,
      responseCode: e?.responseCode,
      response: typeof e?.response === "string" ? e.response.slice(0, 300) : e?.response,
      message: e?.message
    });
    return sendError(
      res,
      502,
      e?.message || "SMTP send failed",
      {
        classification: classified,
        responseCode: e?.responseCode,
        response: typeof e?.response === "string" ? e.response.slice(0, 400) : e?.response
      },
      "SMTP_SEND_FAILED"
    );
  }
}

async function resetPasswordWithOtp(req, res) {
  const maybeError = validationErrorResponse(req, res);
  if (maybeError) return maybeError;

  const email = String(req.body.email || "").trim().toLowerCase();
  const code = String(req.body.code || "").trim();
  const password = String(req.body.password || "");
  const confirmPassword = String(req.body.confirmPassword || "");

  if (password !== confirmPassword) {
    return sendError(res, 400, "Passwords do not match", null, "VALIDATION_ERROR");
  }
  if (password.length < 8) {
    return sendError(res, 400, "Password must be at least 8 characters", null, "VALIDATION_ERROR");
  }

  const row = await emailOtpRepo.findLatestOpen(email, PURPOSES.PASSWORD_RESET);
  if (!row) return sendError(res, 400, "No active reset code for this email", null, "INVALID_OTP");
  if (new Date(row.expires_at).getTime() < Date.now()) {
    await emailOtpRepo.consume(row.id);
    return sendError(res, 400, "Code expired. Request a new one.", null, "OTP_EXPIRED");
  }
  if (Number(row.attempt_count) >= MAX_OTP_ATTEMPTS) {
    await emailOtpRepo.consume(row.id);
    return sendError(res, 429, "Too many attempts. Request a new code.", null, "INVALID_OTP");
  }

  let match = false;
  try {
    match = await bcrypt.compare(code, row.code_hash);
  } catch {
    match = false;
  }
  if (!match) {
    await emailOtpRepo.incrementAttempts(row.id);
    return sendError(res, 400, "Invalid code", null, "INVALID_OTP");
  }

  const passwordHash = await bcrypt.hash(password, 10);
  const updated = await userRepo.updatePasswordHashByEmail(email, passwordHash);
  if (!updated) return sendError(res, 404, "Account not found", null, "SERVER_ERROR");

  await emailOtpRepo.consume(row.id);
  await emailOtpRepo.invalidateOpen(email, PURPOSES.PASSWORD_RESET);

  const token = signToken(updated);
  return sendSuccess(res, 200, authData(updated, token), "Password updated");
}

module.exports = {
  issueRegisterOtpForNewUser,
  upsertPendingRegistrationAndSendOtp,
  verifyRegisterOtp,
  resendRegisterOtp,
  sendForgotPasswordOtp,
  resetPasswordWithOtp,
  smtpPing
};
