/**
 * Phase 7 — E2E security, concurrency, realtime, and state-machine validation.
 */
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const jwt = require("jsonwebtoken");
const {
  hasIntegrationEnv,
  skipIntegrationReason,
  hasDatabaseUrl,
  skipDbReason,
  hasSecondCarrier
} = require("./helpers/config");
const {
  api,
  login,
  createOpenLoad,
  placeBid,
  placeBidRaw,
  acceptBid
} = require("./helpers/http");
const {
  countBidsForLoadCarrier,
  getBidRow,
  deleteTestLoadCascade,
  query,
  closePool
} = require("./helpers/db");

const skip = hasIntegrationEnv() ? false : skipIntegrationReason();

describe("Phase 7 — RBAC penetration", { skip }, () => {
  let shipper;
  let carrier;
  let otherCarrier;

  before(async () => {
    shipper = await login(
      process.env.E2E_SHIPPER_EMAIL,
      process.env.E2E_SHIPPER_PASSWORD,
      "shipper"
    );
    carrier = await login(
      process.env.E2E_CARRIER_EMAIL,
      process.env.E2E_CARRIER_PASSWORD,
      "carrier"
    );
    if (hasSecondCarrier()) {
      otherCarrier = await login(
        process.env.E2E_CARRIER2_EMAIL,
        process.env.E2E_CARRIER2_PASSWORD,
        "carrier"
      );
    }
  });

  it("rejects missing auth with 401", async () => {
    const res = await api("GET", "/api/loads/mine");
    assert.equal(res.status, 401);
  });

  it("rejects expired / invalid JWT with 401", async () => {
    const bad = jwt.sign({ userId: "00000000-0000-4000-8000-000000000099" }, "wrong-secret", {
      expiresIn: "-1h"
    });
    const res = await api("GET", "/api/loads/mine", { token: bad });
    assert.equal(res.status, 401);
  });

  it("carrier cannot accept bid on another shipper load (IDOR)", async () => {
    const load = await createOpenLoad(shipper.token, { cargo: `Phase7 IDOR ${Date.now()}` });
    try {
      const bid = await placeBid(carrier.token, load.id, 130000);
      const hijack = await acceptBid(carrier.token, bid.id);
      assert.equal(hijack.status, 403, hijack.message);
    } finally {
      await deleteTestLoadCascade(load.id);
    }
  });

  it("tampered load id on bid POST returns 404", async () => {
    const res = await placeBidRaw(carrier.token, "00000000-0000-4000-8000-000000000099", 100000);
    assert.equal(res.status, 404);
  });

  it("carrier cannot PATCH shipper-only load by fake id", async () => {
    const res = await api("PATCH", "/api/loads/00000000-0000-4000-8000-000000000099", {
      token: carrier.token,
      body: { cargo: "hijack" }
    });
    assert.ok([403, 404].includes(res.status));
  });

  it("role spoof: carrier cannot claim admin via active-role", async () => {
    const roles = Array.isArray(carrier.user?.roles) ? carrier.user.roles : [];
    if (roles.includes("admin")) return;
    const res = await api("PATCH", "/api/auth/active-role", {
      token: carrier.token,
      body: { activeRole: "admin" }
    });
    assert.ok([400, 403].includes(res.status));
  });

  it("other carrier cannot reject shipper bid", async () => {
    if (!otherCarrier) return;
    const load = await createOpenLoad(shipper.token, { cargo: `Phase7 reject IDOR ${Date.now()}` });
    try {
      const bid = await placeBid(carrier.token, load.id, 125000);
      const res = await api("PUT", `/api/bids/${bid.id}/reject`, { token: otherCarrier.token });
      assert.equal(res.status, 403);
    } finally {
      await deleteTestLoadCascade(load.id);
    }
  });
});

describe("Phase 7 — concurrent duplicate bid (same carrier)", { skip }, () => {
  let shipper;
  let carrier;
  let load;

  before(async () => {
    shipper = await login(
      process.env.E2E_SHIPPER_EMAIL,
      process.env.E2E_SHIPPER_PASSWORD,
      "shipper"
    );
    carrier = await login(
      process.env.E2E_CARRIER_EMAIL,
      process.env.E2E_CARRIER_PASSWORD,
      "carrier"
    );
    load = await createOpenLoad(shipper.token, { cargo: `Phase7 dup bid ${Date.now()}` });
  });

  after(async () => {
    if (load?.id) await deleteTestLoadCascade(load.id);
  });

  it("parallel POST yields one bid row and idempotent responses", async () => {
    const amount = 137000;
    const [a, b] = await Promise.all([
      placeBidRaw(carrier.token, load.id, amount),
      placeBidRaw(carrier.token, load.id, amount)
    ]);

    const okish = [a, b].filter((r) => r.ok && r.payload?.id);
    assert.ok(okish.length >= 1, JSON.stringify([a, b]));
    const ids = new Set(okish.map((r) => String(r.payload.id)));
    assert.equal(ids.size, 1, "both successes must reference same bid id");

    const carrierId = carrier.user?.id;
    assert.ok(carrierId, "carrier user id required for DB count");
    const rowCount = await countBidsForLoadCarrier(load.id, carrierId);
    assert.equal(rowCount, 1);
  });
});

describe("Phase 7 — bid state machine (HTTP)", { skip }, () => {
  let shipper;
  let carrier;

  before(async () => {
    shipper = await login(
      process.env.E2E_SHIPPER_EMAIL,
      process.env.E2E_SHIPPER_PASSWORD,
      "shipper"
    );
    carrier = await login(
      process.env.E2E_CARRIER_EMAIL,
      process.env.E2E_CARRIER_PASSWORD,
      "carrier"
    );
  });

  it("rejected bid cannot be reopened via POST", async () => {
    const load = await createOpenLoad(shipper.token, { cargo: `Phase7 closed bid ${Date.now()}` });
    try {
      const bid = await placeBid(carrier.token, load.id, 128000);
      const rejected = await api("PUT", `/api/bids/${bid.id}/reject`, { token: shipper.token });
      assert.ok(rejected.ok, rejected.message);

      const retry = await placeBidRaw(carrier.token, load.id, 129000);
      assert.equal(retry.status, 409);
      assert.equal(retry.code, "BID_CLOSED");

      const row = await getBidRow(bid.id);
      assert.equal(row.status, "rejected");
    } finally {
      await deleteTestLoadCascade(load.id);
    }
  });

  it("accepting closed/rejected bid returns conflict", async () => {
    const load = await createOpenLoad(shipper.token, { cargo: `Phase7 accept closed ${Date.now()}` });
    try {
      const bid = await placeBid(carrier.token, load.id, 127000);
      await api("PUT", `/api/bids/${bid.id}/reject`, { token: shipper.token });
      const res = await acceptBid(shipper.token, bid.id);
      assert.ok([409, 403].includes(res.status));
    } finally {
      await deleteTestLoadCascade(load.id);
    }
  });
});

describe("Phase 7 — realtime notifications", { skip }, () => {
  let token;
  const stamp = Date.now();

  before(async () => {
    const session = await login(
      process.env.E2E_SHIPPER_EMAIL,
      process.env.E2E_SHIPPER_PASSWORD,
      "shipper"
    );
    token = session.token;
  });

  it("parallel duplicate POST dedupes to one notification id", async () => {
    const title = `PHASE7_DEDUPE_${stamp}`;
    const message = "parallel dedupe probe";
    const [a, b] = await Promise.all([
      api("POST", "/api/notifications", {
        token,
        body: { title, message, roleType: "shipper" }
      }),
      api("POST", "/api/notifications", {
        token,
        body: { title, message, roleType: "shipper" }
      })
    ]);
    assert.ok(a.ok && b.ok);
    assert.equal(a.payload?.id, b.payload?.id);
  });

  it("sync + list unread counts stay aligned after read-all", async () => {
    await api("PATCH", "/api/notifications/read-all", { token });
    const sync = await api("GET", "/api/notifications/sync", { token, workspace: "shipper" });
    assert.ok(sync.ok);
    assert.equal(sync.payload?.unreadCount, 0);
    const list = await api("GET", "/api/notifications/unread-count", {
      token,
      workspace: "shipper"
    });
    assert.ok(list.ok);
    assert.equal(list.payload?.count, 0);
  });

  it("workspace header scopes unread count vs unscoped", async () => {
    const dual = await login(
      process.env.E2E_CARRIER_EMAIL,
      process.env.E2E_CARRIER_PASSWORD,
      "carrier"
    );
    const roles = Array.isArray(dual.user?.roles) ? dual.user.roles : [];
    if (!roles.includes("shipper")) return;

    await api("POST", "/api/notifications", {
      token: dual.token,
      body: {
        title: `PHASE7_WS_${stamp}`,
        message: "carrier workspace probe",
        roleType: "carrier"
      }
    });

    const carrierCount = await api("GET", "/api/notifications/unread-count", {
      token: dual.token,
      workspace: "carrier"
    });
    const shipperCount = await api("GET", "/api/notifications/unread-count", {
      token: dual.token,
      workspace: "shipper"
    });
    assert.ok(carrierCount.ok && shipperCount.ok);
    assert.ok(typeof carrierCount.payload?.count === "number");
    assert.ok(typeof shipperCount.payload?.count === "number");
  });
});

describe("Phase 7 — pagination stability", { skip }, () => {
  it("notification list cursor is stable across back-to-back fetches", async () => {
    const session = await login(
      process.env.E2E_SHIPPER_EMAIL,
      process.env.E2E_SHIPPER_PASSWORD,
      "shipper"
    );
    const first = await api("GET", "/api/notifications", { token: session.token, query: { limit: "5" } });
    assert.ok(first.ok);
    const items = Array.isArray(first.payload) ? first.payload : first.payload?.items || [];
    if (!items.length) return;
    const cursor = items[items.length - 1]?.createdAt;
    if (!cursor) return;
    const page2a = await api("GET", "/api/notifications", {
      token: session.token,
      query: { limit: "5", cursor }
    });
    const page2b = await api("GET", "/api/notifications", {
      token: session.token,
      query: { limit: "5", cursor }
    });
    assert.ok(page2a.ok && page2b.ok);
    const a = Array.isArray(page2a.payload) ? page2a.payload : page2a.payload?.items || [];
    const b = Array.isArray(page2b.payload) ? page2b.payload : page2b.payload?.items || [];
    assert.deepEqual(
      a.map((n) => n.id),
      b.map((n) => n.id)
    );
  });
});

describe("Phase 7 — DB marketplace invariants", {
  skip: hasDatabaseUrl() ? false : skipDbReason()
}, () => {
  after(async () => {
    await closePool();
  });

  it("no load has more than one accepted bid", async () => {
    const { rows } = await query(
      `SELECT load_id, COUNT(*)::int AS c
       FROM bids WHERE status = 'accepted'
       GROUP BY load_id
       HAVING COUNT(*) > 1`
    );
    assert.equal(rows.length, 0, JSON.stringify(rows));
  });

  it("booked loads reference accepted bid when accepted_bid_id set", async () => {
    const { rows } = await query(
      `SELECT l.id
       FROM loads l
       LEFT JOIN bids b ON b.id = l.accepted_bid_id AND b.status = 'accepted'
       WHERE l.accepted_bid_id IS NOT NULL AND b.id IS NULL
       LIMIT 5`
    );
    assert.equal(rows.length, 0, JSON.stringify(rows));
  });
});
