/**
 * Incident replays.
 *
 * These drive the real policy path end to end -- meter, enforcer, ladder -- with
 * event sequences shaped like the incidents in `docs/incident-library.md`.
 *
 * They are *synthetic* sequences built from the documented rates and counts, not
 * recorded gateway payloads. When real payloads are captured from the VM they
 * should replace the generators here; until then these prove the policy, not the
 * payload parsing. `usage.test.ts` covers the payload shape separately.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { Meter } from "../../src/meter.ts";
import { evaluate } from "../../src/enforcer.ts";
import { DEFAULT_CONFIG, limitsFor, parseConfig } from "../../src/config.ts";
import type { Surface } from "../../src/enforcer.ts";
import type { RungName } from "../../src/types.ts";

const T0 = Date.parse("2026-09-02T17:00:00Z");

type Action = { at: number; rung: RungName; trigger: string };

/** Runs one breach check the way the plugin's hook adapter will. */
function check(
  meter: Meter,
  config: ReturnType<typeof parseConfig>["config"],
  agentId: string,
  runId: string,
  now: number,
  surface: Surface,
  actions: Action[],
): void {
  const scope = meter.scope(agentId);
  const breaches = evaluate(
    scope.snapshot(now, runId),
    limitsFor(config, agentId),
    config.rungs,
    surface,
  );
  const worst = breaches[0];
  if (!worst) return;
  const step = scope.ladder.record(now, worst.requested, worst.trigger);
  // Only a *new* step is an action an operator would see; the rest are dedupe.
  if (step.isNew) actions.push({ at: now, rung: step.rung, trigger: worst.trigger });
}

test("incident #1: a confabulation storm escalates to a pause and alerts once per rung", () => {
  // "148 events from one message, ~11 model calls/min, until restarted."
  const { config } = parseConfig({
    limits: { modelCallsPerMinute: 10, spendPerRunUsd: 0.5 },
    ladder: { cooldownMs: 60_000, decayMs: 15 * 60_000 },
  });
  const meter = new Meter(config.timeZone, config.ladder);
  const actions: Action[] = [];

  // 150 model calls spread over five minutes, as the incident ran.
  for (let i = 0; i < 150; i += 1) {
    const now = T0 + i * 2_000;
    meter.scope("main").recordModelCall(now);
    meter.scope("main").recordUsage(now, "run-1", {
      usd: 0.01,
      tokens: 4_000,
      priceable: true,
    });
    check(meter, config, "main", "run-1", now, "model_call", actions);
    check(meter, config, "main", "run-1", now, "agent_run", actions);
  }

  // The ladder climbed all the way to a pause...
  assert.equal(meter.scope("main").ladder.rung, "pause");
  // ...and did so in a handful of alerts, not 150.
  assert.ok(actions.length <= 6, `expected few alerts, got ${actions.length}`);
  assert.deepEqual(
    actions.map((a) => a.rung),
    ["warn", "blockTool", "endRun", "pause"],
  );
  // The run cap was the thing that escalated past a warning.
  assert.ok(actions.some((a) => a.trigger === "spend_run"));
});

test("incident #2: 300 identical failing tool calls block, and alert once", () => {
  // "245-700 model calls per stuck photo", each a retry of the same fetch.
  const { config } = parseConfig({ limits: { identicalToolCalls: 20, toolErrorsPerMinute: 30 } });
  const meter = new Meter(config.timeZone, config.ladder);
  const actions: Action[] = [];
  const scope = meter.scope("main");

  for (let i = 0; i < 300; i += 1) {
    const now = T0 + i * 100; // 30 seconds of hammering, inside one cooldown
    scope.recordToolCall(now, "run-2", "fetch:hallucinated-url");
    scope.recordToolError(now);
    check(meter, config, "main", "run-2", now, "tool_call", actions);
  }

  assert.equal(actions.length, 1, "300 identical failures must produce one alert");
  assert.equal(actions[0]?.rung, "blockTool");
  assert.equal(actions[0]?.trigger, "identical_tool_call");
  // It blocked early rather than after all 300.
  assert.ok((actions[0]?.at ?? 0) - T0 < 5_000);
});

test("incident #4: an hourly 174k-token heartbeat trips a $2 daily cap once", () => {
  // $1/day, not the library's $2: at intro pricing a 174k-token heartbeat is
  // ~$0.13, and the *calendar day* in America/Los_Angeles only holds 14 of them
  // before rolling over -- $1.83, which never reaches $2. The rollover boundary
  // is doing real work here, and a rolling-24h cap would have behaved differently.
  const { config } = parseConfig({
    timeZone: "America/Los_Angeles",
    limits: { spendPerDayUsd: 1 },
  });
  const meter = new Meter(config.timeZone, config.ladder);
  const actions: Action[] = [];
  const scope = meter.scope("main");

  // 24 hourly heartbeats at Gemini 3.8 Flash intro pricing: 174k input ~= $0.13 each.
  for (let hour = 0; hour < 24; hour += 1) {
    const now = T0 + hour * 3_600_000;
    scope.recordUsage(now, `cron-${hour}`, { usd: 0.1305, tokens: 174_000, priceable: true });
    check(meter, config, "main", `cron-${hour}`, now, "agent_run", actions);
  }

  // Seventeen of the 24 hours are over the cap, but the operator hears three
  // things: the first breach, one 6-hourly reminder that it is still breached,
  // and a fresh breach after the Pacific calendar day rolls over.
  assert.equal(actions.length, 3);
  assert.deepEqual(actions.map((a) => a.trigger), ["spend_day", "spend_day", "spend_day"]);
  assert.deepEqual(actions.map((a) => a.rung), ["endRun", "endRun", "endRun"]);
});

test("a normal day trips nothing at all", () => {
  // The plan's second verification criterion, and the one that decides whether
  // anybody keeps the plugin installed.
  const { config } = parseConfig({
    limits: {
      spendPerDayUsd: 2,
      spendPerRunUsd: 0.5,
      modelCallsPerMinute: 30,
      identicalToolCalls: 20,
    },
  });
  const meter = new Meter(config.timeZone, config.ladder);
  const actions: Action[] = [];
  const scope = meter.scope("gauntlet");

  // 40 conversational turns across a day: a few model calls and tools each,
  // roughly the "$4/month chatty group bot" from the incident library.
  for (let turn = 0; turn < 40; turn += 1) {
    const base = T0 + turn * 20 * 60_000;
    const runId = `run-${turn}`;
    for (let call = 0; call < 3; call += 1) {
      const now = base + call * 4_000;
      scope.recordModelCall(now);
      scope.recordUsage(now, runId, { usd: 0.003, tokens: 3_500, priceable: true });
      scope.recordToolCall(now, runId, `tool-${turn}-${call}`);
      check(meter, config, "gauntlet", runId, now, "model_call", actions);
      check(meter, config, "gauntlet", runId, now, "tool_call", actions);
      check(meter, config, "gauntlet", runId, now, "agent_run", actions);
    }
    scope.endRun(runId);
  }

  assert.deepEqual(actions, [], "a normal day must be completely silent");
  assert.equal(scope.ladder.rung, "none");
});

test("default config alone never blocks a normal day", () => {
  // Someone who installs Belay and configures nothing must see no behaviour change.
  const meter = new Meter(DEFAULT_CONFIG.timeZone, DEFAULT_CONFIG.ladder);
  const scope = meter.scope("main");
  const actions: Action[] = [];
  for (let i = 0; i < 20; i += 1) {
    const now = T0 + i * 30_000;
    scope.recordModelCall(now);
    scope.recordUsage(now, "run-1", { usd: 0.05, tokens: 5_000, priceable: true });
    check(meter, DEFAULT_CONFIG, "main", "run-1", now, "model_call", actions);
    check(meter, DEFAULT_CONFIG, "main", "run-1", now, "agent_run", actions);
  }
  assert.deepEqual(actions, []);
});
