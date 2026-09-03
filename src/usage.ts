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

/**
 * Field-name aliases for each token bucket.
 *
 * OpenClaw's own `llm_output.usage` uses the short names, but the assistant
 * transcript entry and several provider payloads use `*Tokens` or snake_case.
 * Belay reads whichever is present rather than requiring one shape: a meter
 * that only understands one spelling reports $0.00 on the others, which is the
 * failure this whole module exists to prevent. Verified against a live gateway.
 */
const ALIASES = {
  input: ["input", "inputTokens", "promptTokens", "input_tokens", "prompt_tokens"],
  output: ["output", "outputTokens", "completionTokens", "output_tokens", "completion_tokens"],
  cacheRead: ["cacheRead", "cacheReadTokens", "cache_read", "cache_read_input_tokens"],
  cacheWrite: ["cacheWrite", "cacheWriteTokens", "cache_write", "cache_creation_input_tokens"],
  total: ["total", "totalTokens", "total_tokens"],
} as const;

/** First alias present with a usable number, else 0. */
function pick(raw: Record<string, unknown>, names: readonly string[]): number {
  for (const name of names) {
    const v = raw[name];
    if (typeof v === "number" && Number.isFinite(v) && v > 0) return v;
  }
  return 0;
}

export function readUsage(raw: HookUsage | undefined): UsageReading {
  if (!raw || typeof raw !== "object") {
    return { usage: { ...ZERO }, tokens: 0, present: false, priceable: false };
  }
  const src = raw as unknown as Record<string, unknown>;

  const usage: Usage = {
    input: pick(src, ALIASES.input),
    output: pick(src, ALIASES.output),
    cacheRead: pick(src, ALIASES.cacheRead),
    cacheWrite: pick(src, ALIASES.cacheWrite),
  };
  const split = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
  const total = pick(src, ALIASES.total);

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
