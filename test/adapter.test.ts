/**
 * Tests for the hook adapter, driven through `createBelay` rather than through
 * `definePluginEntry`, so no gateway is needed. The exported factory is the
 * seam: `register()` is a thin wiring layer over exactly these methods.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createBelay, describeShape, describeUsage, guard, usageFrom } from "../src/belay.ts";
import { parseConfig } from "../src/config.ts";
import { Meter } from "../src/meter.ts";
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
  const { config } = parseConfig({ settleAfterRestartMs: 0, limits: { spendPerDayUsd: 5 } });
  const belay = createBelay(config, makeLogger(), () => T0);
  assert.deepEqual(belay.beforeAgentRun({ agentId: "main", runId: "r1" }), { outcome: "pass" });
});

test("llm_output meters real usage and the daily cap then blocks the run", () => {
  const { config } = parseConfig({ settleAfterRestartMs: 0, limits: { spendPerDayUsd: 0.5 } });
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
    assert.match(decision.message, /Belay stopped this run/);
    assert.equal(decision.category, "cost_limit");
  }
});

test("a missing usage object never counts as spend", () => {
  const { config } = parseConfig({ settleAfterRestartMs: 0, limits: { spendPerDayUsd: 0.01 } });
  const belay = createBelay(config, makeLogger(), () => T0);
  const ctx = { agentId: "main", runId: "r1" };
  for (let i = 0; i < 50; i += 1) {
    belay.llmOutput(ctx, { provider: "google", model: "gemini-3.8-flash", runId: "r1" });
  }
  assert.equal(belay.meter.scope("main").snapshot(T0, "r1").runUsd, 0);
  assert.deepEqual(belay.beforeAgentRun(ctx), { outcome: "pass" });
});

test("an unknown model is counted as unpriced, not as free, and warns once", () => {
  const { config } = parseConfig({ settleAfterRestartMs: 0, estimation: { enabled: true }, limits: { spendPerDayUsd: 1 } });
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
  assert.equal(logger.lines.filter((l) => l.includes("unpriced and")).length, 1);
});

test("a price override is used ahead of the bundled table", () => {
  const { config } = parseConfig({ settleAfterRestartMs: 0,
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
  const { config } = parseConfig({ settleAfterRestartMs: 0, limits: { identicalToolCalls: 5 } });
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
  const { config } = parseConfig({ settleAfterRestartMs: 0, limits: { identicalToolCalls: 3 } });
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
  const { config } = parseConfig({ settleAfterRestartMs: 0, limits: { identicalToolCalls: 2 } });
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
  const { config } = parseConfig({ settleAfterRestartMs: 0, limits: { identicalToolCalls: 2 } });
  const belay = createBelay(config, makeLogger(), () => T0);
  const circular: Record<string, unknown> = {};
  circular["self"] = circular;
  assert.doesNotThrow(() => {
    belay.beforeToolCall({ agentId: "main", runId: "r1" }, { toolName: "x", params: circular });
  });
});

test("scoping falls back to the session key when agentId is absent", () => {
  const { config } = parseConfig({ settleAfterRestartMs: 0, estimation: { enabled: true }, limits: { spendPerDayUsd: 100 } });
  const belay = createBelay(config, makeLogger(), () => T0);
  belay.llmOutput(
    { sessionKey: "telegram:main:123", runId: "r1" },
    { provider: "google", model: "gemini-3.8-flash", usage: { input: 1_000_000 }, runId: "r1" },
  );
  assert.equal(belay.meter.scope(undefined, "telegram:main:123").snapshot(T0).dayUsd, 0.75);
});

test("per-agent caps isolate one agent's overspend from another's", () => {
  const { config } = parseConfig({ settleAfterRestartMs: 0,
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
  const { config } = parseConfig({ settleAfterRestartMs: 0, estimation: { enabled: true }, limits: { spendPerDayUsd: 100 } });
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
  const { config } = parseConfig({ settleAfterRestartMs: 0, limits: { toolErrorsPerMinute: 3 } });
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
  // Opts into the top rung explicitly: the shipped default stops at endRun
  // because a hook cannot call channels.stop on OpenClaw 2026.8.2.
  const { config } = parseConfig({
    settleAfterRestartMs: 0,
    limits: { spendPerRunUsd: 0.1 },
    ladder: { maxRung: "pause" },
  });
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
  // Three alerts, not two: reaching the top rung announces the *attempt*, and a
  // second alert confirms what the gateway actually did. Claiming a completed
  // pause that then failed is the failure mode this exists to prevent.
  assert.deepEqual(alerts.map((a) => a.rung), ["endRun", "pause", "pause"]);
  assert.match(alerts[2]?.reason ?? "", /is now stopped/);
  assert.deepEqual(stops, [
    { method: "channels.stop", params: { channel: "telegram", accountId: "acct-1" } },
  ]);
});

test("with no effects configured, nothing at all happens on the side", async () => {
  // The default install: a breach still blocks, but writes no file, sends no
  // alert and calls no gateway method, because none of those exist.
  const { config } = parseConfig({ settleAfterRestartMs: 0, limits: { spendPerRunUsd: 0.1 } });
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
  const { config } = parseConfig({ settleAfterRestartMs: 0, limits: { identicalToolCalls: 3 } });
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
  const { config } = parseConfig({ settleAfterRestartMs: 0,
    mode: "observe",
    limits: { spendPerRunUsd: 0.01, identicalToolCalls: 2, modelCallsPerMinute: 2 },
    pause: { enabled: true, channel: "telegram", accountId: "acct-1" },
  });

  const records: RecorderRecord[] = [];
  const alerts: AlertEvent[] = [];
  const stops: string[] = [];
  // Declared before createBelay: the clock is now read at construction to
  // timestamp startup for the settling window.
  let now = T0;
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

test("per-agent observe: one agent enforces while another only reports", async () => {
  // The real-world case: enforce on a private agent, leave the group bot that
  // has actual users on it untouched until you trust the reports.
  const { config } = parseConfig({ settleAfterRestartMs: 0,
    mode: "enforce",
    limits: { spendPerRunUsd: 0.1 },
    agents: { groupbot: { mode: "observe" } },
  });

  const stops: string[] = [];
  const pauser = new Pauser(
    { enabled: true },
    async (m) => {
      stops.push(m);
      return { ok: true };
    },
    makeLogger(),
  );
  let now = T0;
  const belay = createBelay(config, makeLogger(), () => now, { pauser });

  const usage = { provider: "google", model: "gemini-3.8-flash", usage: { input: 1_000_000 } };
  belay.llmOutput({ agentId: "main", runId: "r1" }, { ...usage, runId: "r1" });
  belay.llmOutput({ agentId: "groupbot", runId: "g1" }, { ...usage, runId: "g1" });

  now += 1000;
  assert.equal(
    belay.beforeAgentRun({ agentId: "main", runId: "r1" }).outcome,
    "block",
    "the enforcing agent is stopped",
  );
  assert.equal(
    belay.beforeAgentRun({ agentId: "groupbot", runId: "g1" }).outcome,
    "pass",
    "the observing agent keeps serving its users",
  );

  // Climb hard on the observing agent; it must never reach a real pause.
  for (let i = 0; i < 10; i += 1) {
    now += 61_000;
    belay.beforeAgentRun({ agentId: "groupbot", runId: "g1", channel: "telegram", accountId: "b" });
  }
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(stops, []);
});

test("a global observe mode overrides a per-agent enforce", () => {
  // A stale per-agent override must not defeat a gateway-wide safety setting.
  const { config } = parseConfig({ settleAfterRestartMs: 0,
    mode: "observe",
    limits: { spendPerRunUsd: 0.1 },
    agents: { main: { mode: "enforce" } },
  });
  let now = T0;
  const belay = createBelay(config, makeLogger(), () => now);
  belay.llmOutput(
    { agentId: "main", runId: "r1" },
    { provider: "google", model: "gemini-3.8-flash", usage: { input: 1_000_000 }, runId: "r1" },
  );
  now += 1000;
  assert.equal(belay.beforeAgentRun({ agentId: "main", runId: "r1" }).outcome, "pass");
});

test("observe mode records what it would have done", () => {
  const { config } = parseConfig({ settleAfterRestartMs: 0, mode: "observe", limits: { spendPerRunUsd: 0.1 } });
  const records: RecorderRecord[] = [];
  let now = T0;
  const belay = createBelay(config, makeLogger(), () => now, {
    recorder: { write: (r: RecorderRecord) => records.push(r) } as unknown as Recorder,
  });
  belay.llmOutput(
    { agentId: "main", runId: "r1" },
    { provider: "google", model: "gemini-3.8-flash", usage: { input: 1_000_000 }, runId: "r1" },
  );
  now += 1000;
  belay.beforeAgentRun({ agentId: "main", runId: "r1" });
  assert.equal(records[0]?.action, "logged");
  assert.match(records[0]?.reason ?? "", /observe mode: would have been endRun/);
});

test("describeShape reports field names and types, never values", () => {
  const shape = describeShape({
    provider: "google",
    prompt: "something private the user said",
    assistantTexts: ["a reply nobody else should see"],
    usage: { input: 5 },
    n: 1,
    flag: true,
    nothing: null,
  });
  assert.match(shape, /provider:string/);
  assert.match(shape, /usage:object/);
  assert.match(shape, /assistantTexts:array\[1\]/);
  // The whole point: the diagnostic must be safe to print in a shared log.
  assert.equal(shape.includes("private"), false);
  assert.equal(shape.includes("nobody"), false);
});

test("usage is read from the assistant transcript entry when the hook field is empty", () => {
  // Real behaviour on a live gateway: llm_output.usage was undefined for Gemini
  // while the transcript entry carried the counts.
  const { config } = parseConfig({ settleAfterRestartMs: 0, estimation: { enabled: true }, limits: { spendPerDayUsd: 100 } });
  const belay = createBelay(config, makeLogger(), () => T0);
  belay.llmOutput(
    { agentId: "main", runId: "r1" },
    {
      provider: "google",
      model: "gemini-3.8-flash",
      lastAssistant: { usage: { input: 1_000_000, output: 0 } },
      runId: "r1",
    },
  );
  assert.equal(belay.meter.scope("main").snapshot(T0, "r1").runUsd, 0.75);
});

test("the hook's own usage field still wins when present", () => {
  const { config } = parseConfig({ settleAfterRestartMs: 0, estimation: { enabled: true }, limits: { spendPerDayUsd: 100 } });
  const belay = createBelay(config, makeLogger(), () => T0);
  belay.llmOutput(
    { agentId: "main", runId: "r1" },
    {
      provider: "google",
      model: "gemini-3.8-flash",
      usage: { input: 2_000_000 },
      lastAssistant: { usage: { input: 1_000_000 } },
      runId: "r1",
    },
  );
  assert.equal(belay.meter.scope("main").snapshot(T0, "r1").runUsd, 1.5);
});

test("a junk transcript entry degrades to no usage rather than a wrong number", () => {
  assert.equal(usageFrom(undefined), undefined);
  assert.equal(usageFrom("a string"), undefined);
  assert.equal(usageFrom({ usage: "not an object" }), undefined);
  assert.deepEqual(usageFrom({ usage: { input: 5 } }), { input: 5 });
});

test("a provider that reports no usage still gets spend capped, via estimation", () => {
  // The end-to-end version of the live-gateway finding: usage is absent, so
  // cost comes from request size instead, and the cap still fires.
  const { config } = parseConfig({ settleAfterRestartMs: 0, estimation: { enabled: true }, limits: { spendPerDayUsd: 1 } });
  const belay = createBelay(config, makeLogger(), () => T0);
  const ctx = { agentId: "main", runId: "r1" };
  const call = { provider: "google", model: "gemini-3.8-flash", runId: "r1" };

  // First call reports nothing: that is what marks the model as unmetered.
  belay.llmOutput(ctx, call);
  assert.equal(belay.meter.scope("main").snapshot(T0, "r1").runUsd, 0);

  // Subsequent calls are estimated from bytes. 3.5 MB of request payload at the
  // calibrated 3.5 bytes/token is 1M input tokens, i.e. $0.75 at intro pricing.
  belay.modelCallEnded(ctx, { ...call, requestPayloadBytes: 3_500_000 });
  const snap = belay.meter.scope("main").snapshot(T0, "r1");
  assert.equal(snap.runUsd, 0.75);
  assert.equal(snap.estimatedCalls, 1);
});

test("a model reporting real usage is never estimated on top of it", () => {
  const { config } = parseConfig({ settleAfterRestartMs: 0, estimation: { enabled: true }, limits: { spendPerDayUsd: 100 } });
  const belay = createBelay(config, makeLogger(), () => T0);
  const ctx = { agentId: "main", runId: "r1" };
  const call = { provider: "google", model: "gemini-3.8-flash", runId: "r1" };

  belay.llmOutput(ctx, { ...call, usage: { input: 1_000_000 } });
  belay.modelCallEnded(ctx, { ...call, requestPayloadBytes: 3_500_000 });

  const snap = belay.meter.scope("main").snapshot(T0, "r1");
  assert.equal(snap.runUsd, 0.75, "measured only, not measured + estimated");
  assert.equal(snap.estimatedCalls, 0);
});

test("estimation can be turned off, and then nothing is estimated", () => {
  const { config } = parseConfig({ settleAfterRestartMs: 0, estimation: { enabled: false } });
  const belay = createBelay(config, makeLogger(), () => T0);
  const ctx = { agentId: "main", runId: "r1" };
  const call = { provider: "google", model: "gemini-3.8-flash", runId: "r1" };
  belay.llmOutput(ctx, call);
  belay.modelCallEnded(ctx, { ...call, requestPayloadBytes: 3_500_000 });
  assert.equal(belay.meter.scope("main").snapshot(T0, "r1").runUsd, 0);
});

test("an estimated breach says so in the reason", () => {
  const { config } = parseConfig({ settleAfterRestartMs: 0, estimation: { enabled: true }, limits: { spendPerRunUsd: 0.5 } });
  let now = T0;
  const belay = createBelay(config, makeLogger(), () => now);
  const ctx = { agentId: "main", runId: "r1" };
  const call = { provider: "google", model: "gemini-3.8-flash", runId: "r1" };
  belay.llmOutput(ctx, call);
  belay.modelCallEnded(ctx, { ...call, requestPayloadBytes: 3_500_000 });

  now += 1000;
  const decision = belay.beforeAgentRun(ctx);
  assert.equal(decision.outcome, "block");
  if (decision.outcome === "block") {
    // An operator reading a dollar figure deserves to know it was estimated.
    assert.match(decision.message, /estimated from request size/);
  }
});

test("breaches in the minutes after a restart warn but never escalate", () => {
  // A restart drains the channel ingress spool as a burst, so an agent gets a
  // clump of queued messages and legitimately makes a clump of calls. Observed
  // live: a restart was followed two minutes later by a run repeating one tool
  // call 40 times.
  const { config } = parseConfig({ limits: { spendPerRunUsd: 0.1 }, settleAfterRestartMs: 120_000 });
  let now = T0;
  const belay = createBelay(config, makeLogger(), () => now);
  const ctx = { agentId: "main", runId: "r1" };
  belay.llmOutput(ctx, {
    provider: "google",
    model: "gemini-3.8-flash",
    usage: { input: 1_000_000 },
    runId: "r1",
  });

  now = T0 + 60_000; // inside the settling window
  assert.equal(belay.beforeAgentRun(ctx).outcome, "pass");

  now = T0 + 121_000; // past it
  assert.equal(belay.beforeAgentRun(ctx).outcome, "block");
});

test("the settling window is recorded honestly, not hidden", () => {
  const { config } = parseConfig({ limits: { spendPerRunUsd: 0.1 }, settleAfterRestartMs: 120_000 });
  const records: RecorderRecord[] = [];
  const belay = createBelay(config, makeLogger(), () => T0, {
    recorder: { write: (r: RecorderRecord) => records.push(r) } as unknown as Recorder,
  });
  const ctx = { agentId: "main", runId: "r1" };
  belay.llmOutput(ctx, {
    provider: "google",
    model: "gemini-3.8-flash",
    usage: { input: 1_000_000 },
    runId: "r1",
  });
  belay.beforeAgentRun(ctx);
  assert.match(records[0]?.reason ?? "", /settling after restart: would have been endRun/);
});

test("estimation works whichever order the two hooks fire in", () => {
  // Ordering is not guaranteed, and getting this wrong meant the first call
  // after every gateway restart was silently counted as free.
  const call = { provider: "google", model: "gemini-3.8-flash", runId: "r1" };

  const forward = createBelay(
    parseConfig({ settleAfterRestartMs: 0, estimation: { enabled: true }, limits: { spendPerDayUsd: 100 } }).config,
    makeLogger(),
    () => T0,
  );
  forward.modelCallEnded({ agentId: "main", runId: "r1" }, { ...call, requestPayloadBytes: 3_500_000 });
  forward.llmOutput({ agentId: "main", runId: "r1" }, call);

  const reverse = createBelay(
    parseConfig({ settleAfterRestartMs: 0, estimation: { enabled: true }, limits: { spendPerDayUsd: 100 } }).config,
    makeLogger(),
    () => T0,
  );
  reverse.llmOutput({ agentId: "main", runId: "r1" }, call);
  reverse.modelCallEnded({ agentId: "main", runId: "r1" }, { ...call, requestPayloadBytes: 3_500_000 });

  assert.equal(forward.meter.scope("main").snapshot(T0, "r1").runUsd, 0.75);
  assert.equal(reverse.meter.scope("main").snapshot(T0, "r1").runUsd, 0.75, "reverse order too");
});

test("the very first call after a restart is counted, not written off", () => {
  // Regression: estimation used to require the model to have been *seen*
  // reporting nothing first, so call one after every restart was free.
  const { config } = parseConfig({ settleAfterRestartMs: 0, estimation: { enabled: true }, limits: { spendPerDayUsd: 100 } });
  const belay = createBelay(config, makeLogger(), () => T0);
  const ctx = { agentId: "main", runId: "r1" };
  const call = { provider: "google", model: "gemini-3.8-flash", runId: "r1" };
  belay.modelCallEnded(ctx, { ...call, requestPayloadBytes: 400_000 });
  belay.llmOutput(ctx, call);
  assert.ok(belay.meter.scope("main").snapshot(T0, "r1").runUsd > 0);
});

test("byte limits are exact and need no estimation at all", () => {
  // The precise counterpart to a spend cap: byte counts come straight from the
  // gateway and were verified against real traffic to about 1%, where the
  // dollar conversion carries roughly +-50%. See docs/CALIBRATION.md.
  const { config } = parseConfig({
    settleAfterRestartMs: 0,
    limits: { requestBytesPerRun: 1_000_000 },
  });
  let now = T0;
  const belay = createBelay(config, makeLogger(), () => now);
  const ctx = { agentId: "main", runId: "r1" };
  const call = { provider: "google", model: "gemini-3.8-flash", runId: "r1" };

  assert.equal(config.estimation.enabled, false, "estimation is off by default");
  belay.modelCallEnded(ctx, { ...call, requestPayloadBytes: 600_000 });
  assert.equal(belay.beforeAgentRun(ctx).outcome, "pass");

  belay.modelCallEnded(ctx, { ...call, requestPayloadBytes: 600_000 });
  now += 1000;
  const decision = belay.beforeAgentRun(ctx);
  assert.equal(decision.outcome, "block");
  if (decision.outcome === "block") {
    // Reported in human units, and exactly: no "(estimated)" qualifier.
    assert.match(decision.message, /1\.2 MB/);
    assert.equal(decision.message.includes("estimated"), false);
  }
});

test("byte accounting works with estimation off, so it is provider-independent", () => {
  const { config } = parseConfig({ settleAfterRestartMs: 0 });
  const belay = createBelay(config, makeLogger(), () => T0);
  const ctx = { agentId: "main", runId: "r1" };
  belay.modelCallEnded(ctx, {
    provider: "acme",
    model: "unknown-model",
    runId: "r1",
    requestPayloadBytes: 2_500_000,
  });
  const snap = belay.meter.scope("main").snapshot(T0, "r1");
  assert.equal(snap.runBytes, 2_500_000);
  assert.equal(snap.dayBytes, 2_500_000);
  assert.equal(snap.bytesPerMinute, 2_500_000);
  // No dollars claimed for a provider we cannot price and did not estimate.
  assert.equal(snap.runUsd, 0);
});

test("a per-minute byte limit catches a context-bloat storm", () => {
  // Incident #2 shape: a run re-sending a large context over and over. Caught
  // exactly, with no dependence on the provider reporting usage.
  const { config } = parseConfig({
    settleAfterRestartMs: 0,
    limits: { requestBytesPerMinute: 10_000_000 },
  });
  let now = T0;
  const belay = createBelay(config, makeLogger(), () => now);
  const ctx = { agentId: "main", runId: "r1" };
  let blockedAt = -1;
  for (let i = 0; i < 30; i += 1) {
    belay.modelCallEnded(ctx, {
      provider: "google",
      model: "gemini-3.8-flash",
      runId: "r1",
      requestPayloadBytes: 1_000_000,
    });
    if (belay.beforeToolCall(ctx, { toolName: "x" }).block && blockedAt === -1) blockedAt = i;
    now += 500;
  }
  assert.equal(blockedAt, 9, "blocks once 10 MB has gone out inside a minute");
});

test("an empty runId does not switch the per-run caps off", () => {
  // `event.runId ?? ctx.runId ?? "unknown"` accepts "": the spend was metered
  // into a run literally named "", while `snapshot()` treats "" as falsy and
  // reads no run at all. The per-run cap then never fires no matter how much
  // the agent spends, and nothing anywhere says so. Contexts with empty string
  // ids are common when a field is populated from a template or a default.
  const { config } = parseConfig({ settleAfterRestartMs: 0, limits: { spendPerRunUsd: 0.5 } });
  const belay = createBelay(config, makeLogger(), () => T0);
  const ctx = { agentId: "main", runId: "" };

  belay.llmOutput(ctx, {
    provider: "google",
    model: "gemini-3.8-flash",
    usage: { input: 1_000_000 }, // $0.75, over the $0.50 per-run cap
  });

  const decision = belay.beforeAgentRun(ctx);
  assert.equal(decision.outcome, "block");
});

test("a context with no run id at all is still metered per run", () => {
  // Falling back to the session key keeps one turn's calls together, so the
  // per-run cap works, and `agent_end` still clears the bucket -- unlike a
  // shared "unknown" run, which would latch the cap on forever.
  const { config } = parseConfig({ settleAfterRestartMs: 0, limits: { spendPerRunUsd: 0.5 } });
  const belay = createBelay(config, makeLogger(), () => T0);
  const ctx = { agentId: "main", sessionKey: "agent:main:main" };

  belay.llmOutput(ctx, {
    provider: "google",
    model: "gemini-3.8-flash",
    usage: { input: 1_000_000 },
  });
  assert.equal(belay.beforeAgentRun(ctx).outcome, "block");

  belay.agentEnd(ctx);
  assert.deepEqual(belay.beforeAgentRun(ctx), { outcome: "pass" }, "the run's total is released");
});

test("an empty runId still counts identical tool calls", () => {
  const { config } = parseConfig({ settleAfterRestartMs: 0, limits: { identicalToolCalls: 3 } });
  const belay = createBelay(config, makeLogger(), () => T0);
  const ctx = { agentId: "main", runId: "" };
  const event = { toolName: "fetch", params: { url: "https://example.test/404" } };

  belay.beforeToolCall(ctx, event);
  belay.beforeToolCall(ctx, event);
  const third = belay.beforeToolCall(ctx, event);
  assert.equal(third.block, true);
});

test("a failover run does not lose the unmetered model's cost", () => {
  // Buffered request sizes used to be keyed by run alone. On a failover, one run
  // walks down a chain of models; the moment any of them reported real usage,
  // its llm_output took *and discarded* the sizes buffered for a different model
  // in the same run, so that model's call was silently free. This is exactly the
  // incident in the README -- a failover re-sending a huge context down a chain
  // of pricier models -- so it is the last place a byte can be allowed to vanish.
  const { config } = parseConfig({
    settleAfterRestartMs: 0,
    estimation: { enabled: true },
    limits: { spendPerRunUsd: 0.5 },
  });
  const belay = createBelay(config, makeLogger(), () => T0);
  const ctx = { agentId: "main", runId: "r1" };

  // The model that reports nothing finishes its call: 3.5 MB of request payload,
  // which is $0.75 of gemini at the calibrated ratio.
  belay.modelCallEnded(ctx, {
    provider: "google",
    model: "gemini-3.8-flash",
    runId: "r1",
    requestPayloadBytes: 3_500_000,
  });
  // A different model in the same run reports usage first.
  belay.llmOutput(ctx, {
    provider: "google",
    model: "gemini-3.8-pro",
    usage: { input: 10, output: 10 },
    runId: "r1",
  });
  // Now the silent model's llm_output arrives with nothing in it.
  belay.llmOutput(ctx, { provider: "google", model: "gemini-3.8-flash", runId: "r1" });

  const snap = belay.meter.scope("main").snapshot(T0, "r1");
  assert.equal(snap.estimatedCalls, 1, "the unmetered call was estimated");
  assert.ok(snap.runUsd >= 0.75, `expected the 3.5 MB call to be priced, got ${snap.runUsd}`);
  assert.equal(belay.beforeAgentRun(ctx).outcome, "block");
});

test("a model_call_ended with no sizes does not cancel a pending estimate", () => {
  // The first `model_call_ended` can carry no byte counts at all. Clearing the
  // "waiting for sizes" mark on it meant the later event that *did* carry sizes
  // was buffered instead of counted, and the call stayed free.
  const { config } = parseConfig({
    settleAfterRestartMs: 0,
    estimation: { enabled: true },
    limits: { spendPerDayUsd: 100 },
  });
  const belay = createBelay(config, makeLogger(), () => T0);
  const ctx = { agentId: "main", runId: "r1" };
  const call = { provider: "google", model: "gemini-3.8-flash", runId: "r1" };

  belay.llmOutput(ctx, call);
  belay.modelCallEnded(ctx, { ...call }); // no sizes reported
  belay.modelCallEnded(ctx, { ...call, requestPayloadBytes: 3_500_000 });

  assert.ok(belay.meter.scope("main").snapshot(T0, "r1").runUsd > 0);
});

test("a broken alert transport cannot cancel the block it was reporting", () => {
  // `guard` fails open on a Belay bug, which is right -- but the decision to
  // block is already made by the time the alert is sent, and the alert is the
  // part most likely to fail (a logger the host swapped out, a recorder on a
  // full disk, a transport that throws synchronously). Losing enforcement
  // because the *notification* failed is the worst possible trade.
  const { config } = parseConfig({ settleAfterRestartMs: 0, limits: { spendPerRunUsd: 0.5 } });
  const exploding = {
    notify: () => {
      throw new Error("transport exploded");
    },
  } as unknown as Alerter;
  const logger = makeLogger();
  const belay = createBelay(config, logger, () => T0, { alerter: exploding });
  const ctx = { agentId: "main", runId: "r1" };

  belay.llmOutput(ctx, {
    provider: "google",
    model: "gemini-3.8-flash",
    usage: { input: 1_000_000 },
    runId: "r1",
  });

  assert.equal(belay.beforeAgentRun(ctx).outcome, "block", "the breach is still enforced");
  assert.ok(logger.lines.some((l) => l.includes("enforcing anyway")));
});

test("the transcript-usage diagnostic prints numbers, never a provider's strings", () => {
  // This log line only fires when a provider's payload was not the shape we
  // expected, which is precisely when it is least safe to stringify whatever
  // arrived. Belay prints its own normalized reading instead.
  const shape = describeUsage({
    input: 12,
    // A provider really can hang extra fields off `usage`, and this one is the
    // kind of thing that must never reach a log line.
    prompt: "the user's private message",
  } as never);
  assert.ok(!shape.includes("private message"), shape);
  assert.match(shape, /"input":12/);
  assert.equal(describeUsage(undefined), "none");
});

test("a per-agent cap applies on the hooks that carry only a session key", () => {
  // The scope key recovers "main" from "agent:main:main", so the spend lands in
  // the right bucket -- but the per-agent *limits* were looked up on
  // `ctx.agentId` alone, which those hooks do not set. The tighter cap the
  // operator set for this specific agent therefore quietly reverted to the
  // looser global one, on exactly the agent they had singled out as expensive.
  const { config } = parseConfig({
    settleAfterRestartMs: 0,
    limits: { spendPerDayUsd: 100 },
    agents: { main: { spendPerDayUsd: 0.5 } },
  });
  const belay = createBelay(config, makeLogger(), () => T0);
  const ctx = { sessionKey: "agent:main:main", runId: "r1" };

  belay.llmOutput(ctx, {
    provider: "google",
    model: "gemini-3.8-flash",
    usage: { input: 1_000_000 }, // $0.75: under the global cap, over this agent's
    runId: "r1",
  });

  assert.equal(belay.meter.scopes().map((s) => s.key).join(), "main");
  assert.equal(belay.beforeAgentRun(ctx).outcome, "block");
});

test("a per-agent observe mode applies on those hooks too", () => {
  // The same lookup, in the direction that hurts a user rather than a budget:
  // an agent the operator explicitly put in observe mode was enforced against
  // -- blocking real people's messages on a gateway that had been told not to.
  const { config } = parseConfig({
    mode: "enforce",
    settleAfterRestartMs: 0,
    limits: { spendPerDayUsd: 0.5 },
    agents: { "group-bot": { mode: "observe" } },
  });
  const belay = createBelay(config, makeLogger(), () => T0);
  const ctx = { sessionKey: "agent:group-bot:main", runId: "r1" };

  belay.llmOutput(ctx, {
    provider: "google",
    model: "gemini-3.8-flash",
    usage: { input: 1_000_000 },
    runId: "r1",
  });

  assert.deepEqual(belay.beforeAgentRun(ctx), { outcome: "pass" }, "observe never blocks");
});

test("no sequence of junk hook payloads makes a handler throw", () => {
  // `guard` in index.ts turns a throw into "pass", which is the right failure
  // mode -- and also a silent one: a handler that throws on some real-world
  // payload is a guardrail that is off, with one log line to show for it. So the
  // handlers are expected to be total on their own, and this walks a few
  // thousand randomized payloads through every hook to say so.
  const values: unknown[] = [
    undefined, null, 0, -1, Number.NaN, Number.POSITIVE_INFINITY, 1e308, 1.5,
    "", "   ", "x", true, false, [], {}, { a: 1 }, "__proto__", "constructor",
  ];
  let seed = 20260902;
  const pick = (): unknown => {
    // Deterministic PRNG: a failure has to be reproducible to be fixable.
    seed = (seed * 1103515245 + 12345) % 2 ** 31;
    return values[seed % values.length];
  };
  const text = (): string => String(pick());

  const { config } = parseConfig({
    settleAfterRestartMs: 0,
    estimation: { enabled: true },
    limits: { spendPerDayUsd: 1, identicalToolCalls: 5, requestBytesPerRun: 1000 },
  });
  const belay = createBelay(config, makeLogger(), () => T0);

  for (let i = 0; i < 3_000; i += 1) {
    const ctx = { agentId: text(), sessionKey: text(), runId: text() };
    belay.modelCallStarted(ctx);
    belay.llmOutput(ctx, {
      provider: text(),
      model: text(),
      usage: { input: pick() as never, total: pick() as never },
      lastAssistant: pick(),
      runId: text(),
    });
    belay.modelCallEnded(ctx, {
      provider: text(),
      model: text(),
      requestPayloadBytes: pick() as never,
      responseStreamBytes: pick() as never,
    });
    belay.beforeToolCall(ctx, { toolName: text(), params: pick() });
    belay.afterToolCall(ctx, { error: pick() });
    belay.beforeAgentRun(ctx);
    belay.agentEnd(ctx);
  }
  // And the state it built is still serializable and reloadable.
  const revived = new Meter(config.timeZone);
  revived.load(JSON.parse(JSON.stringify(belay.meter.toJSON())));
  assert.ok(revived.scopes().length > 0);
});

test("a model storm before any gate records escalation, not completed enforcement", () => {
  // Reproduces the fourth-pass finding end-to-end: drive only the notification
  // hook, which returns nothing and cannot stop anything, and confirm the trail
  // does not claim a run was ended. Previously this wrote action "ended" while
  // no gate had been called at all, and the CLI presented it as evidence.
  const { config } = parseConfig({
    mode: "enforce",
    settleAfterRestartMs: 0,
    limits: { modelCallsPerMinute: 2 },
    ladder: { cooldownMs: 1 },
  });
  const written: RecorderRecord[] = [];
  const recorder = { write: (r: RecorderRecord) => written.push(r) } as unknown as Recorder;
  let now = T0;
  const belay = createBelay(config, makeLogger(), () => now, { recorder });
  const ctx = { agentId: "main", runId: "r1" };

  for (let i = 0; i < 8; i += 1) {
    now += 1000;
    belay.modelCallStarted(ctx);
  }

  assert.ok(written.length > 0, "the storm must be recorded");
  for (const r of written) {
    assert.ok(
      r.action === "logged" || r.action === "escalated",
      `a notification hook cannot have ${r.action}: ${JSON.stringify(r)}`,
    );
  }
  // The ladder is genuinely up there; only the claim about what was done changes.
  assert.ok(written.some((r) => r.rung === "endRun" && r.action === "escalated"));
});

test("the run gate that actually refuses is what records an ended run", () => {
  const { config } = parseConfig({
    mode: "enforce",
    settleAfterRestartMs: 0,
    limits: { modelCallsPerMinute: 2 },
    ladder: { cooldownMs: 1 },
  });
  const written: RecorderRecord[] = [];
  const recorder = { write: (r: RecorderRecord) => written.push(r) } as unknown as Recorder;
  let now = T0;
  const belay = createBelay(config, makeLogger(), () => now, { recorder });
  const ctx = { agentId: "main", runId: "r1" };

  for (let i = 0; i < 8; i += 1) {
    now += 1000;
    belay.modelCallStarted(ctx);
  }
  now += 1000;
  const decision = belay.beforeAgentRun({ agentId: "main", runId: "r2" });
  assert.equal(decision.outcome, "block", "the storm must still be enforced at the run gate");
});
