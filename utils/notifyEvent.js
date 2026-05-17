const { query } = require("../db/pool");
const { emitToUser } = require("../services/realtimeHub");

async function notifyUser({ receiverId, senderId, roleType, title, message, type }) {
  if (!receiverId || !title || !message) return null;
  try {
    const eventType = type || title;
    const { rows } = await query(
      `INSERT INTO notifications (receiver_id, sender_id, role_type, title, message)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, sender_id AS "senderId", receiver_id AS "receiverId", role_type AS "roleType",
                 title, message, read, created_at AS "createdAt"`,
      [receiverId, senderId || null, roleType || null, String(title).slice(0, 200), String(message).slice(0, 2000)]
    );
    const row = rows[0];
    if (row) {
      const payload = {
        id: row.id,
        senderId: row.senderId,
        receiverId: row.receiverId,
        roleType: row.roleType,
        type: eventType,
        title: row.title,
        message: row.message,
        read: false,
        createdAt: row.createdAt
      };
      emitToUser(receiverId, "notification:new", payload);
    }
    return row;
  } catch {
    return null;
  }
}

module.exports = { notifyUser };
