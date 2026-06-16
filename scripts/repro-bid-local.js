#!/usr/bin/env node
/** Local bid POST reproduction against shared DB — surfaces real error message. */
const path = require('path');
process.env.NODE_ENV = 'development';
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { query, endPool } = require('../db/pool');
const { validateBidPlacement } = require('../utils/matchingEngine');
const { apiBidStatus, isAwaitingShipper } = require('../utils/bidStateMachine');
const { emitBidStateChange, emitBidRefresh, BID_DISPATCH } = require('../utils/bidRealtime');
const { emitContractEntityDispatch } = require('../utils/eventContractRegistry');
const { newEventId } = require('../utils/realtimeDispatch');
const { notifyAdmins } = require('../utils/adminNotify');
const { writeAudit } = require('../utils/auditLog');
const { acceptBidAndBook } = require('../utils/bidAcceptance');

const CARRIER_EMAIL = process.env.E2E_CARRIER_ONLY_EMAIL || 'transpak.phase1.carrier@example.com';

async function main() {
  const { rows: users } = await query(`SELECT id FROM users WHERE email = $1`, [CARRIER_EMAIL]);
  const carrierId = users[0]?.id;
  if (!carrierId) throw new Error('carrier not found');

  const { rows: loads } = await query(
    `SELECT id, code, shipper_id, status, weight, vehicle_type, expected_price,
            deadline_hours, deadline_minutes, created_at, accepted_bid_id
     FROM loads WHERE code = $1`,
    [process.argv[2] || 'L-319541']
  );
  const load = loads[0];
  if (!load) throw new Error('no open load');
  console.log('load', load.code, load.id);

  const loadId = load.id;
  const amount = 82000;

  const { rows: existing } = await query(
    `SELECT id, load_id AS "loadId", carrier_id AS "carrierId", amount, status,
            suggested_amount AS "suggestedAmount", suggested_by AS "suggestedBy",
            created_at AS "createdAt"
     FROM bids WHERE load_id = $1 AND carrier_id = $2`,
    [loadId, carrierId]
  );

  const placement = await validateBidPlacement({
    carrierUserId: carrierId,
    load,
    existingBid: existing[0] || null
  });
  console.log('placement', placement);
  if (!placement.ok) {
    await endPool();
    return;
  }

  try {
    const { rows } = await query(
      `INSERT INTO bids (load_id, carrier_id, amount, status)
       VALUES ($1, $2, $3, 'pending_shipper_confirmation')
       ON CONFLICT (load_id, carrier_id) DO NOTHING
       RETURNING id, load_id AS "loadId", carrier_id AS "carrierId", amount, status,
                 suggested_amount AS "suggestedAmount", suggested_by AS "suggestedBy",
                 created_at AS "createdAt"`,
      [loadId, carrierId, Number(amount)]
    );
    console.log('insert rows', rows);

    if (!rows[0]) {
      console.log('no insert — conflict');
      await endPool();
      return;
    }

    const { rows: loadOwner } = await query(`SELECT shipper_id FROM loads WHERE id = $1`, [loadId]);
    if (loadOwner[0]?.shipper_id) {
      await emitBidStateChange({
        receiverId: loadOwner[0].shipper_id,
        senderId: carrierId,
        roleType: 'shipper',
        dispatchType: BID_DISPATCH.CREATED,
        title: 'SHIPPER_CONFIRMATION_REQUEST',
        message: `Carrier bid PKR ${Number(amount)} — confirm to book`
      });
    }
    emitBidRefresh(carrierId, 'carrier', BID_DISPATCH.CREATED, { bidId: rows[0].id, loadId });
    emitContractEntityDispatch({
      entityType: 'bid',
      entityId: rows[0].id,
      type: BID_DISPATCH.CREATED,
      eventId: newEventId(),
      payload: { bidId: rows[0].id, loadId }
    });

    void writeAudit({
      actorUserId: carrierId,
      action: 'bid.created',
      targetEntity: 'bid',
      targetId: rows[0].id,
      metadata: { loadId, amount: Number(amount) }
    });

    void notifyAdmins({
      senderId: carrierId,
      title: 'BID_CREATED',
      type: 'BID_CREATED',
      message: `[Platform] New bid PKR ${Number(amount)} on load ${loadId}`,
      idempotencyKey: `ADMIN|BID_CREATED|${rows[0].id}`
    });

    const shouldAutoBook =
      String(process.env.BID_AUTO_ACCEPT_LISTED_FARE || 'true').toLowerCase() !== 'false' &&
      Number(amount) === Number(load.expected_price);

    if (shouldAutoBook && Number(load.expected_price) > 0) {
      const booked = await acceptBidAndBook(rows[0].id, carrierId, { allowCarrierListedAccept: true });
      console.log('autoBook', booked);
    } else {
      console.log('PASS bid created', rows[0].id);
    }
  } catch (err) {
    console.error('FAIL', err.message);
    console.error(err.stack);
  }

  await endPool();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
