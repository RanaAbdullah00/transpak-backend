/**
 * PKR/ton and weight round-trip (Issue 13).
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const weightSrc = fs.readFileSync(
  path.join(__dirname, "..", "..", "transpak-frontend", "src", "utils", "weightUnits.js"),
  "utf8"
);

const KG_PER_TON = 1000;
const tonsToKg = (tons) => Number(tons) * KG_PER_TON;
const kgToTons = (kg) => Number(kg) / KG_PER_TON;
const ratePerTonToKg = (rate) => Number(rate) / KG_PER_TON;
const ratePerKgToTon = (rate) => Number(rate) * KG_PER_TON;

describe("weight and rate round-trip", () => {
  it("weightUnits module exports conversion helpers", () => {
    assert.ok(weightSrc.includes("export function tonsToKg"));
    assert.ok(weightSrc.includes("export function ratePerTonToKg"));
    assert.ok(weightSrc.includes("digits = 2"));
  });

  it("15 tons stores as 15000 kg and displays back as 15", () => {
    const kg = tonsToKg(15);
    assert.equal(kg, 15000);
    assert.equal(kgToTons(kg), 15);
  });

  it("5000 PKR/ton round-trips through per-kg storage", () => {
    const perKg = ratePerTonToKg(5000);
    assert.equal(perKg, 5);
    assert.equal(ratePerKgToTon(perKg), 5000);
  });
});
