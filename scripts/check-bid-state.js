#!/usr/bin/env node
const path = require('path');
process.env.NODE_ENV = 'development';
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { query, endPool } = require('../db/pool');

async function main() {
  const { rows } = await query(`
    SELECT b.id, b.status, b.amount, l.code, u.email AS carrier
    FROM bids b
    JOIN loads l ON l.id = b.load_id
    JOIN users u ON u.id = b.carrier_id
    WHERE l.code = 'L-233450'
  `);
  console.log('bids on L-233450', rows);

  const { rows: open } = await query(`
    SELECT l.code, l.id FROM loads l
    WHERE l.status = 'open'
      AND NOT EXISTS (
        SELECT 1 FROM bids b
        JOIN users u ON u.id = b.carrier_id
        WHERE b.load_id = l.id AND u.email = 'transpak.phase1.carrier@example.com'
          AND b.status IN ('pending_shipper_confirmation','counter_offered','accepted')
      )
    ORDER BY l.created_at DESC LIMIT 3
  `);
  console.log('open loads without carrier bid', open);
  await endPool();
}
main();
