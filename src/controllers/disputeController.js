const { sendSuccess, sendError } = require("../../utils/apiResponse");
const { query } = require("../../db/pool");

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || ""));
}

async function create(req, res) {
  try {
    const shipmentId = String(req.body?.shipmentId || "").trim();
    const reason = String(req.body?.reason || "").trim();
    if (!isUuid(shipmentId)) return sendError(res, 400, "shipmentId is required");
    if (reason.length < 10 || reason.length > 2000) return sendError(res, 400, "reason must be 10-2000 chars");

    const { rows: loadRows } = await query(
      `SELECT l.id AS load_id, l.code AS load_code, l.shipper_id, l.assigned_carrier_id, s.id AS shipment_id
       FROM shipments s
       JOIN loads l ON l.id = s.load_id
       WHERE s.id = $1`,
      [shipmentId]
    );
    const row = loadRows[0];
    if (!row) return sendError(res, 404, "Shipment not found");

    const uid = String(req.auth.userId);
    const isAdmin = (req.auth.roles || []).includes("admin");
    const isShipper = String(row.shipper_id) === uid;
    const isCarrier = String(row.assigned_carrier_id || "") === uid;
    if (!isAdmin && !isShipper && !isCarrier) return sendError(res, 403, "Forbidden");

    const { rows: existing } = await query(
      `SELECT id FROM disputes WHERE shipment_id = $1 AND raised_by = $2 AND status = 'open' LIMIT 1`,
      [shipmentId, uid]
    );
    if (existing[0]) return sendError(res, 409, "An open dispute already exists for this shipment");

    const { rows } = await query(
      `INSERT INTO disputes (shipment_id, load_id, load_code, raised_by, reason, status)
       VALUES ($1,$2,$3,$4,$5,'open')
       RETURNING id, shipment_id AS "shipmentId", load_code AS "loadCode", reason, status, created_at AS "createdAt"`,
      [shipmentId, row.load_id, row.load_code, uid, reason]
    );
    return sendSuccess(res, 201, rows[0]);
  } catch (err) {
    return sendError(res, 500, err.message || "Server error");
  }
}

async function mine(req, res) {
  try {
    const { rows } = await query(
      `SELECT id, shipment_id AS "shipmentId", load_code AS "loadCode", reason, status, created_at AS "createdAt"
       FROM disputes
       WHERE raised_by = $1
       ORDER BY created_at DESC
       LIMIT 200`,
      [req.auth.userId]
    );
    return sendSuccess(res, 200, rows);
  } catch (err) {
    return sendError(res, 500, err.message || "Server error");
  }
}

async function adminList(req, res) {
  const { rows } = await query(
    `SELECT id, shipment_id AS "shipmentId", load_code AS "loadCode", reason, status, created_at AS "createdAt"
     FROM disputes
     ORDER BY created_at DESC
     LIMIT 500`
  );
  return sendSuccess(res, 200, rows);
}

async function adminResolve(req, res) {
  const id = String(req.params.id || "").trim();
  if (!isUuid(id)) return sendError(res, 400, "Invalid dispute id");
  const { rows } = await query(
    `UPDATE disputes
     SET status = 'resolved', resolved_at = now()
     WHERE id = $1
     RETURNING id`,
    [id]
  );
  if (!rows[0]) return sendError(res, 404, "Not found");
  return sendSuccess(res, 200, { ok: true });
}

module.exports = { create, mine, adminList, adminResolve };

