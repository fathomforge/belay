/**
 * Sliding-window counters -- the primitive under every rate and spend limit.
 *
 * Design constraints that shaped this:
 *  - The clock is always passed in, never read. Deterministic tests, and no
 *    surprise when the container's TZ disagrees with the configured one.
 *  - Bounded memory. Incident #1 produced 148 events from a single message and
 *    incident #2 produced 700 model calls for one photo; a naive array that
 *    grows with traffic would turn the guardrail into its own incident.
 *  - No I/O. Persistence is `store.ts`'s job alone.
 */

type Sample = { at: number; value: number };

/**
 * A time-ordered window that answers "how much in the last N ms".
 *
 * Samples are kept in a plain array used as a FIFO queue and trimmed from the
 * front on every read or write, so the array length is bounded by the number of
 * events that actually fit in the window -- not by uptime.
 */
export class SlidingWindow {
  readonly windowMs: number;
  /** Hard ceiling on retained samples; protects against a storm inside one window. */
  readonly maxSamples: number;
  #samples: Sample[] = [];
  #sum = 0;
  /** Count of samples dropped by `maxSamples`, so callers can report degraded accuracy. */
  #dropped = 0;

  constructor(windowMs: number, maxSamples = 10_000) {
    if (!Number.isFinite(windowMs) || windowMs <= 0) {
      throw new RangeError(`windowMs must be a positive number, got ${windowMs}`);
    }
    if (!Number.isInteger(maxSamples) || maxSamples <= 0) {
      throw new RangeError(`maxSamples must be a positive integer, got ${maxSamples}`);
    }
    this.windowMs = windowMs;
    this.maxSamples = maxSamples;
  }

  /** Record a value at time `at` (ms since epoch). `value` defaults to 1 for counting. */
  add(at: number, value = 1): void {
    this.#trim(at);
    this.#samples.push({ at, value });
    this.#sum += value;
    if (this.#samples.length > this.maxSamples) {
      // Drop oldest. Under a storm this makes the window slightly *under*-report,
      // but by then every threshold is long since crossed, so no cap is missed.
      const oldest = this.#samples.shift();
      if (oldest) {
        this.#sum -= oldest.value;
        this.#dropped += 1;
      }
    }
  }

  /** Sum of values still inside the window as of `now`. */
  sum(now: number): number {
    this.#trim(now);
    // Guard against float drift accumulating over millions of add/expire cycles.
    return this.#sum < 0 ? 0 : this.#sum;
  }

  /** Number of samples still inside the window as of `now`. */
  count(now: number): number {
    this.#trim(now);
    return this.#samples.length;
  }

  get dropped(): number {
    return this.#dropped;
  }

  /** Oldest retained timestamp, or undefined when empty. Used for "resets in" messages. */
  oldest(now: number): number | undefined {
    this.#trim(now);
    return this.#samples[0]?.at;
  }

  #trim(now: number): void {
    const cutoff = now - this.windowMs;
    let i = 0;
    while (i < this.#samples.length) {
      const s = this.#samples[i];
      // `>=` keeps a sample that is exactly `windowMs` old: "150 calls in 60s"
      // must count all 150, or a limit of 150/min could never actually trip.
      if (s === undefined || s.at >= cutoff) break;
      this.#sum -= s.value;
      i += 1;
    }
    if (i > 0) this.#samples.splice(0, i);
    if (this.#samples.length === 0) this.#sum = 0;
  }
}

/**
 * Calendar-day accumulator in a fixed IANA timezone.
 *
 * A rolling 24h window is harder to game, but incident #4's mental model -- and
 * the daily session reset at 4am PT -- is a calendar day, and an operator who
 * sets "$2/day" means the day they live in. The timezone comes from config, not
 * from the process: incident #5 was a container running UTC while the operator
 * was on Pacific, and reading `process.env.TZ` would rebuild that bug here.
 */
export class DailyTotal {
  readonly timeZone: string;
  #day = "";
  #total = 0;
  #formatter: Intl.DateTimeFormat;

  constructor(timeZone: string) {
    this.timeZone = timeZone;
    // Throws on an invalid zone at construction rather than at the first cap check.
    this.#formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
  }

  /** The local calendar date at `at`, as `YYYY-MM-DD`. */
  dayKey(at: number): string {
    return this.#formatter.format(new Date(at));
  }

  add(at: number, value: number): void {
    this.#roll(at);
    this.#total += value;
  }

  total(now: number): number {
    this.#roll(now);
    return this.#total;
  }

  #roll(at: number): void {
    const key = this.dayKey(at);
    if (key !== this.#day) {
      this.#day = key;
      this.#total = 0;
    }
  }

  /** Serializable form, so `store.ts` can persist cross-session daily spend. */
  toJSON(): { day: string; total: number } {
    return { day: this.#day, total: this.#total };
  }

  static fromJSON(timeZone: string, data: { day: string; total: number }): DailyTotal {
    const d = new DailyTotal(timeZone);
    d.#day = data.day;
    d.#total = data.total;
    return d;
  }
}
