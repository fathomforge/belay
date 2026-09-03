import test from "node:test";
import assert from "node:assert/strict";
import { readUsage } from "../src/usage.ts";
import { costOf } from "../src/pricing.ts";

test("a normal usage report is fully priceable", () => {
  const r = readUsage({ input: 1000, output: 200, cacheRead: 50, cacheWrite: 10 });
  assert.equal(r.present, true);
  assert.equal(r.priceable, true);
  assert.equal(r.tokens, 1260);
  assert.deepEqual(r.usage, { input: 1000, output: 200, cacheRead: 50, cacheWrite: 10 });
});

test("a missing usage object is reported, never treated as free", () => {
  const r = readUsage(undefined);
  assert.equal(r.present, false);
  assert.equal(r.priceable, false);
  assert.equal(r.tokens, 0);
  // The distinction that matters: this is $0.00 only because we do not know,
  // and `present: false` is what stops a spend cap from trusting that zero.
  assert.equal(costOf(r.usage, { input: 1, output: 1 }), 0);
});

test("a total-only report meters tokens but refuses to invent a price", () => {
  const r = readUsage({ total: 174_000 });
  assert.equal(r.present, true);
  assert.equal(r.priceable, false);
  assert.equal(r.tokens, 174_000);
});

test("a reported total larger than the split wins, so we never under-count", () => {
  // Reasoning tokens are billed but are not in the four buckets we model.
  const r = readUsage({ input: 100, output: 100, total: 500 });
  assert.equal(r.tokens, 500);
  assert.equal(r.priceable, true);
});

test("junk from a provider degrades to zero rather than NaN", () => {
  const r = readUsage({
    input: Number.NaN,
    output: -5,
    cacheRead: Number.POSITIVE_INFINITY,
    cacheWrite: undefined,
  });
  assert.deepEqual(r.usage, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  assert.equal(Number.isFinite(costOf(r.usage, { input: 1, output: 1 })), true);
  assert.equal(r.present, false);
});

test("an empty usage object is not a priceable call", () => {
  const r = readUsage({});
  assert.equal(r.present, false);
  assert.equal(r.priceable, false);
});

test("incident #4: an hourly 174k-token heartbeat is visible even without a price", () => {
  // The largest steady cost in the incident library. A token-based warning has
  // to work on providers that never report an input/output split.
  let tokens = 0;
  for (let hour = 0; hour < 24; hour += 1) tokens += readUsage({ total: 174_000 }).tokens;
  assert.equal(tokens, 4_176_000);
});

test("token buckets are read under any of their known field names", () => {
  // OpenClaw's llm_output uses the short names; the transcript entry and several
  // providers use *Tokens or snake_case. A meter that knows one spelling reports
  // $0.00 on the others.
  const camel = readUsage({ inputTokens: 100, outputTokens: 50 } as never);
  assert.deepEqual(camel.usage, { input: 100, output: 50, cacheRead: 0, cacheWrite: 0 });
  assert.equal(camel.priceable, true);

  const snake = readUsage({ input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 2 } as never);
  assert.deepEqual(snake.usage, { input: 10, output: 5, cacheRead: 2, cacheWrite: 0 });

  const openai = readUsage({ promptTokens: 7, completionTokens: 3 } as never);
  assert.deepEqual(openai.usage, { input: 7, output: 3, cacheRead: 0, cacheWrite: 0 });

  assert.equal(readUsage({ totalTokens: 999 } as never).tokens, 999);
});

test("the canonical short names still win when both are present", () => {
  const r = readUsage({ input: 100, inputTokens: 999 } as never);
  assert.equal(r.usage.input, 100);
});

test("a non-object usage value is not usage", () => {
  assert.equal(readUsage("nope" as never).present, false);
  assert.equal(readUsage(42 as never).present, false);
});
