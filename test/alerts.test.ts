import test from "node:test";
import assert from "node:assert/strict";
import {
  Alerter,
  buildTransports,
  DEFAULT_ALERTS,
  formatAlert,
  telegramTransport,
  webhookTransport,
} from "../src/alerts.ts";
import type { AlertEvent, FetchLike } from "../src/alerts.ts";

function makeLogger() {
  const lines: string[] = [];
  return {
    lines,
    info: (m: string) => lines.push(m),
    warn: (m: string) => lines.push(m),
    error: (m: string) => lines.push(m),
  };
}

/** Records every request instead of making one. */
function spyFetch(ok = true): { calls: { url: string; body: string }[]; impl: FetchLike } {
  const calls: { url: string; body: string }[] = [];
  const impl: FetchLike = async (url, init) => {
    calls.push({ url, body: init.body });
    return { ok, status: ok ? 200 : 429 };
  };
  return { calls, impl };
}

const T0 = Date.parse("2026-09-02T17:00:00Z");

const event: AlertEvent = {
  scope: "main",
  rung: "pause",
  trigger: "spend_day",
  reason: "daily spend $2.1 reached the $2 cap",
  at: T0,
};

test("zero network by default: no config means no transports at all", () => {
  const { calls, impl } = spyFetch();
  assert.deepEqual(buildTransports(DEFAULT_ALERTS, impl), []);
  assert.equal(calls.length, 0);
});

test("a transport is only built for what the operator configured", () => {
  const { impl } = spyFetch();
  const tg = buildTransports({ ...DEFAULT_ALERTS, telegram: { botToken: "t", chatId: "1" } }, impl);
  assert.deepEqual(tg.map((t) => t.name), ["telegram"]);

  const both = buildTransports(
    {
      ...DEFAULT_ALERTS,
      telegram: { botToken: "t", chatId: "1" },
      webhook: { url: "https://example.com/h" },
    },
    impl,
  );
  assert.deepEqual(both.map((t) => t.name), ["telegram", "webhook"]);
});

test("an alert carries numbers and reasons, never content", () => {
  const text = formatAlert(event);
  assert.match(text, /PAUSED/);
  assert.match(text, /main/);
  assert.match(text, /daily spend/);
  assert.match(text, /spend_day/);
  // No field exists for any of these, and the format must not grow one.
  for (const forbidden of ["prompt", "assistant", "message:", "params"]) {
    assert.equal(text.toLowerCase().includes(forbidden), false, `leaked ${forbidden}`);
  }
});

test("the telegram bot token never appears in the alert body", async () => {
  const { calls, impl } = spyFetch();
  const t = telegramTransport({ botToken: "123456:SUPER-SECRET-TOKEN", chatId: "42" }, impl);
  await t.send(formatAlert(event), event);
  // It is in the URL because the API requires it, but must not be in the payload
  // that a webhook relay, proxy log or error report might capture.
  assert.equal(calls[0]?.body.includes("SUPER-SECRET-TOKEN"), false);
  assert.match(calls[0]?.url ?? "", /api\.telegram\.org/);
});

test("a failing transport raises, and the Alerter swallows it", async () => {
  const { impl } = spyFetch(false);
  const t = webhookTransport({ url: "https://example.com/h" }, impl);
  await assert.rejects(() => t.send("x", event), /429/);

  const logger = makeLogger();
  const alerter = new Alerter(DEFAULT_ALERTS, [t], logger);
  // The agent turn that triggered this must not fail because a webhook is down.
  await assert.doesNotReject(() => alerter.notify(event, T0));
  assert.match(logger.lines.join(" "), /alert via webhook failed/);
});

test("rungs below the floor are never sent", async () => {
  const { calls, impl } = spyFetch();
  const config = { ...DEFAULT_ALERTS, minRung: "endRun" as const, webhook: { url: "https://x.test/h" } };
  const alerter = new Alerter(config, buildTransports(config, impl), makeLogger());

  await alerter.notify({ ...event, rung: "warn" }, T0);
  await alerter.notify({ ...event, rung: "blockTool" }, T0);
  assert.equal(calls.length, 0);

  await alerter.notify({ ...event, rung: "endRun" }, T0);
  assert.equal(calls.length, 1);
});

test("the `none` rung is never alerted, whatever the floor says", async () => {
  const { calls, impl } = spyFetch();
  const config = { ...DEFAULT_ALERTS, minRung: "none" as const, webhook: { url: "https://x.test/h" } };
  const alerter = new Alerter(config, buildTransports(config, impl), makeLogger());
  await alerter.notify({ ...event, rung: "none" }, T0);
  assert.equal(calls.length, 0);
});

test("the hourly ceiling stops a runaway from becoming an alert storm", async () => {
  const { calls, impl } = spyFetch();
  const config = { ...DEFAULT_ALERTS, maxPerHour: 3, webhook: { url: "https://x.test/h" } };
  const logger = makeLogger();
  const alerter = new Alerter(config, buildTransports(config, impl), logger);

  for (let i = 0; i < 50; i += 1) await alerter.notify(event, T0 + i * 1000);
  assert.equal(calls.length, 3, "the ceiling holds even if the ladder upstream misbehaves");
  // The operator is told once that alerts are being suppressed.
  assert.equal(logger.lines.filter((l) => l.includes("alert ceiling")).length, 1);

  // An hour later the window has rolled off and alerting resumes.
  await alerter.notify(event, T0 + 3_600_001);
  assert.equal(calls.length, 4);
});

test("every alert leaves a local log line even when transports fail", async () => {
  const failing = {
    name: "webhook",
    send: async () => {
      throw new Error("network down");
    },
  };
  const logger = makeLogger();
  await new Alerter(DEFAULT_ALERTS, [failing], logger).notify(event, T0);
  assert.match(logger.lines.join("\n"), /alert: Belay: PAUSED/);
});

test("the webhook payload is structured for machines and free of content", async () => {
  const { calls, impl } = spyFetch();
  const t = webhookTransport({ url: "https://example.com/h", headers: { "x-token": "abc" } }, impl);
  await t.send(formatAlert(event), event);
  const body = JSON.parse(calls[0]?.body ?? "{}") as Record<string, unknown>;
  assert.equal(body["source"], "belay");
  assert.equal(body["scope"], "main");
  assert.equal(body["rung"], "pause");
  assert.equal(body["trigger"], "spend_day");
  assert.deepEqual(Object.keys(body).sort(), [
    "at",
    "reason",
    "rung",
    "scope",
    "source",
    "text",
    "trigger",
  ]);
});
