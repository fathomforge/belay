/**
 * Tests for the hook adapter, driven through `createBelay` rather than through
 * `definePluginEntry`, so no gateway is needed. The exported factory is the
 * seam: `register()` is a thin wiring layer over exactly these methods.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createBelay, guard } from "../src/belay.ts";
import { parseConfig } from "../src/config.ts";
import { Pauser } from "../src/pauser.ts";
import type { AlertEvent, Alerter } from "../src/alerts.ts";
import type { Recorder, Record as RecorderRecord } from "../src/recorder.ts";

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

test("a pause rung fires the alert, the record and the account stop together", async () => {
  const { config } = parseConfig({ limits: { spendPerRunUsd: 0.1 } });
  let now = T0;
  const logger = makeLogger();

  const alerts: AlertEvent[] = [];
  const alerter = {
    notify: async (e: AlertEvent) => {
      alerts.push(e);
    },
  } as unknown as Alerter;

  const records: RecorderRecord[] = [];
  const recorder = { write: (r: RecorderRecord) => records.push(r) } as unknown as Recorder;

  const stops: { method: string; params: unknown }[] = [];
  const pauser = new Pauser(
    { enabled: true },
    async (method, params) => {
      stops.push({ method, params });
      return { ok: true };
    },
    logger,
  );

  const belay = createBelay(config, logger, () => now, { alerter, recorder, pauser });
  const ctx = { agentId: "main", runId: "r1", channel: "telegram", accountId: "acct-1" };

  // Blow the per-run cap, then keep breaching until the ladder reaches the top.
  belay.llmOutput(ctx, {
    provider: "google",
    model: "gemini-3.8-flash",
    usage: { input: 1_000_000 },
    runId: "r1",
  });
  for (let i = 0; i < 5; i += 1) {
    now += 61_000; // clear the cooldown so the ladder climbs a rung each time
    belay.beforeAgentRun(ctx);
  }
  await new Promise((r) => setTimeout(r, 5)); // let the fire-and-forget pause settle

  assert.deepEqual(
    records.map((r) => r.rung),
    ["endRun", "pause"],
    "every new rung is recorded",
  );
  assert.deepEqual(alerts.map((a) => a.rung), ["endRun", "pause"]);
  assert.deepEqual(stops, [
    { method: "channels.stop", params: { channel: "telegram", accountId: "acct-1" } },
  ]);
});

test("with no effects configured, nothing at all happens on the side", async () => {
  // The default install: a breach still blocks, but writes no file, sends no
  // alert and calls no gateway method, because none of those exist.
  const { config } = parseConfig({ limits: { spendPerRunUsd: 0.1 } });
  let now = T0;
  const belay = createBelay(config, makeLogger(), () => now);
  const ctx = { agentId: "main", runId: "r1", channel: "telegram", accountId: "acct-1" };
  belay.llmOutput(ctx, {
    provider: "google",
    model: "gemini-3.8-flash",
    usage: { input: 1_000_000 },
    runId: "r1",
  });
  for (let i = 0; i < 5; i += 1) {
    now += 61_000;
    assert.doesNotThrow(() => belay.beforeAgentRun(ctx));
  }
});

test("effects only fire on a new rung, so a storm is one alert per rung", async () => {
  const { config } = parseConfig({ limits: { identicalToolCalls: 3 } });
  const alerts: AlertEvent[] = [];
  const alerter = {
    notify: async (e: AlertEvent) => {
      alerts.push(e);
    },
  } as unknown as Alerter;

  const belay = createBelay(config, makeLogger(), () => T0, { alerter });
  const ctx = { agentId: "main", runId: "r1" };
  for (let i = 0; i < 300; i += 1) {
    belay.beforeToolCall(ctx, { toolName: "web_fetch", params: { url: "a" } });
  }
  assert.equal(alerts.length, 1, "300 identical failures produce one alert");
});

test("observe mode never blocks, however badly the agent behaves", async () => {
  // The posture for a first install on a gateway with real users on it.
  const { config } = parseConfig({
    mode: "observe",
    limits: { spendPerRunUsd: 0.01, identicalToolCalls: 2, modelCallsPerMinute: 2 },
    pause: { enabled: true, channel: "telegram", accountId: "acct-1" },
  });

  const records: RecorderRecord[] = [];
  const alerts: AlertEvent[] = [];
  const stops: string[] = [];
  const belay = createBelay(config, makeLogger(), () => (now += 61_000), {
    recorder: { write: (r: RecorderRecord) => records.push(r) } as unknown as Recorder,
    alerter: {
      notify: async (e: AlertEvent) => {
        alerts.push(e);
      },
    } as unknown as Alerter,
    pauser: new Pauser(
      { enabled: true },
      async (m) => {
        stops.push(m);
        return { ok: true };
      },
      makeLogger(),
    ),
  });

  let now = T0;
  const ctx = { agentId: "main", runId: "r1", channel: "telegram", accountId: "acct-1" };
  belay.llmOutput(ctx, {
    provider: "google",
    model: "gemini-3.8-flash",
    usage: { input: 1_000_000 },
    runId: "r1",
  });

  for (let i = 0; i < 20; i += 1) {
    assert.equal(belay.beforeAgentRun(ctx).outcome, "pass", "a run is never blocked");
    assert.equal(
      belay.beforeToolCall(ctx, { toolName: "web_fetch", params: { url: "a" } }).block,
      undefined,
      "a tool call is never blocked",
    );
    belay.modelCallStarted(ctx);
  }
  await new Promise((r) => setTimeout(r, 5));

  // ...but the operator still finds out exactly what would have happened.
  assert.ok(records.length > 0, "breaches are still recorded");
  assert.ok(alerts.length > 0, "the operator is still alerted");
  assert.equal(
    records.every((r) => r.action === "logged"),
    true,
    "every recorded action is a log, never a block",
  );
  assert.deepEqual(stops, [], "no account is ever stopped in observe mode");
});
