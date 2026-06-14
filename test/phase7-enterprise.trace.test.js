/**
 * Phase 7 Enterprise — distributed tracing tests.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { createTraceId, runWithTrace, getTraceId } = require("../utils/traceContext");
const { SPAN_NAMES, recordSpan, getTraceById } = require("../utils/traceStore");

describe("Phase 7 Enterprise — trace pipeline", () => {
  it("createTraceId returns non-empty id", () => {
    const id = createTraceId();
    assert.ok(String(id).length >= 16);
  });

  it("runWithTrace binds traceId in async context", async () => {
    const id = createTraceId();
    await runWithTrace(id, async () => {
      assert.equal(getTraceId(), id);
      recordSpan("request_start", { path: "/test" });
      recordSpan("sequence_assign", { sequenceId: 1 });
    });
    const trace = await getTraceById(id);
    assert.ok(trace.spans.length >= 2);
    const names = trace.spans.map((s) => s.spanName);
    assert.ok(names.includes("request_start"));
    assert.ok(names.includes("sequence_assign"));
  });

  it("SPAN_NAMES includes required lifecycle events", () => {
    for (const name of [
      "request_start",
      "idempotency_check",
      "sequence_assign",
      "causal_validate",
      "redis_publish",
      "socket_fanout",
      "client_apply"
    ]) {
      assert.ok(SPAN_NAMES.includes(name), `missing span ${name}`);
    }
  });
});
