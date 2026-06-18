const { getPool, query } = require("../db/pool");
const { ACTIVE_BID_STATUSES_SQL } = require("./bidStateMachine");
const { closeExpiredCapacityListings } = require("./capacityListingLifecycle");

/**
 * Bidding window length as a PostgreSQL interval (Supabase / PG 14+ safe).
 * Uses integer minutes only — no make_interval().
 */
const BIDDING_DEADLINE_INTERVAL_SQL = `(
    GREATEST(
      1,
      COALESCE(
        NULLIF(l.deadline_minutes, 0),
        GREATEST(1, COALESCE(l.deadline_hours, 2)) * 60
      )::int
    ) * INTERVAL '1 minute'
  )`;

const OPEN_LOAD_EXPIRY_SQL = `
  l.status = 'open'
  AND l.created_at + ${BIDDING_DEADLINE_INTERVAL_SQL} < now()
`;

/**
 * Close loads whose bidding window has ended.
 * @param {import('pg').PoolClient} [client]
 */
async function expireStaleOpenLoads(client = null) {
  const q = client ? client.query.bind(client) : query;
  const { rowCount } = await q(
    `UPDATE loads l
     SET status = 'cancelled', updated_at = now()
     WHERE ${OPEN_LOAD_EXPIRY_SQL}`
  );
  return rowCount || 0;
}

/**
 * Cancel active bids on loads that are no longer open for bidding.
 * @param {import('pg').PoolClient} [client]
 */
async function expireBidsOnNonOpenLoads(client = null) {
  const q = client ? client.query.bind(client) : query;
  const { rowCount } = await q(
    `UPDATE bids b
     SET status = 'cancelled', updated_at = now()
     FROM loads l
     WHERE b.load_id = l.id
       AND b.status IN ${ACTIVE_BID_STATUSES_SQL}
       AND l.status <> 'open'`
  );
  return rowCount || 0;
}

/**
 * Cancel active bids on loads whose bidding window has ended.
 * @param {import('pg').PoolClient} [client]
 */
async function expireBidsPastDeadline(client = null) {
  const q = client ? client.query.bind(client) : query;
  const { rowCount } = await q(
    `UPDATE bids b
     SET status = 'cancelled', updated_at = now()
     FROM loads l
     WHERE b.load_id = l.id
       AND b.status IN ${ACTIVE_BID_STATUSES_SQL}
       AND l.status = 'open'
       AND l.created_at + ${BIDDING_DEADLINE_INTERVAL_SQL} < now()`
  );
  return rowCount || 0;
}

/**
 * Centralized marketplace expiry — safe to run on interval or before listings.
 */
async function runMarketplaceExpiryProcessor() {
  const pool = getPool();
  let capacityExpired = 0;
  try {
    await closeExpiredCapacityListings();
    capacityExpired = 1;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn("[expiry] capacity close failed:", err?.message || err);
  }

  if (!pool) {
    const loads = await expireStaleOpenLoads();
    const bids = await expireBidsOnNonOpenLoads();
    const bidsPastDeadline = await expireBidsPastDeadline();
    return { loadsExpired: loads, bidsExpired: bids, bidsPastDeadline, capacityExpired };
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const loadsExpired = await expireStaleOpenLoads(client);
    const bidsExpired = await expireBidsOnNonOpenLoads(client);
    const bidsPastDeadline = await expireBidsPastDeadline(client);
    await client.query("COMMIT");
    return { loadsExpired, bidsExpired, bidsPastDeadline, capacityExpired };
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // ignore
    }
    throw err;
  } finally {
    client.release();
  }
}

let schedulerHandle = null;

function startMarketplaceExpiryScheduler({ dbReady = () => true } = {}) {
  if (schedulerHandle) return schedulerHandle;
  const ms = Math.max(15000, Number(process.env.MARKETPLACE_EXPIRY_MS || 60000));
  const tick = async () => {
    if (!dbReady()) return;
    try {
      const result = await runMarketplaceExpiryProcessor();
      if (process.env.NODE_ENV !== "production" && (result.loadsExpired || result.bidsExpired)) {
        // eslint-disable-next-line no-console
        console.info("[expiry]", result);
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn("[expiry] processor failed:", err?.message || err);
    }
  };
  tick();
  schedulerHandle = setInterval(tick, ms);
  if (typeof schedulerHandle.unref === "function") schedulerHandle.unref();
  return schedulerHandle;
}

function stopMarketplaceExpiryScheduler() {
  if (schedulerHandle) {
    clearInterval(schedulerHandle);
    schedulerHandle = null;
  }
}

/** Loads still accepting bids (open + before deadline). */
const OPEN_BIDDING_ELIGIBLE_SQL = `
  l.status = 'open'
  AND l.created_at + ${BIDDING_DEADLINE_INTERVAL_SQL} >= now()
`;

module.exports = {
  OPEN_LOAD_EXPIRY_SQL,
  OPEN_BIDDING_ELIGIBLE_SQL,
  BIDDING_DEADLINE_INTERVAL_SQL,
  expireStaleOpenLoads,
  expireBidsOnNonOpenLoads,
  expireBidsPastDeadline,
  runMarketplaceExpiryProcessor,
  startMarketplaceExpiryScheduler,
  stopMarketplaceExpiryScheduler
};
