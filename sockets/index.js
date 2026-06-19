const { verifyToken } = require("../utils/jwt");
const { query: db } = require("../db/pool");
const {
  trackRoomKey
} = require("../utils/trackingPayload");
const {
  validateGpsCoordinates,
  checkGpsThrottle,
  markGpsWritten,
  assertAssignedCarrierForGps
} = require("../utils/gpsTracking");
const { appendShipmentLocationLog } = require("../utils/shipmentLocationLog");
const { publishTrackingEvent } = require("../utils/trackingEventPublisher");
const realtimeHub = require("../services/realtimeHub");
const { normalizeWorkspace } = require("../utils/commercialWorkspace");
const { allowSocketEvent, clearSocketRateLimits } = require("../utils/socketEventRateLimit");
const {
  recordSocketConnect,
  recordSocketDisconnect
} = require("../utils/opsTelemetry");

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

  function joinWorkspaceRooms(sock, userId, workspace) {
    const uid = String(userId);
    const ws = String(workspace || "").trim().toLowerCase();
    if (ws === "shipper" || ws === "carrier" || ws === "admin") {
      for (const other of ["shipper", "carrier", "admin"]) {
        if (other !== ws) sock.leave(`user:${uid}:role:${other}`);
      }
      sock.join(`user:${uid}:role:${ws}`);
    }
  }

  function canJoinWorkspace(userRoles, workspace) {
    const ws = normalizeWorkspace(workspace);
    if (!ws) return false;
    const roles = (userRoles || []).map((r) => String(r).trim().toLowerCase());
    if (ws === "admin") return roles.includes("admin");
    return roles.includes(ws);
  }

  io.on("connection", async (socket) => {
    const uid = String(socket.userId);
    recordSocketConnect();

    let userRoles = [];
    let dbActiveRole = null;
    try {
      const { rows } = await db(`SELECT roles, active_role FROM users WHERE id = $1`, [uid]);
      userRoles = Array.isArray(rows[0]?.roles) ? rows[0].roles : [];
      dbActiveRole = rows[0]?.active_role;
      socket.userRoles = userRoles;
    } catch {
      socket.userRoles = [];
    }

    const handshakeWorkspace = String(socket.handshake?.auth?.workspace || "").trim().toLowerCase();
    if (canJoinWorkspace(userRoles, handshakeWorkspace)) {
      joinWorkspaceRooms(socket, uid, handshakeWorkspace);
    } else {
      const fallback = normalizeWorkspace(dbActiveRole);
      if (canJoinWorkspace(userRoles, fallback)) {
        joinWorkspaceRooms(socket, uid, fallback);
      } else if (userRoles.length === 1 && canJoinWorkspace(userRoles, userRoles[0])) {
        joinWorkspaceRooms(socket, uid, userRoles[0]);
      }
    }

    socket.on("disconnect", (reason) => {
      clearSocketRateLimits(socket);
      recordSocketDisconnect(reason);
    });

    socket.on("workspace:join", (payload) => {
      if (!allowSocketEvent(socket, "workspace:join")) return;
      const ws = String(payload?.workspace || payload?.activeRole || "").trim().toLowerCase();
      if (!canJoinWorkspace(socket.userRoles, ws)) return;
      if (ws === "shipper" || ws === "carrier" || ws === "admin") {
        joinWorkspaceRooms(socket, uid, ws);
      }
    });

    socket.on("chat:join", async (payload, ack) => {
      if (!allowSocketEvent(socket, "chat:join")) {
        if (typeof ack === "function") ack({ ok: false, rateLimited: true });
        return;
      }
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
      if (!allowSocketEvent(socket, "tracking:join")) return;
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
        const isShipper = String(load.shipper_id || "") === uid;
        const isCarrier = String(load.assigned_carrier_id || "") === uid;
        if (!isShipper && !isCarrier) return;
        const room = trackRoomKey(load);
        if (room) socket.join(`track:${room}`);
        const { rows: shipRows } = await db(`SELECT id FROM shipments WHERE load_id = $1 LIMIT 1`, [
          load.id
        ]);
        if (shipRows[0]?.id) socket.join(`shipment:${shipRows[0].id}`);
      } catch {
        /* ignore */
      }
    });

    socket.on("space:join", async (payload) => {
      if (!allowSocketEvent(socket, "space:join")) return;
      try {
        const requestId = String(payload?.requestId || "").trim();
        if (!isUuid(requestId)) return;
        const { rows } = await db(
          `SELECT r.id, r.shipper_id, l.carrier_id
           FROM carrier_space_requests r
           JOIN carrier_space_listings l ON l.id = r.listing_id
           WHERE r.id = $1`,
          [requestId]
        );
        const row = rows[0];
        if (!row) return;
        const isParty =
          String(row.shipper_id) === uid || String(row.carrier_id) === uid;
        if (!isParty) return;
        socket.join(`space:${requestId}`);
      } catch {
        /* ignore */
      }
    });

    socket.on("bid:join", async (payload) => {
      if (!allowSocketEvent(socket, "bid:join")) return;
      try {
        const bidId = String(payload?.bidId || "").trim();
        if (!isUuid(bidId)) return;
        const { rows } = await db(
          `SELECT b.id, b.carrier_id, l.shipper_id
           FROM bids b
           JOIN loads l ON l.id = b.load_id
           WHERE b.id = $1`,
          [bidId]
        );
        const row = rows[0];
        if (!row) return;
        const isParty =
          String(row.carrier_id) === uid || String(row.shipper_id) === uid;
        if (!isParty) return;
        socket.join(`bid:${bidId}`);
      } catch {
        /* ignore */
      }
    });

    socket.on("shipment:join", async (payload) => {
      if (!allowSocketEvent(socket, "shipment:join")) return;
      try {
        const shipmentId = String(payload?.shipmentId || "").trim();
        if (!isUuid(shipmentId)) return;
        const { rows } = await db(
          `SELECT s.id, l.shipper_id, l.assigned_carrier_id
           FROM shipments s
           JOIN loads l ON l.id = s.load_id
           WHERE s.id = $1`,
          [shipmentId]
        );
        const row = rows[0];
        if (!row) return;
        const isParty =
          String(row.shipper_id) === uid || String(row.assigned_carrier_id) === uid;
        if (!isParty) return;
        socket.join(`shipment:${shipmentId}`);
      } catch {
        /* ignore */
      }
    });

    socket.on("tracking:location", async (payload, ack) => {
      if (!allowSocketEvent(socket, "tracking:location")) {
        if (typeof ack === "function") ack({ ok: false, rateLimited: true });
        return;
      }
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

        const { normalizeShipmentStatus } = require("../utils/shipmentStatus");
        const { rows: shipGate } = await db(
          `SELECT status FROM shipments WHERE load_id = $1 LIMIT 1`,
          [load.id]
        );
        const shipCanon = normalizeShipmentStatus(shipGate[0]?.status) || "posted";
        if (!["booked", "pickedup", "intransit"].includes(shipCanon)) {
          if (typeof ack === "function") {
            ack({ ok: false, message: "Live tracking is available after the shipment is booked" });
          }
          return;
        }

        const throttle = checkGpsThrottle(load.id);
        if (!throttle.ok) {
          if (typeof ack === "function") {
            ack({ ok: false, message: throttle.message, retryAfterMs: throttle.retryAfterMs });
          }
          return;
        }

        const { createShipmentUnified } = require("../utils/shipmentFactory");
        await createShipmentUnified({ query: db }, { loadId: load.id, mode: "posted_gps" });
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
        await appendShipmentLocationLog(load.id, lat, lng);

        const { rows: shipRows } = await db(`SELECT id FROM shipments WHERE load_id = $1 LIMIT 1`, [
          load.id
        ]);

        const updatePayload = await publishTrackingEvent({
          loadId: load.id,
          shipmentId: shipRows[0]?.id,
          lat,
          lng,
          source: "socket",
          eventId: payload?.eventId,
          idempotencyKey: payload?.idempotencyKey
        });
        if (!updatePayload) {
          if (typeof ack === "function") ack({ ok: false, duplicate: true });
          return;
        }
        if (typeof ack === "function") ack({ ok: true, data: updatePayload });
      } catch {
        if (typeof ack === "function") ack({ ok: false });
      }
    });

    socket.on("chat:seen", async (payload) => {
      if (!allowSocketEvent(socket, "chat:seen")) return;
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
        const { rows: peerRows } = await db(`SELECT roles FROM users WHERE id = $1`, [peerId]);
        const peerRoles = Array.isArray(peerRows[0]?.roles) ? peerRows[0].roles : [];
        const commercial = peerRoles.filter((r) => r === "shipper" || r === "carrier");
        if (commercial.length) {
          commercial.forEach((r) =>
            realtimeHub.emitToUserRole(peerId, r, "chat:seen", { conversationId: convId })
          );
        } else {
          realtimeHub.emitToUserRole(peerId, "admin", "chat:seen", { conversationId: convId });
        }
      } catch {
        /* ignore */
      }
    });
  });
};
