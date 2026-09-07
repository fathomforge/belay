import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_LADDER, Ladder } from "../src/ladder.ts";

// Tests exercise the full ladder, so they opt into the top rung explicitly. The
// shipped default stops at endRun -- see DEFAULT_LADDER for why.
const cfg = {
  cooldownMs: 60_000,
  decayMs: 15 * 60_000,
  maxRung: "pause" as const,
  renotifyMs: 6 * 3_600_000,
};

test("a fresh ladder starts at none", () => {
  const l = new Ladder(cfg);
  assert.equal(l.rung, "none");
  assert.equal(l.rungAt(0), "none");
});

test("a breach lands on the requested rung and is actionable", () => {
  const l = new Ladder(cfg);
  const step = l.record(0, "warn", "spend_run");
  assert.equal(step.rung, "warn");
  assert.equal(step.isNew, true);
  assert.equal(step.escalated, true);
});

test("incident #2: repeats inside the cooldown are deduplicated to one alert", () => {
  const l = new Ladder(cfg);
  let actionable = 0;
  for (let i = 0; i < 300; i += 1) {
    // 300 identical failures over 30 seconds, all inside one cooldown.
    if (l.record(i * 100, "warn", "identical_tool_call").isNew) actionable += 1;
  }
  assert.equal(actionable, 1);
  assert.equal(l.rung, "warn");
});

test("a breach that persists past the cooldown climbs one rung at a time", () => {
  const l = new Ladder(cfg);
  const rungs = [
    l.record(0, "warn", "model_call_rate").rung,
    l.record(60_000, "warn", "model_call_rate").rung,
    l.record(120_000, "warn", "model_call_rate").rung,
    l.record(180_000, "warn", "model_call_rate").rung,
  ];
  assert.deepEqual(rungs, ["warn", "blockTool", "endRun", "pause"]);
});

test("a severe breach may jump straight to its rung without climbing", () => {
  const l = new Ladder(cfg);
  const step = l.record(0, "endRun", "spend_day");
  assert.equal(step.rung, "endRun");
  assert.equal(step.escalated, true);
});

test("a milder breach never drags the ladder back down", () => {
  const l = new Ladder(cfg);
  l.record(0, "endRun", "spend_day");
  const step = l.record(1_000, "warn", "tool_call_rate");
  assert.equal(step.rung, "endRun");
  assert.equal(step.isNew, false);
});

test("quiet time earns rungs back, one per decay interval", () => {
  const l = new Ladder(cfg);
  l.record(0, "endRun", "spend_hour");
  assert.equal(l.rungAt(14 * 60_000), "endRun");
  assert.equal(l.rungAt(15 * 60_000), "blockTool");
  assert.equal(l.rungAt(30 * 60_000), "warn");
  assert.equal(l.rungAt(45 * 60_000), "none");
});

test("pause is sticky: no amount of quiet time resumes an account", () => {
  const l = new Ladder(cfg);
  l.record(0, "pause", "spend_day");
  assert.equal(l.rungAt(24 * 3_600_000), "pause");
  assert.equal(l.rungAt(365 * 24 * 3_600_000), "pause");
});

test("only an explicit resume clears a pause", () => {
  const l = new Ladder(cfg);
  l.record(0, "pause", "spend_day");
  l.resume(1_000);
  assert.equal(l.rungAt(1_000), "none");
});

test("maxRung lets an operator opt out of automatic pausing", () => {
  const l = new Ladder({ ...cfg, maxRung: "endRun" });
  l.record(0, "pause", "spend_day");
  assert.equal(l.rung, "endRun");
  // And climbing cannot exceed the ceiling either.
  l.record(60_000, "endRun", "spend_day");
  l.record(120_000, "endRun", "spend_day");
  assert.equal(l.rung, "endRun");
});

test("ladder state survives a gateway restart via JSON", () => {
  const l = new Ladder(cfg);
  l.record(0, "blockTool", "tool_error_rate");
  const revived = Ladder.fromJSON(l.toJSON(), cfg);
  assert.equal(revived.rungAt(1_000), "blockTool");
  // The cooldown is preserved too, so a restart cannot be used to re-alert.
  assert.equal(revived.record(1_000, "blockTool", "tool_error_rate").isNew, false);
});

test("a climb the ceiling refuses is not an escalation, and stops re-alerting", () => {
  // Regression: `escalated` was computed before clamping to the ceiling, so a
  // ladder stuck at its top rung reported a brand new escalation every cooldown
  // -- an alert storm from the mechanism meant to prevent alert storms.
  const l = new Ladder(cfg);
  l.record(0, "pause", "spend_run");
  const later = l.record(120_000, "endRun", "spend_run");
  assert.equal(later.rung, "pause");
  assert.equal(later.escalated, false);
  assert.equal(later.isNew, false);
});

test("a different trigger at the ceiling does not re-alert either", () => {
  // The account is already stopped; a second reason to stop it is not news.
  const l = new Ladder(cfg);
  l.record(0, "pause", "spend_run");
  const other = l.record(120_000, "warn", "model_call_rate");
  assert.equal(other.rung, "pause");
  assert.equal(other.isNew, false);
});

test("a latched breach is renotified on a slow cadence, not every occurrence", () => {
  // "Over the daily cap" stays true for the rest of the day. Because decay is
  // measured from the last breach, an hourly cron drops the ladder to `none`
  // between occurrences, so every hour would otherwise look like a new incident.
  const l = new Ladder(cfg);
  const hour = 3_600_000;
  const fired: number[] = [];
  for (let h = 0; h < 24; h += 1) {
    const step = l.record(h * hour, "endRun", "spend_day");
    if (step.isNew) fired.push(h);
  }
  // First breach, then one reminder per 6-hour renotify window.
  assert.deepEqual(fired, [0, 6, 12, 18]);
});

test("resume clears the renotify memory so a recurrence is heard again", () => {
  const l = new Ladder(cfg);
  assert.equal(l.record(0, "pause", "spend_day").isNew, true);
  l.resume(1_000);
  assert.equal(l.record(2_000, "pause", "spend_day").isNew, true);
});

test("the shipped default stops at endRun, not pause", () => {
  // A plugin hook cannot call channels.stop on OpenClaw 2026.8.2, so aiming the
  // default ladder at `pause` would promise an action Belay cannot perform.
  assert.equal(DEFAULT_LADDER.maxRung, "endRun");
});

test("an unrecognised persisted rung does not disable the ladder", () => {
  // `RUNG[snapshot.rung]` is `undefined` for anything not in the table, and an
  // undefined rung makes every comparison in `record` false: the ladder never
  // climbs, reports itself as "none", and the scope is silently unguarded for
  // the life of the process. One bad line in a shared state file -- or a rung
  // name from a future version of Belay -- must not switch enforcement off.
  const revived = Ladder.fromJSON({ rung: "PAUSE" as never, lastTriggerAt: 0, lastActionAt: 0 }, cfg);
  const step = revived.record(1_000, "endRun", "spend_day");
  assert.equal(step.rung, "endRun");
  assert.equal(step.escalated, true);
});

test("junk timestamps in persisted state degrade to zero rather than NaN", () => {
  const revived = Ladder.fromJSON(
    { rung: "warn", lastTriggerAt: Number.NaN, lastActionAt: "soon" as never },
    cfg,
  );
  assert.deepEqual(revived.toJSON(), { rung: "warn", lastTriggerAt: 0, lastActionAt: 0 });
  // And it still behaves like a ladder afterwards.
  assert.equal(revived.record(10_000, "blockTool", "spend_day").rung, "blockTool");
});

test("a missing snapshot restores a fresh ladder instead of throwing", () => {
  // Reached when a persisted scope predates the ladder field, or the file was
  // truncated mid-write. This runs during registration, where a throw costs
  // every hook that has not been registered yet.
  assert.equal(Ladder.fromJSON(undefined as never, cfg).rung, "none");
});

test("a rung the ladder could not actually act on can be stepped back down", () => {
  // The top rung is sticky, which is right when the account really stopped. When
  // the pause fails, latching there leaves the scope permanently at the ceiling:
  // every later breach, however small, is treated as maximal and there is no way
  // down. Seen on a live gateway, where a test left an agent in that state for
  // five days.
  const l = new Ladder(cfg);
  l.record(0, "pause", "spend_day");
  assert.equal(l.rungAt(1_000), "pause");

  l.demote(1_000);
  assert.equal(l.rungAt(1_000), "endRun", "back to a rung that decays normally");

  // And it now decays like any other rung, rather than latching forever.
  assert.equal(l.rungAt(1_000 + 3 * cfg.decayMs), "none");
});

test("demote from the bottom is harmless", () => {
  const l = new Ladder(cfg);
  l.demote(1_000);
  assert.equal(l.rungAt(1_000), "none");
});
