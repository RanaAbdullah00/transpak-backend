const bcrypt = require("bcrypt");
const { validationResult } = require("express-validator");
const { signToken } = require("../utils/jwt");
const { sendSuccess, sendError } = require("../utils/apiResponse");
const { authData, authDataNoToken, loginAuthData } = require("../utils/authPayload");
const userRepo = require("../repositories/userRepo");
const { upsertPendingRegistrationAndSendOtp, issueRegisterOtpForNewUser } = require("./emailOtpController");
const { isDevAuthRelaxEnabled, isAllowlistedDevTestEmail } = require("../utils/devAuthMode");
const devAuthTestState = require("../services/devAuthTestState");
const {
  buildRegisterEmailVerification,
  buildFailedRegisterEmailVerification
} = require("../utils/otpDelivery");

const {
  isAdminAccount,
  resolveAuthUserForSession,
  resolveLoginActiveRole,
  canChangeActiveRole
} = require("../utils/authSessionPolicy");
const { notifyUser } = require("../utils/notifyEvent");
const { isTransientDbError, classifyDbError } = require("../utils/dbErrors");
const { writeAudit } = require("../utils/auditLog");

async function withDbRetry(fn, attempts = 2) {
  let lastErr;
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i < attempts - 1 && isTransientDbError(err)) {
        await new Promise((r) => setTimeout(r, 350 * (i + 1)));
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

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

async function register(req, res) {
  try {
    const maybeError = validationErrorResponse(req, res);
    if (maybeError) return maybeError;

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
    let row = await userRepo.findRowByEmailWithPassword(normalizedEmail);
    let passwordOk = false;
    if (row?.password_hash) {
      try {
        passwordOk = await bcrypt.compare(String(password), row.password_hash);
      } catch {
        passwordOk = false;
      }
    }

    /*
     * DEV_MODE + DEV_AUTH_TEST_EMAILS (non-production only): allow "re-registering" the same
     * allowlisted mailbox with a new password for iterative OTP testing. Clears OTP/pending state,
     * updates password hash, sets verified=false — user row and FK-related data stay intact.
     * Reversible: turn off DEV_MODE or remove the email from DEV_AUTH_TEST_EMAILS.
     */
    if (existing && !passwordOk && isDevAuthRelaxEnabled() && isAllowlistedDevTestEmail(normalizedEmail)) {
      await devAuthTestState.clearOtpAndPendingForEmail(normalizedEmail);
      const nextHash = await bcrypt.hash(String(password), 10);
      await userRepo.updatePasswordHashByEmail(normalizedEmail, nextHash);
      await userRepo.setVerifiedByEmail(normalizedEmail, false);
      row = await userRepo.findRowByEmailWithPassword(normalizedEmail);
      passwordOk = row?.password_hash
        ? await bcrypt.compare(String(password), row.password_hash).catch(() => false)
        : false;
    }

    if (existing) {
      if (!row?.password_hash) {
        return sendError(
          res,
          409,
          "This email is already registered, but the account has no password. Use your original sign-in method or contact support.",
          null,
          "EMAIL_ALREADY_EXISTS"
        );
      }
      const passwordOkFinal = passwordOk;
      if (!passwordOkFinal) {
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
          emailVerification = buildFailedRegisterEmailVerification(
            isProd
              ? "Verification could not be started. Try resend after signing in, or contact support."
              : `Verification email could not be queued: ${otpErr?.message || "unknown error"}`
          );
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

    const passwordHash = await bcrypt.hash(String(password), 10);
    let emailVerification = { pending: true, emailSent: false };
    try {
      const otpPack = await upsertPendingRegistrationAndSendOtp({
        email: normalizedEmail,
        phone: normalizedPhone,
        cnicNumber: normalizedCnic,
        fullName: fullName || null,
        passwordHash,
        role: normalizedRole
      });
      emailVerification = buildRegisterEmailVerification(otpPack);
    } catch (otpErr) {
      const isProd = process.env.NODE_ENV === "production";
      // eslint-disable-next-line no-console
      console.error("[auth.register] pending signup OTP issue:", otpErr?.message || otpErr, isProd ? "" : otpErr?.stack || "");
      emailVerification = buildFailedRegisterEmailVerification(
        isProd
          ? "Verification could not be started. Try again shortly or contact support."
          : `Verification email could not be queued: ${otpErr?.message || "unknown error"}`
      );
    }
    return sendSuccess(
      res,
      200,
      {
        registrationKind: "pending",
        email: normalizedEmail,
        emailVerification
      },
      "Verification code sent"
    );
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
  const loginStarted = Date.now();
  try {
    const maybeError = validationErrorResponse(req, res);
    if (maybeError) return maybeError;

    const { email, password, roleHint: bodyRoleHint, role: bodyRole } = req.body;
    const normalizedEmail = String(email || "").trim().toLowerCase();
    const roleHint = String(bodyRoleHint || bodyRole || "").trim().toLowerCase();

    // eslint-disable-next-line no-console
    console.log("[auth.login] start", { email: normalizedEmail });

    const lookupStarted = Date.now();
    const row = await withDbRetry(() => userRepo.findRowByEmailWithPassword(normalizedEmail));
    // eslint-disable-next-line no-console
    console.log("[auth.login] db_lookup_ms", Date.now() - lookupStarted);
    if (!row) {
      return sendError(res, 401, "Invalid username", null, "USER_NOT_FOUND");
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
      return sendError(res, 401, "Invalid password", null, "INVALID_CREDENTIALS");
    }

    if (!row.verified) {
      return sendError(
        res,
        403,
        "Please verify your email before signing in.",
        null,
        "EMAIL_NOT_VERIFIED"
      );
    }

    let authUser = await withDbRetry(() => userRepo.findByEmail(normalizedEmail));
    if (!authUser) return sendError(res, 401, "Invalid credentials", null, "INVALID_CREDENTIALS");

    const { sanitizeRolesForStorage } = require("../utils/rolePolicy");
    const { validateLoginRoleHint } = require("../utils/policyEngine");
    const roleCheck = validateLoginRoleHint(authUser, roleHint);
    if (!roleCheck.ok) {
      return sendError(res, roleCheck.status, roleCheck.message, null, roleCheck.code);
    }
    const resolvedRole = resolveLoginActiveRole(authUser, normalizedEmail, roleHint);
    if (!resolvedRole) {
      return sendError(res, 403, "Account configuration error", null, "INVALID_ROLES");
    }

    const sanitized = sanitizeRolesForStorage(
      isAdminAccount(authUser) ? ["admin"] : authUser.roles,
      resolvedRole
    );
    await withDbRetry(() =>
      userRepo.setRolesAndActive(authUser.id, sanitized.roles, sanitized.activeRole)
    );

    const refreshed = await withDbRetry(() => userRepo.findById(authUser.id));
    const sessionUser = await resolveAuthUserForSession(refreshed || authUser);
    const token = signToken(sessionUser);

    try {
      await notifyUser({
        receiverId: sessionUser.id,
        senderId: sessionUser.id,
        roleType: sessionUser.activeRole,
        title: "LOGIN_SUCCESS",
        type: "LOGIN_SUCCESS",
        message: `Welcome back ${String(sessionUser.fullName || sessionUser.name || sessionUser.email || "there").trim().split("@")[0]}`
      });
    } catch (notifyErr) {
      // eslint-disable-next-line no-console
      console.error("[auth.login] login notification failed:", notifyErr?.message || notifyErr);
    }

    // eslint-disable-next-line no-console
    console.log("[auth.login] complete", { status: 200, ms: Date.now() - loginStarted });
    void writeAudit({
      actorUserId: sessionUser.id,
      action: "auth.login",
      targetEntity: "user",
      targetId: sessionUser.id,
      metadata: { activeRole: sessionUser.activeRole }
    });
    return sendSuccess(res, 200, loginAuthData(sessionUser, token), "Logged in");
  } catch (err) {
    const classified = classifyDbError(err);
    // eslint-disable-next-line no-console
    console.error(
      "[auth.login] fail",
      classified.code || "SERVER_ERROR",
      classified.log || err?.message || err,
      { ms: Date.now() - loginStarted }
    );
    if (classified.code !== "SERVER_ERROR") {
      return sendError(res, classified.status, classified.message, null, classified.code);
    }
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
  try {
    let user = await userRepo.findById(req.auth.userId);
    if (!user) return sendError(res, 401, "Unauthorized");
    user = (await userRepo.enforceSingleRolePolicy(user.id)) || user;
    const sessionUser = await resolveAuthUserForSession(user);
    const token = signToken(sessionUser);
    return sendSuccess(res, 200, authData(sessionUser, token), "OK");
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[auth.profile]", err?.message || err);
    return sendError(res, 500, "Could not load profile", null, "SERVER_ERROR");
  }
}

async function updateActiveRole(req, res) {
  try {
  const { activeRole } = req.body || {};
  const allowed = userRepo.ALLOWED_ROLES;
  const next = String(activeRole || "").trim().toLowerCase();
  if (!allowed.includes(next)) {
    return sendError(res, 400, "Invalid role", null, "INVALID_ROLE");
  }

  let user = await userRepo.findById(req.auth.userId);
  if (!user) return sendError(res, 401, "Unauthorized");

  if (next === "admin" && !userRepo.hasRole(user, "admin")) {
    return sendError(res, 403, "Role not available for this account");
  }

  if (!userRepo.hasRole(user, next)) {
    return sendError(res, 403, "Role not available for this account", null, "ROLE_NOT_GRANTED");
  }

  if (!canChangeActiveRole(user, next)) {
    if (isAdminAccount(user)) {
      return sendError(
        res,
        403,
        "Admin accounts cannot use shipper or carrier workspace",
        null,
        "ADMIN_ROLE_LOCKED"
      );
    }
    return sendError(res, 403, "Role switching is disabled", null, "ROLE_SWITCH_DISABLED");
  }

  const { validateRoleMutation } = require("../utils/rolePolicy");
  const policy = validateRoleMutation(user, next);
  if (!policy.ok) {
    return sendError(res, 403, policy.message, null, policy.code);
  }

  const updated = await userRepo.setRolesAndActive(req.auth.userId, policy.roles, policy.activeRole);
  if (!updated) {
    return sendError(res, 500, "Role update failed");
  }

  const token = signToken(updated);
  void writeAudit({
    actorUserId: req.auth.userId,
    action: "role.switched",
    targetEntity: "user",
    targetId: req.auth.userId,
    metadata: { activeRole: next }
  });
  return sendSuccess(res, 200, authData(updated, token), "Role updated");
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[auth.updateActiveRole]", err?.message || err);
    return sendError(res, 500, "Role update failed", null, "SERVER_ERROR");
  }
}

async function addRoleToAccount(req, res) {
  try {
    const maybeError = validationErrorResponse(req, res);
    if (maybeError) return maybeError;

    const next = String(req.body.role || "").trim().toLowerCase();
    const user = await userRepo.findById(req.auth.userId);
    if (!user) return sendError(res, 401, "Unauthorized");

    const { validateAddRole } = require("../utils/rolePolicy");
    const check = validateAddRole(user, next);
    if (!check.ok) {
      return sendError(res, 403, check.message, null, check.code);
    }
    if (check.already) {
      const token = signToken(user);
      return sendSuccess(res, 200, authData(user, token), "Role already on account");
    }

    const updated = await userRepo.addRole(req.auth.userId, next);
    if (!updated) {
      return sendError(res, 500, "Failed to add role", null, "ROLE_ADD_FAILED");
    }

    const token = signToken(updated);
    void writeAudit({
      actorUserId: req.auth.userId,
      action: "role.added",
      targetEntity: "user",
      targetId: req.auth.userId,
      metadata: { role: next }
    });
    return sendSuccess(res, 200, authData(updated, token), "Role added");
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[auth.addRole]", err?.message || err);
    return sendError(res, 500, "Failed to add role", null, "SERVER_ERROR");
  }
}

module.exports = {
  register,
  login,
  profile,
  updateActiveRole,
  addRoleToAccount
};
