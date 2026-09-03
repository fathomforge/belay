/**
 * Cost estimation from request size, for providers that report no token usage.
 *
 * Why this exists: on a real gateway, `llm_output.usage` came back `undefined`
 * and the transcript entry's usage was all zeros. A spend cap with no token
 * counts is inert, and that is most of the product. But `model_call_ended`
 * carries `requestPayloadBytes` and `responseStreamBytes` -- the *size* of the
 * request and response, not their content -- which is enough to estimate.
 *
 * The privacy property is the important part: this reads two integers of
 * transport metadata. It never sees a prompt, a reply, or a tool parameter, and
 * it needs no additional hook access to work.
 *
 * It is an estimate and is labelled as one everywhere it surfaces. Measured
 * error against the provider's own tokenizer is roughly +-50% on realistic
 * content and worse at the extremes -- see docs/CALIBRATION.md for the data.
 * That is an order-of-magnitude signal, not accounting, and it is worth far
 * more than the honest alternative here, which is no cap at all.
 */
import type { Usage } from "./types.ts";

export type EstimationConfig = {
  /** Estimate when a provider reports no usage. */
  enabled: boolean;
  /**
   * Bytes of request payload per input token.
   *
   * Measured against Gemini's own tokenizer across ten content types: the true
   * ratio ranges from 1.39 bytes/token for identifier-heavy text to 7.88 for
   * varied English prose, a 5.7x spread. **No single value is accurate**, which
   * is a property of tokenizers, not a tuning problem.
   *
   * The default sits in the middle of the realistic-payload band (2.33-3.60 for
   * JSON, code and mixed content), where its error is -33% to +3%. It
   * over-counts prose, which is the tolerable direction.
   *
   * The full experiment, data and per-traffic-type guidance are in
   * docs/CALIBRATION.md. Calibrated for google/gemini-3.8-flash; other
   * providers have different tokenizers and need their own measurement.
   */
  bytesPerToken: number;
};

/**
 * Off by default.
 *
 * A dollar figure derived from byte counts carries roughly +-50% on realistic
 * content (docs/CALIBRATION.md), and shipping that as a headline number invites
 * people to trust it as accounting. The exact alternative -- `requestBytesPer*`
 * limits -- needs no estimation at all. Turn this on deliberately, when an
 * approximate spend cap is more useful to you than none.
 */
export const DEFAULT_ESTIMATION: EstimationConfig = { enabled: false, bytesPerToken: 3.5 };

/** Bytes reported by `model_call_ended`. Both are optional in practice. */
export type CallBytes = {
  requestPayloadBytes?: number | undefined;
  responseStreamBytes?: number | undefined;
};

export type Estimate = {
  usage: Usage;
  tokens: number;
  /** False when there were no usable byte counts to work from. */
  usable: boolean;
};

function positive(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * Estimate token usage from transport byte counts.
 *
 * Request bytes map to input tokens and response bytes to output tokens. Cache
 * buckets stay zero: there is no way to tell a cached read from a fresh one at
 * this layer, and guessing would understate cost, which is the wrong direction.
 */
export function estimateFromBytes(bytes: CallBytes, config: EstimationConfig): Estimate {
  const perToken = config.bytesPerToken > 0 ? config.bytesPerToken : DEFAULT_ESTIMATION.bytesPerToken;
  const requestBytes = positive(bytes.requestPayloadBytes);
  const responseBytes = positive(bytes.responseStreamBytes);

  if (requestBytes === 0 && responseBytes === 0) {
    return { usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, tokens: 0, usable: false };
  }
  const usage: Usage = {
    input: Math.ceil(requestBytes / perToken),
    output: Math.ceil(responseBytes / perToken),
    cacheRead: 0,
    cacheWrite: 0,
  };
  return { usage, tokens: usage.input + usage.output, usable: true };
}

/**
 * Tracks which provider/model pairs report real usage and which do not.
 *
 * Estimation must never double-count a call that also reported real numbers, so
 * a model that has ever reported usage is permanently trusted to keep doing so
 * and is never estimated for again. A model only becomes eligible for
 * estimation after it has actually been seen reporting nothing.
 */
export class UsageReporting {
  #measured = new Set<string>();
  #missing = new Set<string>();

  /** Record that this model reported real token counts. */
  markMeasured(key: string): void {
    this.#measured.add(key);
    this.#missing.delete(key);
  }

  /** Record that this model reported no usable token counts. */
  markMissing(key: string): void {
    if (this.#measured.has(key)) return;
    this.#missing.add(key);
  }

  /** True when this model has been observed reporting nothing, and never real numbers. */
  shouldEstimate(key: string): boolean {
    return this.#missing.has(key) && !this.#measured.has(key);
  }

  /** Models currently being estimated, for `status` output and startup logs. */
  estimatedModels(): string[] {
    return [...this.#missing];
  }
}

/**
 * Holds request/response sizes until the matching `llm_output` arrives.
 *
 * Estimating directly inside `model_call_ended` made the result depend on hook
 * ordering: a model is only eligible for estimation once it has been *seen*
 * reporting no usage, which happens in `llm_output`. If that fires second, the
 * call is never counted -- so the first call after every gateway restart was
 * silently free, which is exactly the kind of quiet undercount this project
 * exists to prevent.
 *
 * Buffering by run id removes the ordering dependence: sizes accumulate, and
 * whichever hook runs second does the arithmetic.
 */
export class PendingBytes {
  readonly maxRuns: number;
  #byRun = new Map<string, CallBytes>();
  /** Runs whose llm_output already reported no usage and are waiting on sizes. */
  #awaiting = new Set<string>();

  constructor(maxRuns = 500) {
    this.maxRuns = maxRuns;
  }

  /** Record that this run reported no usage and has nothing to estimate from yet. */
  awaitBytes(runId: string): void {
    this.#awaiting.add(runId);
    while (this.#awaiting.size > this.maxRuns) {
      const oldest = this.#awaiting.values().next().value;
      if (oldest === undefined) break;
      this.#awaiting.delete(oldest);
    }
  }

  /** True when `llm_output` has already asked for an estimate on this run. */
  isAwaiting(runId: string): boolean {
    return this.#awaiting.has(runId);
  }

  clearAwaiting(runId: string): void {
    this.#awaiting.delete(runId);
  }

  /** Accumulate a call's sizes against its run. */
  add(runId: string, bytes: CallBytes): void {
    const existing = this.#byRun.get(runId);
    const merged: CallBytes = {
      requestPayloadBytes:
        (existing?.requestPayloadBytes ?? 0) + (bytes.requestPayloadBytes ?? 0),
      responseStreamBytes:
        (existing?.responseStreamBytes ?? 0) + (bytes.responseStreamBytes ?? 0),
    };
    this.#byRun.set(runId, merged);
    // A run whose llm_output never arrives must not leak. Map iteration is
    // insertion-ordered, so the first key is the oldest run.
    while (this.#byRun.size > this.maxRuns) {
      const oldest = this.#byRun.keys().next().value;
      if (oldest === undefined) break;
      this.#byRun.delete(oldest);
    }
  }

  /** Take and clear whatever has accumulated for a run. */
  take(runId: string): CallBytes | undefined {
    const bytes = this.#byRun.get(runId);
    if (bytes) this.#byRun.delete(runId);
    this.#awaiting.delete(runId);
    return bytes;
  }

  get size(): number {
    return this.#byRun.size;
  }
}
