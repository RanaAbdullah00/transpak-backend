#!/usr/bin/env node
/**
 * Read-only database integrity checks for release sign-off.
 * Usage: node transpak-backend/scripts/db-integrity-check.mjs [--strict]
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const backendRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(backendRoot, 'package.json'));
require('dotenv').config({ path: path.join(backendRoot, '.env') });

const strict = process.argv.includes('--strict');

const CHECKS = [
  {
    name: 'duplicate_active_bids',
    sql: `SELECT load_id, carrier_id, COUNT(*)::int AS c
          FROM bids
          WHERE status NOT IN ('cancelled', 'rejected')
          GROUP BY load_id, carrier_id
          HAVING COUNT(*) > 1
          LIMIT 5`
  },
  {
    name: 'duplicate_shipments_per_load',
    sql: `SELECT load_id, COUNT(*)::int AS c
          FROM shipments
          WHERE status NOT IN ('closed', 'delivered')
          GROUP BY load_id
          HAVING COUNT(*) > 1
          LIMIT 5`
  },
  {
    name: 'duplicate_ratings',
    sql: `SELECT shipment_id, from_user_id, COUNT(*)::int AS c
          FROM ratings
          WHERE shipment_id IS NOT NULL
          GROUP BY shipment_id, from_user_id
          HAVING COUNT(*) > 1
          LIMIT 5`
  },
  {
    name: 'duplicate_unread_notifications',
    sql: `SELECT receiver_id, dedupe_key, COUNT(*)::int AS c
          FROM notifications
          WHERE read = false AND dedupe_key IS NOT NULL
          GROUP BY receiver_id, dedupe_key
          HAVING COUNT(*) > 1
          LIMIT 5`
  },
  {
    name: 'orphan_bids',
    sql: `SELECT b.id FROM bids b
          LEFT JOIN loads l ON l.id = b.load_id
          WHERE l.id IS NULL
          LIMIT 5`
  },
  {
    name: 'orphan_shipments',
    sql: `SELECT s.id FROM shipments s
          LEFT JOIN loads l ON l.id = s.load_id
          WHERE l.id IS NULL
          LIMIT 5`
  }
];

async function main() {
  const dbUrl = String(process.env.DATABASE_URL || '').trim();
  if (!dbUrl) {
    console.log('SKIP [db-integrity] DATABASE_URL not set');
    process.exit(strict ? 1 : 0);
  }

  const { getPool } = require(path.join(backendRoot, 'db', 'pool.js'));
  const pool = getPool();
  if (!pool) {
    console.log('SKIP [db-integrity] pool unavailable');
    process.exit(strict ? 1 : 0);
  }

  let failed = 0;
  console.log('\n=== Database Integrity Check ===\n');

  for (const check of CHECKS) {
    const { rows } = await pool.query(check.sql);
    const pass = rows.length === 0;
    console.log(`${pass ? 'PASS' : 'FAIL'} [${check.name}] rows=${rows.length}`);
    if (!pass) {
      failed += 1;
      console.log(JSON.stringify(rows.slice(0, 3), null, 2));
    }
  }

  await pool.end().catch(() => {});

  if (failed > 0) {
    console.log(`\n--- ${failed} integrity check(s) failed ---\n`);
    process.exit(1);
  }
  console.log('\n--- All integrity checks passed ---\n');
}

main().catch((err) => {
  console.error('[db-integrity] fatal:', err?.message || err);
  process.exit(1);
});
