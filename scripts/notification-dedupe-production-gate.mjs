#!/usr/bin/env node
/**
 * Production verification gate — notification event-safe dedupe (read-only + test data).
 * Usage: node transpak-backend/scripts/notification-dedupe-production-gate.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const backendRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(backendRoot, 'package.json'));
require('dotenv').config({ path: path.join(backendRoot, '.env') });

const PREVIOUS_COMMIT = '547c541960ec';
const API = (process.env.QA_BASE_URL || 'https://transpak-backend-1.onrender.com').replace(/\/$/, '');
const PASS = process.env.PHASE1_RBAC_PASSWORD || '';
const SHIPPER = process.env.E2E_SHIPPER_ONLY_EMAIL || 'transpak.phase1.shipper@example.com';
const CARRIER = process.env.E2E_CARRIER_ONLY_EMAIL || 'transpak.phase1.carrier@example.com';

const report = {
  at: new Date().toISOString(),
  api: API,
  phases: {},
  verdict: 'NOT APPROVED'
};

function phase(name, pass, detail, extra = {}) {
  report.phases[name] = { pass, detail, ...extra };
  console.log(`${pass ? 'PASS' : 'FAIL'} [${name}] ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`);
  return pass;
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
  const pickup = new Date(Date.now() + 86400000 * 5).toISOString().slice(0, 10);
  const res = await fetch(`${API}/api/loads/create`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${shipperToken}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': `gate-${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    },
    body: JSON.stringify({
      cargo: `GATE_${tag}`,
      origin: 'Lahore',
      destination: 'Karachi',
      weight: 11000,
      vehicleType: 'Truck',
      expectedPrice: 150000,
      pickupDate: pickup,
      deadlineMinutes: 720
    })
  });
  const body = await res.json();
  return { ok: res.ok, status: res.status, load: body?.data, message: body?.message };
}

async function placeBid(carrierToken, loadId, tag) {
  const res = await fetch(`${API}/api/bids`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${carrierToken}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': `gate-bid-${tag}-${loadId}`
    },
    body: JSON.stringify({ loadId, amount: 145000, acceptListedFare: false })
  });
  const body = await res.json();
  return { ok: res.ok, status: res.status, bid: body?.data };
}

async function acceptBid(shipperToken, bidId, tag) {
  const res = await fetch(`${API}/api/bids/${bidId}/accept`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${shipperToken}`,
      'Idempotency-Key': `gate-accept-${tag}-${bidId}`
    }
  });
  return { ok: res.ok, status: res.status, body: await res.json().catch(() => ({})) };
}

function parseDedupeKey(key) {
  const parts = String(key || '').split('|');
  return {
    eventType: parts[0] || null,
    entityId: parts[1] || null,
    receiverId: parts[2] || null,
    eventVersion: parts[3] || null,
    legacy: parts.length <= 3 && !parts[0]?.includes('_')
  };
}

async function dbQuery(sql, params = []) {
  const { query, endPool } = require(path.join(backendRoot, 'db', 'pool.js'));
  try {
    return await query(sql, params);
  } finally {
    await endPool();
  }
}

async function pollSync(token, since, predicate, deadlineMs = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < deadlineMs) {
    const res = await fetch(
      `${API}/api/notifications/sync?since=${encodeURIComponent(since)}&limit=50`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (res.ok) {
      const body = await res.json();
      const items = body?.data?.items || [];
      if (predicate(items, body)) return { ok: true, items, elapsedMs: Date.now() - t0 };
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  return { ok: false, elapsedMs: Date.now() - t0 };
}

async function main() {
  // PHASE 1 — deploy confirmation
  const healthRes = await fetch(`${API}/api/health`, { cache: 'no-store' });
  const health = await healthRes.json().catch(() => ({}));
  const commit =
    health?.data?.commitFull ||
    health?.data?.commit ||
    health?.commitFull ||
    health?.commit ||
    'unknown';
  const commitShort = String(commit).slice(0, 12);
  const deployChanged = commitShort !== PREVIOUS_COMMIT.slice(0, 12) && commit !== 'unknown';
  report.deploy = { commit, commitShort, previous: PREVIOUS_COMMIT, changed: deployChanged };

  if (!deployChanged) {
    phase('phase1-deploy', false, `commit still ${commitShort} (expected != ${PREVIOUS_COMMIT.slice(0, 12)})`);
    writeReport();
    process.exit(1);
  }
  phase('phase1-deploy', true, `commit=${commitShort} (was ${PREVIOUS_COMMIT.slice(0, 12)})`);

  const shipper = await login(SHIPPER, 'shipper');
  const carrier = await login(CARRIER, 'carrier');
  if (!shipper.token || !carrier.token || !carrier.user?.id) {
    phase('phase1-auth', false, 'login failed');
    writeReport();
    process.exit(1);
  }

  const carrierId = carrier.user.id;
  const sinceBaseline = new Date().toISOString();

  // PHASE 2 — 3 distinct bid accepts
  const bidIds = [];
  for (let i = 0; i < 3; i++) {
    const loadR = await createLoad(shipper.token, `triple-${i}`);
    if (!loadR.load?.id) {
      phase('phase2-triple-accept', false, `load create failed i=${i} status=${loadR.status}`);
      writeReport();
      process.exit(1);
    }
    const bidR = await placeBid(carrier.token, loadR.load.id, `triple-${i}`);
    if (!bidR.bid?.id) {
      phase('phase2-triple-accept', false, `bid failed i=${i}`);
      writeReport();
      process.exit(1);
    }
    const acc = await acceptBid(shipper.token, bidR.bid.id, `triple-${i}`);
    if (!acc.ok) {
      phase('phase2-triple-accept', false, `accept failed i=${i} status=${acc.status}`);
      writeReport();
      process.exit(1);
    }
    bidIds.push(bidR.bid.id);
    await new Promise((r) => setTimeout(r, 500));
  }

  let dbRows = [];
  if (process.env.DATABASE_URL) {
    const { rows } = await dbQuery(
      `SELECT id, title, dedupe_key, event_id::text, created_at::text
       FROM notifications
       WHERE receiver_id = $1 AND title = 'BID_ACCEPTED'
         AND created_at > $2::timestamptz
       ORDER BY created_at DESC`,
      [carrierId, sinceBaseline]
    );
    dbRows = rows;
  }

  const dedupeKeys = dbRows.map((r) => r.dedupe_key).filter(Boolean);
  const uniqueKeys = new Set(dedupeKeys);
  const parsed = dedupeKeys.map(parseDedupeKey);
  const entityIds = parsed.map((p) => p.entityId).filter(Boolean);
  const uniqueEntities = new Set(entityIds);
  const legacyOnly = parsed.every((p) => !p.eventType || p.legacy);

  const phase2Pass =
    dbRows.length >= 3 && uniqueKeys.size >= 3 && uniqueEntities.size >= 3 && !legacyOnly;
  phase(
    'phase2-db-insert',
    phase2Pass,
    `rows=${dbRows.length} uniqueDedupe=${uniqueKeys.size} uniqueEntity=${uniqueEntities.size} legacyOnly=${legacyOnly}`,
    { dbRows: dbRows.slice(0, 10), bidIds }
  );

  // PHASE 3 — identity consistency (only rows from this run's bidIds; ignore concurrent probe noise)
  const relevantParsed = parsed.filter((p) => p.entityId && bidIds.includes(p.entityId));
  const identityPass =
    relevantParsed.length >= 3 &&
    new Set(relevantParsed.map((p) => p.entityId)).size >= 3 &&
    relevantParsed.every((p) => p.eventType === 'BID_ACCEPTED' && p.entityId);
  phase('phase3-identity', identityPass, { parsed: relevantParsed.slice(0, 5), bidIds, totalRows: parsed.length });

  // PHASE 4 — sync API (3 accepts + optional status if we advance one shipment)
  const sinceTriple = sinceBaseline;
  const syncTriple = await pollSync(
    carrier.token,
    sinceTriple,
    (items) => items.filter((n) => String(n.title || '').includes('BID_ACCEPTED')).length >= 3,
    10000
  );
  phase(
    'phase4-sync-triple',
    syncTriple.ok,
    `BID_ACCEPTED in sync=${syncTriple.ok} elapsed=${syncTriple.elapsedMs}ms count=${syncTriple.items?.filter((n) => String(n.title || '').includes('BID_ACCEPTED')).length || 0}`
  );

  // Shipment status update on first accepted load
  let statusSyncOk = false;
  const activeRes = await fetch(`${API}/api/shipments/active`, {
    headers: { Authorization: `Bearer ${carrier.token}` }
  });
  const activeRows = (await activeRes.json())?.data || [];
  const activeRow = activeRows.find((r) => bidIds.some((id) => String(r.bidId || '') === id)) || activeRows[0];
  const ref = activeRow?.trackRef || activeRow?.code || activeRow?.loadCode;
  const sinceStatus = new Date().toISOString();
  if (ref && activeRow) {
    const statusRes = await fetch(`${API}/api/shipments/${encodeURIComponent(ref)}/status`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${carrier.token}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': `gate-status-${Date.now()}`
      },
      body: JSON.stringify({ status: 'pickedup' })
    });
    if (statusRes.ok) {
      const statusSync = await pollSync(
        carrier.token,
        sinceStatus,
        (items) =>
          items.some(
            (n) =>
              String(n.title || '').includes('PICKED') ||
              String(n.title || '').includes('SHIPMENT')
          ),
        8000
      );
      statusSyncOk = statusSync.ok;
    }
  }
  phase('phase4-sync-status', statusSyncOk || !ref, `statusSync=${statusSyncOk} ref=${ref || 'n/a'}`);

  const phase4Pass = syncTriple.ok && (statusSyncOk || !ref);
  report.phases['phase4-sync'] = { pass: phase4Pass };

  // PHASE 5 — REST list vs sync alignment
  const listRes = await fetch(`${API}/api/notifications?limit=30`, {
    headers: { Authorization: `Bearer ${carrier.token}` }
  });
  const listItems = (await listRes.json())?.data?.items || [];
  const syncRes = await fetch(`${API}/api/notifications/sync?limit=30`, {
    headers: { Authorization: `Bearer ${carrier.token}` }
  });
  const syncItems = (await syncRes.json())?.data?.items || [];
  const listIds = new Set(listItems.map((n) => n.id));
  const syncIds = new Set(syncItems.map((n) => n.id));
  const overlap = [...listIds].filter((id) => syncIds.has(id)).length;
  const alignPass = listRes.ok && syncRes.ok && overlap >= Math.min(listItems.length, syncItems.length, 1);
  phase('phase5-rest-align', alignPass, `list=${listItems.length} sync=${syncItems.length} overlap=${overlap}`);

  // PHASE 6 — reconnect: since before triple, should recover all 3+
  const sinceReconnect = new Date(Date.parse(sinceBaseline) - 1000).toISOString();
  const reconnectSync = await fetch(
    `${API}/api/notifications/sync?since=${encodeURIComponent(sinceReconnect)}&limit=50`,
    { headers: { Authorization: `Bearer ${carrier.token}` } }
  );
  const reconnectItems = (await reconnectSync.json())?.data?.items || [];
  const reconnectAccepted = reconnectItems.filter((n) =>
    String(n.title || '').includes('BID_ACCEPTED')
  );
  const phase6Pass = reconnectAccepted.length >= 3;
  phase(
    'phase6-reconnect',
    phase6Pass,
    `recovered BID_ACCEPTED=${reconnectAccepted.length} since=${sinceReconnect}`
  );

  // PHASE 7 — 20 rapid accepts (different loads)
  const sinceBurst = new Date().toISOString();
  const burstBidIds = [];
  let burstFails = 0;
  const burstResults = await Promise.all(
    Array.from({ length: 20 }, async (_, i) => {
      try {
        const loadR = await createLoad(shipper.token, `burst-${i}`);
        if (!loadR.load?.id) return { ok: false };
        const bidR = await placeBid(carrier.token, loadR.load.id, `burst-${i}`);
        if (!bidR.bid?.id) return { ok: false };
        const acc = await acceptBid(shipper.token, bidR.bid.id, `burst-${i}`);
        if (acc.ok) burstBidIds.push(bidR.bid.id);
        return { ok: acc.ok, bidId: bidR.bid?.id };
      } catch {
        return { ok: false };
      }
    })
  );
  burstFails = burstResults.filter((r) => !r.ok).length;

  let burstDbCount = 0;
  let burstUniqueKeys = 0;
  if (process.env.DATABASE_URL) {
    await new Promise((r) => setTimeout(r, 2000));
    const { rows } = await dbQuery(
      `SELECT dedupe_key FROM notifications
       WHERE receiver_id = $1 AND title = 'BID_ACCEPTED' AND created_at > $2::timestamptz`,
      [carrierId, sinceBurst]
    );
    burstDbCount = rows.length;
    burstUniqueKeys = new Set(rows.map((r) => r.dedupe_key)).size;
  }

  const phase7Pass =
    burstFails <= 2 && burstDbCount >= 15 && burstUniqueKeys === burstDbCount && burstDbCount >= burstBidIds.length - 2;
  phase(
    'phase7-burst',
    phase7Pass,
    `accepts=${burstBidIds.length}/20 fails=${burstFails} dbRows=${burstDbCount} uniqueKeys=${burstUniqueKeys}`
  );

  const allPass =
    phase2Pass &&
    identityPass &&
    phase4Pass &&
    alignPass &&
    phase6Pass &&
    phase7Pass;

  report.verdict = allPass ? 'APPROVED' : 'NOT APPROVED';
  writeReport();
  console.log(`\n=== VERDICT: ${report.verdict} ===`);
  process.exit(allPass ? 0 : 1);
}

function writeReport() {
  const out = path.join(backendRoot, '..', 'deploy', 'notification-dedupe-gate.json');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(report, null, 2));
  console.log('artifact:', out);
}

main().catch((e) => {
  console.error(e);
  report.verdict = 'NOT APPROVED';
  report.error = e.message;
  try {
    writeReport();
  } catch {
    /* ignore */
  }
  process.exit(1);
});
