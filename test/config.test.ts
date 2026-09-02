import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_CONFIG, limitsFor, parseConfig } from "../src/config.ts";

test("an empty config yields the conservative defaults", () => {
  const { config, issues } = parseConfig({});
  assert.deepEqual(issues, []);
  assert.equal(config.enabled, true);
  // No spend cap ships enabled: Belay cannot know what an operator finds expensive.
  assert.equal(config.limits.spendPerDayUsd, undefined);
  assert.equal(config.limits.modelCallsPerMinute, 30);
});

test("a typo'd limit is reported instead of silently ignored", () => {
  const { config, issues } = parseConfig({ limits: { spendPerDay: 2 } });
  assert.equal(config.limits.spendPerDayUsd, undefined);
  assert.equal(issues.length, 1);
  assert.match(issues[0]?.message ?? "", /unknown limit/);
});

test("a nonsense cap is dropped with an issue, never enforced as zero", () => {
  const { config, issues } = parseConfig({ limits: { spendPerDayUsd: -5 } });
  assert.equal(config.limits.spendPerDayUsd, undefined);
  assert.equal(issues.length, 1);
});

test("an invalid timezone falls back rather than throwing", () => {
  const { config, issues } = parseConfig({ timeZone: "Mars/Olympus_Mons" });
  assert.equal(config.timeZone, DEFAULT_CONFIG.timeZone);
  assert.equal(issues.length, 1);
});

test("garbage input still produces a usable config", () => {
  for (const junk of [null, undefined, 42, "nope", []]) {
    const { config } = parseConfig(junk);
    assert.equal(config.enabled, true);
    assert.equal(typeof config.timeZone, "string");
  }
});

test("per-agent limits override the global ones", () => {
  const { config } = parseConfig({
    limits: { spendPerDayUsd: 5, modelCallsPerMinute: 30 },
    agents: { gauntlet: { spendPerDayUsd: 1 } },
  });
  assert.equal(limitsFor(config, "gauntlet").spendPerDayUsd, 1);
  assert.equal(limitsFor(config, "gauntlet").modelCallsPerMinute, 30);
  assert.equal(limitsFor(config, "main").spendPerDayUsd, 5);
  assert.equal(limitsFor(config, undefined).spendPerDayUsd, 5);
});

test("a price override needs both rates or it is refused", () => {
  const { config, issues } = parseConfig({
    prices: { "google/gemini-3.8-flash": { input: 1 } },
  });
  assert.equal(config.prices["google/gemini-3.8-flash"], undefined);
  assert.ok(issues.length >= 1);
});

test("enabled:false is honoured, and only an explicit false disables", () => {
  assert.equal(parseConfig({ enabled: false }).config.enabled, false);
  assert.equal(parseConfig({ enabled: "no" }).config.enabled, true);
});
