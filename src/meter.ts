/**
 * The meter: what has this agent spent and how fast is it moving.
 *
 * One `ScopeState` per enforcement scope (an agent, falling back to a session
 * key when `agentId` is absent -- the SDK marks it optional). All accounting is
 * in memory and serializable; `store.ts` decides what survives a restart.
 *
 * Two deliberate omissions: no tool names or parameters are kept (callers pass a
 * pre-computed fingerprint), and no prompt or output text exists anywhere in
 * these structures. The recorder stores decisions, not content.
 */
import { DailyTotal, SlidingWindow } from "./windows.ts";
import { Ladder } from "./ladder.ts";
import type { LadderConfig } from "./ladder.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** Per-run accounting. Runs are bounded so a long-lived gateway cannot leak. */
type RunState = {
  usd: number;
  tokens: number;
  /** Request payload bytes, measured exactly. See docs/CALIBRATION.md. */
  bytes: number;
  /** fingerprint -> repeat count, for the identical-call limit. */
  identical: Map<string, number>;
  lastSeen: number;
};

const MAX_TRACKED_RUNS = 200;

/**
 * Ceiling on distinct enforcement scopes held in memory (and persisted).
 * Generous: a gateway has a handful of agents, and this only bites when the
 * scope key degrades to a per-message session key.
 */
const MAX_TRACKED_SCOPES = 2_000;

export type MeterSnapshot = {
  runUsd: number;
  runTokens: number;
  /**
   * Request bytes, measured rather than estimated.
   *
   * Byte counts come straight from `model_call_ended` and were verified against
   * real traffic to about 1%, where a dollar figure derived from them carries
   * roughly +-50% (docs/CALIBRATION.md). Anything that can be expressed as a
   * byte limit is therefore enforced far more precisely than as a spend cap.
   */
  runBytes: number;
  bytesPerMinute: number;
  dayBytes: number;
  hourUsd: number;
  dayUsd: number;
  modelCallsPerMinute: number;
  toolCallsPerMinute: number;
  toolErrorsPerMinute: number;
  /** Highest repeat count for any single identical call in this run. */
  maxIdenticalCalls: number;
  /** Calls we could not price. A non-zero value means the spend caps are partial. */
  unpricedCalls: number;
  /** Calls that reported no usage at all -- see `recordMissingUsage`. */
  unmeteredCalls: number;
  /** Calls whose cost was estimated from request size rather than measured. */
  estimatedCalls: number;
};

export class ScopeState {
  readonly key: string;
  readonly ladder: Ladder;
  #hourUsd = new SlidingWindow(HOUR);
  #dayUsd: DailyTotal;
  #modelCalls = new SlidingWindow(MINUTE);
  #bytesPerMinute = new SlidingWindow(MINUTE);
  #dayBytes: DailyTotal;
  #toolCalls = new SlidingWindow(MINUTE);
  #toolErrors = new SlidingWindow(MINUTE);
  #runs = new Map<string, RunState>();
  #unpriced = 0;
  #unmetered = 0;
  #estimated = 0;

  constructor(key: string, timeZone: string, ladder?: LadderConfig, restored?: PersistedScope) {
    this.key = key;
    this.#dayUsd = restored
      ? DailyTotal.fromJSON(timeZone, restored.day)
      : new DailyTotal(timeZone);
    this.#dayBytes = restored?.dayBytes
      ? DailyTotal.fromJSON(timeZone, restored.dayBytes)
      : new DailyTotal(timeZone);
    // A rung must survive a restart, or an agent could be walked back to "none"
    // simply by bouncing the gateway -- which is exactly what an operator does
    // when an agent is misbehaving.
    this.ladder = restored ? Ladder.fromJSON(restored.ladder, ladder) : new Ladder(ladder);
  }

  #run(runId: string, now: number): RunState {
    let run = this.#runs.get(runId);
    if (!run) {
      run = { usd: 0, tokens: 0, bytes: 0, identical: new Map(), lastSeen: now };
      this.#runs.set(runId, run);
      // Map iteration is insertion-ordered, so the first key is the oldest run.
      // Runs normally end via `endRun`; this only catches ones whose end we missed.
      while (this.#runs.size > MAX_TRACKED_RUNS) {
        const oldest = this.#runs.keys().next().value;
        if (oldest === undefined) break;
        this.#runs.delete(oldest);
      }
    }
    run.lastSeen = now;
    return run;
  }

  /**
   * Record a completed model call.
   *
   * `priceable: false` increments `unpricedCalls` instead of adding $0. The
   * difference is the whole point: an unpriced call is unknown, not free.
   */
  recordUsage(
    now: number,
    runId: string,
    reading: { usd: number; tokens: number; priceable: boolean; estimated?: boolean },
  ): void {
    if (reading.estimated) this.#estimated += 1;
    const run = this.#run(runId, now);
    run.tokens += reading.tokens;
    if (reading.priceable) {
      run.usd += reading.usd;
      this.#hourUsd.add(now, reading.usd);
      this.#dayUsd.add(now, reading.usd);
    } else {
      this.#unpriced += 1;
    }
  }

  /**
   * A model call that reported no usage object at all.
   *
   * Tracked separately from `unpriced` because it is a worse failure: an
   * unpriced call at least contributes tokens, while this one is completely
   * invisible to every spend cap. Found on a live gateway, where the first turn
   * metered $0.00 in total silence.
   */
  recordMissingUsage(): void {
    this.#unmetered += 1;
  }

  /**
   * Record the exact size of a model request. Independent of usage reporting,
   * so this works identically on every provider.
   */
  recordRequestBytes(now: number, runId: string, bytes: number): void {
    if (!Number.isFinite(bytes) || bytes <= 0) return;
    this.#run(runId, now).bytes += bytes;
    this.#bytesPerMinute.add(now, bytes);
    this.#dayBytes.add(now, bytes);
  }

  recordModelCall(now: number): void {
    this.#modelCalls.add(now);
  }

  /** `fingerprint` is a hash of tool name + params, never the params themselves. */
  recordToolCall(now: number, runId: string, fingerprint: string): void {
    this.#toolCalls.add(now);
    const run = this.#run(runId, now);
    const seen = (run.identical.get(fingerprint) ?? 0) + 1;
    run.identical.set(fingerprint, seen);
    // A run that legitimately touches thousands of distinct files should not
    // grow this map without bound; the limit only cares about repeats.
    if (run.identical.size > 5_000) {
      const oldest = run.identical.keys().next().value;
      if (oldest !== undefined) run.identical.delete(oldest);
    }
  }

  recordToolError(now: number): void {
    this.#toolErrors.add(now);
  }

  snapshot(now: number, runId?: string): MeterSnapshot {
    const run = runId ? this.#runs.get(runId) : undefined;
    let maxIdentical = 0;
    if (run) for (const n of run.identical.values()) if (n > maxIdentical) maxIdentical = n;
    return {
      runUsd: run?.usd ?? 0,
      runTokens: run?.tokens ?? 0,
      runBytes: run?.bytes ?? 0,
      bytesPerMinute: this.#bytesPerMinute.sum(now),
      dayBytes: this.#dayBytes.total(now),
      hourUsd: this.#hourUsd.sum(now),
      dayUsd: this.#dayUsd.total(now),
      modelCallsPerMinute: this.#modelCalls.count(now),
      toolCallsPerMinute: this.#toolCalls.count(now),
      toolErrorsPerMinute: this.#toolErrors.count(now),
      maxIdenticalCalls: maxIdentical,
      unpricedCalls: this.#unpriced,
      unmeteredCalls: this.#unmetered,
      estimatedCalls: this.#estimated,
    };
  }

  endRun(runId: string): void {
    this.#runs.delete(runId);
  }

  /** Only cross-session facts are persisted: the day's spend and the ladder rung. */
  toJSON(): PersistedScope {
    return {
      key: this.key,
      day: this.#dayUsd.toJSON(),
      dayBytes: this.#dayBytes.toJSON(),
      ladder: this.ladder.toJSON(),
    };
  }

  static fromJSON(data: PersistedScope, timeZone: string, ladder?: LadderConfig): ScopeState {
    return new ScopeState(data.key, timeZone, ladder, data);
  }
}

/**
 * Recover an agent id from a session key such as `agent:main:main`.
 *
 * Returns undefined for any shape we do not recognise, so an unexpected format
 * degrades to session-key scoping rather than to a confidently wrong bucket.
 */
export function agentIdFromSessionKey(sessionKey: string | undefined): string | undefined {
  if (!sessionKey) return undefined;
  const match = /^agent:([^:]+):/.exec(sessionKey);
  return ident(match?.[1]);
}

/**
 * An identifier we are willing to key accounting on.
 *
 * `??` only rejects null and undefined, so an `agentId` of `""` -- which a hook
 * context really can carry -- used to sail through as a scope key of its own.
 * That is the two-buckets-for-one-agent bug again: the hooks that supplied `""`
 * metered into one scope and the hooks that supplied only a session key metered
 * into another, and neither half ever reached the cap.
 */
export function ident(value: string | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

export type PersistedScope = {
  key: string;
  day: { day: string; total: number };
  dayBytes?: { day: string; total: number };
  ladder: ReturnType<Ladder["toJSON"]>;
};

/** All scopes on this gateway. */
export class Meter {
  readonly timeZone: string;
  readonly #ladder: LadderConfig | undefined;
  #scopes = new Map<string, ScopeState>();

  constructor(timeZone: string, ladder?: LadderConfig) {
    this.timeZone = timeZone;
    this.#ladder = ladder;
  }

  /**
   * `agentId` is optional in the SDK's hook context, so a fallback is required.
   *
   * The naive fallback -- use the session key -- turned out to be wrong on a
   * live gateway: some hooks supply `agentId` ("main") and others only supply
   * `sessionKey` ("agent:main:main"), so a single agent was metered under two
   * separate keys and each saw roughly half its own spend. Session keys for
   * agent runs embed the agent id, so recover it rather than starting a second
   * bucket. Anything unrecognised still falls back to the raw session key.
   */
  scope(agentId: string | undefined, sessionKey?: string): ScopeState {
    const key =
      ident(agentId) ?? agentIdFromSessionKey(sessionKey) ?? ident(sessionKey) ?? "unknown";
    const existing = this.#scopes.get(key);
    if (existing) {
      // Re-insert so Map iteration order is least-recently-used first. A real
      // agent is touched constantly and therefore never evicted below.
      this.#scopes.delete(key);
      this.#scopes.set(key, existing);
      return existing;
    }
    const s = new ScopeState(key, this.timeZone, this.#ladder);
    this.#scopes.set(key, s);
    // Scopes are normally one per agent, so this bound is never reached in
    // practice. It exists because the fallback key is a session key: a gateway
    // that mints a fresh session per inbound message, with no agent id on the
    // hook context, would otherwise grow this map -- and the state file it is
    // serialized into -- without limit for as long as the process lives.
    while (this.#scopes.size > MAX_TRACKED_SCOPES) {
      const oldest = this.#scopes.keys().next().value;
      if (oldest === undefined || oldest === key) break;
      this.#scopes.delete(oldest);
    }
    return s;
  }

  scopes(): ScopeState[] {
    return [...this.#scopes.values()];
  }

  toJSON(): PersistedScope[] {
    return this.scopes().map((s) => s.toJSON());
  }

  /**
   * Restore persisted scopes. Never throws.
   *
   * This runs during plugin registration, before the hooks are wired up, so an
   * exception here does not merely lose the day's totals -- it aborts
   * registration and leaves the gateway with no guardrail at all, while the
   * plugin still reports itself as loaded. The state file is shared with other
   * processes and can be truncated or hand-edited, so every field is treated as
   * untrusted and a scope that cannot be understood is skipped, not fatal.
   */
  load(data: PersistedScope[]): void {
    if (!Array.isArray(data)) return;
    for (const entry of data) {
      const key = ident((entry as PersistedScope | undefined)?.key);
      if (key === undefined) continue;
      this.#scopes.set(key, ScopeState.fromJSON({ ...entry, key }, this.timeZone, this.#ladder));
    }
  }
}
