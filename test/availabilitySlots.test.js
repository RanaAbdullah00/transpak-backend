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

  it("normalizes visibility duration metadata", () => {
    const slots = normalizeAvailabilitySlots([
      { type: "visibility", durationMinutes: 360, visibleUntil: "2030-01-01T00:00:00.000Z" }
    ]);
    assert.equal(slots.length, 1);
    assert.equal(slots[0].type, "visibility");
    assert.equal(slots[0].durationMinutes, 360);
  });
});
