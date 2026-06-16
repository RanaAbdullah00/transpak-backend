require('dotenv').config();
const { query, endPool } = require('../db/pool');

async function main() {
  const { rows } = await query(
    `SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'bids'`
  );
  console.log('bids indexes:', rows);
  await endPool();
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
