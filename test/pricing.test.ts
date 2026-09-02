import test from "node:test";
import assert from "node:assert/strict";
import { costOf, priceKey, resolvePrice, totalTokens, FALLBACK_PRICES } from "../src/pricing.ts";

test("priceKey canonicalises provider and model", () => {
  assert.equal(priceKey("Google", "Gemini-3.8-Flash"), "google/gemini-3.8-flash");
  assert.equal(priceKey("google", "google/gemini-3.8-flash"), "google/gemini-3.8-flash");
  assert.equal(priceKey(" google ", " gemini-3.8-flash "), "google/gemini-3.8-flash");
});

test("costOf multiplies tokens by the per-million rate", () => {
  const price = { input: 0.75, output: 3.75 };
  // 1M input + 1M output = 0.75 + 3.75
  assert.equal(costOf({ input: 1_000_000, output: 1_000_000, cacheRead: 0, cacheWrite: 0 }, price), 4.5);
  assert.equal(costOf({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, price), 0);
});

test("costOf falls back to the input rate for cache tokens when unpriced", () => {
  const price = { input: 1, output: 10 };
  const withCache = costOf(
    { input: 0, output: 0, cacheRead: 1_000_000, cacheWrite: 1_000_000 },
    price,
  );
  assert.equal(withCache, 2);
});

test("costOf uses explicit cache rates when the provider prices them", () => {
  const price = { input: 1, output: 10, cacheRead: 0.1, cacheWrite: 1.25 };
  const c = costOf(
    { input: 0, output: 0, cacheRead: 1_000_000, cacheWrite: 1_000_000 },
    price,
  );
  assert.equal(c, 1.35);
});

test("resolvePrice honours the scheduled introductory-price expiry", () => {
  const before = Date.parse("2026-09-02T00:00:00Z");
  const after = Date.parse("2027-01-02T00:00:00Z");
  assert.deepEqual(resolvePrice("google", "gemini-3.8-flash", { now: before }), {
    input: 0.75,
    output: 3.75,
  });
  assert.deepEqual(resolvePrice("google", "gemini-3.8-flash", { now: after }), {
    input: 1.5,
    output: 7.5,
  });
});

test("operator overrides beat the bundled table", () => {
  const overrides = { "google/gemini-3.8-flash": { input: 2, output: 4 } };
  assert.deepEqual(
    resolvePrice("google", "gemini-3.8-flash", { overrides, now: Date.parse("2026-09-02Z") }),
    { input: 2, output: 4 },
  );
});

test("an unknown model returns undefined rather than a guess", () => {
  assert.equal(resolvePrice("acme", "mystery-model-9"), undefined);
});

test("the bundled table is frozen so a plugin bug cannot rewrite prices", () => {
  assert.throws(() => {
    (FALLBACK_PRICES as Record<string, never>)["evil/model"] = undefined as never;
  });
});

test("totalTokens sums every billed bucket", () => {
  assert.equal(
    totalTokens({ input: 10, output: 5, cacheRead: 2, cacheWrite: 3 }),
    20,
  );
});
