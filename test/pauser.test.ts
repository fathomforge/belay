import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_PAUSER, Pauser } from "../src/pauser.ts";
import type { Dispatch } from "../src/pauser.ts";

function makeLogger() {
  const lines: string[] = [];
  return {
    lines,
    info: (m: string) => lines.push(m),
    warn: (m: string) => lines.push(m),
    error: (m: string) => lines.push(m),
  };
}

/** Records gateway calls instead of making them. */
function spyDispatch(ok = true): { calls: { method: string; params: unknown }[]; impl: Dispatch } {
  const calls: { method: string; params: unknown }[] = [];
  const impl: Dispatch = async (method, params) => {
    calls.push({ method, params });
    return ok
      ? { ok: true }
      : { ok: false, error: { code: "channel_unknown", message: "no such account" } };
  };
  return { calls, impl };
}

const target = { channel: "telegram", accountId: "acct-1" };

test("pausing is off unless the operator turns it on", async () => {
  const { calls, impl } = spyDispatch();
  const p = new Pauser(DEFAULT_PAUSER, impl, makeLogger());
  assert.deepEqual(await p.pause(target, "over cap"), { status: "disabled" });
  // Nobody's bot goes silent because they installed a plugin and kept defaults.
  assert.equal(calls.length, 0);
});

test("an enabled pauser stops the account once", async () => {
  const { calls, impl } = spyDispatch();
  const p = new Pauser({ enabled: true }, impl, makeLogger());
  const result = await p.pause(target, "daily cap");
  assert.equal(result.status, "paused");
  assert.deepEqual(calls, [
    { method: "channels.stop", params: { channel: "telegram", accountId: "acct-1" } },
  ]);
  assert.equal(p.isPaused(target), true);
});

test("repeated pause rungs never re-issue channels.stop", async () => {
  // Every extra stop/start cycle risks another burst when the ingress spool
  // drains, so a stuck agent must not be able to hammer the gateway.
  const { calls, impl } = spyDispatch();
  const p = new Pauser({ enabled: true }, impl, makeLogger());
  for (let i = 0; i < 20; i += 1) await p.pause(target, "still over cap");
  assert.equal(calls.length, 1);
  assert.equal((await p.pause(target, "again")).status, "already-paused");
});

test("a missing or partial target is refused, not guessed", async () => {
  const { calls, impl } = spyDispatch();
  const p = new Pauser({ enabled: true }, impl, makeLogger());
  assert.deepEqual(await p.pause(undefined, "x"), { status: "no-target" });
  assert.deepEqual(await p.pause({ channel: "telegram", accountId: "" }, "x"), {
    status: "no-target",
  });
  // Pausing the wrong account is worse than not pausing at all.
  assert.equal(calls.length, 0);
});

test("a configured fallback target is used when the hook does not carry one", async () => {
  const { calls, impl } = spyDispatch();
  const p = new Pauser({ enabled: true, target }, impl, makeLogger());
  assert.equal((await p.pause(undefined, "x")).status, "paused");
  assert.deepEqual(calls[0]?.params, { channel: "telegram", accountId: "acct-1" });
});

test("a gateway error is reported, not thrown", async () => {
  const { impl } = spyDispatch(false);
  const logger = makeLogger();
  const p = new Pauser({ enabled: true }, impl, logger);
  const result = await p.pause(target, "x");
  assert.equal(result.status, "failed");
  assert.match(logger.lines.join(" "), /channels\.stop failed/);
});

test("a dispatcher that throws does not retry in a loop", async () => {
  let attempts = 0;
  const throwing: Dispatch = async () => {
    attempts += 1;
    throw new Error("gateway gone");
  };
  const p = new Pauser({ enabled: true }, throwing, makeLogger());
  assert.equal((await p.pause(target, "x")).status, "failed");
  // The account is marked before dispatching precisely so a failure cannot
  // become a hammering loop from a stuck agent.
  await p.pause(target, "x");
  await p.pause(target, "x");
  assert.equal(attempts, 1);
});

test("a missing dispatcher fails cleanly instead of crashing", async () => {
  const p = new Pauser({ enabled: true }, undefined, makeLogger());
  const result = await p.pause(target, "x");
  assert.equal(result.status, "failed");
  if (result.status === "failed") assert.match(result.error, /no gateway dispatch/);
});

test("the pause log tells the operator exactly how to undo it", async () => {
  const { impl } = spyDispatch();
  const logger = makeLogger();
  await new Pauser({ enabled: true }, impl, logger).pause(target, "daily cap");
  const line = logger.lines.join("\n");
  assert.match(line, /channels\.start/);
  // Messages queue while stopped; the operator needs to know that before resuming.
  assert.match(line, /queue while stopped/);
});

test("resume clears the paused mark and points at a verification step", async () => {
  const { calls, impl } = spyDispatch();
  const logger = makeLogger();
  const p = new Pauser({ enabled: true }, impl, logger);
  await p.pause(target, "x");
  await p.resume(target);
  assert.equal(p.isPaused(target), false);
  assert.deepEqual(calls.map((c) => c.method), ["channels.stop", "channels.start"]);
  // A `started: true` response is not proof if the crash-loop breaker tripped.
  assert.match(logger.lines.join(" "), /channels status --probe/);
});

test("nothing resumes an account automatically", async () => {
  const { calls, impl } = spyDispatch();
  const p = new Pauser({ enabled: true }, impl, makeLogger());
  await p.pause(target, "x");
  // Simulate a long quiet period: no timer, no scheduler, nothing may un-pause.
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(calls.map((c) => c.method), ["channels.stop"]);
  assert.deepEqual(p.pausedAccounts(), ["telegram:acct-1"]);
});
