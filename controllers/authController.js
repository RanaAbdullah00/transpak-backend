const bcrypt = require("bcrypt");
const { validationResult } = require("express-validator");
const { signToken } = require("../utils/jwt");
const { sendSuccess, sendError } = require("../utils/apiResponse");
const { authData, authDataNoToken, loginAuthData } = require("../utils/authPayload");
const userRepo = require("../repositories/userRepo");
const { issueRegisterOtpForNewUser } = require("./emailOtpController");

const DEMO_FORCE_ADMIN_EMAIL = "mrabdullah0456@gmail.com";

function normalizeRolesAndActiveRole(user) {
  const allowed = userRepo.ALLOWED_ROLES;
  const raw = Array.isArray(user.roles) ? user.roles : [];
  const roles = [...new Set(raw.map((r) => String(r || "").trim().toLowerCase()).filter((r) => allowed.includes(r)))];
  if (!roles.length) return { ok: false };
  const activeRaw = user.activeRole != null ? String(user.activeRole).trim().toLowerCase() : "";
  const active = roles.includes(activeRaw) ? activeRaw : roles.includes("admin") ? "admin" : roles[0];
  return { ok: true, roles, activeRole: active };
}

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

/** Maps OTP delivery outcome to API fields (backward compatible: optional deliveryReason). */
function buildRegisterEmailVerification(otpPack) {
  const delivered = Boolean(otpPack?.delivery?.delivered);
  const reason = otpPack?.delivery?.reason || null;
  const isDev = process.env.NODE_ENV !== "production";
  let deliveryHint = null;
  if (!delivered) {
    if (isDev) {
      deliveryHint =
        "Development: OTP is printed in the server console if email could not be sent.";
    } else if (reason === "smtp_not_configured") {
      deliveryHint =
        "Email is not configured on the server (SMTP). Your account was created; contact support or try again after the server is configured.";
    } else if (reason === "mail_from_missing") {
      deliveryHint =
        "Email sender (SMTP_FROM or MAIL_FROM) is not configured on the server. Your account was created; contact support.";
    } else if (reason === "authentication_failed") {
      deliveryHint =
        "SMTP login failed (wrong SMTP user/key). For Brevo use the SMTP password from SMTP & API, not the REST API key.";
    } else if (reason === "sender_not_verified") {
      deliveryHint =
        "The From address is not verified with your email provider. In Brevo: Senders & IP → verify sender/domain; SMTP_FROM must match.";
    } else if (reason === "rate_limited") {
      deliveryHint =
        "Email was temporarily blocked by rate limits. Retry in a few minutes or check Brevo quotas.";
    } else {
      deliveryHint =
        "We could not deliver the verification email (SMTP error). Try resend in a moment or contact support if it continues.";
    }
  }
  return {
    pending: true,
    emailSent: delivered,
    devOtp: otpPack?.devOtp || undefined,
    deliveryHint,
    deliveryReason: reason || undefined
  };
}

async function register(req, res) {
  try {
    const maybeError = validationErrorResponse(req, res);
    if (maybeError) return maybeError;

    const dbg =
      process.env.NODE_ENV === "development" ||
      String(process.env.AUTH_DEBUG_REGISTER || "").toLowerCase() === "true";
    if (dbg) {
      const { name, email, phone, CNIC, role } = req.body || {};
      // eslint-disable-next-line no-console
      console.log("[auth.register] body (redacted)", {
        name,
        email,
        phone,
        CNIC,
        role,
        hasPassword: Boolean(req.body?.password),
        fileFields: req.file ? [req.file.fieldname] : req.files ? Object.keys(req.files) : []
      });
    }

    const { name, email, phone, CNIC, password, confirmPassword, role } = req.body;

    if (String(password) !== String(confirmPassword)) {
      return sendError(res, 400, "Passwords do not match", null, "VALIDATION_ERROR");
    }

    const normalizedEmail = String(email).trim().toLowerCase();
    const phoneRaw = String(phone).trim();
    const normalizedPhone = phoneRaw.startsWith("+") ? phoneRaw : `+${phoneRaw}`;
    const normalizedCnic = String(CNIC).trim();
    const normalizedRole = String(role).trim().toLowerCase();
    const fullName = String(name || "").trim();

    const allowedRoles = userRepo.ALLOWED_ROLES;
    if (normalizedRole === "admin") {
      return sendError(res, 403, "Admin registration is not allowed", null, "INVALID_ROLE");
    }
    if (!allowedRoles.includes(normalizedRole)) {
      return sendError(res, 400, "Invalid or missing role", null, "INVALID_ROLE");
    }

    const existing = await userRepo.findByEmail(normalizedEmail);
    if (existing) {
      const row = await userRepo.findRowByEmailWithPassword(normalizedEmail);
      if (!row?.password_hash) {
        return sendError(
          res,
          409,
          "This email is already registered, but the account has no password. Use your original sign-in method or contact support.",
          null,
          "EMAIL_ALREADY_EXISTS"
        );
      }
      const passwordOk = await bcrypt.compare(String(password), row.password_hash);
      if (!passwordOk) {
        return sendError(
          res,
          401,
          "That email is already registered. The password you entered is incorrect. Sign in with the correct password, or use a different email to create a new account.",
          null,
          "WRONG_PASSWORD"
        );
      }

      if (existing.cnicNumber && normalizedCnic !== existing.cnicNumber) {
        return sendError(
          res,
          409,
          "CNIC does not match this account",
          { field: "CNIC" },
          "VALIDATION_ERROR"
        );
      }

      const cnicOther = await userRepo.findByCnicNumber(normalizedCnic);
      if (cnicOther && String(cnicOther.id) !== String(existing.id)) {
        return sendError(
          res,
          409,
          "This CNIC is registered to another account",
          { field: "CNIC" },
          "VALIDATION_ERROR"
        );
      }

      const phoneOwner = await userRepo.findPhoneOwner(normalizedPhone);
      if (phoneOwner && String(phoneOwner.id) !== String(existing.id)) {
        return sendError(
          res,
          409,
          "Phone number is registered to another account",
          { field: "phone" },
          "VALIDATION_ERROR"
        );
      }

      let u = existing;
      const hadRole = userRepo.hasRole(u, normalizedRole);

      const cnicUp = await userRepo.setCnicIfEmpty(u.id, normalizedCnic);
      if (cnicUp) u = cnicUp;
      const phoneUp = await userRepo.setPhoneIfEmpty(u.id, normalizedPhone);
      if (phoneUp) u = phoneUp;
      const nameUp = await userRepo.setFullNameIfEmpty(u.id, fullName);
      if (nameUp) u = nameUp;

      if (!hadRole) {
        const added = await userRepo.addRole(u.id, normalizedRole);
        if (added) u = added;
      }

      const switched = await userRepo.setActiveRole(u.id, normalizedRole);
      if (switched) u = switched;

      const finalUser = (await userRepo.findById(u.id)) || u;
      if (!finalUser.verified) {
        let emailVerification = { pending: true, emailSent: false };
        try {
          const otpPack = await issueRegisterOtpForNewUser(normalizedEmail);
          emailVerification = buildRegisterEmailVerification(otpPack);
        } catch (otpErr) {
          const isProd = process.env.NODE_ENV === "production";
          // eslint-disable-next-line no-console
          console.error(
            "[auth.register] email OTP issue (existing user):",
            otpErr?.message || otpErr,
            isProd ? "" : otpErr?.stack || ""
          );
          emailVerification = {
            pending: true,
            emailSent: false,
            deliveryHint: isProd
              ? "Verification could not be started. Try resend after signing in, or contact support."
              : `Verification email could not be queued: ${otpErr?.message || "unknown error"}`,
            deliveryReason: "exception"
          };
        }
        const base = authDataNoToken(finalUser);
        return sendSuccess(
          res,
          200,
          { ...base, registrationKind: hadRole ? "existing" : "merged", emailVerification },
          "Verify your email to continue"
        );
      }
      const token = signToken(finalUser);
      const base = authData(finalUser, token);
      const msg = hadRole ? "Signed in to existing account" : "Role added to your account";
      return sendSuccess(res, 200, { ...base, registrationKind: hadRole ? "existing" : "merged" }, msg);
    }

    const cnicUser = await userRepo.findByCnicNumber(normalizedCnic);
    if (cnicUser && cnicUser.email !== normalizedEmail) {
      return sendError(
        res,
        409,
        "This CNIC is already registered with another email",
        { field: "CNIC" },
        "EMAIL_ALREADY_EXISTS"
      );
    }

    const phoneOwner = await userRepo.findPhoneOwner(normalizedPhone);
    if (phoneOwner) {
      return sendError(
        res,
        409,
        "Phone number is already registered",
        { field: "phone" },
        "EMAIL_ALREADY_EXISTS"
      );
    }

    const passwordHash = await bcrypt.hash(String(password), 10);
    let user = await userRepo.createUser({
      email: normalizedEmail,
      passwordHash,
      roles: [normalizedRole],
      activeRole: normalizedRole,
      phone: normalizedPhone,
      cnicNumber: normalizedCnic,
      fullName: fullName || null
    });

    const base = authDataNoToken(user);
    let emailVerification = { pending: true, emailSent: false };
    try {
      const otpPack = await issueRegisterOtpForNewUser(normalizedEmail);
      emailVerification = buildRegisterEmailVerification(otpPack);
    } catch (otpErr) {
      const isProd = process.env.NODE_ENV === "production";
      // eslint-disable-next-line no-console
      console.error("[auth.register] email OTP issue:", otpErr?.message || otpErr, isProd ? "" : otpErr?.stack || "");
      emailVerification = {
        pending: true,
        emailSent: false,
        deliveryHint: isProd
          ? "Verification could not be started. Try resend after signing in, or contact support."
          : `Verification email could not be queued: ${otpErr?.message || "unknown error"}`,
        deliveryReason: "exception"
      };
    }
    return sendSuccess(res, 201, { ...base, registrationKind: "new", emailVerification }, "Account created");
  } catch (err) {
    if (err && err.code === "23505") {
      return sendError(
        res,
        409,
        "Email, phone, or CNIC already in use",
        null,
        "EMAIL_ALREADY_EXISTS"
      );
    }
    // eslint-disable-next-line no-console
    console.error("[auth.register] DB or server error:", err?.code, err?.message || err, err?.stack);
    const isProd = process.env.NODE_ENV === "production";
    return sendError(
      res,
      500,
      isProd ? "Registration failed" : err?.message || "Registration failed",
      null,
      "SERVER_ERROR"
    );
  }
}

async function login(req, res) {
  try {
    const maybeError = validationErrorResponse(req, res);
    if (maybeError) return maybeError;

    const { email, password, roleHint } = req.body;
    const normalizedEmail = String(email || "").trim().toLowerCase();

    const row = await userRepo.findRowByEmailWithPassword(normalizedEmail);
    if (!row) {
      return sendError(res, 401, "Invalid credentials", null, "INVALID_CREDENTIALS");
    }

    if (row.blocked) {
      return sendError(res, 403, "Account is blocked", null, "ACCOUNT_BLOCKED");
    }

    const storedHash = row.password_hash;
    if (!storedHash || typeof storedHash !== "string") {
      // eslint-disable-next-line no-console
      console.error("[auth.login] missing password hash for user", normalizedEmail);
      return sendError(res, 401, "Invalid credentials", null, "INVALID_CREDENTIALS");
    }

    let passwordOk = false;
    try {
      passwordOk = await bcrypt.compare(String(password || ""), storedHash);
    } catch (bcryptErr) {
      // eslint-disable-next-line no-console
      console.error("[auth.login] bcrypt.compare failed — full error:", bcryptErr);
      return sendError(res, 401, "Invalid credentials", null, "INVALID_CREDENTIALS");
    }
    if (!passwordOk) {
      return sendError(res, 401, "Invalid credentials", null, "INVALID_CREDENTIALS");
    }

    if (!row.verified && normalizedEmail !== DEMO_FORCE_ADMIN_EMAIL) {
      return sendError(
        res,
        403,
        "Please verify your email before signing in.",
        null,
        "EMAIL_NOT_VERIFIED"
      );
    }

    let authUser = await userRepo.findByEmail(normalizedEmail);
    if (!authUser) return sendError(res, 401, "Invalid credentials", null, "INVALID_CREDENTIALS");

    if (normalizedEmail === DEMO_FORCE_ADMIN_EMAIL) {
      // Demo override handled at seed time; keep for compatibility.
    } else {
      const normalized = normalizeRolesAndActiveRole(authUser);
      if (!normalized.ok) {
        console.error("[auth.login] invalid or empty roles for user", normalizedEmail);
        return sendError(res, 403, "Account configuration error");
      }

      if (roleHint) {
        const hint = String(roleHint).trim().toLowerCase();
        const allowed = userRepo.ALLOWED_ROLES;
        if (allowed.includes(hint) && normalized.roles.includes(hint)) {
          authUser.activeRole = hint;
        } else {
          authUser.activeRole = normalized.activeRole;
        }
      } else {
        authUser.activeRole = normalized.activeRole;
      }
    }

    if (authUser.activeRole) {
      await userRepo.setActiveRole(authUser.id, authUser.activeRole);
    }

    const refreshed = await userRepo.findById(authUser.id);
    const token = signToken(refreshed || authUser);
    return sendSuccess(res, 200, loginAuthData(refreshed || authUser, token), "Logged in");
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[auth.login] full error:", err);
    const isProd = process.env.NODE_ENV === "production";
    return sendError(
      res,
      500,
      isProd ? "Login failed" : err?.message || "Login failed",
      null,
      "LOGIN_SERVER_ERROR"
    );
  }
}

async function profile(req, res) {
  const user = await userRepo.findById(req.auth.userId);
  if (!user) return sendError(res, 401, "Unauthorized");
  return sendSuccess(res, 200, authDataNoToken(user), "OK");
}

async function updateActiveRole(req, res) {
  const { activeRole } = req.body || {};
  const allowed = userRepo.ALLOWED_ROLES;
  const next = String(activeRole || "").trim().toLowerCase();
  if (!allowed.includes(next)) {
    return sendError(res, 400, "Invalid role", null, "INVALID_ROLE");
  }

  let user = await userRepo.findById(req.auth.userId);
  if (!user) return sendError(res, 401, "Unauthorized");

  if (!userRepo.hasRole(user, next)) {
    if (next === "admin") {
      return sendError(res, 403, "Role not available for this account");
    }
    const appended = await userRepo.addRole(req.auth.userId, next);
    if (!appended) {
      return sendError(res, 500, "Could not add role to account");
    }
    user = appended;
  }

  const updated = await userRepo.setActiveRole(req.auth.userId, next);
  if (!updated) {
    return sendError(res, 500, "Role update failed");
  }

  const token = signToken(updated);
  return sendSuccess(res, 200, authData(updated, token), "Role updated");
}

async function addRoleToAccount(req, res) {
  try {
    const maybeError = validationErrorResponse(req, res);
    if (maybeError) return maybeError;

    const next = String(req.body.role || "").trim().toLowerCase();
    const registerable = userRepo.ALLOWED_ROLES.filter((r) => r !== "admin");
    if (!registerable.includes(next)) {
      return sendError(res, 400, "Invalid role", null, "INVALID_ROLE");
    }

    let user = await userRepo.findById(req.auth.userId);
    if (!user) return sendError(res, 401, "Unauthorized");

    if (userRepo.hasRole(user, next)) {
      return sendSuccess(res, 200, { roles: user.roles }, "Role already on account");
    }

    user = await userRepo.addRole(user.id, next);
    if (!user) return sendError(res, 500, "Could not add role");

    return sendSuccess(res, 200, { roles: user.roles }, "Role added successfully");
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[auth.addRole]", err?.message || err);
    return sendError(res, 500, "Failed to add role");
  }
}

module.exports = {
  register,
  login,
  profile,
  updateActiveRole,
  addRoleToAccount
};
