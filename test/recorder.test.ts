import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_RECORDER, parseTrail, Recorder, toRecord } from "../src/recorder.ts";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "belay-rec-"));
}
function makeLogger() {
  const lines: string[] = [];
  return { lines, warn: (m: string) => lines.push(m) };
}

const T0 = Date.parse("2026-09-02T17:00:00Z");

const record = toRecord(T0, "main", "endRun", "spend_day", 2.1, 2, "daily spend $2.1 reached the $2 cap");

test("toRecord maps each rung to what actually happened", () => {
  const at = T0;
  assert.equal(toRecord(at, "s", "warn", "spend_run", 1, 1, "r").action, "logged");
  assert.equal(toRecord(at, "s", "blockTool", "spend_run", 1, 1, "r").action, "blocked");
  assert.equal(toRecord(at, "s", "endRun", "spend_run", 1, 1, "r").action, "ended");
  // "pause" records as "ended": see the dedicated test below for why.
  assert.equal(toRecord(at, "s", "pause", "spend_run", 1, 1, "r").action, "ended");
});

test("recording is off unless a file is configured", () => {
  const r = new Recorder(DEFAULT_RECORDER, makeLogger());
  assert.equal(r.enabled, false);
  assert.doesNotThrow(() => r.write(record));
});

test("each decision is one JSON line", () => {
  const file = join(tmp(), "trail.jsonl");
  const r = new Recorder({ file, maxBytes: 1_000_000 }, makeLogger());
  r.write(record);
  r.write({ ...record, rung: "warn", action: "logged" });

  const lines = readFileSync(file, "utf8").trim().split("\n");
  assert.equal(lines.length, 2);
  assert.equal(JSON.parse(lines[0] ?? "{}").scope, "main");
});

test("only known fields reach disk, whatever the caller passes", () => {
  const file = join(tmp(), "trail.jsonl");
  const r = new Recorder({ file, maxBytes: 1_000_000 }, makeLogger());
  // A caller that smuggles content in must not be able to write it.
  r.write({
    ...record,
    prompt: "the user asked me to do something private",
    // Not an absolute home path: check-secrets blocks those in source, rightly.
    params: { path: "workspace/private-notes.txt" },
  } as never);

  const written = readFileSync(file, "utf8");
  assert.equal(written.includes("private"), false);
  assert.equal(written.includes("private-notes"), false);
  assert.deepEqual(Object.keys(JSON.parse(written.trim())).sort(), [
    "action",
    "limit",
    "observed",
    "reason",
    "rung",
    "scope",
    "t",
    "trigger",
  ]);
});

test("the trail is written with restrictive permissions", () => {
  const file = join(tmp(), "trail.jsonl");
  new Recorder({ file, maxBytes: 1_000_000 }, makeLogger()).write(record);
  assert.equal(statSync(file).mode & 0o777, 0o600);
});

test("the trail rotates instead of growing without bound", () => {
  const file = join(tmp(), "trail.jsonl");
  const r = new Recorder({ file, maxBytes: 200 }, makeLogger());
  for (let i = 0; i < 20; i += 1) r.write({ ...record, scope: `agent-${i}` });

  assert.equal(existsSync(`${file}.1`), true, "one backup is kept");
  // An unbounded log on someone's VM would be a bug we shipped.
  assert.ok(statSync(file).size <= 400);
});

test("an unwritable trail disables itself and warns exactly once", () => {
  const logger = makeLogger();
  // A directory where a file should be: every write fails.
  const r = new Recorder({ file: tmp(), maxBytes: 1000 }, logger);
  for (let i = 0; i < 10; i += 1) r.write(record);
  assert.equal(logger.lines.length, 1, "a full disk must not warn once per model call");
  assert.match(logger.lines[0] ?? "", /flight recorder disabled/);
  assert.equal(r.enabled, false);
});

test("a trail truncated mid-write still parses everything before the break", () => {
  // The exact shape a `docker kill` leaves behind.
  const good = JSON.stringify(record);
  const parsed = parseTrail(`${good}\n${good}\n{"t":"2026-09-02T17:0`);
  assert.equal(parsed.length, 2);
});

test("parseTrail skips junk lines rather than giving up", () => {
  const good = JSON.stringify(record);
  assert.equal(parseTrail(`not json\n${good}\n\n[]\n{}\n`).length, 1);
  assert.deepEqual(parseTrail(""), []);
});

test("a real trail round-trips through the file", () => {
  const file = join(tmp(), "trail.jsonl");
  const r = new Recorder({ file, maxBytes: 1_000_000 }, makeLogger());
  r.write(record);
  r.write(toRecord(T0 + 1000, "gauntlet", "pause", "model_call_rate", 40, 30, "40 model calls in the last minute"));

  const trail = parseTrail(readFileSync(file, "utf8"));
  assert.equal(trail.length, 2);
  assert.equal(trail[1]?.action, "ended");
  assert.equal(trail[1]?.observed, 40);
});

test("a pre-existing trail is appended to, not overwritten", () => {
  const file = join(tmp(), "trail.jsonl");
  writeFileSync(file, `${JSON.stringify(record)}\n`);
  new Recorder({ file, maxBytes: 1_000_000 }, makeLogger()).write(record);
  assert.equal(parseTrail(readFileSync(file, "utf8")).length, 2);
});

test("a path that is not a regular file is never rotated away", () => {
  // Rotation renames the old file aside. Pointed at a directory, that would
  // move an operator's directory and then write a file in its place. A
  // directory's own size (4096 on Linux) is enough to pass a naive size check,
  // so this only ever failed on Linux.
  const dir = tmp();
  const logger = makeLogger();
  const r = new Recorder({ file: dir, maxBytes: 100 }, logger);
  r.write(record);

  assert.equal(existsSync(dir), true, "the directory must still be there");
  assert.equal(existsSync(`${dir}.1`), false, "and must not have been rotated");
  assert.equal(r.enabled, false, "the recorder disables itself instead");
});

test("reaching the pause rung records an ended run, not a completed pause", () => {
  // Whether the account actually stopped is not known when the decision is
  // made. A trail claiming "paused" for an attempt that failed is the same
  // false claim the alerts used to make -- and the trail is the evidence an
  // operator reaches for afterwards, so it has to be true.
  assert.equal(toRecord(T0, "s", "pause", "spend_day", 3, 2, "r").action, "ended");
});
