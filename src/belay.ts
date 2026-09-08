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
import { limitsFor, modeFor, parseConfig } from "./config.ts";
import type { BelayConfig } from "./config.ts";
import { evaluate, spendCapsAreBlind } from "./enforcer.ts";
import type { Surface } from "./enforcer.ts";
import { agentIdFromSessionKey, ident, Meter } from "./meter.ts";
import { costOf, priceKey, resolvePrice } from "./pricing.ts";
import { loadState, StateWriter } from "./store.ts";
import { readUsage } from "./usage.ts";
import type { Alerter } from "./alerts.ts";
import { estimateFromBytes, PendingBytes, UsageReporting } from "./estimate.ts";
import type { CallBytes } from "./estimate.ts";
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

/**
 * The key a run is metered under.
 *
 * Two failures this exists to prevent, both of which switch off the per-run
 * limits without saying anything:
 *
 *  - `??` accepts an empty string, so a hook context carrying `runId: ""` used to
 *    meter into a run named `""` -- while `snapshot()` treats `""` as falsy and
 *    reads no run at all. Spend and identical-call limits for that run could
 *    then never fire, however much the agent spent.
 *  - A context with no run id at all still deserves per-run accounting; falling
 *    back to the session groups a turn's calls together and `agent_end` clears
 *    it, so the bucket cannot latch forever the way a shared "unknown" does.
 */
function runKeyOf(ctx: AgentCtx, eventRunId?: string): string {
  return (
    ident(eventRunId) ??
    ident(ctx.runId) ??
    (ident(ctx.sessionKey) === undefined ? undefined : `session:${ident(ctx.sessionKey)}`) ??
    "unknown"
  );
}

/**
 * The agent a hook context belongs to, by the *same* rule the meter uses.
 *
 * The scope key already recovers the agent id from a session key such as
 * `agent:main:main`, because some hooks carry `agentId` and others only carry
 * `sessionKey`. Per-agent config was not doing the same recovery, so on the
 * hooks that supply only a session key:
 *
 *  - a tighter per-agent cap silently reverted to the looser global one, on an
 *    agent the operator had specifically singled out as expensive; and
 *  - a per-agent `"mode": "observe"` was ignored, so Belay would block and end
 *    runs for the very agent the operator had said not to interrupt.
 *
 * Spend was still metered under the right scope, which is what made this hard to
 * see: the numbers looked right and the policy applied to them did not.
 */
function agentIdOf(ctx: AgentCtx): string | undefined {
  return ident(ctx.agentId) ?? agentIdFromSessionKey(ctx.sessionKey);
}

/**
 * Key for buffered request sizes: one run's one model, not one run.
 *
 * `model_call_ended` and `llm_output` both carry the provider and model, so the
 * pair can be matched exactly. Falling back to the run alone (when neither is
 * reported) is the old behaviour and is still safe on a single-model run.
 */
function pendingKey(runKey: string, provider?: string, model?: string): string {
  return `${runKey}\u0000${priceKey(provider ?? "", model ?? "")}`;
}

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
  const reporting = new UsageReporting();
  const pending = new PendingBytes();

  /**
   * Record an estimated call. Called from whichever of `llm_output` /
   * `model_call_ended` completes the pair, so ordering does not matter.
   */
  function recordEstimate(
    ctx: AgentCtx,
    provider: string,
    model: string,
    runKey: string,
    bytes: CallBytes,
  ): boolean {
    const estimate = estimateFromBytes(bytes, config.estimation);
    if (!estimate.usable) return false;
    const price = resolvePrice(provider, model, { overrides: config.prices, now: now() });
    meter.scope(ctx.agentId, ctx.sessionKey).recordUsage(now(), runKey, {
      usd: price ? costOf(estimate.usage, price) : 0,
      tokens: estimate.tokens,
      priceable: price !== undefined,
      estimated: true,
    });
    const key = priceKey(provider, model);
    if (!blindnessReported.has(`estimating:${key}`)) {
      blindnessReported.add(`estimating:${key}`);
      logger.warn(
        `[${PLUGIN_ID}] estimating cost for ${key} from request size, because it reports no ` +
          "token usage. Figures are approximate and labelled as estimates.",
      );
    }
    return true;
  }
  /** Set at construction, which is gateway startup. See `settleAfterRestartMs`. */
  const startedAt = now();

  /**
   * Ask the policy what should happen, and move the ladder if anything breached.
   * Returns the rung to act on, or undefined when everything is within limits.
   */
  function assess(ctx: AgentCtx, surface: Surface): { rung: RungName; reason: string } | undefined {
    const at = now();
    const scope = meter.scope(ctx.agentId, ctx.sessionKey);
    const agentId = agentIdOf(ctx);
    const limits = limitsFor(config, agentId);
    const snapshot = scope.snapshot(at, runKeyOf(ctx));

    // Tell the operator once per scope if their spend caps are only partial.
    if (spendCapsAreBlind(snapshot, limits) && !blindnessReported.has(scope.key)) {
      blindnessReported.add(scope.key);
      logger.warn(
        `[${PLUGIN_ID}] ${scope.key}: ${snapshot.unpricedCalls} unpriced and ` +
          `${snapshot.unmeteredCalls} unmetered model call(s), ` +
          "so spend caps for this agent are incomplete. Set plugins.entries.belay.config.prices " +
          "or models.providers.*.models[].cost.",
      );
    }

    const worst = evaluate(snapshot, limits, config.rungs, surface)[0];
    if (!worst) return undefined;

    const step = scope.ladder.record(at, worst.requested, worst.trigger);
    if (step.rung === "none") return undefined;

    // Observe mode clamps the acted-on rung to `warn`. The ladder still climbs
    // internally, so the reports show what *would* have happened, but nothing
    // above a warning is ever returned to a caller or handed to the pauser.
    const observing = modeFor(config, agentId) === "observe";
    // A restart drains the ingress spool as a burst, so the minutes right after
    // startup are not representative traffic. Warn, but do not act on them.
    const settling = at - startedAt < config.settleAfterRestartMs;
    const rung = observing || settling ? "warn" : step.rung;

    // Side effects fire only on a *new* step. Everything below this line is
    // deduplicated by the ladder, which is why 300 identical failures produce
    // one Telegram message rather than 300.
    //
    // The whole block is wrapped: reporting a decision must never be able to
    // cancel it. Without this, a throw from a logger, a recorder or an alert
    // transport propagates to `guard`, which -- correctly, for a bug -- returns
    // the permissive fallback. The breach would then be silently *unenforced*
    // because telling someone about it failed, which is the worst possible
    // trade. The decision itself is already made; only the telling is optional.
    try {
      if (step.isNew) {
        logger.warn(
          `[${PLUGIN_ID}] ${scope.key}: ${observing ? `would ${step.rung} (observe mode)` : step.rung}` +
            ` for ${worst.reason}`,
        );

        effects.recorder?.write(
          toRecord(
            at,
            scope.key,
            rung,
            worst.trigger,
            worst.observed,
            worst.limit,
            observing
              ? `${worst.reason} (observe mode: would have been ${step.rung})`
              : settling
                ? `${worst.reason} (settling after restart: would have been ${step.rung})`
                : worst.reason,
            // The surface decides what the record may claim: a notification
            // hook cannot have blocked or ended anything.
            surface,
          ),
        );

        void effects.alerter?.notify(
          { scope: scope.key, rung, trigger: worst.trigger, reason: worst.reason, at },
          at,
        );
      }

      // Deliberately outside the `isNew` guard. Once the ladder is at the top the
      // account should be stopped, and a previous attempt may have failed -- at
      // the ceiling every later breach is deduplicated, so gating the retry on
      // `isNew` left the account running while Belay believed it had paused it.
      // `pause()` is idempotent per account, so a success is never re-dispatched.
      if (rung === "pause" && effects.pauser && !observing && !settling) {
        const target =
          ctx.channel && ctx.accountId ? { channel: ctx.channel, accountId: ctx.accountId } : undefined;
        void effects.pauser
          .pause(target, worst.reason)
          .then((outcome) => {
            // Report what actually happened. A pause that silently failed leaves
            // an operator believing an agent was stopped when it is still running.
            if (outcome.status === "paused") {
              void effects.alerter?.notify(
                {
                  scope: scope.key,
                  rung: "pause",
                  trigger: worst.trigger,
                  reason: `account ${outcome.target.channel}:${outcome.target.accountId} is now stopped`,
                  at: now(),
                },
                now(),
              );
            } else if (outcome.status === "failed" || outcome.status === "no-target") {
              const why = outcome.status === "failed" ? outcome.error : "no channel account to pause";
              logger.error(`[${PLUGIN_ID}] PAUSE FAILED: ${why}`);
              void effects.alerter?.notify(
                {
                  scope: scope.key,
                  rung: "pause",
                  trigger: worst.trigger,
                  reason:
                    `PAUSE FAILED (${why}) -- the account is still running. Stop it by hand: ` +
                    "openclaw gateway call channels.stop --params " +
                    `'{"channel":"${target?.channel ?? "<channel>"}","accountId":"${ctx.accountId ?? "<accountId>"}"}'`,
                  at: now(),
                },
                now(),
              );
            }
          })
          .catch((err: unknown) => logger.error(`[${PLUGIN_ID}] pause failed: ${String(err)}`));
      }
    } catch (err) {
      // Last resort: the log call itself is what usually fails here, so this is
      // best-effort too.
      try {
        logger.error(`[${PLUGIN_ID}] reporting a decision failed, enforcing anyway: ${String(err)}`);
      } catch {
        /* nothing left to do */
      }
    }

    return { rung, reason: worst.reason };
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
      // Say what actually happened. "Paused" means an account was stopped and
      // needs a human to restart it; ending a run is a much smaller thing, and
      // conflating them would misinform the person reading the message.
      // Both rungs stop the run, and that much is certain by the time this is
      // returned. Whether the account also stopped is not known yet, so the
      // message does not claim it.
      const headline = "Belay stopped this run";
      return {
        outcome: "block",
        // `reason` is plugin-internal per the SDK contract; `message` is user-facing.
        reason: `belay:${decision.rung}`,
        message: `${headline}: ${decision.reason}.`,
        category: "cost_limit",
      };
    },

    /** `before_tool_call`: blocking one call still lets the agent explain itself. */
    beforeToolCall(
      ctx: AgentCtx,
      event: { toolName: string; params?: unknown },
    ): { block?: boolean; blockReason?: string } {
      const scope = meter.scope(ctx.agentId, ctx.sessionKey);
      scope.recordToolCall(now(), runKeyOf(ctx), fingerprint(event.toolName, event.params));
      const decision = assess(ctx, "tool_call");
      if (!decision || decision.rung === "none" || decision.rung === "warn") return {};
      return { block: true, blockReason: `Belay blocked this tool call: ${decision.reason}.` };
    },

    /** `after_tool_call`: observe only; feeds the error-storm counter. */
    afterToolCall(ctx: AgentCtx, event: { error?: unknown }): void {
      if (event.error !== undefined && event.error !== null) {
        meter.scope(ctx.agentId, ctx.sessionKey).recordToolError(now());
      }
    },

    /**
     * `model_call_ended`: the fallback cost source.
     *
     * Carries `requestPayloadBytes` and `responseStreamBytes` -- the *size* of
     * the request and response, never their content. For a provider that has
     * been observed reporting no token usage, this is what keeps spend caps
     * working. Models that do report usage are never estimated, so nothing is
     * ever counted twice.
     */
    modelCallEnded(
      ctx: AgentCtx,
      event: {
        provider?: string;
        model?: string;
        runId?: string;
        requestPayloadBytes?: number;
        responseStreamBytes?: number;
      },
    ): void {
      const runKey = runKeyOf(ctx, event.runId);
      // Always record the exact size, whatever estimation is set to: byte
      // limits do not depend on it and are accurate on every provider.
      meter
        .scope(ctx.agentId, ctx.sessionKey)
        .recordRequestBytes(now(), runKey, event.requestPayloadBytes ?? 0);
      if (!config.estimation.enabled) return;
      const callKey = pendingKey(runKey, event.provider, event.model);
      // If llm_output already reported no usage for this call, complete the pair
      // now. Otherwise hold the sizes until it does.
      if (pending.isAwaiting(callKey)) {
        if (recordEstimate(ctx, event.provider ?? "", event.model ?? "", runKey, event)) {
          pending.clearAwaiting(callKey);
          return;
        }
        // Nothing usable in this event. Leave the call marked as awaiting so a
        // later `model_call_ended` that does carry sizes still completes it.
      }
      pending.add(callKey, event);
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
      event: {
        provider?: string;
        model?: string;
        usage?: HookUsage;
        lastAssistant?: unknown;
        runId?: string;
        resolvedRef?: string;
        api?: string;
        harnessId?: string;
      },
    ): void {
      // On a real gateway `usage` came back undefined for Gemini while the
      // assistant transcript entry carried the counts, so fall back to it.
      // Both shapes are the same normalized bucket names.
      const reading = readUsage(event.usage ?? usageFrom(event.lastAssistant));
      const scopeForUsage = meter.scope(ctx.agentId, ctx.sessionKey);
      const modelKey = priceKey(event.provider ?? "", event.model ?? "");
      if (reading.present) reporting.markMeasured(modelKey);
      else reporting.markMissing(modelKey);

      const runKey = runKeyOf(ctx, event.runId);
      // Buffered sizes are keyed by run *and* model. Keying by run alone meant a
      // model that reports usage took (and threw away) the sizes buffered for a
      // different model in the same run -- so on a failover, where a run walks
      // down a chain of models and only some of them report usage, the
      // unreported calls were silently free. That is precisely the incident this
      // plugin exists for.
      const bytes = pending.take(pendingKey(runKey, event.provider, event.model));

      if (!reading.present) {
        // No token counts. Estimate from the sizes buffered by model_call_ended,
        // which is metadata rather than content.
        if (config.estimation.enabled) {
          if (
            bytes &&
            recordEstimate(ctx, event.provider ?? "", event.model ?? "", runKey, bytes)
          ) {
            return;
          }
          // The sizes have not arrived yet. Wait for model_call_ended rather
          // than writing this call off as free.
          pending.awaitBytes(pendingKey(runKey, event.provider, event.model));
          return;
        }
        // Nothing to estimate from: this call is genuinely invisible.
        scopeForUsage.recordMissingUsage();
        const key = `missing-usage:${event.provider ?? "?"}/${event.model ?? "?"}`;
        if (!blindnessReported.has(key)) {
          blindnessReported.add(key);
          logger.warn(
            `[${PLUGIN_ID}] ${event.provider ?? "?"}/${event.model ?? "?"} reports no token usage` +
              (config.estimation.enabled
                ? "; falling back to estimating cost from request size."
                : "; spend caps cannot see these calls. Set estimation.enabled to fix this."),
          );
          // Field *names* and value *types* only -- never values. Enough to find
          // where a provider hid its token counts, without touching content.
          logger.warn(`[${PLUGIN_ID}] llm_output shape: ${describeShape(event)}`);
          // Identifiers, not content: which transport and harness actually ran.
          // Without these an operator reporting missing usage upstream cannot
          // say *which* code path produced it, which is the first thing a
          // maintainer asks for.
          const entry = (event.lastAssistant ?? {}) as Record<string, unknown>;
          logger.warn(
            `[${PLUGIN_ID}] resolved route: provider=${String(event.provider)} ` +
              `model=${String(event.model)} resolvedRef=${String(event.resolvedRef)} ` +
              `api=${String(event.api)} harnessId=${String(event.harnessId)} | ` +
              `transcript: api=${String(entry["api"])} provider=${String(entry["provider"])} ` +
              `model=${String(entry["model"])} stopReason=${String(entry["stopReason"])}`,
          );
          logger.warn(`[${PLUGIN_ID}] lastAssistant shape: ${describeShape(event.lastAssistant)}`);
          // Only the numbers Belay itself understands, re-emitted from its own
          // normalized reading. Stringifying the raw `usage` object would print
          // whatever a provider happened to put there -- and this is untrusted
          // data from another process, on a code path that exists precisely
          // because a provider's payload was not the shape we expected.
          logger.warn(
            `[${PLUGIN_ID}] transcript usage values: ${describeUsage(usageFrom(event.lastAssistant))}`,
          );
        }
        return;
      }
      const price = reading.priceable
        ? resolvePrice(event.provider ?? "", event.model ?? "", {
            overrides: config.prices,
            now: now(),
          })
        : undefined;
      scopeForUsage.recordUsage(now(), runKey, {
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
      const runKey = runKeyOf(ctx);
      meter.scope(ctx.agentId, ctx.sessionKey).endRun(runKey);
      // Drop any buffered sizes for the run too: without this, a run whose
      // `llm_output` never arrives holds its bytes until the eviction bound,
      // where they would be attributed to whichever run is estimated next.
      pending.dropRun(runKey);
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

/**
 * Describe an object's field names and value types, never its values.
 *
 * A provider that reports usage under a name we do not expect makes every spend
 * cap silently inert, and the only way to find it is to look at the payload. But
 * `llm_output` also carries `prompt` and `assistantTexts`, so this must never
 * print a value -- only the shape, one level deep.
 */
export function describeShape(value: unknown, depth = 0): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return `array[${value.length}]`;
  if (typeof value !== "object") return typeof value;
  if (depth >= 1) return "object";
  const parts: string[] = [];
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    parts.push(`${k}:${describeShape(v, depth + 1)}`);
  }
  return `{${parts.join(", ")}}`;
}

/**
 * Pull a usage object off a transcript-shaped value, if it has one.
 *
 * Deliberately narrow: it reads exactly one property named `usage` and hands it
 * to the same validator as the hook's own field, so a surprising shape degrades
 * to "no usage" rather than to a wrong number. It never touches any other
 * property, so message content stays untouched.
 */
/**
 * Render a usage object as numbers, and nothing else.
 *
 * `JSON.stringify` on the raw object would faithfully print any string a
 * provider tucked in beside the token counts. Belay's whole claim is that no
 * content reaches a log line, so the diagnostic prints Belay's own normalized
 * reading rather than the payload it came from.
 */
export function describeUsage(raw: HookUsage | undefined): string {
  if (raw === undefined) return "none";
  const { usage, tokens, present, priceable } = readUsage(raw);
  return JSON.stringify({ ...usage, tokens, present, priceable });
}

export function usageFrom(value: unknown): HookUsage | undefined {
  if (!value || typeof value !== "object") return undefined;
  const usage = (value as { usage?: unknown }).usage;
  if (!usage || typeof usage !== "object") return undefined;
  return usage as HookUsage;
}
