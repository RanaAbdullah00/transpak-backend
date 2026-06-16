#!/usr/bin/env node
/** Reproduce bid POST against production API — capture exact error body. */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const https = require('https');

const API = 'https://transpak-backend-1.onrender.com';
const PASS = process.env.PHASE1_RBAC_PASSWORD || process.env.E2E_SHIPPER_PASSWORD || '';
const SHIPPER = process.env.E2E_SHIPPER_ONLY_EMAIL || 'transpak.phase1.shipper@example.com';
const CARRIER = process.env.E2E_CARRIER_ONLY_EMAIL || 'transpak.phase1.carrier@example.com';

function req(method, urlPath, token, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const headers = { Accept: 'application/json', 'Content-Type': 'application/json' };
    if (token) headers.Authorization = 'Bearer ' + token;
    const r = https.request(`${API}${urlPath}`, { method, headers, timeout: 120000 }, (res) => {
      let d = '';
      res.on('data', (c) => { d += c; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(d) }); }
        catch { resolve({ status: res.statusCode, body: d }); }
      });
    });
    r.on('error', reject);
    r.on('timeout', () => { r.destroy(); reject(new Error('timeout')); });
    if (payload) r.write(payload);
    r.end();
  });
}

async function login(email, roleHint) {
  const res = await req('POST', '/api/auth/login', null, { email, password: PASS, roleHint });
  return res.body?.data?.token;
}

async function main() {
  const { query, endPool } = require('../db/pool');
  const { rows: idx } = await query(
    `SELECT indexname FROM pg_indexes WHERE tablename = 'bids' AND indexdef ILIKE '%unique%'`
  );
  console.log('bids unique indexes:', idx.map((r) => r.indexname));

  const shipperToken = await login(SHIPPER, 'shipper');
  const carrierToken = await login(CARRIER, 'carrier');
  if (!shipperToken || !carrierToken) {
    console.error('login failed');
    process.exit(1);
  }

  const pickup = new Date(Date.now() + 86400000 * 4).toISOString().slice(0, 10);
  const create = await req('POST', '/api/loads/create', shipperToken, {
    cargo: 'BID_REPRO_' + Date.now(),
    origin: 'Lahore',
    destination: 'Islamabad',
    weight: 15000,
    vehicleType: 'Truck',
    expectedPrice: 85000,
    pickupDate: pickup,
    deadlineMinutes: 480
  });
  console.log('create load', create.status, create.body?.data?.code, create.body?.message);
  const loadId = create.body?.data?.id;
  if (!loadId) {
    await endPool();
    process.exit(1);
  }

  const bid = await req('POST', '/api/bids', carrierToken, { loadId, amount: 82000 });
  console.log('bid POST', bid.status);
  console.log('bid body', JSON.stringify(bid.body, null, 2));

  await endPool();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
