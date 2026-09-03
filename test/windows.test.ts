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

test("a clock stepping backwards across midnight does not un-spend the day", () => {
  // NTP correcting a container's clock, or a VM resuming from a snapshot, moves
  // `Date.now()` backwards by seconds to minutes. If that step lands on the
  // other side of the local midnight, the naive "the day key changed, so reset"
  // rule zeroes a daily cap that was nearly full, and the agent gets to spend
  // the whole budget a second time -- with no error anywhere.
  const d = new DailyTotal("America/Los_Angeles");
  const justAfterMidnightPT = Date.parse("2026-09-03T07:00:30Z");
  d.add(justAfterMidnightPT, 4.9);
  assert.equal(d.dayKey(justAfterMidnightPT), "2026-09-03");

  const correctedBack = justAfterMidnightPT - 60_000; // now 23:59:30 on Sept 2
  assert.equal(d.dayKey(correctedBack), "2026-09-02");
  d.add(correctedBack, 0.05);

  assert.equal(d.total(justAfterMidnightPT), 4.95, "the day's spend survives the correction");
});

test("a real rollover still resets, in the configured zone", () => {
  const d = new DailyTotal("America/Los_Angeles");
  d.add(Date.parse("2026-09-02T20:00:00Z"), 3);
  assert.equal(d.total(Date.parse("2026-09-02T20:00:00Z")), 3);
  // 17:00 PT on the 3rd: a genuine new calendar day, so the total starts over.
  assert.equal(d.total(Date.parse("2026-09-04T00:00:00Z")), 0);
});

test("DST does not create or destroy a day in the daily total", () => {
  // US DST ends 2026-11-01, when 01:00-02:00 PT happens twice. Both instances
  // are the same calendar day, so a daily cap must keep accumulating across the
  // repeated hour rather than treating the second pass as a new day.
  const d = new DailyTotal("America/Los_Angeles");
  const firstOneThirty = Date.parse("2026-11-01T08:30:00Z"); // 01:30 PDT
  const secondOneThirty = Date.parse("2026-11-01T09:30:00Z"); // 01:30 PST
  d.add(firstOneThirty, 1);
  d.add(secondOneThirty, 1);
  assert.equal(d.dayKey(firstOneThirty), "2026-11-01");
  assert.equal(d.dayKey(secondOneThirty), "2026-11-01");
  assert.equal(d.total(secondOneThirty), 2);

  // Spring forward 2026-03-08: 02:00-03:00 PT does not exist, and the day is
  // 23 hours long. It is still one calendar day.
  const spring = new DailyTotal("America/Los_Angeles");
  spring.add(Date.parse("2026-03-08T09:59:00Z"), 1); // 01:59 PST
  spring.add(Date.parse("2026-03-08T10:01:00Z"), 1); // 03:01 PDT
  assert.equal(spring.total(Date.parse("2026-03-08T18:00:00Z")), 2);
  assert.equal(spring.total(Date.parse("2026-03-09T18:00:00Z")), 0, "the next day is a new day");
});

test("a corrupt persisted day cannot poison the total", () => {
  // The state file is shared with other processes and can be truncated or
  // hand-edited. A day like "9999-99-99" sorts above every real date, so left
  // unchecked it would win every merge and never roll over.
  const bogus = DailyTotal.fromJSON("UTC", { day: "9999-99-99", total: 100 });
  assert.deepEqual(bogus.toJSON(), { day: "", total: 0 });

  const nan = DailyTotal.fromJSON("UTC", { day: "2026-09-02", total: Number.NaN });
  assert.deepEqual(nan.toJSON(), { day: "2026-09-02", total: 0 });

  // Nothing at all is the first-run case, and must not throw during startup.
  assert.deepEqual(DailyTotal.fromJSON("UTC", undefined).toJSON(), { day: "", total: 0 });
});
