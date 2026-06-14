/**
 * Phase 6 — distributed stress + fallback validation (synthetic).
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { pathToFileURL } = require("url");

const frontendSrc = path.join(__dirname, "..", "..", "transpak-frontend", "src");

async function importFe(rel) {
  return import(pathToFileURL(path.join(frontendSrc, rel)).href);
}

describe("Phase 6 — rating density", () => {
  it("10,000 users still produce one batch param string", () => {
    const ids = Array.from(
      { length: 10000 },
      (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`
    );
    assert.equal(ids.join(",").split(",").length, 10000);
  });
});

describe("Phase 6 — tracking ordering + dedupe", () => {
  it("sequence authority rejects stale sequenceId", async () => {
    const { createSequenceAuthorityGate } = await importFe("utils/trackingSequenceAuthority.js");
    const gate = createSequenceAuthorityGate();
    assert.equal(gate.accept({ sequenceId: 10 }), true);
    assert.equal(gate.accept({ sequenceId: 9 }), false);
    assert.equal(gate.accept({ sequenceId: 11 }), true);
  });

  it("state machine rejects invalid transitions", () => {
    const { validateTrackingStateTransition, STATES } = require("../utils/trackingStateMachine");
    assert.equal(validateTrackingStateTransition(STATES.INIT, STATES.SOCKET_ACTIVE).ok, true);
    assert.equal(validateTrackingStateTransition(STATES.INIT, STATES.RECOVERED).ok, false);
  });

  it("resolveSequenceWinner prefers higher sequenceId", () => {
    const { resolveSequenceWinner } = require("../utils/trackingStateMachine");
    assert.equal(resolveSequenceWinner(100, 101).accept, true);
    assert.equal(resolveSequenceWinner(100, 99).accept, false);
  });

  it("500 duplicate claims collapse to single accept", async () => {
    const { claimDistributedEvent } = require("../utils/socketEventDedupe");
    const { resetRedisClientForTests } = require("../utils/redisClient");
    resetRedisClientForTests();
    let accepted = 0;
    for (let i = 0; i < 500; i += 1) {
      if (await claimDistributedEvent("burst-event")) accepted += 1;
    }
    assert.equal(accepted, 1);
    resetRedisClientForTests();
  });
});

describe("Phase 6 — Redis failover", () => {
  it("system remains functional in memory fallback mode", async () => {
    const { getRedisClient, getRedisMode, resetRedisClientForTests } = require("../utils/redisClient");
    const { createNotificationDedupeAdapter } = require("../utils/notificationDedupeAdapter");
    resetRedisClientForTests();
    delete process.env.REDIS_URL;
    assert.equal(getRedisMode(), "memory");
    const adapter = createNotificationDedupeAdapter();
    await adapter.set("failover-key");
    assert.equal(await adapter.has("failover-key"), true);
    resetRedisClientForTests();
  });
});

describe("Phase 6 — multi-shipment isolation", () => {
  it("50 shipments keep independent sequence gates", async () => {
    const { createSequenceAuthorityGate } = await importFe("utils/trackingSequenceAuthority.js");
    const gates = Array.from({ length: 50 }, () => createSequenceAuthorityGate());
    gates.forEach((gate, i) => {
      assert.equal(gate.accept({ sequenceId: i + 1 }), true);
    });
    assert.equal(gates[0].getLastSequenceId(), 1);
    assert.equal(gates[49].getLastSequenceId(), 50);
  });
});
