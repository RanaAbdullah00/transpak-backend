require('dotenv').config();
const { query, endPool } = require('../db/pool');
const { validateBidPlacement } = require('../utils/matchingEngine');
const { assertNotSelfCommercial } = require('../utils/selfExclusion');
const { apiBidStatus } = require('../utils/bidStateMachine');
const { emitBidStateChange, emitBidRefresh, BID_DISPATCH } = require('../utils/bidRealtime');
const { writeAudit } = require('../utils/auditLog');
const { notifyAdmins } = require('../utils/adminNotify');
const { buildDedupeKey, newEventId } = require('../utils/realtimeDispatch');
const { emitContractEntityDispatch } = require('../utils/eventContractRegistry');

async function main() {
  const carrierEmail = process.env.E2E_CARRIER_ONLY_EMAIL || 'transpak.phase1.carrier@example.com';
  const shipperEmail = process.env.E2E_SHIPPER_ONLY_EMAIL || 'transpak.phase1.shipper@example.com';
  const { rows: users } = await query(`SELECT id, email FROM users WHERE email IN ($1,$2)`, [shipperEmail, carrierEmail]);
  const carrier = users.find((u) => u.email === carrierEmail);
  const shipper = users.find((u) => u.email === shipperEmail);

  const code = `L-SIM${Date.now().toString().slice(-6)}`;
  const { rows: loads } = await query(
    `INSERT INTO loads (shipper_id, code, cargo, origin, destination, weight, vehicle_type, expected_price, pickup_date, status, deadline_minutes)
     VALUES ($1,$2,'SIM', 'Lahore','Islamabad',15000,'Truck',85000,CURRENT_DATE+3,'open',480) RETURNING id`,
    [shipper.id, code]
  );
  const loadId = loads[0].id;

  const { rows: loadRows } = await query(
    `SELECT id, shipper_id, status, weight, vehicle_type, expected_price, deadline_hours, deadline_minutes, created_at FROM loads WHERE id=$1`,
    [loadId]
  );
  const load = loadRows[0];
  const carrierId = carrier.id;

  try {
    assertNotSelfCommercial({ shipperId: load.shipper_id, carrierId, action: 'bid on' });
    const placement = await validateBidPlacement({ carrierUserId: carrierId, load, existingBid: null });
    console.log('placement', placement);
    if (!placement.ok) throw new Error('placement failed: ' + placement.message);

    const { rows } = await query(
      `INSERT INTO bids (load_id, carrier_id, amount, status) VALUES ($1,$2,$3,'pending_shipper_confirmation')
       ON CONFLICT (load_id, carrier_id) DO NOTHING
       RETURNING id, load_id AS "loadId", carrier_id AS "carrierId", amount, status, created_at AS "createdAt"`,
      [loadId, carrierId, 82000]
    );
    console.log('insert', rows[0]);
    if (!rows[0]) throw new Error('insert empty');

    await emitBidStateChange({
      receiverId: load.shipper_id,
      senderId: carrierId,
      roleType: 'shipper',
      dispatchType: BID_DISPATCH.CREATED,
      title: 'SHIPPER_CONFIRMATION_REQUEST',
      message: `Carrier bid PKR 82000 — confirm to book`
    });
    console.log('emitBidStateChange OK');

    emitBidRefresh(carrierId, 'carrier', BID_DISPATCH.CREATED, { bidId: rows[0].id, loadId });
    console.log('emitBidRefresh OK');

    emitContractEntityDispatch({
      entityType: 'bid',
      entityId: rows[0].id,
      type: BID_DISPATCH.CREATED,
      eventId: newEventId(),
      payload: { bidId: rows[0].id, loadId }
    });
    console.log('emitContractEntityDispatch OK');

    await writeAudit({ actorUserId: carrierId, action: 'bid.created', targetEntity: 'bid', targetId: rows[0].id, metadata: { loadId, amount: 82000 } });
    console.log('writeAudit OK');

    await notifyAdmins({
      senderId: carrierId,
      title: 'BID_CREATED',
      type: 'BID_CREATED',
      message: `[Platform] New bid PKR 82000 on load ${loadId}`,
      idempotencyKey: buildDedupeKey(['ADMIN', 'BID_CREATED', rows[0].id])
    });
    console.log('notifyAdmins OK');
    console.log('ALL STEPS PASS');
  } catch (e) {
    console.error('FAIL STEP:', e.message);
    console.error(e.stack);
  } finally {
    await query(`DELETE FROM bids WHERE load_id=$1`, [loadId]);
    await query(`DELETE FROM loads WHERE id=$1`, [loadId]);
    await endPool();
  }
}

main();
