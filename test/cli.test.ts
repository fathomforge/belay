import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// The CLI is the surface an operator uses to decide whether Belay is working.
// Its central obligation is to never report a clean bill of health it did not
// actually observe: an unconfigured path, an absent file and a file that was
// read and found empty are three different facts. 0.1.0 collapsed all three
// into "No incidents in the last 24h." with exit 0, which told an operator
// whose recorder was never configured that everything was fine.
//
// Spawned as a subprocess rather than imported, because the exit code is half
// of the contract being tested.
const CLI = fileURLToPath(new URL("../bin/belay.mjs", import.meta.url));

function run(args: string[], env: Record<string, string> = {}) {
  const res = spawnSync(process.execPath, [CLI, ...args], {
    encoding: "utf8",
    // Start from a clean slate: an inherited BELAY_TRAIL_FILE from the
    // developer's own shell would quietly invalidate every "unconfigured" case.
    env: { PATH: process.env.PATH ?? "", ...env },
  });
  return { code: res.status, out: res.stdout };
}

const dir = mkdtempSync(join(tmpdir(), "belay-cli-"));
const trail = join(dir, "trail.jsonl");
const emptyTrail = join(dir, "empty.jsonl");
const state = join(dir, "state.json");

writeFileSync(
  trail,
  `${JSON.stringify({
    t: new Date().toISOString(),
    scope: "bot",
    rung: "warn",
    trigger: "model_call_rate",
    observed: 40,
    limit: 20,
    reason: "40 model calls in the last minute",
    action: "logged",
  })}\n`,
);
writeFileSync(emptyTrail, "");
writeFileSync(
  state,
  JSON.stringify({
    version: 1,
    scopes: [{ key: "bot", day: { day: "2026-09-07", total: 1.25 }, dayBytes: { day: "2026-09-07", total: 246075 }, ladder: { rung: "warn", lastTriggerAt: 1, lastActionAt: 1 } }],
  }),
);

test("incidents with nothing configured does not claim there were no incidents", () => {
  const { code, out } = run(["incidents"]);
  assert.equal(code, 2, "no evidence must not exit 0");
  assert.match(out, /unknown/);
  assert.match(out, /not the same as/);
  assert.doesNotMatch(out, /No incidents in the last/);
});

test("incidents --json with nothing configured does not return a bare empty array", () => {
  const { code, out } = run(["incidents", "--json"]);
  assert.equal(code, 2);
  const parsed = JSON.parse(out);
  assert.equal(parsed.source, "unconfigured");
  assert.deepEqual(parsed.incidents, []);
});

test("a configured but absent trail is reported as absent, not as quiet", () => {
  const { code, out } = run(["incidents", "--trail", join(dir, "nope.jsonl")]);
  assert.equal(code, 2);
  assert.match(out, /nope\.jsonl/);
  assert.doesNotMatch(out, /No incidents in the last/);
});

test("an unreadable trail is reported as unreadable", () => {
  // A directory is readable as a path but not as a file: a real I/O failure
  // that is neither "absent" nor "empty".
  const { code, out } = run(["incidents", "--trail", dir, "--json"]);
  assert.equal(code, 2);
  assert.equal(JSON.parse(out).source, "unreadable");
});

test("a trail that was read and is empty is honestly reported as empty", () => {
  const { code, out } = run(["incidents", "--trail", emptyTrail]);
  assert.equal(code, 0, "a successful read is not an error");
  assert.match(out, /No incidents recorded/);
  assert.match(out, /empty\.jsonl/, "says which file it read");
  // Reading an empty trail proves nothing was recorded, not that metering works,
  // and it must point at the counter that does settle it rather than at the
  // startup log line, which only proves the plugin loaded.
  assert.match(out, /not by itself proof/);
  assert.match(out, /request-bytes column/);
});

test("a trail with a decision reports it and exits 0", () => {
  const { code, out } = run(["incidents", "--trail", trail]);
  assert.equal(code, 0);
  assert.match(out, /40 model calls/);
  assert.match(out, /rule=model_call_rate/);
});

test("incidents --json on a real trail reports source ok and the records", () => {
  const { code, out } = run(["incidents", "--trail", trail, "--json"]);
  assert.equal(code, 0);
  const parsed = JSON.parse(out);
  assert.equal(parsed.source, "ok");
  assert.equal(parsed.incidents.length, 1);
});

test("status with nothing configured never describes a healthy day", () => {
  const { code, out } = run(["status"]);
  assert.equal(code, 2);
  assert.doesNotMatch(out, /healthy day/);
  assert.match(out, /Decisions in the last 24h: unknown/);
});

test("status with a missing state file does not imply health from the trail", () => {
  const { code, out } = run(["status", "--state", join(dir, "nope.json"), "--trail", emptyTrail]);
  assert.equal(code, 2, "an unreadable half of the report still means degraded");
  assert.doesNotMatch(out, /healthy day/);
});

test("status with both files readable exits 0 and reports what it read", () => {
  const { code, out } = run(["status", "--state", state, "--trail", trail]);
  assert.equal(code, 0);
  assert.match(out, /bot/);
  assert.match(out, /Decisions in the last 24h: 1/);
});

test("the environment variables are honoured like the flags", () => {
  const { code, out } = run(["status"], { BELAY_STATE_FILE: state, BELAY_TRAIL_FILE: trail });
  assert.equal(code, 0);
  assert.match(out, /Decisions in the last 24h: 1/);
});

test("--help exits 0 and documents the exit codes", () => {
  const { code, out } = run(["--help"]);
  assert.equal(code, 0);
  assert.match(out, /Exit codes:/);
  assert.match(out, /BELAY_TRAIL_FILE/);
});

// --- second-pass findings -------------------------------------------------

test("status shows the request-byte counter the metering check depends on", () => {
  // The documented acceptance procedure says to watch a byte total. Printing
  // only dollars made that procedure impossible to follow -- and for a provider
  // that reports no token usage, the dollar column is always $0, so the check
  // would have "failed" on a perfectly healthy install.
  const { code, out } = run(["status", "--state", state, "--trail", trail]);
  assert.equal(code, 0);
  assert.match(out, /246 kB/);
});

test("$0 spend against real bytes is explained, not left to read as free", () => {
  const blind = join(dir, "blind.json");
  writeFileSync(
    blind,
    JSON.stringify({
      version: 1,
      scopes: [{ key: "bot", day: { day: "2026-09-07", total: 0 }, dayBytes: { day: "2026-09-07", total: 500000 }, ladder: { rung: "none", lastTriggerAt: 0, lastActionAt: 0 } }],
    }),
  );
  const { out } = run(["status", "--state", blind, "--trail", trail]);
  assert.match(out, /reported no token usage/);
});

test("a wholly corrupt trail is unreadable, not empty", () => {
  const corrupt = join(dir, "corrupt.jsonl");
  writeFileSync(corrupt, "{not json\n{\"also\": \"bad\"}\n");
  const { code, out } = run(["incidents", "--trail", corrupt, "--json"]);
  assert.equal(code, 2, "damaged evidence is not a clean bill of health");
  assert.equal(JSON.parse(out).source, "unreadable");
});

test("a record with an unparseable timestamp counts as damage, not absence", () => {
  const bad = join(dir, "badtime.jsonl");
  writeFileSync(bad, `${JSON.stringify({ t: "not-a-date", scope: "bot", action: "logged" })}\n`);
  const { code } = run(["incidents", "--trail", bad, "--json"]);
  assert.equal(code, 2);
});

test("surviving records are reported, with the damaged ones disclosed", () => {
  const mixed = join(dir, "mixed.jsonl");
  writeFileSync(
    mixed,
    `${JSON.stringify({ t: new Date().toISOString(), scope: "bot", rung: "warn", trigger: "model_call_rate", observed: 40, limit: 20, reason: "storm", action: "logged" })}\n{truncated`,
  );
  const { code, out } = run(["incidents", "--trail", mixed]);
  assert.equal(code, 0, "one good record is still evidence");
  assert.match(out, /storm/);
  assert.match(out, /unreadable record/, "but the damage must be disclosed");
});

test("a stored rung is not reported as an action without evidence", () => {
  // Observe mode advances the ladder without acting, so a rung alone proves
  // nothing. With no trail to corroborate it, saying "ended a run" invents an
  // enforcement event that may never have happened.
  const ended = join(dir, "ended.json");
  writeFileSync(
    ended,
    JSON.stringify({
      version: 1,
      scopes: [{ key: "bot", day: { day: "2026-09-07", total: 1 }, dayBytes: { day: "2026-09-07", total: 10 }, ladder: { rung: "endRun", lastTriggerAt: 1, lastActionAt: 1 } }],
    }),
  );
  const { out } = run(["status", "--state", ended]);
  assert.match(out, /action unverified/);
  assert.doesNotMatch(out, /<- ended a run/);
});

test("a malformed --hours fails loudly instead of hiding real incidents", () => {
  // Number("garbage") is NaN and every `>= NaN` is false, so the filter used to
  // discard every incident and still report success.
  const { code, out } = run(["incidents", "--trail", trail, "--hours", "garbage", "--json"]);
  assert.equal(code, 1);
  assert.match(out, /--hours must be a positive number/);
});

test("a negative --hours is rejected too", () => {
  assert.equal(run(["incidents", "--trail", trail, "--hours", "-5"]).code, 1);
});
