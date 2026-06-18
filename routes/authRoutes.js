const express = require("express");
const { body } = require("express-validator");
const rateLimit = require("express-rate-limit");
const { register, login, profile, updateActiveRole, addRoleToAccount } = require("../controllers/authController");
const {
  verifyRegisterOtp,
  resendRegisterOtp,
  sendForgotPasswordOtp,
  resetPasswordWithOtp,
  smtpPing
} = require("../controllers/emailOtpController");
const { sendAuthOtp, verifyAuthOtp, resendAuthOtp } = require("../controllers/authOtpAuthController");
const { protect } = require("../middleware/authMiddleware");
const userRepo = require("../repositories/userRepo");
const { asyncHandler } = require("../utils/asyncHandler");

const router = express.Router();

const allowedRoles = userRepo.ALLOWED_ROLES;
const registerableRoles = allowedRoles.filter((r) => r !== "admin");

// Basic brute-force protection for login
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  skip: () =>
    process.env.NODE_ENV !== "production" &&
    process.env.INTEGRATION_SERVER_READY === "1" &&
    process.env.DISABLE_LOGIN_RATE_LIMIT === "1",
  message: {
    success: false,
    message: "Too many login attempts, please try again later",
    data: null
  }
});

const otpVerifyLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 40,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { success: false, message: "Too many attempts, please try again later", data: null }
});

const otpSendLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 8,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { success: false, message: "Too many code requests, please try again later", data: null }
});

const smtpPingLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 10,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { success: false, message: "Too many email test requests", data: null }
});

const authOtpSendLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 8,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { success: false, message: "Too many OTP requests", data: null }
});

router.post(
  "/send-otp",
  authOtpSendLimiter,
  [body("email").trim().isEmail().withMessage("Valid email is required")],
  asyncHandler(sendAuthOtp)
);

router.post(
  "/verify-otp",
  otpVerifyLimiter,
  [
    body("email").trim().isEmail().withMessage("Valid email is required"),
    body("code")
      .trim()
      .isLength({ min: 6, max: 6 })
      .withMessage("Code must be 6 digits")
      .matches(/^[0-9]+$/)
      .withMessage("Code must be numeric")
  ],
  asyncHandler(verifyAuthOtp)
);

router.post(
  "/resend-otp",
  authOtpSendLimiter,
  [body("email").trim().isEmail().withMessage("Valid email is required")],
  asyncHandler(resendAuthOtp)
);

router.post(
  "/register",
  [
    body("name").trim().isLength({ min: 2 }).withMessage("Name must be at least 2 characters"),
    body("email").trim().isEmail().withMessage("Valid email is required"),
    body("phone")
      .trim()
      .custom((value) => {
        // Accept international numbers with or without '+', 8-15 digits (E.164 style)
        const raw = String(value ?? "").trim();
        const normalized = raw.startsWith("+") ? raw : `+${raw}`;
        if (!/^\+[1-9]\d{7,14}$/.test(normalized)) {
          throw new Error("Phone must be a valid international number");
        }
        return true;
      }),
    body("CNIC")
      .trim()
      .matches(/^[0-9]{5}-[0-9]{7}-[0-9]{1}$/)
      .withMessage("CNIC must be XXXXX-XXXXXXX-X"),
    body("password")
      .isLength({ min: 8 })
      .withMessage("Password must be at least 8 characters"),
    body("confirmPassword")
      .isLength({ min: 1 })
      .withMessage("Confirm password is required")
      .custom((value, { req }) => {
        if (String(value) !== String(req.body.password)) {
          throw new Error("Passwords do not match");
        }
        return true;
      }),
    body("role")
      .trim()
      .toLowerCase()
      .isIn(registerableRoles)
      .withMessage(`Role must be one of: ${registerableRoles.join(", ")}`)
  ],
  asyncHandler(register)
);

router.post(
  "/login",
  loginLimiter,
  [
    body("email").trim().isEmail().withMessage("Valid email is required"),
    body("password").isLength({ min: 1 }).withMessage("Password is required"),
    body("roleHint").optional().trim().toLowerCase().isIn(allowedRoles).withMessage("Invalid roleHint"),
    body("role").optional().trim().toLowerCase().isIn(allowedRoles).withMessage("Invalid role")
  ],
  asyncHandler(login)
);

/**
 * Email OTP (public; no Bearer on these paths).
 * Actual routes (POST /api/auth/...):
 *   /otp/register/verify  — body: { email, code }
 *   /otp/register/resend  — body: { email }
 *   /otp/forgot/send      — body: { email }
 *   /otp/forgot/reset     — body: { email, code, password, confirmPassword }
 * Security: rate limits + bcrypt(code) in DB + expiry + attempt cap + resend cooldown (see emailOtpController).
 *
 * Diagnostic (same Brevo API as OTP):
 *   POST /otp/smtp-ping  body: { to?: string } — dev: no secret; prod: header x-smtp-test-secret = SMTP_TEST_SECRET
 */
router.post(
  "/otp/smtp-ping",
  smtpPingLimiter,
  [body("to").optional({ values: "falsy" }).trim().isEmail().withMessage("Valid email if provided")],
  asyncHandler(smtpPing)
);

router.post(
  "/otp/register/verify",
  otpVerifyLimiter,
  [
    body("email").trim().isEmail().withMessage("Valid email is required"),
    body("code")
      .trim()
      .isLength({ min: 6, max: 6 })
      .withMessage("Code must be 6 digits")
      .matches(/^[0-9]+$/)
      .withMessage("Code must be numeric")
  ],
  asyncHandler(verifyRegisterOtp)
);

router.post(
  "/otp/register/resend",
  otpSendLimiter,
  [body("email").trim().isEmail().withMessage("Valid email is required")],
  asyncHandler(resendRegisterOtp)
);

router.post(
  "/otp/forgot/send",
  otpSendLimiter,
  [body("email").trim().isEmail().withMessage("Valid email is required")],
  asyncHandler(sendForgotPasswordOtp)
);

router.post(
  "/otp/forgot/reset",
  otpVerifyLimiter,
  [
    body("email").trim().isEmail().withMessage("Valid email is required"),
    body("code")
      .trim()
      .isLength({ min: 6, max: 6 })
      .withMessage("Code must be 6 digits")
      .matches(/^[0-9]+$/)
      .withMessage("Code must be numeric"),
    body("password").isLength({ min: 8 }).withMessage("Password must be at least 8 characters"),
    body("confirmPassword")
      .isLength({ min: 1 })
      .withMessage("Confirm password is required")
      .custom((value, { req }) => {
        if (String(value) !== String(req.body.password)) {
          throw new Error("Passwords do not match");
        }
        return true;
      })
  ],
  asyncHandler(resetPasswordWithOtp)
);

router.get("/profile", protect, asyncHandler(profile));

router.patch("/active-role", protect, asyncHandler(updateActiveRole));

router.post(
  "/add-role",
  protect,
  [body("role").trim().toLowerCase().isIn(registerableRoles).withMessage("Invalid role")],
  asyncHandler(addRoleToAccount)
);

module.exports = router;

