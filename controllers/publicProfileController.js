const { query } = require("../db/pool");
const { sendSuccess, sendError } = require("../utils/apiResponse");

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || ""));
}

async function hasActiveContract(viewerId, targetId) {
  const { rows } = await query(
    `SELECT 1 FROM bookings b
     WHERE b.status = 'approved'
       AND (
         (b.shipper_id = $1 AND b.carrier_id = $2)
         OR (b.shipper_id = $2 AND b.carrier_id = $1)
       )
     LIMIT 1`,
    [viewerId, targetId]
  );
  if (rows[0]) return true;
  const { rows: spaceRows } = await query(
    `SELECT 1 FROM carrier_space_requests r
     JOIN carrier_space_listings l ON l.id = r.listing_id
     WHERE r.status IN ('accepted', 'active', 'in_transit')
       AND (
         (r.shipper_id = $1 AND l.carrier_id = $2)
         OR (r.shipper_id = $2 AND l.carrier_id = $1)
       )
     LIMIT 1`,
    [viewerId, targetId]
  );
  return Boolean(spaceRows[0]);
}

async function getPublicProfile(req, res) {
  const targetId = String(req.params.id || "");
  if (!isUuid(targetId)) return sendError(res, 400, "Invalid profile id");

  const { rows: userRows } = await query(
    `SELECT id, email, full_name AS "fullName", phone, profile_image AS "profileImage",
            roles, active_role AS "activeRole", is_profile_complete AS "profileComplete",
            created_at AS "joinedAt"
     FROM users WHERE id = $1`,
    [targetId]
  );
  const user = userRows[0];
  if (!user) return sendError(res, 404, "Profile not found");

  const viewerId = req.auth?.userId ? String(req.auth.userId) : null;
  const showPhone = viewerId && (viewerId === targetId || (await hasActiveContract(viewerId, targetId)));

  const { rows: ratingRows } = await query(
    `SELECT COALESCE(AVG(score), 0)::numeric(10,2) AS avg, COUNT(*)::int AS count
     FROM ratings WHERE to_user_id = $1`,
    [targetId]
  );

  const { rows: trucks } = await query(
    `SELECT id, truck_type AS "truckType", capacity,
            truck_card_front_image AS "truckCardFrontImage",
            license_plate AS "licensePlate"
     FROM trucks WHERE user_id = $1 ORDER BY created_at DESC LIMIT 12`,
    [targetId]
  );

  const { rows: activeRows } = await query(
    `SELECT COUNT(*)::int AS c FROM bookings
     WHERE status = 'approved' AND (shipper_id = $1 OR carrier_id = $1)`,
    [targetId]
  );

  const { rows: completedRows } = await query(
    `SELECT COUNT(*)::int AS c FROM shipments s
     JOIN loads l ON l.id = s.load_id
     WHERE s.status IN ('delivered', 'closed')
       AND (l.shipper_id = $1 OR l.assigned_carrier_id = $1)`,
    [targetId]
  );

  const completed = Number(completedRows[0]?.c || 0);
  const active = Number(activeRows[0]?.c || 0);
  const totalJobs = completed + active;
  const completionRate = totalJobs > 0 ? Math.round((completed / totalJobs) * 100) : null;

  const { rows: recentBid } = await query(
    `SELECT MAX(updated_at) AS last FROM bids WHERE carrier_id = $1 OR load_id IN (SELECT id FROM loads WHERE shipper_id = $1)`,
    [targetId]
  );
  const lastActive = recentBid[0]?.last ? new Date(recentBid[0].last) : null;
  const isActiveNow = lastActive && Date.now() - lastActive.getTime() < 7 * 24 * 60 * 60 * 1000;

  return sendSuccess(res, 200, {
    id: user.id,
    fullName: user.fullName || user.email?.split("@")[0] || "User",
    roles: user.roles || [],
    activeRole: user.activeRole,
    profileImage: user.profileImage,
    phone: showPhone ? user.phone : null,
    phoneLocked: !showPhone,
    profileComplete: Boolean(user.profileComplete),
    verified: Boolean(user.profileComplete),
    joinedAt: user.joinedAt,
    ratingAverage: Number(ratingRows[0]?.avg || 0),
    ratingCount: Number(ratingRows[0]?.count || 0),
    completionRate,
    isActiveNow: Boolean(isActiveNow),
    trucks,
    activeDeliveries: active,
    completedDeliveries: completed
  });
}

module.exports = { getPublicProfile };
