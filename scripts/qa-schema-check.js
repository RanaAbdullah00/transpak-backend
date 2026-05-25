require("dotenv").config();
const { query, getPool } = require("../db/pool");

async function main() {
  const col = await query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'loads' AND column_name = 'deadline_minutes'`
  );
  console.log("[qa] loads.deadline_minutes:", col.rows.length ? "OK" : "MISSING");
  const pool = getPool();
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
