const express = require("express");
const { body, param, query, validationResult } = require("express-validator");
const { protect, requireAnyRole } = require("../middleware/authMiddleware");
const COMMERCIAL_ROLES = ["shipper", "carrier", "admin"];
const { sendError, sendSuccess } = require("../utils/apiResponse");
const { query: db } = require("../db/pool");
const realtimeHub = require("../services/realtimeHub");
const { assertChatAttachmentFromUserUpload } = require("../controllers/uploadController");

const router = express.Router();

const ATTACHMENT_PREVIEW_SENTINEL = "__TP_FILE__";

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    String(value || "")
  );
}

function handleVal(req, res, next) {
  const e = validationResult(req);
  if (!e.isEmpty()) {
    const first = e.array()[0];
    return sendError(res, 400, first.msg || "Validation failed");
  }
  return next();
}

router.post(
  "/conversations/open",
  protect,
  requireAnyRole(COMMERCIAL_ROLES),
  body("peerUserId")
    .custom((v) => (isUuid(v) ? true : (() => { throw new Error("Invalid peerUserId"); })()))
    .bail(),
  body("loadId")
    .optional()
    .custom((v) => (isUuid(v) ? true : (() => { throw new Error("Invalid loadId"); })()))
    .bail(),
  handleVal,
  async (req, res) => {
    const me = String(req.auth.userId);
    const peer = String(req.body.peerUserId);
    const loadId = req.body.loadId ? String(req.body.loadId) : null;

    const userA = me < peer ? me : peer;
    const userB = me < peer ? peer : me;

    const { rows } = await db(
      `INSERT INTO conversations (load_id, user_a_id, user_b_id)
       VALUES ($1, $2, $3)
       ON CONFLICT (load_id, user_a_id, user_b_id)
       DO UPDATE SET updated_at = now()
       RETURNING id, load_id AS "loadId", user_a_id AS "userAId", user_b_id AS "userBId", updated_at AS "updatedAt"`,
      [loadId, userA, userB]
    );

    return sendSuccess(res, 200, rows[0], "OK");
  }
);

router.get("/conversations", protect, requireAnyRole(COMMERCIAL_ROLES), async (req, res) => {
  const uid = String(req.auth.userId);
  const { rows } = await db(
    `SELECT c.id, c.load_id AS "loadId", c.user_a_id AS "userAId", c.user_b_id AS "userBId",
            c.updated_at AS "updatedAt",
            (SELECT CASE
               WHEN m.attachment_url IS NOT NULL AND (m.body IS NULL OR trim(m.body) = '')
                 THEN $2::text
               ELSE left(trim(m.body), 200)
             END
             FROM messages m WHERE m.conversation_id = c.id ORDER BY m.created_at DESC LIMIT 1) AS "lastMessage",
            (SELECT m.created_at FROM messages m WHERE m.conversation_id = c.id ORDER BY m.created_at DESC LIMIT 1) AS "lastMessageAt"
     FROM conversations c
     WHERE c.user_a_id = $1 OR c.user_b_id = $1
     ORDER BY c.updated_at DESC
     LIMIT 200`,
    [uid, ATTACHMENT_PREVIEW_SENTINEL]
  );
  return sendSuccess(res, 200, rows);
});

router.get(
  "/conversations/:id/messages",
  protect,
  requireAnyRole(COMMERCIAL_ROLES),
  param("id").custom((v) => (isUuid(v) ? true : (() => { throw new Error("Invalid conversation id"); })())),
  query("before").optional().custom((v) => (isUuid(v) ? true : (() => { throw new Error("Invalid before id"); })())),
  query("limit").optional().isInt({ min: 1, max: 100 }),
  handleVal,
  async (req, res) => {
    const uid = String(req.auth.userId);
    const convId = String(req.params.id);
    const limit = req.query.limit ? Number(req.query.limit) : 50;

    const { rows: convRows } = await db(`SELECT id, user_a_id, user_b_id FROM conversations WHERE id = $1`, [convId]);
    const conv = convRows[0];
    if (!conv) return sendError(res, 404, "Not found");
    if (String(conv.user_a_id) !== uid && String(conv.user_b_id) !== uid) return sendError(res, 403, "Forbidden");

    const { rows } = await db(
      `SELECT id, "senderId", body, "attachmentUrl", "attachmentPublicId", "attachmentKind", "attachmentFileName", "seenAt", "createdAt"
       FROM (
         SELECT id,
                sender_id AS "senderId",
                body,
                attachment_url AS "attachmentUrl",
                attachment_public_id AS "attachmentPublicId",
                attachment_kind AS "attachmentKind",
                attachment_file_name AS "attachmentFileName",
                seen_at AS "seenAt",
                created_at AS "createdAt",
                created_at AS _ts
         FROM messages
         WHERE conversation_id = $1
         ORDER BY created_at DESC
         LIMIT $2
       ) _page
       ORDER BY _page._ts ASC`,
      [convId, limit]
    );
    return sendSuccess(res, 200, rows);
  }
);

router.post(
  "/conversations/:id/messages",
  protect,
  requireAnyRole(COMMERCIAL_ROLES),
  param("id").custom((v) => (isUuid(v) ? true : (() => { throw new Error("Invalid conversation id"); })())),
  body("body").optional().isString(),
  body("clientMessageId").optional().trim().isLength({ max: 128 }),
  body("attachment").optional(),
  handleVal,
  async (req, res) => {
    const uid = String(req.auth.userId);
    const convId = String(req.params.id);

    const { rows: convRows } = await db(`SELECT id, user_a_id, user_b_id FROM conversations WHERE id = $1`, [convId]);
    const conv = convRows[0];
    if (!conv) return sendError(res, 404, "Not found");
    if (String(conv.user_a_id) !== uid && String(conv.user_b_id) !== uid) return sendError(res, 403, "Forbidden");

    let bodyText = req.body.body != null ? String(req.body.body).trim() : "";
    if (bodyText.length > 2000) return sendError(res, 400, "Message too long");
    const bodyForDb = bodyText.length > 0 ? bodyText : null;

    const att = req.body.attachment && typeof req.body.attachment === "object" ? req.body.attachment : null;
    let attachmentUrl = null;
    let attachmentPublicId = null;
    let attachmentKind = null;
    let attachmentFileName = null;

    if (att && att.url) {
      attachmentUrl = String(att.url || "").trim();
      attachmentPublicId = String(att.publicId || "").trim();
      attachmentKind = att.kind === "pdf" ? "pdf" : att.kind === "image" ? "image" : null;
      attachmentFileName = att.fileName != null ? String(att.fileName).trim().slice(0, 200) : null;
      if (!attachmentKind) return sendError(res, 400, "attachment.kind must be image or pdf");
      if (!attachmentPublicId) return sendError(res, 400, "attachment.publicId is required");
      try {
        assertChatAttachmentFromUserUpload(uid, attachmentUrl, attachmentPublicId);
      } catch (e) {
        const code = Number(e?.statusCode) || 400;
        return sendError(res, code, e?.message || "Invalid attachment");
      }
    }

    if (!bodyForDb && !attachmentUrl) return sendError(res, 400, "Message or attachment required");

    const peerId = String(conv.user_a_id) === uid ? String(conv.user_b_id) : String(conv.user_a_id);

    const { rows } = await db(
      `INSERT INTO messages (conversation_id, sender_id, body, attachment_url, attachment_public_id, attachment_kind, attachment_file_name)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, sender_id AS "senderId", body,
                 attachment_url AS "attachmentUrl",
                 attachment_public_id AS "attachmentPublicId",
                 attachment_kind AS "attachmentKind",
                 attachment_file_name AS "attachmentFileName",
                 created_at AS "createdAt"`,
      [convId, uid, bodyForDb, attachmentUrl, attachmentPublicId, attachmentKind, attachmentFileName]
    );
    await db(`UPDATE conversations SET updated_at = now() WHERE id = $1`, [convId]);

    const msg = rows[0];
    const payload = {
      conversationId: convId,
      ...msg,
      clientMessageId: req.body.clientMessageId || null
    };
    realtimeHub.emitToUser(peerId, "chat:message", payload);

    return sendSuccess(res, 201, msg, "Sent");
  }
);

router.post(
  "/conversations/:id/read",
  protect,
  requireAnyRole(COMMERCIAL_ROLES),
  param("id").custom((v) => (isUuid(v) ? true : (() => { throw new Error("Invalid conversation id"); })())),
  body("upToMessageId").optional().custom((v) => (isUuid(v) ? true : (() => { throw new Error("Invalid upToMessageId"); })())),
  handleVal,
  async (req, res) => {
    const uid = String(req.auth.userId);
    const convId = String(req.params.id);

    const { rows: convRows } = await db(`SELECT id, user_a_id, user_b_id FROM conversations WHERE id = $1`, [convId]);
    const conv = convRows[0];
    if (!conv) return sendError(res, 404, "Not found");
    if (String(conv.user_a_id) !== uid && String(conv.user_b_id) !== uid) return sendError(res, 403, "Forbidden");

    await db(
      `UPDATE messages
       SET seen_at = COALESCE(seen_at, now())
       WHERE conversation_id = $1 AND sender_id <> $2`,
      [convId, uid]
    );
    realtimeHub.emitToUser(
      String(conv.user_a_id) === uid ? String(conv.user_b_id) : String(conv.user_a_id),
      "chat:seen",
      { conversationId: convId }
    );
    return sendSuccess(res, 200, { ok: true });
  }
);

module.exports = router;
