/**
 * Hook handlers, expressed without any dependency on OpenClaw itself.
 *
 * This is the layer that turns hook payloads into policy questions and rungs
 * into return values. It deliberately imports nothing from the SDK: the payload
 * shapes it accepts are structural, so the whole thing is unit-testable with
 * plain objects and an injected clock, and `index.ts` is left as a thin wiring
 * file whose only job is registration and fail-open guarding.
 *
 * Payload shapes verified against openclaw@2026.8.2. See docs/openclaw-plugin-sdk.md.
 */
import { createHash } from "node:crypto";
import { limitsFor, parseConfig } from "./config.ts";
import type { BelayConfig } from "./config.ts";
import { evaluate, spendCapsAreBlind } from "./enforcer.ts";
import type { Surface } from "./enforcer.ts";
import { Meter } from "./meter.ts";
import { costOf, priceKey, resolvePrice } from "./pricing.ts";
import { loadState, StateWriter } from "./store.ts";
import { readUsage } from "./usage.ts";
import type { Alerter } from "./alerts.ts";
import type { Pauser } from "./pauser.ts";
import { toRecord } from "./recorder.ts";
import type { Recorder } from "./recorder.ts";
import type { HookUsage, RungName } from "./types.ts";

const PLUGIN_ID = "belay";

/** Minimal shape of the logger the SDK hands us. */
export type Logger = {
  debug?: (message: string) => void;
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
};

/**
 * The subset of `PluginHookAgentContext` Belay reads.
 *
 * Note `agentId` is genuinely optional in the SDK, so every scope lookup has to
 * survive its absence. `accountId` is what a future `channels.stop` needs.
 */
export type AgentCtx = {
  agentId?: string;
  sessionKey?: string;
  runId?: string;
  /** Channel plugin id (e.g. "telegram"); needed to identify a pause target. */
  channel?: string;
  accountId?: string;
};

type BlockDecision =
  | { outcome: "pass" }
  | { outcome: "block"; reason: string; message: string; category: string };

/** Hash a tool call so repeats can be counted without retaining parameters. */
function fingerprint(toolName: string, params: unknown): string {
  let serialized: string;
  try {
    serialized = JSON.stringify(params) ?? "";
  } catch {
    // Circular or exotic params: fall back to the tool name alone. Coarser, but
    // it still catches "the same call over and over", which is the whole point.
    serialized = "";
  }
  return createHash("sha256").update(`${toolName} ${serialized}`).digest("hex").slice(0, 16);
}

/**
 * Optional side-effect sinks. All three are omitted in unit tests and in a
 * default install, which is what keeps "no network, no files, no side effects
 * unless configured" true by construction rather than by promise.
 */
export type Effects = {
  alerter?: Alerter;
  recorder?: Recorder;
  pauser?: Pauser;
};

export function createBelay(
  config: BelayConfig,
  logger: Logger,
  now: () => number = Date.now,
  effects: Effects = {},
) {
  const meter = new Meter(config.timeZone, config.ladder);
  const blindnessReported = new Set<string>();

  /**
   * Ask the policy what should happen, and move the ladder if anything breached.
   * Returns the rung to act on, or undefined when everything is within limits.
   */
  function assess(ctx: AgentCtx, surface: Surface): { rung: RungName; reason: string } | undefined {
    const at = now();
    const scope = meter.scope(ctx.agentId, ctx.sessionKey);
    const limits = limitsFor(config, ctx.agentId);
    const snapshot = scope.snapshot(at, ctx.runId);

    // Tell the operator once per scope if their spend caps are only partial.
    if (spendCapsAreBlind(snapshot, limits) && !blindnessReported.has(scope.key)) {
      blindnessReported.add(scope.key);
      logger.warn(
        `[${PLUGIN_ID}] ${scope.key}: ${snapshot.unpricedCalls} model call(s) could not be priced, ` +
          "so spend caps for this agent are incomplete. Set plugins.entries.belay.config.prices " +
          "or models.providers.*.models[].cost.",
      );
    }

    const worst = evaluate(snapshot, limits, config.rungs, surface)[0];
    if (!worst) return undefined;

    const step = scope.ladder.record(at, worst.requested, worst.trigger);
    if (step.rung === "none") return undefined;

    // Side effects fire only on a *new* step. Everything below this line is
    // deduplicated by the ladder, which is why 300 identical failures produce
    // one Telegram message rather than 300.
    if (step.isNew) {
      logger.warn(`[${PLUGIN_ID}] ${scope.key}: ${step.rung} for ${worst.reason}`);

      effects.recorder?.write(
        toRecord(at, scope.key, step.rung, worst.trigger, worst.observed, worst.limit, worst.reason),
      );

      void effects.alerter?.notify(
        { scope: scope.key, rung: step.rung, trigger: worst.trigger, reason: worst.reason, at },
        at,
      );

      if (step.rung === "pause" && effects.pauser) {
        // Fire and forget: an agent turn must never wait on a gateway RPC.
        // `pause()` is idempotent per account and never rejects.
        const target =
          ctx.channel && ctx.accountId
            ? { channel: ctx.channel, accountId: ctx.accountId }
            : undefined;
        void effects.pauser
          .pause(target, worst.reason)
          .catch((err: unknown) => logger.error(`[${PLUGIN_ID}] pause failed: ${String(err)}`));
      }
    }
    return { rung: step.rung, reason: worst.reason };
  }

  return {
    meter,
    assess,

    /** `before_agent_run`: the only gate that can stop work before money moves. */
    beforeAgentRun(ctx: AgentCtx): BlockDecision {
      const decision = assess(ctx, "agent_run");
      // `warn` and `blockTool` are not run-level actions; only the top rungs stop a run.
      if (!decision || (decision.rung !== "endRun" && decision.rung !== "pause")) {
        return { outcome: "pass" };
      }
      return {
        outcome: "block",
        // `reason` is plugin-internal per the SDK contract; `message` is user-facing.
        reason: `belay:${decision.rung}`,
        message: `Paused by Belay: ${decision.reason}.`,
        category: "cost_limit",
      };
    },

    /** `before_tool_call`: blocking one call still lets the agent explain itself. */
    beforeToolCall(
      ctx: AgentCtx,
      event: { toolName: string; params?: unknown },
    ): { block?: boolean; blockReason?: string } {
      const scope = meter.scope(ctx.agentId, ctx.sessionKey);
      scope.recordToolCall(now(), ctx.runId ?? "unknown", fingerprint(event.toolName, event.params));
      const decision = assess(ctx, "tool_call");
      if (!decision || decision.rung === "none" || decision.rung === "warn") return {};
      return { block: true, blockReason: `Belay: ${decision.reason}.` };
    },

    /** `after_tool_call`: observe only; feeds the error-storm counter. */
    afterToolCall(ctx: AgentCtx, event: { error?: unknown }): void {
      if (event.error !== undefined && event.error !== null) {
        meter.scope(ctx.agentId, ctx.sessionKey).recordToolError(now());
      }
    },

    /** `model_call_started`: the storm counter from incident #1. */
    modelCallStarted(ctx: AgentCtx): void {
      meter.scope(ctx.agentId, ctx.sessionKey).recordModelCall(now());
      assess(ctx, "model_call");
    },

    /**
     * `llm_output`: the meter's only money input.
     *
     * The event also carries `prompt` and `assistantTexts`. Neither is read here,
     * and nothing downstream has a field to put them in.
     */
    llmOutput(
      ctx: AgentCtx,
      event: { provider?: string; model?: string; usage?: HookUsage; runId?: string },
    ): void {
      const reading = readUsage(event.usage);
      if (!reading.present) return;
      const price = reading.priceable
        ? resolvePrice(event.provider ?? "", event.model ?? "", {
            overrides: config.prices,
            now: now(),
          })
        : undefined;
      const scope = meter.scope(ctx.agentId, ctx.sessionKey);
      scope.recordUsage(now(), event.runId ?? ctx.runId ?? "unknown", {
        usd: price ? costOf(reading.usage, price) : 0,
        tokens: reading.tokens,
        // An unknown model is as unpriceable as a missing split: both must count
        // as "unknown", never as "$0.00 spent".
        priceable: reading.priceable && price !== undefined,
      });
      if (reading.priceable && !price) {
        const key = priceKey(event.provider ?? "", event.model ?? "");
        if (!blindnessReported.has(key)) {
          blindnessReported.add(key);
          logger.warn(`[${PLUGIN_ID}] no price known for ${key}; its cost is not counted.`);
        }
      }
    },

    agentEnd(ctx: AgentCtx): void {
      if (ctx.runId) meter.scope(ctx.agentId, ctx.sessionKey).endRun(ctx.runId);
    },
  };
}

export type Belay = ReturnType<typeof createBelay>;

/**
 * The fail-open boundary.
 *
 * A thrown error inside a hook must never propagate into the gateway. Note the
 * asymmetry that makes this safe: `fallback` is always the permissive answer, so
 * a Belay bug degrades to "no guardrail", never to "everything blocked".
 */
export function guard<T>(logger: Logger, hook: string, fn: () => T, fallback?: T): T | undefined {
  try {
    return fn();
  } catch (err) {
    logger.error(`[${PLUGIN_ID}] ${hook} failed, passing through: ${String(err)}`);
    return fallback;
  }
}
