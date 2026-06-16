#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const backendRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(backendRoot, 'package.json'));
require('dotenv').config({ path: path.join(backendRoot, '.env') });

const API = 'https://transpak-backend-1.onrender.com';
const PASS = process.env.PHASE1_RBAC_PASSWORD || '';
const ADMIN = process.env.E2E_ADMIN_ONLY_EMAIL || 'transpak.phase1.admin@example.com';
const SHIPPER = process.env.E2E_SHIPPER_ONLY_EMAIL || 'transpak.phase1.shipper@example.com';
const CARRIER = process.env.E2E_CARRIER_ONLY_EMAIL || 'transpak.phase1.carrier@example.com';
const MAX_MS = 2000;

const results = [];
function record(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'} [${name}] ${detail}`);
}

async function login(email, role) {
  const res = await fetch(`${API}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: PASS, roleHint: role })
  });
  const body = await res.json();
  return { token: body?.data?.token, status: res.status };
}

async function timed(name, fn) {
  const t0 = Date.now();
  const res = await fn();
  const ms = Date.now() - t0;
  record(name, res.ok && ms < MAX_MS, `HTTP ${res.status} ${ms}ms`);
  return res;
}

async function main() {
  const health = await fetch(`${API}/api/health`).then((r) => r.json());
  const commit = health?.data?.deploy?.commitFull || health?.data?.build || '';
  record('deploy-commit', !commit.startsWith('77f286d'), `live=${commit.slice(0, 12)}`);

  const admin = await login(ADMIN, 'admin');
  const shipper = await login(SHIPPER, 'shipper');
  const carrier = await login(CARRIER, 'carrier');

  await timed('perf-admin-activity-feed', () =>
    fetch(`${API}/api/admin/activity-feed?limit=25`, {
      headers: { Authorization: `Bearer ${admin.token}` }
    })
  );

  await timed('perf-admin-dashboard', () =>
    fetch(`${API}/api/admin/dashboard/live`, {
      headers: { Authorization: `Bearer ${admin.token}` }
    })
  );

  await timed('perf-admin-notifications', () =>
    fetch(`${API}/api/admin/notifications`, {
      headers: { Authorization: `Bearer ${admin.token}` }
    })
  );

  const pickup = new Date(Date.now() + 86400000 * 3).toISOString().slice(0, 10);
  const createRes = await fetch(`${API}/api/loads/create`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${shipper.token}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': `perf-${Date.now()}`
    },
    body: JSON.stringify({
      cargo: 'PERF_BID',
      origin: 'Lahore',
      destination: 'Islamabad',
      weight: 15000,
      vehicleType: 'Truck',
      expectedPrice: 85000,
      pickupDate: pickup,
      deadlineMinutes: 480
    })
  });
  const loadId = (await createRes.json())?.data?.id;

  const bidT0 = Date.now();
  const bidRes = await fetch(`${API}/api/bids`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${carrier.token}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': `perf-bid-${Date.now()}`
    },
    body: JSON.stringify({ loadId, amount: 82000, acceptListedFare: false })
  });
  const bidBody = await bidRes.json();
  const bidMs = Date.now() - bidT0;
  const bidId = bidBody?.data?.id;
  record('perf-bid-post', bidRes.status === 201 && bidMs < MAX_MS, `HTTP ${bidRes.status} ${bidMs}ms`);

  if (bidId) {
    const acceptRes = await fetch(`${API}/api/bids/${bidId}/accept`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${shipper.token}` }
    });
    let shipmentId = null;
    if (acceptRes.ok) {
      const ab = await acceptRes.json();
      shipmentId = ab?.data?.shipmentId || ab?.data?.shipment?.id;
    }

    const trackT0 = Date.now();
    const trackRes = await fetch(`${API}/api/shipments/track/${loadId}`, {
      headers: { Authorization: `Bearer ${shipper.token}` }
    });
    const trackMs = Date.now() - trackT0;
    const trackBody = await trackRes.json().catch(() => ({}));
    const hasStack = JSON.stringify(trackBody).includes('at ') || JSON.stringify(trackBody).includes('.js:');
    record('perf-tracking', trackRes.ok && trackMs < MAX_MS, `HTTP ${trackRes.status} ${trackMs}ms shipment=${shipmentId || 'n/a'}`);
    record('security-no-stack-trace', !hasStack, hasStack ? 'stack leak detected' : 'clean');
  } else {
    record('perf-tracking', false, 'bid placement failed');
    record('security-no-stack-trace', true, 'skipped');
  }

  const idor = await fetch(`${API}/api/admin/dashboard/live`, {
    headers: { Authorization: `Bearer ${carrier.token}` }
  });
  record('security-carrier-no-admin', idor.status === 403 || idor.status === 401, `HTTP ${idor.status}`);

  const noAuth = await fetch(`${API}/api/admin/activity-feed`);
  record('security-admin-auth-required', noAuth.status === 401 || noAuth.status === 403, `HTTP ${noAuth.status}`);

  const failed = results.filter((r) => !r.pass);
  console.log(`\n--- ${results.length - failed.length}/${results.length} passed ---`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
