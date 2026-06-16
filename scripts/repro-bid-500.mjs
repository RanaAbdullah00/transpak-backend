#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const backendRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(backendRoot, 'package.json'));
require('dotenv').config({ path: path.join(backendRoot, '.env') });

const API = (process.env.QA_BASE_URL || process.argv[2] || 'https://transpak-backend-1.onrender.com').replace(/\/$/, '');
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
  return { status: res.status, token: body?.data?.token, body };
}

async function main() {
  const shipper = await login(SHIPPER, 'shipper');
  const carrier = await login(CARRIER, 'carrier');
  console.log('shipper login', shipper.status, 'carrier login', carrier.status);

  const pickup = new Date(Date.now() + 86400000 * 3).toISOString().slice(0, 10);
  const create = await fetch(`${API}/api/loads/create`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${shipper.token}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': `repro-bid-${Date.now()}`
    },
    body: JSON.stringify({
      cargo: 'REPRO_BID_500',
      origin: 'Lahore',
      destination: 'Islamabad',
      weight: 15000,
      vehicleType: 'Truck',
      expectedPrice: 85000,
      pickupDate: pickup,
      deadlineMinutes: 480
    })
  });
  const createBody = await create.json();
  console.log('create load', create.status, createBody?.data?.code, createBody?.message);
  const loadId = createBody?.data?.id;
  if (!loadId) return;

  const bid = await fetch(`${API}/api/bids`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${carrier.token}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': `repro-bid-post-${loadId}`
    },
    body: JSON.stringify({ loadId, amount: 82000 })
  });
  const bidText = await bid.text();
  console.log('bid status', bid.status);
  console.log('bid body', bidText.slice(0, 800));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
