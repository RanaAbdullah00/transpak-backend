const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { normalizeAvailabilitySlots, validateAvailabilitySlots } = require("../utils/availabilitySlots");

describe("availabilitySlots", () => {
  it("normalizes valid slots", () => {
    const slots = normalizeAvailabilitySlots([{ start: "08:00", end: "12:00" }]);
    assert.deepEqual(slots, [{ start: "08:00", end: "12:00" }]);
  });

  it("rejects end before start", () => {
    const slots = normalizeAvailabilitySlots([{ start: "14:00", end: "10:00" }]);
    assert.equal(slots, null);
  });

  it("validate returns ok for null", () => {
    assert.deepEqual(validateAvailabilitySlots(null), { ok: true, value: null });
  });
});
