#!/usr/bin/env node
/**
 * Production-only GET /api/shipments/active audit.
 * Usage: node scripts/probe-production-active.mjs [origin]
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const backendRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(backendRoot, 'package.json'));
require('dotenv').config({ path: path.join(backendRoot, '.env') });

const ORIGIN = (process.argv[2] || 'https://transpak-backend-1.onrender.com').replace(/\/$/, '');
const PASS = process.env.PHASE1_RBAC_PASSWORD || '11223344';
const CARRIER = process.env.E2E_CARRIER_ONLY_EMAIL || 'transpak.phase1.carrier@example.com';
const SHIPPER = process.env.E2E_SHIPPER_ONLY_EMAIL || 'transpak.phase1.shipper@example.com';

async function login(email, roleHint) {
  const res = await fetch(`${ORIGIN}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: PASS, roleHint })
  });
  const body = await res.json();
  return { status: res.status, token: body?.data?.token, body };
}

async function getActive(token) {
  const res = await fetch(`${ORIGIN}/api/shipments/active`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  let body = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return { status: res.status, body };
}

async function probeDbSql() {
    const { query, endPool } = require(path.join(backendRoot, 'db/pool'));
  try {
    const { rows: users } = await query(
      `SELECT id, email FROM users WHERE email IN ($1, $2)`,
      [CARRIER, SHIPPER]
    );
    for (const u of users) {
      try {
        const { rows } = await query(
          `SELECT l.id, l.code, s.status AS shipment_status, l.status AS load_status
           FROM shipments s
           JOIN loads l ON l.id = s.load_id
           WHERE s.status NOT IN ('delivered', 'closed')
             AND (l.status = 'booked' OR l.assigned_carrier_id IS NOT NULL)
             AND (l.shipper_id = $1 OR l.assigned_carrier_id = $1)
           LIMIT 10`,
          [u.id]
        );
        console.log(`[db] ${u.email}: ${rows.length} active row(s)`);
      } catch (e) {
        console.log(`[db] ${u.email} SQL ERROR:`, e.message);
      }
    }
  } finally {
    await endPool().catch(() => {});
  }
}

async function main() {
  console.log('[prod-active] origin', ORIGIN);

  const health = await fetch(`${ORIGIN}/api/health`).then((r) => r.json());
  console.log('[prod-active] build', health?.data?.build || health?.build);
  console.log('[prod-active] schema', health?.data?.schema?.version || health?.schemaVersion);
  console.log('[prod-active] http5xx', health?.data?.ops?.counters?.http5xx);

  await probeDbSql();

  for (const [role, email] of [
    ['carrier', CARRIER],
    ['shipper', SHIPPER]
  ]) {
    const loginRes = await login(email, role);
    console.log(`[prod-active] login ${role}:`, loginRes.status, Boolean(loginRes.token));
    if (!loginRes.token) continue;
    const active = await getActive(loginRes.token);
    console.log(`[prod-active] GET /active (${role}):`, active.status, {
      success: active.body?.success,
      code: active.body?.code,
      count: Array.isArray(active.body?.data) ? active.body.data.length : null,
      message: active.body?.message
    });
    if (active.status === 500) {
      process.exitCode = 1;
    }
  }
}

main().catch((e) => {
  console.error('[prod-active] fatal', e.message);
  process.exit(1);
});
