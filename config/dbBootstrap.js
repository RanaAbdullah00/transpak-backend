/**
 * Coordinates one-shot DB connect + schema verify for deterministic /api/health.
 */
const DEFAULT_HEALTH_WAIT_MS = Number(process.env.HEALTH_DB_WAIT_MS || 10000);

function createDbState() {
  return {
    ready: false,
    needsMigration: false,
    error: null,
    schema: null,
    initSettled: false,
    initStartedAt: null,
    _initPromise: null
  };
}

/**
 * @param {ReturnType<createDbState>} dbState
 * @param {() => Promise<void>} runInit
 */
function startDbInit(dbState, runInit) {
  if (dbState._initPromise) return dbState._initPromise;
  dbState.initStartedAt = Date.now();
  dbState._initPromise = (async () => {
    try {
      await runInit();
    } finally {
      dbState.initSettled = true;
    }
  })();
  return dbState._initPromise;
}

/**
 * Wait for DB init (used by /api/health before returning schema).
 * @param {ReturnType<createDbState>} dbState
 * @param {number} [timeoutMs]
 */
async function waitForDbInit(dbState, timeoutMs = DEFAULT_HEALTH_WAIT_MS) {
  if (!dbState._initPromise) {
    return { timedOut: false, settled: Boolean(dbState.initSettled) };
  }
  if (dbState.initSettled) {
    return { timedOut: false, settled: true };
  }

  const result = await Promise.race([
    dbState._initPromise.then(() => ({ timedOut: false, settled: true })),
    new Promise((resolve) => {
      setTimeout(() => {
        resolve({ timedOut: true, settled: Boolean(dbState.initSettled) });
      }, timeoutMs);
    })
  ]);
  return result;
}

module.exports = {
  createDbState,
  startDbInit,
  waitForDbInit,
  DEFAULT_HEALTH_WAIT_MS
};
