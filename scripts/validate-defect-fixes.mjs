#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const backendRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(backendRoot, 'package.json'));
require('dotenv').config({ path: path.join(backendRoot, '.env') });

const API = (process.env.QA_BASE_URL || process.argv[2] || 'http://127.0.0.1:10100').replace(/\/$/, '');
const PASS = process.env.PHASE1_RBAC_PASSWORD || '';
const SHIPPER = process.env.E2E_SHIPPER_ONLY_EMAIL || 'transpak.phase1.shipper@example.com';
const CARRIER = process.env.E2E_CARRIER_ONLY_EMAIL || 'transpak.phase1.carrier@example.com';
const ADMIN = process.env.E2E_ADMIN_ONLY_EMAIL || 'transpak.phase1.admin@example.com';

const results = [];
function pass(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} [${name}] ${detail}`);
}

async function login(email, role) {
  const res = await fetch(`${API}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: PASS, roleHint: role })
  });
  const body = await res.json();
  return { status: res.status, token: body?.data?.token, body };
}

async function main() {
  const admin = await login(ADMIN, 'admin');
  const shipper = await login(SHIPPER, 'shipper');
  const carrier = await login(CARRIER, 'carrier');

  // D-001 activity feed
  const feed = await fetch(`${API}/api/admin/activity-feed?page=1&limit=10`, {
    headers: { Authorization: `Bearer ${admin.token}` }
  });
  const feedBody = await feed.json();
  const items = feedBody?.data?.items || [];
  const ids = items.map((i) => i.id);
  const dupes = ids.length !== new Set(ids).size;
  pass('D-001-activity-feed', feed.ok && Array.isArray(items), `HTTP ${feed.status} items=${items.length} dupes=${dupes}`);

  const feedShip = await fetch(`${API}/api/admin/activity-feed?type=shipment&page=1&limit=5`, {
    headers: { Authorization: `Bearer ${admin.token}` }
  });
  pass('D-001-shipment-filter', feedShip.ok, `HTTP ${feedShip.status}`);

  // D-002 mark read
  const notifs = await fetch(`${API}/api/admin/notifications`, {
    headers: { Authorization: `Bearer ${admin.token}` }
  });
  const notifBody = await notifs.json();
  const first = (notifBody?.data || [])[0];
  if (first?.id) {
    const mark = await fetch(`${API}/api/admin/notifications/${first.id}/read`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${admin.token}` }
    });
    pass('D-002-mark-read', mark.ok, `HTTP ${mark.status}`);
  } else {
    pass('D-002-mark-read', true, 'skipped — no notifications');
  }
  const markAll = await fetch(`${API}/api/admin/notifications/read-all`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${admin.token}` }
  });
  pass('D-002-mark-all-read', markAll.ok, `HTTP ${markAll.status}`);

  // D-003 bid placement
  const pickup = new Date(Date.now() + 86400000 * 3).toISOString().slice(0, 10);
  const create = await fetch(`${API}/api/loads/create`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${shipper.token}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': `val-bid-${Date.now()}`
    },
    body: JSON.stringify({
      cargo: 'VAL_BID_FLOW',
      origin: 'Lahore',
      destination: 'Islamabad',
      weight: 15000,
      vehicleType: 'Truck',
      expectedPrice: 85000,
      pickupDate: pickup,
      deadlineMinutes: 480
    })
  });
  const loadBody = await create.json();
  const loadId = loadBody?.data?.id;
  pass('bid-flow-create-load', create.ok && loadId, `HTTP ${create.status} loadId=${loadId || 'n/a'}`);

  const bid1 = await fetch(`${API}/api/bids`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${carrier.token}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': `val-bid-post-${Date.now()}`
    },
    body: JSON.stringify({ loadId, amount: 82000, acceptListedFare: false })
  });
  const bidBody = await bid1.json();
  const bidId = bidBody?.data?.id;
  pass('D-003-bid-placement', bid1.ok && bidId, `HTTP ${bid1.status} bidId=${bidId || 'n/a'}`);

  const bidDup = await fetch(`${API}/api/bids`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${carrier.token}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': `val-bid-dup-${Date.now()}`
    },
    body: JSON.stringify({ loadId, amount: 82000, acceptListedFare: false })
  });
  const dupBody = await bidDup.json();
  pass('bid-no-duplicate', bidDup.status === 409 || (bidDup.ok && (dupBody?.message || '').includes('Already')), `HTTP ${bidDup.status} msg=${dupBody?.message}`);

  const accept = await fetch(`${API}/api/bids/${bidId}/accept`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${shipper.token}` }
  });
  const acceptBody = await accept.json();
  pass('bid-accept', accept.ok, `HTTP ${accept.status} shipment=${acceptBody?.data?.shipmentId || acceptBody?.data?.shipment?.id || 'n/a'}`);

  // Counter offer on new load
  const create2 = await fetch(`${API}/api/loads/create`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${shipper.token}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': `val-counter-${Date.now()}`
    },
    body: JSON.stringify({
      cargo: 'VAL_COUNTER',
      origin: 'Lahore',
      destination: 'Islamabad',
      weight: 15000,
      vehicleType: 'Truck',
      expectedPrice: 85000,
      pickupDate: pickup,
      deadlineMinutes: 480
    })
  });
  const load2 = (await create2.json())?.data;
  const counterBid = await fetch(`${API}/api/bids`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${carrier.token}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': `val-counter-bid-${Date.now()}`
    },
    body: JSON.stringify({ loadId: load2?.id, amount: 82000, acceptListedFare: false })
  });
  const cb = await counterBid.json();
  const cbId = cb?.data?.id;
  const suggest = await fetch(`${API}/api/bids/${cbId}/suggest-carrier`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${carrier.token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ amount: 95000 })
  });
  pass('counter-offer-suggest', suggest.ok, `HTTP ${suggest.status}`);

  const reject = await fetch(`${API}/api/bids/${cbId}/reject`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${shipper.token}` }
  });
  pass('counter-offer-reject', reject.ok, `HTTP ${reject.status}`);

  const failed = results.filter((r) => !r.ok);
  console.log(`\n--- ${results.length - failed.length}/${results.length} passed ---`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
