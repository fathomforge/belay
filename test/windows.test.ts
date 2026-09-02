import test from "node:test";
import assert from "node:assert/strict";
import { DailyTotal, SlidingWindow } from "../src/windows.ts";

test("SlidingWindow counts only samples inside the window", () => {
  const w = new SlidingWindow(60_000);
  w.add(1_000);
  w.add(30_000);
  w.add(59_000);
  assert.equal(w.count(60_000), 3);
  // At t=61_001 the first sample (t=1_000) has aged out.
  assert.equal(w.count(61_001), 2);
  assert.equal(w.count(120_000), 0);
});

test("SlidingWindow sums values, not just occurrences", () => {
  const w = new SlidingWindow(3_600_000);
  w.add(0, 0.25);
  w.add(1_000, 0.5);
  assert.equal(w.sum(2_000), 0.75);
});

test("expired samples leave the sum at exactly zero, without float drift", () => {
  const w = new SlidingWindow(1_000);
  for (let i = 0; i < 100; i += 1) w.add(i, 0.1);
  assert.equal(w.sum(10_000), 0);
});

test("incident #1: 150 model calls in 60s are all visible to a per-minute limit", () => {
  const w = new SlidingWindow(60_000);
  for (let i = 0; i < 150; i += 1) w.add(i * 400); // 150 calls over 60s
  assert.equal(w.count(60_000), 150);
});

test("maxSamples bounds memory during a storm and reports the loss", () => {
  const w = new SlidingWindow(60_000, 10);
  for (let i = 0; i < 100; i += 1) w.add(i * 10);
  assert.equal(w.count(1_000), 10);
  assert.equal(w.dropped, 90);
});

test("SlidingWindow rejects a nonsensical window", () => {
  assert.throws(() => new SlidingWindow(0), RangeError);
  assert.throws(() => new SlidingWindow(-5), RangeError);
  assert.throws(() => new SlidingWindow(60_000, 0), RangeError);
});

test("oldest() reports when the window will start freeing up", () => {
  const w = new SlidingWindow(60_000);
  assert.equal(w.oldest(0), undefined);
  w.add(5_000);
  w.add(9_000);
  assert.equal(w.oldest(10_000), 5_000);
});

test("DailyTotal rolls over on the configured timezone, not the process one", () => {
  const d = new DailyTotal("America/Los_Angeles");
  // 2026-09-02 20:00 PT is still 2026-09-02 locally, though it is Sept 3 in UTC.
  const eveningPT = Date.parse("2026-09-03T03:00:00Z");
  d.add(eveningPT, 1.5);
  assert.equal(d.dayKey(eveningPT), "2026-09-02");
  assert.equal(d.total(eveningPT), 1.5);

  // 2026-09-03 10:00 PT is a new local day: the total resets.
  const nextMorningPT = Date.parse("2026-09-03T17:00:00Z");
  assert.equal(d.dayKey(nextMorningPT), "2026-09-03");
  assert.equal(d.total(nextMorningPT), 0);
});

test("incident #5: a UTC process cannot shift a Pacific operator's day boundary", () => {
  const utc = new DailyTotal("UTC");
  const pacific = new DailyTotal("America/Los_Angeles");
  const at = Date.parse("2026-06-01T04:00:00Z"); // May 31, 9pm PT
  assert.equal(utc.dayKey(at), "2026-06-01");
  assert.equal(pacific.dayKey(at), "2026-05-31");
});

test("DailyTotal survives a round trip through JSON", () => {
  const d = new DailyTotal("America/Los_Angeles");
  const at = Date.parse("2026-09-02T18:00:00Z");
  d.add(at, 2.25);
  const revived = DailyTotal.fromJSON("America/Los_Angeles", d.toJSON());
  assert.equal(revived.total(at), 2.25);
});

test("DailyTotal rejects an invalid timezone at construction", () => {
  assert.throws(() => new DailyTotal("Mars/Olympus_Mons"), RangeError);
});
