/**
 * The enforcer: a pure function from "what the meter saw" to "what should happen".
 *
 * No clock, no I/O, no SDK. Given a snapshot and the effective limits it returns
 * the breaches; the caller feeds each through the scope's ladder to get a rung,
 * then translates that rung into a hook return value. Keeping the decision pure
 * is what makes the incident replays in `test/replay` meaningful -- they exercise
 * the real policy, not a mock of it.
 */
import type { Limits } from "./config.ts";
import type { MeterSnapshot } from "./meter.ts";
import type { RungName, Trigger } from "./types.ts";

export type Breach = {
  trigger: Trigger;
  observed: number;
  limit: number;
  /** The rung a first offence lands on, from config. */
  requested: RungName;
  reason: string;
};

/** Which hook is asking. A tool gate cannot end a run; a run gate cannot block a tool. */
export type Surface = "agent_run" | "tool_call" | "model_call";

const USD = (n: number): string => `$${n.toFixed(4).replace(/0+$/, "").replace(/\.$/, "")}`;

/**
 * Which triggers each surface is allowed to act on.
 *
 * `before_agent_run` is the only gate that can stop work before money is spent,
 * so it owns the budget checks. Rate limits belong on the tool gate, where
 * blocking one call still lets the agent recover and explain itself.
 */
const SURFACE_TRIGGERS: Record<Surface, ReadonlySet<Trigger>> = {
  agent_run: new Set<Trigger>(["spend_run", "spend_hour", "spend_day"]),
  tool_call: new Set<Trigger>([
    "spend_run",
    "spend_hour",
    "spend_day",
    "tool_call_rate",
    "identical_tool_call",
    "tool_error_rate",
  ]),
  model_call: new Set<Trigger>(["model_call_rate"]),
};

/**
 * Evaluate a snapshot against the limits.
 *
 * Ordering matters: the most expensive breach is returned first, so a caller
 * that acts on one breach acts on the worst one.
 */
export function evaluate(
  snapshot: MeterSnapshot,
  limits: Limits,
  rungs: Record<Trigger, RungName>,
  surface: Surface,
): Breach[] {
  const allowed = SURFACE_TRIGGERS[surface];
  const breaches: Breach[] = [];

  const add = (
    trigger: Trigger,
    observed: number,
    limit: number | undefined,
    reason: string,
  ): void => {
    // An unset limit is not a limit of zero. This is the single most important
    // line in the file: `undefined > 0` must never read as "always breached".
    if (limit === undefined) return;
    if (!allowed.has(trigger)) return;
    if (observed < limit) return;
    breaches.push({ trigger, observed, limit, requested: rungs[trigger], reason });
  };

  add(
    "spend_day",
    snapshot.dayUsd,
    limits.spendPerDayUsd,
    `daily spend ${USD(snapshot.dayUsd)} reached the ${USD(limits.spendPerDayUsd ?? 0)} cap`,
  );
  add(
    "spend_hour",
    snapshot.hourUsd,
    limits.spendPerHourUsd,
    `hourly spend ${USD(snapshot.hourUsd)} reached the ${USD(limits.spendPerHourUsd ?? 0)} cap`,
  );
  add(
    "spend_run",
    snapshot.runUsd,
    limits.spendPerRunUsd,
    `this run has spent ${USD(snapshot.runUsd)}, reaching the ${USD(limits.spendPerRunUsd ?? 0)} cap`,
  );
  add(
    "identical_tool_call",
    snapshot.maxIdenticalCalls,
    limits.identicalToolCalls,
    `the same tool call repeated ${snapshot.maxIdenticalCalls} times in one run`,
  );
  add(
    "tool_error_rate",
    snapshot.toolErrorsPerMinute,
    limits.toolErrorsPerMinute,
    `${snapshot.toolErrorsPerMinute} tool errors in the last minute`,
  );
  add(
    "model_call_rate",
    snapshot.modelCallsPerMinute,
    limits.modelCallsPerMinute,
    `${snapshot.modelCallsPerMinute} model calls in the last minute`,
  );
  add(
    "tool_call_rate",
    snapshot.toolCallsPerMinute,
    limits.toolCallsPerMinute,
    `${snapshot.toolCallsPerMinute} tool calls in the last minute`,
  );

  return breaches;
}

/**
 * True when spend caps are configured but the meter could not price some calls.
 *
 * Worth surfacing on its own: it means the operator believes they have a dollar
 * cap and only have a partial one.
 */
export function spendCapsAreBlind(snapshot: MeterSnapshot, limits: Limits): boolean {
  const hasSpendCap =
    limits.spendPerRunUsd !== undefined ||
    limits.spendPerHourUsd !== undefined ||
    limits.spendPerDayUsd !== undefined;
  return hasSpendCap && snapshot.unpricedCalls > 0;
}
