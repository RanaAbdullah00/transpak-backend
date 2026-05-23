const express = require("express");
const { body, validationResult } = require("express-validator");
const { protect } = require("../middleware/authMiddleware");
const { sendSuccess, sendError } = require("../utils/apiResponse");
const { query } = require("../db/pool");
const { asyncHandler } = require("../utils/asyncHandler");

const router = express.Router();

function validate(req, res, next) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return sendError(res, 400, errors.array()[0]?.msg || "Validation error", {
      fields: errors.array().map((e) => e.path)
    });
  }
  return next();
}

router.post(
  "/",
  protect,
  [
    body("subject").trim().isLength({ min: 1, max: 120 }).withMessage("subject is required"),
    body("message").trim().isLength({ min: 1, max: 2000 }).withMessage("message is required")
  ],
  validate,
  asyncHandler(async (req, res) => {
    const subject = String(req.body.subject || "").trim();
    const message = String(req.body.message || "").trim();
    const title = `[Feedback] ${subject}`.slice(0, 120);

    const { rows: admins } = await query(
      `SELECT id FROM users WHERE blocked = false AND 'admin' = ANY(roles) LIMIT 50`
    );
    if (!admins.length) {
      return sendError(res, 503, "Support is temporarily unavailable. Please try again later.");
    }

    const senderId = req.auth.userId;
    for (const admin of admins) {
      await query(
        `INSERT INTO notifications (receiver_id, sender_id, role_type, title, message)
         VALUES ($1, $2, 'admin', $3, $4)`,
        [admin.id, senderId, title, message]
      );
    }

    return sendSuccess(res, 201, { delivered: admins.length }, "Feedback submitted");
  })
);

module.exports = router;
