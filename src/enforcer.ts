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

/** Bytes in human terms. These figures are exact, so they are worth reading. */
const BYTES = (n: number): string => {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)} GB`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)} MB`;
  if (n >= 1_000) return `${Math.round(n / 1_000)} kB`;
  return `${Math.round(n)} B`;
};

/**
 * Which triggers each surface is allowed to act on.
 *
 * `before_agent_run` is the only gate that can stop work before money is spent,
 * so it owns the budget checks. Tool-rate triggers belong on the tool gate,
 * where blocking one call still lets the agent recover and explain itself.
 *
 * `model_call_rate` and `request_bytes_minute` are on the run gate as well, and
 * that is deliberate. The incident this project was built around is a *model*
 * storm: an agent that loops without ever calling a tool, so no tool gate ever
 * fires. With those triggers on the tool gate only, such a loop met no gate at
 * all -- the ladder climbed to endRun and the next run was still allowed
 * through, because the run gate had no rate trigger to evaluate. Spend and byte
 * budgets did not cover the gap either: spend needs a provider that reports
 * usage, and the byte limits are unset by default.
 *
 * A minute-window trigger on the run gate means a run can be refused while a
 * storm is still inside the window, and allowed again once it ages out. That is
 * the intended behaviour: it stops work "while the breach persists" rather than
 * permanently.
 */
const SURFACE_TRIGGERS: Record<Surface, ReadonlySet<Trigger>> = {
  agent_run: new Set<Trigger>([
    "spend_run",
    "spend_hour",
    "spend_day",
    "request_bytes_run",
    "request_bytes_minute",
    "request_bytes_day",
    "model_call_rate",
  ]),
  tool_call: new Set<Trigger>([
    "spend_run",
    "spend_hour",
    "spend_day",
    "tool_call_rate",
    "identical_tool_call",
    "tool_error_rate",
    "request_bytes_run",
    "request_bytes_minute",
    "request_bytes_day",
  ]),
  model_call: new Set<Trigger>(["model_call_rate", "request_bytes_minute"]),
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
  // Spend built partly from estimates must say so wherever it surfaces: an
  // operator reading "$2.10" deserves to know whether that was measured.
  const est = snapshot.estimatedCalls > 0 ? " (estimated from request size)" : "";

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
    `daily spend ${USD(snapshot.dayUsd)} reached the ${USD(limits.spendPerDayUsd ?? 0)} cap${est}`,
  );
  add(
    "spend_hour",
    snapshot.hourUsd,
    limits.spendPerHourUsd,
    `hourly spend ${USD(snapshot.hourUsd)} reached the ${USD(limits.spendPerHourUsd ?? 0)} cap${est}`,
  );
  add(
    "spend_run",
    snapshot.runUsd,
    limits.spendPerRunUsd,
    `this run has spent ${USD(snapshot.runUsd)}, reaching the ${USD(limits.spendPerRunUsd ?? 0)} cap${est}`,
  );
  // Byte limits are checked before the token-rate ones because they are the
  // exact measurements: if both fire, the precise reason is the better one to
  // show an operator.
  add(
    "request_bytes_day",
    snapshot.dayBytes,
    limits.requestBytesPerDay,
    `${BYTES(snapshot.dayBytes)} sent to models today, reaching the ${BYTES(limits.requestBytesPerDay ?? 0)} limit`,
  );
  add(
    "request_bytes_run",
    snapshot.runBytes,
    limits.requestBytesPerRun,
    `this run has sent ${BYTES(snapshot.runBytes)} to models, reaching the ${BYTES(limits.requestBytesPerRun ?? 0)} limit`,
  );
  add(
    "request_bytes_minute",
    snapshot.bytesPerMinute,
    limits.requestBytesPerMinute,
    `${BYTES(snapshot.bytesPerMinute)} sent to models in the last minute, reaching the ${BYTES(limits.requestBytesPerMinute ?? 0)} limit`,
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
  // Either failure blinds a spend cap, but they blind it differently: an
  // unpriced call still moves token counters, while an unmetered one is
  // completely invisible.
  // An estimated call is not blind: it produces a real, if approximate, figure.
  // Unmetered calls only blind a cap while nothing is filling the gap, so once
  // estimation is contributing, stop telling the operator their caps are broken.
  const unmeteredAndUnestimated = snapshot.unmeteredCalls > 0 && snapshot.estimatedCalls === 0;
  return hasSpendCap && (snapshot.unpricedCalls > 0 || unmeteredAndUnestimated);
}
