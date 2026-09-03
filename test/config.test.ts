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

test("no alert config means no transports, which is what keeps it offline", () => {
  const { config } = parseConfig({});
  assert.equal(config.alerts.telegram, undefined);
  assert.equal(config.alerts.webhook, undefined);
  assert.equal(config.pause.enabled, false);
  assert.equal(config.recorder.file, "");
});

test("a telegram token is read from the environment by name", () => {
  process.env["BELAY_TEST_TOKEN"] = "123:abc";
  try {
    const { config, issues } = parseConfig({
      alerts: { telegram: { botTokenEnv: "BELAY_TEST_TOKEN", chatId: "42" } },
    });
    assert.deepEqual(config.alerts.telegram, { botToken: "123:abc", chatId: "42" });
    assert.deepEqual(issues, []);
  } finally {
    delete process.env["BELAY_TEST_TOKEN"];
  }
});

test("a missing environment variable disables the transport and says so", () => {
  const { config, issues } = parseConfig({
    alerts: { telegram: { botTokenEnv: "BELAY_DEFINITELY_NOT_SET", chatId: "42" } },
  });
  assert.equal(config.alerts.telegram, undefined);
  assert.match(issues.map((i) => i.message).join(" "), /is not set/);
});

test("an inline token works but is called out as a bad idea", () => {
  const { config, issues } = parseConfig({
    alerts: { telegram: { botToken: "123:abc", chatId: "42" } },
  });
  // Accepted, because refusing would just make people give up...
  assert.equal(config.alerts.telegram?.botToken, "123:abc");
  // ...but it lands in config backups and screenshots, so say so once.
  assert.match(issues.map((i) => i.message).join(" "), /config backups/);
});

test("a plaintext webhook is refused", () => {
  const { config, issues } = parseConfig({ alerts: { webhook: { url: "http://example.com/h" } } });
  // Alerts describe security incidents; sending them in the clear is not on.
  assert.equal(config.alerts.webhook, undefined);
  assert.match(issues.map((i) => i.message).join(" "), /must be https/);
});

test("pause needs channel and accountId together", () => {
  const { config, issues } = parseConfig({ pause: { enabled: true, channel: "telegram" } });
  assert.equal(config.pause.target, undefined);
  assert.match(issues.map((i) => i.message).join(" "), /must be set together/);
});

test("pause enabled without a target warns that it may not be able to act", () => {
  const { issues } = parseConfig({ pause: { enabled: true } });
  assert.match(issues.map((i) => i.message).join(" "), /only pause when the triggering hook/);
});

test("observe mode leaves the ladder free to climb, so reports stay useful", () => {
  const { config } = parseConfig({ mode: "observe", limits: { spendPerDayUsd: 0.01 } });
  assert.equal(config.mode, "observe");
  // Capping the ladder here would also prevent action, but then the recorder
  // could only ever say "would have warned". Action is prevented by the clamp
  // in belay.ts instead, so the ladder climbs and the report can say what would
  // really have happened. See the adapter tests for the enforced behaviour.
  // endRun is the shipped ceiling; the point here is that observe mode does not
  // lower it, so the ladder still climbs and reports what would have happened.
  assert.equal(config.ladder.maxRung, "endRun");
});

test("observe mode overrides an enabled pauser rather than trusting the operator", () => {
  const { config, issues } = parseConfig({
    mode: "observe",
    pause: { enabled: true, channel: "telegram", accountId: "a1" },
  });
  assert.equal(config.pause.enabled, false);
  assert.match(issues.map((i) => i.message).join(" "), /nothing is paused in observe mode/);
});

test("enforce is the default, and an unknown mode falls back to it loudly", () => {
  assert.equal(parseConfig({}).config.mode, "enforce");
  const { config, issues } = parseConfig({ mode: "dry-run" });
  assert.equal(config.mode, "enforce");
  assert.match(issues.map((i) => i.message).join(" "), /expected "observe" or "enforce"/);
});
