/**
 * The only module in Belay that touches the filesystem.
 *
 * Cross-session totals have to survive a gateway restart -- otherwise a daily
 * cap resets every time the container bounces, and incident #4's hourly
 * heartbeat would never accumulate. But `session_end` gives *two seconds total*
 * across every session and handler on shutdown, so this writes incrementally in
 * the background and keeps a synchronous flush for the shutdown path.
 *
 * Failure policy: reads and writes never throw. A corrupt or unwritable state
 * file degrades to in-memory-only accounting plus a loud warning. Belay
 * mismetering is bad; Belay preventing the gateway from starting is worse.
 */
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, writeSync, fsyncSync } from "node:fs";
import { dirname } from "node:path";
import type { PersistedScope } from "./meter.ts";

export type StoreData = { version: 1; scopes: PersistedScope[] };

/**
 * Merge two views of the state, keeping the higher value for each counter.
 *
 * More than one process writes this file. A long-running gateway holds its own
 * in-memory meter, and every `openclaw agent` invocation is a separate process
 * that loads the plugin, meters its turn and flushes on exit. Without merging,
 * whichever wrote last simply overwrote the other -- observed in production as a
 * daily byte total going *backwards* from 756,060 to 648,114, which silently
 * un-spends money an agent had already spent.
 *
 * Daily totals only increase within a day, so taking the maximum converges both
 * writers upward and never invents spend. A newer calendar day always replaces
 * an older one. For the ladder, the most recent action wins, so an escalation
 * recorded by one process is not undone by another that never saw it.
 */
export function mergeState(a: StoreData | undefined, b: StoreData): StoreData {
  if (!a) return b;
  const byKey = new Map<string, PersistedScope>();
  for (const scope of a.scopes) if (scope?.key) byKey.set(scope.key, scope);

  for (const incoming of b.scopes) {
    if (!incoming?.key) continue;
    const existing = byKey.get(incoming.key);
    if (!existing) {
      byKey.set(incoming.key, incoming);
      continue;
    }
    byKey.set(incoming.key, {
      key: incoming.key,
      day: mergeDaily(existing.day, incoming.day),
      ...(existing.dayBytes || incoming.dayBytes
        ? { dayBytes: mergeDaily(existing.dayBytes, incoming.dayBytes) }
        : {}),
      ladder:
        (incoming.ladder?.lastActionAt ?? 0) >= (existing.ladder?.lastActionAt ?? 0)
          ? incoming.ladder
          : existing.ladder,
    });
  }
  return { version: 1, scopes: [...byKey.values()] };
}

function mergeDaily(
  a: { day: string; total: number } | undefined,
  b: { day: string; total: number } | undefined,
): { day: string; total: number } {
  const left = a ?? { day: "", total: 0 };
  const right = b ?? { day: "", total: 0 };
  // A later calendar day supersedes an earlier one rather than being maxed
  // against it, or yesterday's larger total would leak into today.
  if (left.day !== right.day) return left.day > right.day ? left : right;
  return { day: left.day, total: Math.max(left.total, right.total) };
}

export type StoreResult = { data: StoreData | undefined; error?: string };

const EMPTY: StoreData = { version: 1, scopes: [] };

/** Read persisted state. Returns `undefined` data when there is nothing usable. */
export function loadState(file: string): StoreResult {
  if (!file) return { data: undefined };
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // A missing file is the normal first-run case, not an error.
    if (code === "ENOENT") return { data: { ...EMPTY } };
    return { data: undefined, error: `cannot read ${file}: ${code ?? String(err)}` };
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (
      typeof parsed !== "object" || parsed === null ||
      (parsed as StoreData).version !== 1 ||
      !Array.isArray((parsed as StoreData).scopes)
    ) {
      return { data: { ...EMPTY }, error: `ignoring ${file}: unrecognised format` };
    }
    return { data: parsed as StoreData };
  } catch {
    // Truncated JSON from an unclean shutdown. Start fresh rather than crash.
    return { data: { ...EMPTY }, error: `ignoring ${file}: invalid JSON` };
  }
}

/**
 * Write state atomically: temp file, fsync, rename. The rename is what makes a
 * reader either see the old file or the new one, never a half-written one --
 * which matters because the process this protects against is a hard container kill.
 */
export function saveStateSync(file: string, data: StoreData): string | undefined {
  if (!file) return undefined;
  const tmp = `${file}.tmp`;
  try {
    mkdirSync(dirname(file), { recursive: true });
    // 0o600: this file records what an operator's agents cost. Not secret, but
    // not world-readable either.
    const fd = openSync(tmp, "w", 0o600);
    try {
      writeSync(fd, JSON.stringify(data));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, file);
    return undefined;
  } catch (err) {
    return `cannot write ${file}: ${(err as NodeJS.ErrnoException).code ?? String(err)}`;
  }
}

/**
 * Debounced writer.
 *
 * Persisting on every model call would put a synchronous write in the hot path
 * of every turn, against a < 10 ms overhead target. Persisting only on shutdown
 * would lose the day's spend to a `docker kill`. So: coalesce writes on a timer,
 * and flush synchronously when the gateway says it is going away.
 */
export class StateWriter {
  readonly file: string;
  readonly intervalMs: number;
  #timer: NodeJS.Timeout | undefined;
  #snapshot: (() => StoreData) | undefined;
  #onError: (message: string) => void;

  constructor(file: string, onError: (message: string) => void, intervalMs = 10_000) {
    this.file = file;
    this.intervalMs = intervalMs;
    this.#onError = onError;
  }

  /** `snapshot` is called at write time so we always persist current state. */
  start(snapshot: () => StoreData): void {
    if (!this.file) return;
    this.#snapshot = snapshot;
    this.#timer = setInterval(() => this.flush(), this.intervalMs);
    // Never hold the process open just to save cost counters.
    this.#timer.unref?.();
  }

  flush(): void {
    if (!this.file || !this.#snapshot) return;
    let data: StoreData;
    try {
      data = this.#snapshot();
    } catch (err) {
      this.#onError(`state snapshot failed: ${String(err)}`);
      return;
    }
    // Read-modify-write: another process may have advanced the file since our
    // last flush, and its progress must not be discarded.
    const merged = mergeState(loadState(this.file).data, data);
    const error = saveStateSync(this.file, merged);
    if (error) this.#onError(error);
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
    this.flush();
  }
}
