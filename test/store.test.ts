import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, statSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadState, saveStateSync, StateWriter } from "../src/store.ts";
import type { StoreData } from "../src/store.ts";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "belay-test-"));
}

const sample: StoreData = {
  version: 1,
  scopes: [
    {
      key: "main",
      day: { day: "2026-09-02", total: 1.25 },
      ladder: { rung: "warn", lastTriggerAt: 1000, lastActionAt: 1000 },
    },
  ],
};

test("state round-trips through a file", () => {
  const file = join(tmp(), "state.json");
  assert.equal(saveStateSync(file, sample), undefined);
  assert.deepEqual(loadState(file).data, sample);
});

test("a missing file is the normal first run, not an error", () => {
  const result = loadState(join(tmp(), "does-not-exist.json"));
  assert.deepEqual(result.data, { version: 1, scopes: [] });
  assert.equal(result.error, undefined);
});

test("truncated JSON from an unclean shutdown starts fresh instead of throwing", () => {
  const file = join(tmp(), "state.json");
  writeFileSync(file, '{"version":1,"scopes":[{"key":"ma');
  const result = loadState(file);
  assert.deepEqual(result.data, { version: 1, scopes: [] });
  assert.match(result.error ?? "", /invalid JSON/);
});

test("a file from a future version is ignored rather than misread", () => {
  const file = join(tmp(), "state.json");
  writeFileSync(file, JSON.stringify({ version: 99, scopes: [{ key: "x" }] }));
  const result = loadState(file);
  assert.deepEqual(result.data, { version: 1, scopes: [] });
  assert.match(result.error ?? "", /unrecognised format/);
});

test("an unwritable path reports an error instead of throwing", () => {
  // A directory where a file should be: the write must fail cleanly.
  const dir = tmp();
  const error = saveStateSync(dir, sample);
  assert.ok(error, "expected an error string");
  assert.match(error ?? "", /cannot write/);
});

test("an empty path disables persistence entirely", () => {
  assert.equal(saveStateSync("", sample), undefined);
  assert.deepEqual(loadState(""), { data: undefined });
});

test("the state file is written with restrictive permissions", () => {
  const file = join(tmp(), "state.json");
  saveStateSync(file, sample);
  // 0o600: it records what an operator's agents cost.
  assert.equal(statSync(file).mode & 0o777, 0o600);
});

test("writing leaves no temp file behind", () => {
  const dir = tmp();
  const file = join(dir, "state.json");
  saveStateSync(file, sample);
  saveStateSync(file, sample);
  assert.deepEqual(readdirSync(dir), ["state.json"]);
});

test("a reader never sees a half-written file", () => {
  // The atomic rename is what protects against `docker kill` mid-write: a reader
  // sees either the whole old file or the whole new one.
  const file = join(tmp(), "state.json");
  saveStateSync(file, sample);
  const bigger: StoreData = {
    version: 1,
    scopes: Array.from({ length: 500 }, (_, i) => ({
      key: `agent-${i}`,
      day: { day: "2026-09-02", total: i },
      ladder: { rung: "none" as const, lastTriggerAt: 0, lastActionAt: 0 },
    })),
  };
  saveStateSync(file, bigger);
  const parsed = JSON.parse(readFileSync(file, "utf8")) as StoreData;
  assert.equal(parsed.scopes.length, 500);
});

test("StateWriter flushes on demand and survives a failing snapshot", () => {
  const file = join(tmp(), "state.json");
  const errors: string[] = [];
  const writer = new StateWriter(file, (m) => errors.push(m));

  writer.start(() => sample);
  writer.flush();
  assert.deepEqual(loadState(file).data, sample);

  // A snapshot that throws must be reported, not propagated.
  const bad = new StateWriter(join(tmp(), "s.json"), (m) => errors.push(m));
  bad.start(() => {
    throw new Error("boom");
  });
  assert.doesNotThrow(() => bad.flush());
  assert.match(errors.join(" "), /state snapshot failed/);
});

test("stop() flushes and clears the timer", () => {
  const file = join(tmp(), "state.json");
  const writer = new StateWriter(file, () => {});
  writer.start(() => sample);
  writer.stop();
  assert.deepEqual(loadState(file).data, sample);
  // A second stop must be harmless.
  assert.doesNotThrow(() => writer.stop());
});
