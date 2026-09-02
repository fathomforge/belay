/**
 * Tests for the hook adapter, driven through `createBelay` rather than through
 * `definePluginEntry`, so no gateway is needed. The exported factory is the
 * seam: `register()` is a thin wiring layer over exactly these methods.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createBelay, guard } from "../src/belay.ts";
import { parseConfig } from "../src/config.ts";

function makeLogger() {
  const lines: string[] = [];
  return {
    lines,
    info: (m: string) => lines.push(`info ${m}`),
    warn: (m: string) => lines.push(`warn ${m}`),
    error: (m: string) => lines.push(`error ${m}`),
  };
}

const T0 = Date.parse("2026-09-02T17:00:00Z");

test("a run under every cap passes", () => {
  const { config } = parseConfig({ limits: { spendPerDayUsd: 5 } });
  const belay = createBelay(config, makeLogger(), () => T0);
  assert.deepEqual(belay.beforeAgentRun({ agentId: "main", runId: "r1" }), { outcome: "pass" });
});

test("llm_output meters real usage and the daily cap then blocks the run", () => {
  const { config } = parseConfig({ limits: { spendPerDayUsd: 0.5 } });
  let now = T0;
  const belay = createBelay(config, makeLogger(), () => now);
  const ctx = { agentId: "main", runId: "r1" };

  // 1M input tokens of gemini-3.8-flash at intro pricing = $0.75, over the $0.50 cap.
  belay.llmOutput(ctx, {
    provider: "google",
    model: "gemini-3.8-flash",
    usage: { input: 1_000_000, output: 0 },
    runId: "r1",
  });

  now += 1000;
  const decision = belay.beforeAgentRun(ctx);
  assert.equal(decision.outcome, "block");
  if (decision.outcome === "block") {
    // `reason` is plugin-internal per the SDK; `message` is what a user may see.
    assert.equal(decision.reason, "belay:endRun");
    assert.match(decision.message, /Paused by Belay/);
    assert.equal(decision.category, "cost_limit");
  }
});

test("a missing usage object never counts as spend", () => {
  const { config } = parseConfig({ limits: { spendPerDayUsd: 0.01 } });
  const belay = createBelay(config, makeLogger(), () => T0);
  const ctx = { agentId: "main", runId: "r1" };
  for (let i = 0; i < 50; i += 1) {
    belay.llmOutput(ctx, { provider: "google", model: "gemini-3.8-flash", runId: "r1" });
  }
  assert.equal(belay.meter.scope("main").snapshot(T0, "r1").runUsd, 0);
  assert.deepEqual(belay.beforeAgentRun(ctx), { outcome: "pass" });
});

test("an unknown model is counted as unpriced, not as free, and warns once", () => {
  const { config } = parseConfig({ limits: { spendPerDayUsd: 1 } });
  const logger = makeLogger();
  const belay = createBelay(config, logger, () => T0);
  const ctx = { agentId: "main", runId: "r1" };
  for (let i = 0; i < 5; i += 1) {
    belay.llmOutput(ctx, {
      provider: "acme",
      model: "mystery-9",
      usage: { input: 1_000_000, output: 1_000_000 },
      runId: "r1",
    });
  }
  const snap = belay.meter.scope("main").snapshot(T0, "r1");
  assert.equal(snap.unpricedCalls, 5);
  assert.equal(snap.runUsd, 0);
  assert.equal(snap.runTokens, 10_000_000);
  // Five unknown-model calls, one warning.
  assert.equal(logger.lines.filter((l) => l.includes("no price known")).length, 1);

  // The "your cap is incomplete" warning comes from the gate path, which runs on
  // every turn in practice. Also once, no matter how many turns.
  belay.beforeAgentRun(ctx);
  belay.beforeAgentRun(ctx);
  assert.equal(logger.lines.filter((l) => l.includes("could not be priced")).length, 1);
});

test("a price override is used ahead of the bundled table", () => {
  const { config } = parseConfig({
    limits: { spendPerDayUsd: 100 },
    prices: { "acme/mystery-9": { input: 10, output: 10 } },
  });
  const belay = createBelay(config, makeLogger(), () => T0);
  belay.llmOutput(
    { agentId: "main", runId: "r1" },
    { provider: "acme", model: "mystery-9", usage: { input: 1_000_000 }, runId: "r1" },
  );
  assert.equal(belay.meter.scope("main").snapshot(T0, "r1").runUsd, 10);
});

test("incident #2: identical tool calls are blocked with a user-facing reason", () => {
  const { config } = parseConfig({ limits: { identicalToolCalls: 5 } });
  const belay = createBelay(config, makeLogger(), () => T0);
  const ctx = { agentId: "main", runId: "r1" };
  const call = { toolName: "web_fetch", params: { url: "https://example.invalid/x.jpg" } };

  let blockedAt = -1;
  for (let i = 0; i < 10; i += 1) {
    const result = belay.beforeToolCall(ctx, call);
    if (result.block && blockedAt === -1) blockedAt = i;
  }
  assert.equal(blockedAt, 4, "blocks on the 5th identical call");
  assert.match(belay.beforeToolCall(ctx, call).blockReason ?? "", /repeated/);
});

test("a different tool call is unaffected by another one's repeats", () => {
  const { config } = parseConfig({ limits: { identicalToolCalls: 3 } });
  const belay = createBelay(config, makeLogger(), () => T0);
  const ctx = { agentId: "main", runId: "r1" };
  for (let i = 0; i < 5; i += 1) {
    belay.beforeToolCall(ctx, { toolName: "web_fetch", params: { url: "a" } });
  }
  // The ladder is up, but a distinct call in a *fresh* run is not penalised.
  const other = belay.beforeToolCall(
    { agentId: "main", runId: "r2" },
    { toolName: "read_file", params: { path: "b" } },
  );
  assert.equal(other.block, undefined);
});

test("tool params are fingerprinted, never retained", () => {
  const { config } = parseConfig({ limits: { identicalToolCalls: 2 } });
  const belay = createBelay(config, makeLogger(), () => T0);
  // Deliberately not credential-shaped: check-secrets treats real-looking keys
  // in source as a commit blocker, and it is right to.
  const sensitiveParam = "PARAM-THAT-MUST-NEVER-BE-STORED";
  const ctx = { agentId: "main", runId: "r1" };
  belay.beforeToolCall(ctx, { toolName: "exec", params: { cmd: sensitiveParam } });
  belay.beforeToolCall(ctx, { toolName: "exec", params: { cmd: sensitiveParam } });
  // Nothing anywhere in the meter's serialized state may contain the parameters.
  assert.equal(JSON.stringify(belay.meter.toJSON()).includes(sensitiveParam), false);
});

test("unserialisable tool params do not throw", () => {
  const { config } = parseConfig({ limits: { identicalToolCalls: 2 } });
  const belay = createBelay(config, makeLogger(), () => T0);
  const circular: Record<string, unknown> = {};
  circular["self"] = circular;
  assert.doesNotThrow(() => {
    belay.beforeToolCall({ agentId: "main", runId: "r1" }, { toolName: "x", params: circular });
  });
});

test("scoping falls back to the session key when agentId is absent", () => {
  const { config } = parseConfig({ limits: { spendPerDayUsd: 100 } });
  const belay = createBelay(config, makeLogger(), () => T0);
  belay.llmOutput(
    { sessionKey: "telegram:main:123", runId: "r1" },
    { provider: "google", model: "gemini-3.8-flash", usage: { input: 1_000_000 }, runId: "r1" },
  );
  assert.equal(belay.meter.scope(undefined, "telegram:main:123").snapshot(T0).dayUsd, 0.75);
});

test("per-agent caps isolate one agent's overspend from another's", () => {
  const { config } = parseConfig({
    limits: { spendPerDayUsd: 100 },
    agents: { gauntlet: { spendPerDayUsd: 0.5 } },
  });
  let now = T0;
  const belay = createBelay(config, makeLogger(), () => now);
  const usage = { provider: "google", model: "gemini-3.8-flash", usage: { input: 1_000_000 } };

  belay.llmOutput({ agentId: "gauntlet", runId: "g1" }, { ...usage, runId: "g1" });
  now += 1000;
  assert.equal(belay.beforeAgentRun({ agentId: "gauntlet", runId: "g1" }).outcome, "block");
  assert.equal(belay.beforeAgentRun({ agentId: "main", runId: "m1" }).outcome, "pass");
});

test("agent_end releases the run without losing the day's spend", () => {
  const { config } = parseConfig({ limits: { spendPerDayUsd: 100 } });
  const belay = createBelay(config, makeLogger(), () => T0);
  const ctx = { agentId: "main", runId: "r1" };
  belay.llmOutput(ctx, {
    provider: "google",
    model: "gemini-3.8-flash",
    usage: { input: 1_000_000 },
    runId: "r1",
  });
  belay.agentEnd(ctx);
  assert.equal(belay.meter.scope("main").snapshot(T0, "r1").runUsd, 0);
  assert.equal(belay.meter.scope("main").snapshot(T0).dayUsd, 0.75);
});

test("errors feed the storm counter only when there is an error", () => {
  const { config } = parseConfig({ limits: { toolErrorsPerMinute: 3 } });
  const belay = createBelay(config, makeLogger(), () => T0);
  const ctx = { agentId: "main", runId: "r1" };
  belay.afterToolCall(ctx, {});
  belay.afterToolCall(ctx, { error: null });
  assert.equal(belay.meter.scope("main").snapshot(T0).toolErrorsPerMinute, 0);
  belay.afterToolCall(ctx, { error: new Error("404") });
  assert.equal(belay.meter.scope("main").snapshot(T0).toolErrorsPerMinute, 1);
});

test("the fail-open guard swallows a bug and returns the permissive answer", () => {
  // The whole trust argument rests on this: a defect in Belay must degrade to
  // "no guardrail", never to "the gateway is down" or "everything is blocked".
  const logger = makeLogger();
  const result = guard(
    logger,
    "before_agent_run",
    (): { outcome: string } => {
      throw new Error("kaboom");
    },
    { outcome: "pass" },
  );
  assert.deepEqual(result, { outcome: "pass" });
  assert.match(logger.lines.join(" "), /before_agent_run failed, passing through/);
});

test("the guard returns the value untouched when nothing throws", () => {
  assert.equal(guard(makeLogger(), "h", () => 42, 0), 42);
});

test("a guard with no fallback yields undefined rather than propagating", () => {
  const logger = makeLogger();
  assert.equal(
    guard(logger, "llm_output", () => {
      throw new Error("nope");
    }),
    undefined,
  );
  assert.equal(logger.lines.length, 1);
});

test("a thrown non-Error is still contained", () => {
  const logger = makeLogger();
  assert.doesNotThrow(() => {
    guard(logger, "h", () => {
      throw "a string, because providers do that";
    });
  });
});
