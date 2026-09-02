/**
 * Belay's own vocabulary. Nothing here imports the OpenClaw SDK: the policy core
 * is deliberately runtime-agnostic so it can be unit-tested without a gateway and
 * so an SDK shape change only ever breaks the adapter in `index.ts`.
 */

/**
 * The `usage` object exactly as `llm_output` delivers it, verified against
 * OpenClaw 2026.8.2 (`PluginHookLlmOutputEvent`).
 *
 * Every field is optional, and `usage` itself is optional on the event. That is
 * not defensive typing on our part -- it is the real contract, and it is the
 * single most dangerous fact about metering: a meter that assumes these are
 * present bills $0.00 and enforces nothing.
 */
export type HookUsage = {
  // `| undefined` is explicit: this is untrusted data crossing a process
  // boundary, and a provider really can hand us a key whose value is undefined.
  input?: number | undefined;
  output?: number | undefined;
  cacheRead?: number | undefined;
  cacheWrite?: number | undefined;
  total?: number | undefined;
};

/** Token counts for a single model call, normalized. Numbers only -- never text. */
export type Usage = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
};

/** Dollars per million tokens, matching how providers publish pricing. */
export type ModelPrice = {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
};

/** Rungs of the pause ladder, in ascending severity. Numeric so they compare. */
export const RUNG = {
  none: 0,
  warn: 1,
  blockTool: 2,
  endRun: 3,
  pause: 4,
} as const;

export type RungName = keyof typeof RUNG;
export type RungLevel = (typeof RUNG)[RungName];

export const RUNG_NAMES = Object.keys(RUNG) as RungName[];

/** Why a rung fired. Kept coarse so the flight recorder stays free of content. */
export type Trigger =
  | "spend_run"
  | "spend_hour"
  | "spend_day"
  | "model_call_rate"
  | "tool_call_rate"
  | "identical_tool_call"
  | "tool_error_rate"
  | "failover_context";

/** One decision, as recorded and as acted on. Carries no prompt or output content. */
export type Decision = {
  rung: RungName;
  trigger: Trigger;
  reason: string;
  /** The measured value that crossed the threshold (USD or a count). */
  observed: number;
  /** The configured threshold it crossed. */
  limit: number;
  /** False when the ladder suppressed a repeat inside its cooldown. */
  isNew: boolean;
  at: number;
};
