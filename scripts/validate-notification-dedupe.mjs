#!/usr/bin/env node
/**
 * Phase 3–4 validation: bid accept notification identity + sync consistency.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';

const backendRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(backendRoot, 'package.json'));
require('dotenv').config({ path: path.join(backendRoot, '.env') });

const API = (process.env.QA_BASE_URL || 'https://transpak-backend-1.onrender.com')
  .replace(/\/$/, '');
const PASS = process.env.PHASE1_RBAC_PASSWORD || '';
const SHIPPER = process.env.E2E_SHIPPER_ONLY_EMAIL || 'transpak.phase1.shipper@example.com';
const CARRIER = process.env.E2E_CARRIER_ONLY_EMAIL || 'transpak.phase1.carrier@example.com';

async function login(email, role) {
  const res = await fetch(`${API}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: PASS, roleHint: role })
  });
  const body = await res.json();
  return { token: body?.data?.token, user: body?.data?.user };
}

async function main() {
  const unit = spawnSync('node', ['--test', 'test/notification-event-dedupe.test.js'], {
    cwd: backendRoot,
    encoding: 'utf8',
    shell: true
  });
  console.log(unit.stdout || unit.stderr);
  if (unit.status !== 0) process.exit(1);

  const shipper = await login(SHIPPER, 'shipper');
  const carrier = await login(CARRIER, 'carrier');
  if (!shipper.token || !carrier.token) {
    console.error('FAIL: login');
    process.exit(1);
  }

  const pickup = new Date(Date.now() + 86400000 * 5).toISOString().slice(0, 10);
  const createRes = await fetch(`${API}/api/loads/create`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${shipper.token}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': `notif-dedupe-${Date.now()}`
    },
    body: JSON.stringify({
      cargo: 'NOTIF_DEDUPE_TEST',
      origin: 'Lahore',
      destination: 'Karachi',
      weight: 10000,
      vehicleType: 'Truck',
      expectedPrice: 75000,
      pickupDate: pickup,
      deadlineMinutes: 600
    })
  });
  const load = (await createRes.json())?.data;
  if (!load?.id) {
    console.error('FAIL: create load');
    process.exit(1);
  }

  const bidRes = await fetch(`${API}/api/bids`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${carrier.token}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': `notif-dedupe-bid-${load.id}`
    },
    body: JSON.stringify({ loadId: load.id, amount: 72000, acceptListedFare: false })
  });
  const bid = (await bidRes.json())?.data;
  if (!bid?.id) {
    console.error('FAIL: place bid');
    process.exit(1);
  }

  const since = new Date(Date.now() - 3000).toISOString();
  const accept1 = await fetch(`${API}/api/bids/${bid.id}/accept`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${shipper.token}`,
      'Idempotency-Key': `notif-accept-1-${bid.id}`
    }
  });
  const accept2 = await fetch(`${API}/api/bids/${bid.id}/accept`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${shipper.token}`,
      'Idempotency-Key': `notif-accept-2-${bid.id}`
    }
  });

  let syncOk = false;
  for (let i = 0; i < 20; i++) {
    const syncRes = await fetch(
      `${API}/api/notifications/sync?since=${encodeURIComponent(since)}&limit=20`,
      { headers: { Authorization: `Bearer ${carrier.token}` } }
    );
    const body = await syncRes.json();
    const items = body?.data?.items || [];
    if (items.some((n) => String(n.title || '').includes('BID_ACCEPTED'))) {
      syncOk = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 300));
  }

  let dbCount = null;
  if (process.env.DATABASE_URL && carrier.user?.id) {
    const { query, endPool } = require(path.join(backendRoot, 'db', 'pool.js'));
    try {
      const { rows } = await query(
        `SELECT COUNT(*)::int AS c FROM notifications
         WHERE receiver_id = $1 AND title = 'BID_ACCEPTED'
           AND created_at > now() - interval '5 minutes'`,
        [carrier.user.id]
      );
      dbCount = rows[0]?.c ?? 0;
    } finally {
      await endPool();
    }
  }

  const idempotentOk = accept1.ok && (accept2.ok || accept2.status === 409 || accept2.status === 400);
  const pass = idempotentOk && syncOk && (dbCount === null || dbCount >= 1);

  console.log(
    `${pass ? 'PASS' : 'FAIL'} [validate-notification-dedupe] accept1=${accept1.status} accept2=${accept2.status} sync=${syncOk} dbRecent=${dbCount}`
  );
  process.exit(pass ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
