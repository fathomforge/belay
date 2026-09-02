/**
 * Turning what `llm_output` actually hands us into something a meter can bill.
 *
 * Verified against OpenClaw 2026.8.2: `PluginHookLlmOutputEvent.usage` is
 * optional, and so is every field inside it. Three failure modes follow, and
 * silently treating any of them as zero is how a guardrail becomes decorative:
 *
 *  1. No `usage` at all -- nothing to meter. Must be reported, not assumed free.
 *  2. `usage` present but only `total` -- we know the size but not the
 *     input/output split, and the two are priced up to 5x apart, so no honest
 *     dollar figure exists. Token limits still work; spend caps must not pretend.
 *  3. `usage` with the normal split -- fully priceable.
 *
 * The event also carries `prompt` and `assistantTexts`. Belay never reads them,
 * and `HookUsage` deliberately has nowhere to put them.
 */
import type { HookUsage, Usage } from "./types.ts";

export type UsageReading = {
  usage: Usage;
  /** Tokens we are confident about, including a `total`-only report. */
  tokens: number;
  /** False when no usage was reported at all. */
  present: boolean;
  /** False when the input/output split is unknown, so cost cannot be computed. */
  priceable: boolean;
};

const ZERO: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

/** Non-negative finite number, or 0. Providers have shipped nulls and NaNs here. */
function num(v: number | undefined): number {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0;
}

export function readUsage(raw: HookUsage | undefined): UsageReading {
  if (!raw) return { usage: { ...ZERO }, tokens: 0, present: false, priceable: false };

  const usage: Usage = {
    input: num(raw.input),
    output: num(raw.output),
    cacheRead: num(raw.cacheRead),
    cacheWrite: num(raw.cacheWrite),
  };
  const split = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
  const total = num(raw.total);

  // A `total` with no split is real: some providers report only an aggregate.
  if (split === 0 && total > 0) {
    return { usage, tokens: total, present: true, priceable: false };
  }
  return {
    usage,
    // Prefer the reported total when it is larger; it may include buckets we
    // do not model (reasoning tokens), and under-counting is the failure we care about.
    tokens: Math.max(split, total),
    present: split > 0 || total > 0,
    priceable: split > 0,
  };
}
