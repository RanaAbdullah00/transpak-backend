#!/usr/bin/env node
/**
 * Post-approval hardening gate — schema, stress, sync fallback, perf (read-only + test data).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const backendRoot = path.join(root, 'transpak-backend');
const require = createRequire(path.join(backendRoot, 'package.json'));
require('dotenv').config({ path: path.join(backendRoot, '.env') });

const API = (process.env.QA_BASE_URL || 'https://transpak-backend-1.onrender.com').replace(/\/$/, '');
const PASS = process.env.PHASE1_RBAC_PASSWORD || '';
const SHIPPER = process.env.E2E_SHIPPER_ONLY_EMAIL || 'transpak.phase1.shipper@example.com';
const CARRIER = process.env.E2E_CARRIER_ONLY_EMAIL || 'transpak.phase1.carrier@example.com';

const report = { at: new Date().toISOString(), api: API, phases: {}, verdict: 'AT RISK' };

function phase(name, pass, detail, extra = {}) {
  report.phases[name] = { pass, detail, ...extra };
  console.log(`${pass ? 'PASS' : 'FAIL'} [${name}] ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`);
  return pass;
}

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(sorted.length - 1, idx))];
}

async function login(email, role) {
  const res = await fetch(`${API}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: PASS, roleHint: role })
  });
  const body = await res.json();
  return { token: body?.data?.token, user: body?.data?.user };
}

async function createLoad(shipperToken, tag) {
  const pickup = new Date(Date.now() + 86400000 * 6).toISOString().slice(0, 10);
  const res = await fetch(`${API}/api/loads/create`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${shipperToken}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': `hard-${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    },
    body: JSON.stringify({
      cargo: `HARD_${tag}`,
      origin: 'Lahore',
      destination: 'Karachi',
      weight: 12000,
      vehicleType: 'Truck',
      expectedPrice: 150000,
      pickupDate: pickup,
      deadlineMinutes: 720
    })
  });
  return { ok: res.ok, load: (await res.json())?.data };
}

async function placeBid(carrierToken, loadId, tag) {
  const res = await fetch(`${API}/api/bids`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${carrierToken}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': `hard-bid-${tag}-${loadId}`
    },
    body: JSON.stringify({ loadId, amount: 145000, acceptListedFare: false })
  });
  return { ok: res.ok, bid: (await res.json())?.data };
}

async function acceptBid(shipperToken, bidId, tag) {
  const res = await fetch(`${API}/api/bids/${bidId}/accept`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${shipperToken}`, 'Idempotency-Key': `hard-acc-${tag}-${bidId}` }
  });
  return res.ok;
}

async function dbQuery(sql, params = []) {
  const { query, endPool } = require(path.join(backendRoot, 'db', 'pool.js'));
  try {
    return await query(sql, params);
  } finally {
    await endPool();
  }
}

async function main() {
  // Phase 1 — schema drift
  const healthDb = await fetch(`${API}/api/health/db`).then((r) => r.json());
  const constraintOk = healthDb?.data?.notificationDedupeConstraint?.ok === true;
  phase('phase1-schema-guard', constraintOk, healthDb?.data?.notificationDedupeConstraint || healthDb);

  let dbConstraint = false;
  if (process.env.DATABASE_URL) {
    const { rows } = await dbQuery(
      `SELECT conname FROM pg_constraint WHERE conname = 'uq_notifications_receiver_dedupe_full'`
    );
    dbConstraint = rows.length > 0;
    phase('phase1-db-constraint', dbConstraint, rows[0]?.conname || 'missing');
  }

  const shipper = await login(SHIPPER, 'shipper');
  const carrier = await login(CARRIER, 'carrier');
  if (!shipper.token || !carrier.token) {
    phase('auth', false, 'login failed');
    writeReport();
    process.exit(1);
  }

  const carrierId = carrier.user.id;
  const sinceStress = new Date().toISOString();

  // Phase 5 — 50 concurrent accepts (batched to avoid connection reset)
  const burst = [];
  for (let batch = 0; batch < 5; batch++) {
    const chunk = await Promise.all(
      Array.from({ length: 10 }, async (_, i) => {
        const idx = batch * 10 + i;
        const loadR = await createLoad(shipper.token, `b50-${idx}`);
        if (!loadR.load?.id) return { ok: false };
        const bidR = await placeBid(carrier.token, loadR.load.id, `b50-${idx}`);
        if (!bidR.bid?.id) return { ok: false };
        const ok = await acceptBid(shipper.token, bidR.bid.id, `b50-${idx}`);
        return { ok, bidId: bidR.bid?.id };
      })
    );
    burst.push(...chunk);
    await new Promise((r) => setTimeout(r, 500));
  }
  const burstOk = burst.filter((b) => b.ok).length;
  await new Promise((r) => setTimeout(r, 8000));

  let burstDb = 0;
  let burstUnique = 0;
  if (process.env.DATABASE_URL) {
    const { rows } = await dbQuery(
      `SELECT dedupe_key FROM notifications
       WHERE receiver_id = $1 AND title = 'BID_ACCEPTED' AND created_at > $2::timestamptz`,
      [carrierId, sinceStress]
    );
    burstDb = rows.length;
    burstUnique = new Set(rows.map((r) => r.dedupe_key)).size;
  }
  phase(
    'phase5-stress-50',
    burstOk >= 45 && burstDb >= burstOk - 3 && burstUnique === burstDb,
    `accepts=${burstOk}/50 dbRows=${burstDb} uniqueKeys=${burstUnique}`
  );

  // Phase 6 — sync fallback (no socket; API-only reconnect simulation)
  const sinceReconnect = new Date(Date.parse(sinceStress) - 1000).toISOString();
  let reconnectDupes = 0;
  const syncSets = [];
  for (let i = 0; i < 10; i++) {
    const syncRes = await fetch(
      `${API}/api/notifications/sync?since=${encodeURIComponent(sinceReconnect)}&limit=60`,
      { headers: { Authorization: `Bearer ${carrier.token}` } }
    );
    const items = (await syncRes.json())?.data?.items || [];
    syncSets.push(items.length);
    const ids = items.map((n) => n.id);
    reconnectDupes += ids.length - new Set(ids).size;
    await new Promise((r) => setTimeout(r, 200));
  }
  const syncStable = syncSets.every((c) => c >= burstDb - 2);
  phase(
    'phase6-sync-fallback',
    syncStable && reconnectDupes === 0,
    `cycles=10 counts=${syncSets.join(',')} dupes=${reconnectDupes}`
  );

  // Phase 7 — cross-role (carrier vs shipper scopes)
  const carrierList = await fetch(`${API}/api/notifications?limit=50`, {
    headers: { Authorization: `Bearer ${carrier.token}` }
  }).then((r) => r.json());
  const carrierSyncRole = await fetch(
    `${API}/api/notifications/sync?since=${encodeURIComponent(sinceStress)}&limit=50`,
    { headers: { Authorization: `Bearer ${carrier.token}` } }
  ).then((r) => r.json());
  const shipperList = await fetch(`${API}/api/notifications?limit=30`, {
    headers: { Authorization: `Bearer ${shipper.token}` }
  }).then((r) => r.json());
  const carrierItems = carrierList?.data?.items || [];
  const carrierSyncItems = carrierSyncRole?.data?.items || [];
  const shipperItems = shipperList?.data?.items || [];
  const carrierLeak = carrierItems.some((n) => n.roleType === 'shipper' && n.title?.includes('CONTRACT'));
  const carrierHasBid =
    carrierItems.some((n) => String(n.title || '').includes('BID_ACCEPTED')) ||
    carrierSyncItems.some((n) => String(n.title || '').includes('BID_ACCEPTED'));
  const shipperHasContract = shipperItems.some((n) => String(n.title || '').includes('CONTRACT'));
  phase(
    'phase7-cross-role',
    carrierHasBid && !carrierLeak,
    `carrierBid=${carrierHasBid} carrierLeak=${carrierLeak} shipperContract=${shipperHasContract}`
  );

  // Phase 8 — perf (warmup discarded; remote RTT included — threshold 1000ms for cross-region probe)
  const syncLat = [];
  const listLat = [];
  for (let i = 0; i < 3; i++) {
    await fetch(`${API}/api/notifications/sync?limit=10`, {
      headers: { Authorization: `Bearer ${carrier.token}` }
    });
  }
  for (let i = 0; i < 12; i++) {
    const t0 = Date.now();
    await fetch(`${API}/api/notifications/sync?limit=30`, {
      headers: { Authorization: `Bearer ${carrier.token}` }
    });
    syncLat.push(Date.now() - t0);
    const t1 = Date.now();
    await fetch(`${API}/api/notifications?limit=30`, {
      headers: { Authorization: `Bearer ${carrier.token}` }
    });
    listLat.push(Date.now() - t1);
  }
  syncLat.sort((a, b) => a - b);
  listLat.sort((a, b) => a - b);
  const syncP95 = percentile(syncLat, 95);
  const listP95 = percentile(listLat, 95);

  let insertP95 = null;
  if (process.env.DATABASE_URL) {
    const insertDelta = [];
    for (let i = 0; i < 10; i++) {
      const p0 = Date.now();
      await dbQuery('SELECT 1');
      const ping = Date.now() - p0;
      const t0 = Date.now();
      await dbQuery(
        `INSERT INTO notifications (receiver_id, role_type, title, message, dedupe_key, event_id)
         VALUES ($1, 'carrier', 'PERF_PROBE', $2, $3, gen_random_uuid())
         ON CONFLICT ON CONSTRAINT uq_notifications_receiver_dedupe_full DO NOTHING`,
        [carrierId, `perf ${i}`, `PERF_PROBE|${Date.now()}-${i}|${carrierId}`]
      );
      insertDelta.push(Math.max(0, Date.now() - t0 - ping));
    }
    insertDelta.sort((a, b) => a - b);
    insertP95 = percentile(insertDelta, 95);
    phase('phase8-perf-insert', insertP95 < 300, `insertDeltaP95=${insertP95}ms (DB round-trip adjusted)`);
  }

  phase('phase8-perf-sync', syncP95 < 1000, `syncP95=${syncP95}ms (remote probe)`);
  phase('phase8-perf-list', listP95 < 1000, `listP95=${listP95}ms (remote probe)`);

  // Sync ordering check
  const syncRes = await fetch(`${API}/api/notifications/sync?limit=20`, {
    headers: { Authorization: `Bearer ${carrier.token}` }
  });
  const syncItems = (await syncRes.json())?.data?.items || [];
  let ordered = true;
  for (let i = 1; i < syncItems.length; i++) {
    const prev = new Date(syncItems[i - 1].createdAt).getTime();
    const cur = new Date(syncItems[i].createdAt).getTime();
    if (cur > prev) ordered = false;
  }
  phase('phase4-sync-order', ordered, `items=${syncItems.length} desc=${ordered}`);

  const allPass = Object.values(report.phases).every((p) => p.pass);
  report.verdict = allPass ? 'STABLE' : 'AT RISK';
  report.metrics = { syncP95, listP95, insertP95, burstOk, burstDb, burstUnique };
  writeReport();
  console.log(`\n=== VERDICT: ${report.verdict} ===`);
  process.exit(allPass ? 0 : 1);
}

function writeReport() {
  const out = path.join(root, 'deploy', 'notification-hardening-gate.json');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(report, null, 2));
  console.log('artifact:', out);
}

main().catch((e) => {
  console.error(e);
  report.error = e.message;
  writeReport();
  process.exit(1);
});
