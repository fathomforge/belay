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
    scopes: [{ key: "bot", day: { day: "2026-09-07", total: 1.25 }, ladder: { rung: "warn", lastTriggerAt: 1, lastActionAt: 1 } }],
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
  // Reading an empty trail proves nothing was recorded, not that metering works.
  assert.match(out, /\[belay\] active/);
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
