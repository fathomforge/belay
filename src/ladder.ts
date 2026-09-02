/**
 * The pause ladder: warn -> block tool -> end run -> pause account.
 *
 * This is the piece that distinguishes Belay from a kill switch. A breach does
 * not stop an agent dead; it moves the agent one rung up a ladder, and quiet
 * time moves it back down. Two properties matter operationally:
 *
 *  - Deduplication. Incident #2 fired 300 identical failures; the operator wants
 *    one alert, not 300. A rung that is already standing does not re-fire inside
 *    its cooldown.
 *  - Stickiness at the top. Pausing an account is the one rung with real-world
 *    side effects (and, per the infra notes, an ingress spool that drains as a
 *    burst on restart), so it never decays on its own -- a human resumes it.
 */
import { RUNG, RUNG_NAMES } from "./types.ts";
import type { RungLevel, RungName, Trigger } from "./types.ts";

export type LadderConfig = {
  /** Suppress a repeat action at the same rung for this long. */
  cooldownMs: number;
  /** Quiet time that earns back one rung. */
  decayMs: number;
  /** Highest rung this ladder may reach. Lets an operator opt out of auto-pause. */
  maxRung: RungName;
  /** Minimum gap before repeating an identical (trigger, rung) alert. */
  renotifyMs: number;
};

export const DEFAULT_LADDER: LadderConfig = {
  cooldownMs: 60_000,
  decayMs: 15 * 60_000,
  maxRung: "pause",
  renotifyMs: 6 * 3_600_000,
};

export type LadderStep = {
  rung: RungName;
  /** True when the caller should act and alert; false when deduplicated. */
  isNew: boolean;
  /** True when this step moved up from the previous rung. */
  escalated: boolean;
  trigger: Trigger;
  at: number;
};

export type LadderSnapshot = {
  rung: RungName;
  lastTriggerAt: number;
  lastActionAt: number;
};

function rungName(level: number): RungName {
  const clamped = Math.max(RUNG.none, Math.min(RUNG.pause, level)) as RungLevel;
  const name = RUNG_NAMES.find((n) => RUNG[n] === clamped);
  // RUNG_NAMES covers every level, so this is unreachable; typed for strictness.
  return name ?? "none";
}

/**
 * One ladder per enforcement scope (typically per agent, or per agent+session).
 * Pure and serializable: no timers, no I/O, clock always injected.
 */
export class Ladder {
  readonly config: LadderConfig;
  #rung: RungLevel = RUNG.none;
  #lastTriggerAt = 0;
  #lastActionAt = 0;
  /** (trigger:rung) -> when we last actioned it. Bounded by the trigger list. */
  #acted = new Map<string, number>();

  constructor(config: Partial<LadderConfig> = {}) {
    this.config = { ...DEFAULT_LADDER, ...config };
  }

  get rung(): RungName {
    return rungName(this.#rung);
  }

  /** Current rung after applying any decay earned by quiet time since `now`. */
  rungAt(now: number): RungName {
    return rungName(this.#decayed(now));
  }

  /**
   * Record a breach that deserves at least `requested`.
   *
   * A breach never lands below the rung already standing. Repeating the same
   * breach after the cooldown climbs one more rung -- that is what makes this a
   * ladder rather than a threshold.
   */
  record(now: number, requested: RungName, trigger: Trigger): LadderStep {
    const ceiling = RUNG[this.config.maxRung];
    const current = this.#decayed(now);
    const asked = RUNG[requested];

    let next: number;
    if (asked > current) {
      next = asked;
    } else if (now - this.#lastActionAt >= this.config.cooldownMs && current > RUNG.none) {
      // Same breach still happening after a full cooldown: climb one rung.
      next = current + 1;
    } else {
      next = current;
    }
    // Clamp *before* deciding whether this escalated. A climb that the ceiling
    // refuses is not an escalation, and treating it as one re-alerts forever at
    // the top rung.
    next = Math.min(next, ceiling);
    const escalated = next > current;

    // At the ceiling with nowhere to escalate, a repeat carries no new
    // instruction: the account is already stopped. This is separate from the
    // renotify rule below because it holds even for a *different* trigger.
    const atCeiling = !escalated && next >= ceiling;
    let isNew = escalated || (!atCeiling && now - this.#lastActionAt >= this.config.cooldownMs);

    // Same problem, same severity -> say it once per `renotifyMs`, regardless of
    // what the rung did in between.
    //
    // Without this, a *latched* breach re-alerts forever: "over the daily cap"
    // stays true for the rest of the day, and because decay is measured from the
    // last breach, an hourly cron drops the ladder back to `none` between
    // occurrences and every hour looks like a brand new incident. Rate breaches
    // are transient and genuinely do recur; cumulative ones do not.
    const key = `${trigger}:${rungName(next)}`;
    if (isNew) {
      const last = this.#acted.get(key);
      if (last !== undefined && now - last < this.config.renotifyMs) isNew = false;
      else this.#acted.set(key, now);
    }
    this.#rung = Math.max(RUNG.none, next) as RungLevel;
    this.#lastTriggerAt = now;
    if (isNew) this.#lastActionAt = now;

    return { rung: rungName(this.#rung), isNew, escalated, trigger, at: now };
  }

  /** Operator resume. The only way down from `pause`. */
  resume(now: number): void {
    this.#rung = RUNG.none;
    this.#lastTriggerAt = now;
    this.#lastActionAt = 0;
    // An operator who resumes wants to hear about it if it happens again.
    this.#acted.clear();
  }

  #decayed(now: number): RungLevel {
    if (this.#rung === RUNG.none) return RUNG.none;
    // Pause is sticky by design: an account stays stopped until a human says otherwise.
    if (this.#rung >= RUNG.pause) return RUNG.pause;
    const quiet = now - this.#lastTriggerAt;
    if (quiet < this.config.decayMs) return this.#rung;
    const steps = Math.floor(quiet / this.config.decayMs);
    const level = Math.max(RUNG.none, this.#rung - steps) as RungLevel;
    this.#rung = level;
    // Consume the quiet time we just spent. Without this, decay is re-measured
    // from the original trigger on every read, so merely *asking* for the rung
    // twice would walk an agent down the ladder faster than time did.
    this.#lastTriggerAt += steps * this.config.decayMs;
    return level;
  }

  toJSON(): LadderSnapshot {
    return {
      rung: rungName(this.#rung),
      lastTriggerAt: this.#lastTriggerAt,
      lastActionAt: this.#lastActionAt,
    };
  }

  static fromJSON(snapshot: LadderSnapshot, config: Partial<LadderConfig> = {}): Ladder {
    const l = new Ladder(config);
    l.#rung = RUNG[snapshot.rung];
    l.#lastTriggerAt = snapshot.lastTriggerAt;
    l.#lastActionAt = snapshot.lastActionAt;
    return l;
  }
}
