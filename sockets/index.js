const { verifyToken } = require("../utils/jwt");
const { query: db } = require("../db/pool");
const {
  trackRoomKey,
  buildTrackingUpdatePayload
} = require("../utils/trackingPayload");
const {
  validateGpsCoordinates,
  checkGpsThrottle,
  markGpsWritten,
  assertAssignedCarrierForGps
} = require("../utils/gpsTracking");

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

    socket.on("tracking:join", async (payload) => {
      try {
        const refKey = String(payload?.refKey || "").trim();
        if (!refKey || refKey.length > 72) return;
        const { rows: loadRows } = await db(
          `SELECT id, code, shipper_id, assigned_carrier_id
           FROM loads WHERE code = $1 OR id::text = $1 LIMIT 1`,
          [refKey]
        );
        const load = loadRows[0];
        if (!load) return;
        let isAdmin = false;
        try {
          const { rows: u } = await db(`SELECT roles FROM users WHERE id = $1`, [uid]);
          const r = u[0]?.roles;
          if (Array.isArray(r) && r.includes("admin")) isAdmin = true;
        } catch {
          /* ignore */
        }
        const isShipper = String(load.shipper_id || "") === uid;
        const isCarrier = String(load.assigned_carrier_id || "") === uid;
        if (!isShipper && !isCarrier && !isAdmin) return;
        const room = trackRoomKey(load);
        if (room) socket.join(`track:${room}`);
      } catch {
        /* ignore */
      }
    });

    socket.on("tracking:location", async (payload, ack) => {
      try {
        const refKey = String(payload?.refKey || "").trim();
        const coordCheck = validateGpsCoordinates(payload?.lat, payload?.lng);
        if (!refKey || !coordCheck.ok) {
          if (typeof ack === "function") ack({ ok: false });
          return;
        }
        const lat = coordCheck.lat;
        const lng = coordCheck.lng;

        const { rows: loadRows } = await db(
          `SELECT l.id, l.code, l.shipper_id, l.assigned_carrier_id
           FROM loads l
           WHERE l.code = $1 OR l.id::text = $1
           LIMIT 1`,
          [refKey]
        );
        const load = loadRows[0];
        if (!load) {
          if (typeof ack === "function") ack({ ok: false });
          return;
        }

        const carrierErr = assertAssignedCarrierForGps(load, uid);
        if (carrierErr) {
          if (typeof ack === "function") ack({ ok: false, message: carrierErr.message });
          return;
        }

        const throttle = checkGpsThrottle(load.id);
        if (!throttle.ok) {
          if (typeof ack === "function") {
            ack({ ok: false, message: throttle.message, retryAfterMs: throttle.retryAfterMs });
          }
          return;
        }

        await db(
          `INSERT INTO shipments (load_id, status, location_unavailable)
           VALUES ($1, 'posted', true)
           ON CONFLICT (load_id) DO NOTHING`,
          [load.id]
        );
        const result = await db(
          `UPDATE shipments
           SET current_lat = $2, current_lng = $3, location_unavailable = false, updated_at = now()
           WHERE load_id = $1`,
          [load.id, lat, lng]
        );
        if (!result.rowCount) {
          if (typeof ack === "function") ack({ ok: false });
          return;
        }
        markGpsWritten(load.id);

        const updatePayload = await buildTrackingUpdatePayload(load.id, lat, lng);
        if (!updatePayload) {
          if (typeof ack === "function") ack({ ok: false });
          return;
        }

        const room = trackRoomKey(load);
        if (room) {
          io.to(`track:${room}`).emit("tracking:update", updatePayload);
        }
        if (typeof ack === "function") ack({ ok: true, data: updatePayload });
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
