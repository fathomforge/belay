import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_ESTIMATION,
  estimateFromBytes,
  PendingBytes,
  UsageReporting,
} from "../src/estimate.ts";
import { costOf } from "../src/pricing.ts";

test("request and response bytes become input and output tokens", () => {
  // Explicit divisor: this test is about the arithmetic, not the default.
  const e = estimateFromBytes(
    { requestPayloadBytes: 40_000, responseStreamBytes: 400 },
    { enabled: true, bytesPerToken: 4 },
  );
  assert.equal(e.usable, true);
  assert.equal(e.usage.input, 10_000);
  assert.equal(e.usage.output, 100);
  assert.equal(e.tokens, 10_100);
});

test("the default divisor matches the published calibration", () => {
  // Measured against Gemini's own tokenizer across ten content types; 3.5 sits
  // in the realistic-payload band (2.33-3.60). See docs/CALIBRATION.md. If this
  // changes, that document must change with it.
  assert.equal(DEFAULT_ESTIMATION.bytesPerToken, 3.5);
});

test("cache buckets stay zero rather than being guessed", () => {
  // Guessing a cached read would understate cost, which is the wrong direction
  // for a cap.
  const e = estimateFromBytes({ requestPayloadBytes: 4000 }, DEFAULT_ESTIMATION);
  assert.equal(e.usage.cacheRead, 0);
  assert.equal(e.usage.cacheWrite, 0);
});

test("no byte counts means no estimate, not a zero-cost call", () => {
  assert.equal(estimateFromBytes({}, DEFAULT_ESTIMATION).usable, false);
  assert.equal(
    estimateFromBytes({ requestPayloadBytes: 0, responseStreamBytes: 0 }, DEFAULT_ESTIMATION).usable,
    false,
  );
});

test("junk byte counts degrade to unusable rather than NaN", () => {
  const e = estimateFromBytes(
    { requestPayloadBytes: Number.NaN, responseStreamBytes: -5 },
    DEFAULT_ESTIMATION,
  );
  assert.equal(e.usable, false);
  assert.equal(Number.isFinite(e.tokens), true);
});

test("a nonsensical bytesPerToken falls back to the default", () => {
  const e = estimateFromBytes({ requestPayloadBytes: 3500 }, { enabled: true, bytesPerToken: 0 });
  assert.equal(e.usage.input, 1000);
});

test("the divisor sets the direction of the error, and is measured not guessed", () => {
  // Real bytes/token spans 1.39 (identifier-heavy) to 7.88 (varied prose), so no
  // divisor is right for everything. What matters is that a smaller divisor
  // counts more tokens, i.e. errs toward tripping a cap early.
  const dense = estimateFromBytes({ requestPayloadBytes: 350_000 }, { enabled: true, bytesPerToken: 2.5 });
  const sparse = estimateFromBytes({ requestPayloadBytes: 350_000 }, { enabled: true, bytesPerToken: 5 });
  assert.ok(dense.usage.input > sparse.usage.input);
  assert.ok(costOf(dense.usage, { input: 0.75, output: 3.75 }) > 0);
});

test("incident #4: an unmetered 174k heartbeat still trips a daily cap", () => {
  // The whole point. Without estimation this call contributes $0.00 and the cap
  // never fires, however many times it runs.
  const perCall = estimateFromBytes({ requestPayloadBytes: 700_000 }, DEFAULT_ESTIMATION);
  assert.ok(perCall.usable);
  let spent = 0;
  for (let hour = 0; hour < 14; hour += 1) {
    spent += costOf(perCall.usage, { input: 0.75, output: 3.75 });
  }
  assert.ok(spent > 1, `14 hourly heartbeats should exceed $1, got ${spent}`);
});

test("a model is only estimated after it is seen reporting nothing", () => {
  const r = new UsageReporting();
  assert.equal(r.shouldEstimate("google/gemini-3.8-flash"), false);
  r.markMissing("google/gemini-3.8-flash");
  assert.equal(r.shouldEstimate("google/gemini-3.8-flash"), true);
});

test("a model that reports real usage is never estimated, so nothing double-counts", () => {
  const r = new UsageReporting();
  r.markMissing("acme/m1");
  r.markMeasured("acme/m1");
  assert.equal(r.shouldEstimate("acme/m1"), false);
  // And it stays trusted even if a later call happens to report nothing.
  r.markMissing("acme/m1");
  assert.equal(r.shouldEstimate("acme/m1"), false);
});

test("reporting state is per model, not global", () => {
  const r = new UsageReporting();
  r.markMissing("google/gemini-3.8-flash");
  r.markMeasured("openai/gpt-5.4");
  assert.equal(r.shouldEstimate("google/gemini-3.8-flash"), true);
  assert.equal(r.shouldEstimate("openai/gpt-5.4"), false);
  assert.deepEqual(r.estimatedModels(), ["google/gemini-3.8-flash"]);
});

test("sizes accumulate per run and are consumed once", () => {
  const p = new PendingBytes();
  p.add("run-1", { requestPayloadBytes: 100, responseStreamBytes: 10 });
  p.add("run-1", { requestPayloadBytes: 50 });
  assert.deepEqual(p.take("run-1"), { requestPayloadBytes: 150, responseStreamBytes: 10 });
  // Taken once, gone: a second llm_output must not re-bill the same sizes.
  assert.equal(p.take("run-1"), undefined);
});

test("a run can wait for sizes that have not arrived yet", () => {
  // llm_output first, model_call_ended second: the estimate must still happen.
  const p = new PendingBytes();
  assert.equal(p.isAwaiting("run-1"), false);
  p.awaitBytes("run-1");
  assert.equal(p.isAwaiting("run-1"), true);
  p.clearAwaiting("run-1");
  assert.equal(p.isAwaiting("run-1"), false);
});

test("taking sizes also clears any awaiting flag", () => {
  const p = new PendingBytes();
  p.awaitBytes("run-1");
  p.add("run-1", { requestPayloadBytes: 40 });
  p.take("run-1");
  assert.equal(p.isAwaiting("run-1"), false);
});

test("runs whose llm_output never arrives cannot leak memory", () => {
  const p = new PendingBytes(10);
  for (let i = 0; i < 100; i += 1) {
    p.add(`run-${i}`, { requestPayloadBytes: 10 });
    p.awaitBytes(`run-${i}`);
  }
  assert.equal(p.size, 10);
});
