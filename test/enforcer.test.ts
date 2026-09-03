import test from "node:test";
import assert from "node:assert/strict";
import { evaluate, spendCapsAreBlind } from "../src/enforcer.ts";
import { DEFAULT_CONFIG } from "../src/config.ts";
import type { MeterSnapshot } from "../src/meter.ts";

const rungs = DEFAULT_CONFIG.rungs;

function snap(over: Partial<MeterSnapshot> = {}): MeterSnapshot {
  return {
    runUsd: 0,
    runTokens: 0,
    hourUsd: 0,
    dayUsd: 0,
    modelCallsPerMinute: 0,
    toolCallsPerMinute: 0,
    toolErrorsPerMinute: 0,
    maxIdenticalCalls: 0,
    unpricedCalls: 0,
    unmeteredCalls: 0,
    ...over,
  };
}

test("an unset limit is never a limit of zero", () => {
  // The failure mode this guards: `0 >= undefined` coerced into "always breached",
  // which would block every run on a default install.
  const breaches = evaluate(snap({ dayUsd: 0, runUsd: 0 }), {}, rungs, "agent_run");
  assert.deepEqual(breaches, []);
});

test("traffic below every cap produces no breach", () => {
  const limits = { spendPerDayUsd: 2, modelCallsPerMinute: 30 };
  assert.deepEqual(evaluate(snap({ dayUsd: 1.99 }), limits, rungs, "agent_run"), []);
});

test("a cap breaches on reaching it, not only on exceeding it", () => {
  const breaches = evaluate(snap({ dayUsd: 2 }), { spendPerDayUsd: 2 }, rungs, "agent_run");
  assert.equal(breaches.length, 1);
  assert.equal(breaches[0]?.trigger, "spend_day");
});

test("incident #4: a $2 daily cap trips at $2.10 and asks to end the run", () => {
  const breaches = evaluate(snap({ dayUsd: 2.1 }), { spendPerDayUsd: 2 }, rungs, "agent_run");
  assert.equal(breaches[0]?.requested, "endRun");
  assert.match(breaches[0]?.reason ?? "", /daily spend \$2\.1 reached the \$2 cap/);
});

test("the worst breach is reported first", () => {
  const limits = { spendPerDayUsd: 2, spendPerHourUsd: 1, spendPerRunUsd: 0.5 };
  const breaches = evaluate(snap({ dayUsd: 3, hourUsd: 2, runUsd: 1 }), limits, rungs, "agent_run");
  assert.deepEqual(breaches.map((b) => b.trigger), ["spend_day", "spend_hour", "spend_run"]);
});

test("each surface only acts on what it can actually control", () => {
  const limits = { modelCallsPerMinute: 10, identicalToolCalls: 5, spendPerRunUsd: 1 };
  const s = snap({ modelCallsPerMinute: 50, maxIdenticalCalls: 50, runUsd: 5 });

  // A run gate cannot un-repeat a tool call, and a tool gate cannot end a run.
  assert.deepEqual(evaluate(s, limits, rungs, "agent_run").map((b) => b.trigger), ["spend_run"]);
  assert.deepEqual(evaluate(s, limits, rungs, "model_call").map((b) => b.trigger), [
    "model_call_rate",
  ]);
  assert.deepEqual(evaluate(s, limits, rungs, "tool_call").map((b) => b.trigger), [
    "spend_run",
    "identical_tool_call",
  ]);
});

test("incident #1: 11 model calls a minute breaches a 10/min limit", () => {
  const breaches = evaluate(
    snap({ modelCallsPerMinute: 11 }),
    { modelCallsPerMinute: 10 },
    rungs,
    "model_call",
  );
  assert.equal(breaches[0]?.trigger, "model_call_rate");
  assert.equal(breaches[0]?.requested, "warn");
});

test("incident #2: identical repeats breach and ask to block the tool", () => {
  const breaches = evaluate(
    snap({ maxIdenticalCalls: 245 }),
    { identicalToolCalls: 20 },
    rungs,
    "tool_call",
  );
  assert.equal(breaches[0]?.trigger, "identical_tool_call");
  assert.equal(breaches[0]?.requested, "blockTool");
  assert.match(breaches[0]?.reason ?? "", /repeated 245 times/);
});

test("a spend cap with unpriced calls is reported as blind", () => {
  assert.equal(spendCapsAreBlind(snap({ unpricedCalls: 3 }), { spendPerDayUsd: 2 }), true);
  // No spend cap configured: unpriced calls are not a problem worth alarming about.
  assert.equal(spendCapsAreBlind(snap({ unpricedCalls: 3 }), {}), false);
  assert.equal(spendCapsAreBlind(snap({ unpricedCalls: 0 }), { spendPerDayUsd: 2 }), false);
});
