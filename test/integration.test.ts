/**
 * Producer -> disk -> reader, in one test.
 *
 * Every previous round of action-evidence fixes was verified with unit tests
 * that either asserted on `toRecord`'s return value or read hand-written
 * fixtures. Both passed while the shipped behaviour was wrong:
 *
 *  - the writer's field allowlist dropped `v`, so every real record was
 *    unversioned and the reader distrusted all of them;
 *  - the outcome of the gate that actually refused a run was never recorded at
 *    all, because reporting was deduplicated on ladder transitions and the
 *    ladder was already at its ceiling;
 *  - `incidents` still rendered the ladder rung, so an escalation printed
 *    "ended a run".
 *
 * None of those are visible unless a real Recorder writes a real file and the
 * real CLI reads it. So this test does exactly that, end to end.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createBelay } from "../src/belay.ts";
import { parseConfig } from "../src/config.ts";
import { Recorder } from "../src/recorder.ts";
import { Alerter } from "../src/alerts.ts";
import { parseTrail } from "../src/recorder.ts";

const CLI = fileURLToPath(new URL("../bin/belay.mjs", import.meta.url));
const T0 = Date.parse("2026-09-02T17:00:00Z");

function cli(args: string[]) {
  const res = spawnSync(process.execPath, [CLI, ...args], {
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "" },
  });
  return { code: res.status, out: res.stdout };
}

function makeLogger() {
  return { info: () => {}, warn: () => {}, error: () => {} };
}

/** A storm of model-call notifications, recorded by a real Recorder to a real file. */
function stormFixture(over: Record<string, unknown> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "belay-int-"));
  const file = join(dir, "trail.jsonl");
  const { config } = parseConfig({
    mode: "enforce",
    settleAfterRestartMs: 0,
    limits: { modelCallsPerMinute: 2 },
    ladder: { cooldownMs: 1 },
    ...over,
  });
  const recorder = new Recorder({ file, maxBytes: 1_000_000 }, makeLogger());
  let now = T0;
  const belay = createBelay(config, makeLogger(), () => now, { recorder });
  const ctx = { agentId: "main", runId: "r1" };
  for (let i = 0; i < 8; i += 1) {
    now += 1000;
    belay.modelCallStarted(ctx);
  }
  return { dir, file, belay, at: () => now, bump: (ms: number) => (now += ms) };
}

test("1. a storm before any gate records escalation, and no output claims enforcement", () => {
  const { file } = stormFixture();
  const written = parseTrail(readFileSync(file, "utf8"));

  assert.ok(written.length > 0);
  for (const r of written) {
    assert.ok(r.action === "logged" || r.action === "escalated", `notification wrote ${r.action}`);
  }

  // The human command is a customer-facing surface too: it must not translate
  // the rung into a past-tense enforcement claim.
  const { out } = cli(["incidents", "--trail", file, "--hours", "9999"]);
  assert.doesNotMatch(out, /ended a run/);
  assert.doesNotMatch(out, /blocked a tool/);
  assert.match(out, /escalated to endRun/);
});

test("2. the gate that actually refuses writes a distinct outcome record", () => {
  const { file, belay, bump } = stormFixture();
  const before = parseTrail(readFileSync(file, "utf8")).length;

  bump(1000);
  const decision = belay.beforeAgentRun({ agentId: "main", runId: "r2" });
  assert.equal(decision.outcome, "block", "the breach must still be enforced");

  const after = parseTrail(readFileSync(file, "utf8"));
  assert.ok(after.length > before, "the refusal must reach the trail");
  const ended = after.filter((r) => r.action === "ended");
  assert.equal(ended.length, 1, "exactly one outcome record for the refusal");
  assert.equal(ended[0]?.rung, "endRun");
});

test("2b. repeated refusals do not write a line per call", () => {
  const { file, belay, bump } = stormFixture();
  for (let i = 0; i < 5; i += 1) {
    bump(1000);
    belay.beforeAgentRun({ agentId: "main", runId: `r${i + 2}` });
  }
  const ended = parseTrail(readFileSync(file, "utf8")).filter((r) => r.action === "ended");
  assert.equal(ended.length, 1, "deduplicated, but present");
});

test("3. the schema version survives to disk and the CLI trusts it", () => {
  const { file, belay, bump } = stormFixture();
  bump(1000);
  belay.beforeAgentRun({ agentId: "main", runId: "r2" });

  const raw = readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  for (const r of raw) assert.equal(r.v, 3, "every written record carries the version");

  const { out } = cli(["incidents", "--trail", file, "--hours", "9999"]);
  assert.match(out, /ended a run/, "a real refusal reads as one");
  assert.doesNotMatch(out, /unverified/, "and is not second-guessed");
});

test("4a. observe mode never records enforcement, whatever the ladder reaches", () => {
  const { file, belay, bump } = stormFixture({ mode: "observe" });
  bump(1000);
  assert.deepEqual(belay.beforeAgentRun({ agentId: "main", runId: "r2" }), { outcome: "pass" });

  for (const r of parseTrail(readFileSync(file, "utf8"))) {
    assert.equal(r.action, "logged", "observe mode acts on nothing");
  }
  const { out } = cli(["incidents", "--trail", file, "--hours", "9999"]);
  assert.doesNotMatch(out, /ended a run(?! )/);
});

test("4b. the settling window never records enforcement either", () => {
  const { file, belay, bump } = stormFixture({ settleAfterRestartMs: 60 * 60 * 1000 });
  bump(1000);
  assert.deepEqual(belay.beforeAgentRun({ agentId: "main", runId: "r2" }), { outcome: "pass" });
  for (const r of parseTrail(readFileSync(file, "utf8"))) {
    assert.equal(r.action, "logged");
  }
});

test("4c. a tool gate refusal is recorded as a blocked tool, not an ended run", () => {
  const dir = mkdtempSync(join(tmpdir(), "belay-int-"));
  const file = join(dir, "trail.jsonl");
  // spend_day maps to endRun by default; at the tool gate that refuses the tool
  // call, so the record must say "blocked", not "ended".
  const { config } = parseConfig({
    mode: "enforce",
    settleAfterRestartMs: 0,
    limits: { spendPerDayUsd: 0.001 },
    prices: { "openai/gpt-5.4-nano": { input: 1000, output: 1000 } },
  });
  const recorder = new Recorder({ file, maxBytes: 1_000_000 }, makeLogger());
  let now = T0;
  const belay = createBelay(config, makeLogger(), () => now, { recorder });
  const ctx = { agentId: "main", runId: "r1" };
  belay.llmOutput(ctx, {
    provider: "openai",
    model: "gpt-5.4-nano",
    usage: { input: 5000, output: 5000 },
    runId: "r1",
  });
  now += 1000;
  const res = belay.beforeToolCall(ctx, { toolName: "read_file", params: { a: 1 } });
  assert.equal(res.block, true);

  const blocked = parseTrail(readFileSync(file, "utf8")).filter((r) => r.action === "blocked");
  assert.equal(blocked.length, 1);
  const { out } = cli(["incidents", "--trail", file, "--hours", "9999"]);
  assert.match(out, /blocked a tool/);
  assert.doesNotMatch(out, /ended a run/);
});

test("5. genuinely old unversioned records stay unverified", () => {
  const dir = mkdtempSync(join(tmpdir(), "belay-int-"));
  const file = join(dir, "trail.jsonl");
  // Exactly what 0.4.0 and earlier wrote: an action derived from the rung, with
  // no version. It may describe a notification-hook escalation that stopped
  // nothing, so it cannot be presented as proof.
  writeFileSync(
    file,
    `${JSON.stringify({
      t: new Date(T0).toISOString(),
      scope: "main",
      rung: "endRun",
      trigger: "spend_day",
      observed: 3,
      limit: 2,
      reason: "legacy",
      action: "ended",
    })}\n`,
  );
  const { out } = cli(["incidents", "--trail", file, "--hours", "9999"]);
  assert.match(out, /unverified/);
});

// --- alert path ------------------------------------------------------------
// The third surface with the same defect. The recorder was corrected in 0.5.0
// and the CLI in 0.6.0, but the alert formatter still derived its headline from
// the ladder rung -- so a model-call notification, which stops nothing, sent
// "Belay: blocked a tool call" and "Belay: ended a run" to Telegram. That is the
// line an operator reads at 2am before deciding whether to intervene, and it
// told them a runaway had been contained when it had not.

function alertFixture(over: Record<string, unknown> = {}) {
  const sent: string[] = [];
  const transport = {
    name: "capture",
    send: async (text: string) => {
      sent.push(text);
    },
  };
  const { config } = parseConfig({
    mode: "enforce",
    settleAfterRestartMs: 0,
    limits: { modelCallsPerMinute: 2 },
    ladder: { cooldownMs: 1 },
    alerts: { minRung: "warn" },
    ...over,
  });
  const alerter = new Alerter(config.alerts, [transport], makeLogger());
  let now = T0;
  const belay = createBelay(config, makeLogger(), () => now, { alerter });
  return { sent, belay, bump: (ms: number) => (now += ms) };
}

test("6. alerts never announce enforcement before a gate has acted", async () => {
  const { sent, belay, bump } = alertFixture();
  for (let i = 0; i < 8; i += 1) {
    bump(1000);
    belay.modelCallStarted({ agentId: "main", runId: "r1" });
  }
  await new Promise((r) => setTimeout(r, 20));

  assert.ok(sent.length > 0, "the storm must alert");
  for (const text of sent) {
    assert.doesNotMatch(text, /blocked a tool call/, `false containment claim: ${text}`);
    assert.doesNotMatch(text, /ended a run/, `false containment claim: ${text}`);
  }
  assert.ok(
    sent.some((s) => /escalated to endRun -- no gate action yet/.test(s)),
    "and must say plainly that nothing has been stopped",
  );
});

test("7. an alert says a run was ended only once the run gate ended one", async () => {
  const { sent, belay, bump } = alertFixture();
  for (let i = 0; i < 8; i += 1) {
    bump(1000);
    belay.modelCallStarted({ agentId: "main", runId: "r1" });
  }
  bump(1000);
  assert.equal(belay.beforeAgentRun({ agentId: "main", runId: "r2" }).outcome, "block");
  await new Promise((r) => setTimeout(r, 20));

  assert.ok(
    sent.some((s) => /Belay: ended a run/.test(s)),
    "the real refusal must be announced",
  );
});

test("8. observe mode never announces enforcement", async () => {
  const { sent, belay, bump } = alertFixture({ mode: "observe" });
  for (let i = 0; i < 8; i += 1) {
    bump(1000);
    belay.modelCallStarted({ agentId: "main", runId: "r1" });
  }
  bump(1000);
  belay.beforeAgentRun({ agentId: "main", runId: "r2" });
  await new Promise((r) => setTimeout(r, 20));

  for (const text of sent) {
    assert.doesNotMatch(text, /blocked a tool call|ended a run|paused an account/, text);
  }
});

/**
 * 9. The single-call run.
 *
 * Request bytes are only known when a call *ends*, and the per-run counter dies
 * with the run. Until 0.8.0 the only assessment happened at
 * `model_call_started` -- when the run's byte total was still zero -- and the
 * `model_call` surface did not even permit the `request_bytes_run` trigger. So
 * a run consisting of one enormous request was never measured against
 * `requestBytesPerRun` at all: the cap fired only on the second and later calls
 * of a multi-call run.
 *
 * That is the failover-context shape this project exists to catch, and it was
 * invisible to every existing test because they all drive multi-call runs.
 * Found by driving a real agent on a production gateway, where five turns at
 * 125 kB each against a 1 kB cap produced no breach whatsoever.
 */
test("9. one oversized request in a single-call run still breaches the per-run cap", () => {
  const dir = mkdtempSync(join(tmpdir(), "belay-int-"));
  const file = join(dir, "trail.jsonl");
  const { config } = parseConfig({
    mode: "enforce",
    settleAfterRestartMs: 0,
    limits: { requestBytesPerRun: 1_000_000 },
    ladder: { cooldownMs: 1 },
  });
  const recorder = new Recorder({ file, maxBytes: 1_000_000 }, makeLogger());
  let now = T0;
  const belay = createBelay(config, makeLogger(), () => now, { recorder });
  const ctx = { agentId: "main", runId: "r1" };

  // Exactly one model call, nine times the per-run cap.
  belay.modelCallStarted(ctx);
  now += 1000;
  belay.modelCallEnded(ctx, { runId: "r1", requestPayloadBytes: 9_000_000 });

  const written = parseTrail(readFileSync(file, "utf8"));
  const byRun = written.filter((r) => r.trigger === "request_bytes_run");
  assert.ok(byRun.length > 0, "a single oversized call must breach requestBytesPerRun");

  // A notification hook refuses nothing, so the record must claim escalation
  // rather than enforcement -- the 0.5.0 rule still holds on this new path.
  assert.equal(byRun[0]?.action, "escalated");
  assert.equal(byRun[0]?.mode, "enforce");

  const { out } = cli(["incidents", "--trail", file, "--hours", "9999"]);
  assert.match(out, /escalated to endRun/);
  assert.doesNotMatch(out, /would have/, "enforce mode is not hypothetical");

  // But detection is all a per-run cap can give here, and saying otherwise
  // would be the overclaim this project keeps fixing. `assess` acts on a
  // breach that is *currently standing*; once the run ends its byte counter is
  // gone, so the next run gates on a clean slate and passes. The ladder's rung
  // is never consulted, because no breach is found to consult it about.
  now += 1000;
  assert.equal(
    belay.beforeAgentRun({ agentId: "main", runId: "r2" }).outcome,
    "pass",
    "a per-run cap cannot contain the *next* run: its counter died with the run",
  );
});

/**
 * Which is why containment across runs needs a cross-run limit. Same single
 * oversized call, but with a daily byte cap in play: the breach is still
 * standing when the next run asks, so the run gate refuses it.
 */
test("9b. a cross-run byte cap turns that detection into containment", () => {
  const dir = mkdtempSync(join(tmpdir(), "belay-int-"));
  const file = join(dir, "trail.jsonl");
  const { config } = parseConfig({
    mode: "enforce",
    settleAfterRestartMs: 0,
    limits: { requestBytesPerRun: 1_000_000, requestBytesPerDay: 2_000_000 },
    ladder: { cooldownMs: 1 },
  });
  const recorder = new Recorder({ file, maxBytes: 1_000_000 }, makeLogger());
  let now = T0;
  const belay = createBelay(config, makeLogger(), () => now, { recorder });

  belay.modelCallEnded({ agentId: "main", runId: "r1" }, { runId: "r1", requestPayloadBytes: 9_000_000 });

  now += 1000;
  assert.equal(
    belay.beforeAgentRun({ agentId: "main", runId: "r2" }).outcome,
    "block",
    "the daily total still stands, so the next run is refused",
  );
});

/**
 * The bytes must be assessed even when estimation is off: byte limits are
 * measured exactly and have never depended on it. An early `return` for the
 * estimation branch sat directly below the byte recording, so it would be easy
 * to reintroduce this by moving the assessment one line down.
 */
test("10. the per-run byte cap does not depend on estimation being enabled", () => {
  const dir = mkdtempSync(join(tmpdir(), "belay-int-"));
  const file = join(dir, "trail.jsonl");
  const { config } = parseConfig({
    mode: "enforce",
    settleAfterRestartMs: 0,
    estimation: { enabled: false },
    limits: { requestBytesPerRun: 1000 },
    ladder: { cooldownMs: 1 },
  });
  const recorder = new Recorder({ file, maxBytes: 1_000_000 }, makeLogger());
  let now = T0;
  const belay = createBelay(config, makeLogger(), () => now, { recorder });
  belay.modelCallEnded({ agentId: "main", runId: "r1" }, { runId: "r1", requestPayloadBytes: 50_000 });

  const written = parseTrail(readFileSync(file, "utf8"));
  assert.ok(
    written.some((r) => r.trigger === "request_bytes_run"),
    "estimation is irrelevant to an exactly-measured byte limit",
  );
});
