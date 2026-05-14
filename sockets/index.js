const { verifyToken } = require("../utils/jwt");
const { query: db } = require("../db/pool");

function extractToken(socket) {
  const a = socket.handshake.auth;
  if (a && typeof a.token === "string" && a.token.trim()) return a.token.trim();
  const h = socket.handshake.headers?.authorization;
  if (typeof h === "string" && h.startsWith("Bearer ")) return h.slice(7).trim();
  return null;
}

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    String(value || "")
  );
}

module.exports = function registerSocketHandlers(io) {
  io.use((socket, next) => {
    try {
      const token = extractToken(socket);
      if (!token) return next(new Error("auth_required"));
      const decoded = verifyToken(token);
      socket.userId = decoded.sub;
      return next();
    } catch {
      return next(new Error("auth_required"));
    }
  });

  io.on("connection", (socket) => {
    const uid = String(socket.userId);
    socket.join(`user:${uid}`);

    socket.on("chat:join", async (payload, ack) => {
      try {
        const convId = payload?.conversationId;
        if (!isUuid(convId)) {
          if (typeof ack === "function") ack({ ok: false });
          return;
        }
        const { rows } = await db(`SELECT user_a_id, user_b_id FROM conversations WHERE id = $1`, [convId]);
        const c = rows[0];
        if (!c || (String(c.user_a_id) !== uid && String(c.user_b_id) !== uid)) {
          if (typeof ack === "function") ack({ ok: false });
          return;
        }
        socket.join(`conv:${convId}`);
        if (typeof ack === "function") ack({ ok: true });
      } catch {
        if (typeof ack === "function") ack({ ok: false });
      }
    });

    socket.on("chat:seen", async (payload) => {
      try {
        const convId = payload?.conversationId;
        if (!isUuid(convId)) return;
        const { rows } = await db(`SELECT user_a_id, user_b_id FROM conversations WHERE id = $1`, [convId]);
        const c = rows[0];
        if (!c || (String(c.user_a_id) !== uid && String(c.user_b_id) !== uid)) return;
        await db(
          `UPDATE messages SET seen_at = COALESCE(seen_at, now()) WHERE conversation_id = $1 AND sender_id <> $2`,
          [convId, uid]
        );
        const peerId = String(c.user_a_id) === uid ? String(c.user_b_id) : String(c.user_a_id);
        io.to(`user:${peerId}`).emit("chat:seen", { conversationId: convId });
      } catch {
        /* ignore */
      }
    });
  });
};
