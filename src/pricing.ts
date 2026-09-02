/**
 * Cost arithmetic and the bundled fallback price table.
 *
 * Why a bundled table at all: dollar costs only appear in OpenClaw's own usage
 * records when the operator configured `models.providers.*.models[].cost`. Most
 * people never do, so a meter that trusted `usage.cost` would silently meter $0
 * and enforce nothing. Belay therefore computes cost from token counts itself.
 * Operator-supplied prices always win; this table is the floor, not the truth.
 */
import type { ModelPrice, Usage } from "./types.ts";

/**
 * A price that is scheduled to change. Introductory pricing that silently
 * doubles on a known date is a real under-metering trap, so the table encodes it
 * rather than pretending prices are constant.
 */
export type PriceEntry = ModelPrice & {
  /** ISO date; before this instant `this` applies, at or after it `then` applies. */
  until?: string;
  then?: ModelPrice;
};

/**
 * Dollars per million tokens. Keys are canonical `provider/model`, lowercased.
 * Deliberately small: a wrong price is worse than a missing one, because a
 * missing one is reported and a wrong one is trusted.
 */
export const FALLBACK_PRICES: Readonly<Record<string, PriceEntry>> = Object.freeze({
  // Introductory pricing through 2026-12-31, then $1.50/$7.50.
  "google/gemini-3.8-flash": {
    input: 0.75,
    output: 3.75,
    until: "2027-01-01T00:00:00Z",
    then: { input: 1.5, output: 7.5 },
  },
});

/** Canonical lookup key for a provider/model pair. */
export function priceKey(provider: string, model: string): string {
  const p = provider.trim().toLowerCase();
  const m = model.trim().toLowerCase();
  // Some providers already report the model as "provider/model".
  return m.includes("/") ? m : `${p}/${m}`;
}

export type ResolvePriceOptions = {
  /** Operator-configured prices, keyed like `priceKey`. Always win. */
  overrides?: Record<string, ModelPrice>;
  /** Injected clock (ms since epoch) so scheduled price changes are testable. */
  now?: number;
};

/**
 * Returns the price for a model, or `undefined` when we genuinely do not know.
 *
 * `undefined` is a first-class answer: the caller meters tokens, skips dollars,
 * and alerts once. Guessing a price would make the spend cap a fiction.
 */
export function resolvePrice(
  provider: string,
  model: string,
  opts: ResolvePriceOptions = {},
): ModelPrice | undefined {
  const key = priceKey(provider, model);
  const override = opts.overrides?.[key];
  if (override) return override;

  const entry = FALLBACK_PRICES[key];
  if (!entry) return undefined;

  if (entry.until && entry.then) {
    const at = opts.now ?? Date.now();
    if (at >= Date.parse(entry.until)) return entry.then;
  }
  const { input, output, cacheRead, cacheWrite } = entry;
  const price: ModelPrice = { input, output };
  if (cacheRead !== undefined) price.cacheRead = cacheRead;
  if (cacheWrite !== undefined) price.cacheWrite = cacheWrite;
  return price;
}

const PER_MILLION = 1_000_000;

/**
 * Cost of one model call in USD.
 *
 * Cached reads fall back to the input rate and cache writes to the input rate
 * when a provider does not price them separately -- erring toward over-counting,
 * because a cap that trips slightly early is a far cheaper mistake than one that
 * never trips.
 */
export function costOf(usage: Usage, price: ModelPrice): number {
  const cacheReadRate = price.cacheRead ?? price.input;
  const cacheWriteRate = price.cacheWrite ?? price.input;
  const tokens =
    usage.input * price.input +
    usage.output * price.output +
    usage.cacheRead * cacheReadRate +
    usage.cacheWrite * cacheWriteRate;
  return tokens / PER_MILLION;
}

/** Total tokens billed for a call, used for context-size and failover checks. */
export function totalTokens(usage: Usage): number {
  return usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
}
