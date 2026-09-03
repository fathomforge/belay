import test from "node:test";
import assert from "node:assert/strict";
import { Meter, ScopeState } from "../src/meter.ts";

test("usage accumulates per run, per hour and per day", () => {
  const s = new ScopeState("main", "UTC");
  const t = Date.parse("2026-09-02T10:00:00Z");
  s.recordUsage(t, "run-1", { usd: 0.25, tokens: 1000, priceable: true });
  s.recordUsage(t + 1000, "run-1", { usd: 0.25, tokens: 1000, priceable: true });
  const snap = s.snapshot(t + 2000, "run-1");
  assert.equal(snap.runUsd, 0.5);
  assert.equal(snap.runTokens, 2000);
  assert.equal(snap.hourUsd, 0.5);
  assert.equal(snap.dayUsd, 0.5);
});

test("an unpriceable call is counted as unknown, not as free", () => {
  const s = new ScopeState("main", "UTC");
  const t = Date.parse("2026-09-02T10:00:00Z");
  s.recordUsage(t, "run-1", { usd: 0, tokens: 174_000, priceable: false });
  const snap = s.snapshot(t, "run-1");
  assert.equal(snap.dayUsd, 0);
  assert.equal(snap.runTokens, 174_000);
  assert.equal(snap.unpricedCalls, 1);
});

test("runs are isolated from each other", () => {
  const s = new ScopeState("main", "UTC");
  const t = Date.parse("2026-09-02T10:00:00Z");
  s.recordUsage(t, "run-1", { usd: 1, tokens: 10, priceable: true });
  s.recordUsage(t, "run-2", { usd: 2, tokens: 20, priceable: true });
  assert.equal(s.snapshot(t, "run-1").runUsd, 1);
  assert.equal(s.snapshot(t, "run-2").runUsd, 2);
  // ...but the hour and day see everything.
  assert.equal(s.snapshot(t, "run-1").hourUsd, 3);
});

test("ending a run releases its state", () => {
  const s = new ScopeState("main", "UTC");
  const t = Date.parse("2026-09-02T10:00:00Z");
  s.recordUsage(t, "run-1", { usd: 1, tokens: 10, priceable: true });
  s.endRun("run-1");
  assert.equal(s.snapshot(t, "run-1").runUsd, 0);
  // The hour total is unaffected: the money was still spent.
  assert.equal(s.snapshot(t).hourUsd, 1);
});

test("abandoned runs cannot grow without bound", () => {
  const s = new ScopeState("main", "UTC");
  const t = Date.parse("2026-09-02T10:00:00Z");
  for (let i = 0; i < 500; i += 1) {
    s.recordUsage(t + i, `run-${i}`, { usd: 0.001, tokens: 1, priceable: true });
  }
  // The newest run is still tracked; the oldest were evicted.
  assert.equal(s.snapshot(t + 499, "run-499").runUsd, 0.001);
  assert.equal(s.snapshot(t + 499, "run-0").runUsd, 0);
  assert.ok(Math.abs(s.snapshot(t + 499).hourUsd - 0.5) < 1e-9);
});

test("identical calls are counted by fingerprint, per run", () => {
  const s = new ScopeState("main", "UTC");
  const t = Date.parse("2026-09-02T10:00:00Z");
  for (let i = 0; i < 5; i += 1) s.recordToolCall(t + i, "run-1", "fp-a");
  s.recordToolCall(t, "run-1", "fp-b");
  assert.equal(s.snapshot(t + 10, "run-1").maxIdenticalCalls, 5);
  assert.equal(s.snapshot(t + 10, "run-1").toolCallsPerMinute, 6);
  // A different run starts its own count.
  assert.equal(s.snapshot(t + 10, "run-2").maxIdenticalCalls, 0);
});

test("the day total survives a restart but the rate windows do not", () => {
  const s = new ScopeState("main", "America/Los_Angeles");
  const t = Date.parse("2026-09-02T18:00:00Z");
  s.recordUsage(t, "run-1", { usd: 1.75, tokens: 10, priceable: true });
  s.recordModelCall(t);

  const revived = ScopeState.fromJSON(s.toJSON(), "America/Los_Angeles");
  assert.equal(revived.snapshot(t).dayUsd, 1.75);
  // Rates are inherently short-window; rebuilding them after a restart would be
  // guesswork, and under-reporting a rate is safe where under-reporting spend is not.
  assert.equal(revived.snapshot(t).modelCallsPerMinute, 0);
});

test("a ladder rung survives a restart, so bouncing the gateway is not an escape", () => {
  const s = new ScopeState("main", "UTC");
  s.ladder.record(1000, "blockTool", "identical_tool_call");
  const revived = ScopeState.fromJSON(s.toJSON(), "UTC");
  assert.equal(revived.ladder.rungAt(2000), "blockTool");
});

test("Meter falls back to the session key when agentId is absent", () => {
  const m = new Meter("UTC");
  // `agentId` is optional in the SDK's hook context, so this path is real.
  assert.equal(m.scope(undefined, "telegram:123").key, "telegram:123");
  assert.equal(m.scope("main", "telegram:123").key, "main");
  assert.equal(m.scope(undefined, undefined).key, "unknown");
  assert.equal(m.scopes().length, 3);
});

test("Meter round-trips through persistence", () => {
  const m = new Meter("UTC");
  const t = Date.parse("2026-09-02T10:00:00Z");
  m.scope("main").recordUsage(t, "run-1", { usd: 3, tokens: 10, priceable: true });
  const revived = new Meter("UTC");
  revived.load(JSON.parse(JSON.stringify(m.toJSON())));
  assert.equal(revived.scope("main").snapshot(t).dayUsd, 3);
});

test("Meter.load ignores junk entries rather than throwing", () => {
  const m = new Meter("UTC");
  m.load([null, { nope: true }, undefined] as never);
  assert.equal(m.scopes().length, 0);
});

test("an agent is one scope whether or not the hook supplied agentId", () => {
  // Found on a live gateway: some hooks give `agentId` ("main"), others only
  // give `sessionKey` ("agent:main:main"). Metering them separately split one
  // agent's spend across two buckets, so neither reached its cap.
  const m = new Meter("UTC");
  const t = Date.parse("2026-09-02T10:00:00Z");
  m.scope("main", "agent:main:main").recordUsage(t, "r1", { usd: 1, tokens: 10, priceable: true });
  m.scope(undefined, "agent:main:main").recordUsage(t, "r1", { usd: 1, tokens: 10, priceable: true });

  assert.equal(m.scopes().length, 1, "one agent, one scope");
  assert.equal(m.scope("main").snapshot(t).dayUsd, 2);
});

test("an unrecognised session key still gets its own scope rather than a wrong one", () => {
  const m = new Meter("UTC");
  assert.equal(m.scope(undefined, "telegram:12345").key, "telegram:12345");
  assert.equal(m.scope(undefined, undefined).key, "unknown");
});

test("a model call with no usage at all is counted, not silently ignored", () => {
  const s = new ScopeState("main", "UTC");
  const t = Date.parse("2026-09-02T10:00:00Z");
  s.recordMissingUsage();
  s.recordMissingUsage();
  const snap = s.snapshot(t, "r1");
  assert.equal(snap.unmeteredCalls, 2);
  // Distinct from unpriced: those at least contribute tokens.
  assert.equal(snap.unpricedCalls, 0);
});
