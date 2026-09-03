/**
 * The flight recorder: one line per decision, on local disk, forever yours.
 *
 * This is the answer to "how do I know it's working?" -- a guardrail that never
 * fires is indistinguishable from one that isn't installed, so the record of
 * what Belay saw and did is the only proof a user ever gets.
 *
 * It records **decisions, not content**: scope, rung, trigger, the number that
 * broke the rule and the limit it broke. There is no field for a prompt, a
 * reply, a tool parameter or a file path, and `write()` strips anything it does
 * not recognise rather than passing it through.
 *
 * Format is JSONL (one JSON object per line) because it survives truncation: a
 * hard container kill loses at most the final line, and every earlier line is
 * still readable. A single JSON array would be unparseable after the same event.
 */
import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { dirname } from "node:path";
import type { RungName, Trigger } from "./types.ts";

/** One recorded decision. Every field is a number, an id, or a fixed keyword. */
export type Record = {
  /** ISO timestamp, for grepping by eye. */
  t: string;
  /** Agent id or session key. */
  scope: string;
  rung: RungName;
  trigger: Trigger;
  /** The measured value that crossed the threshold. */
  observed: number;
  /** The configured threshold. */
  limit: number;
  /** Plain-English reason, built from numbers only. */
  reason: string;
  /** What Belay actually did about it. */
  action: "logged" | "blocked" | "ended" | "paused";
};

export type RecorderConfig = {
  /** Absolute path to the JSONL file. Empty disables recording. */
  file: string;
  /** Rotate to `<file>.1` past this size. One backup is kept. */
  maxBytes: number;
};

export const DEFAULT_RECORDER: RecorderConfig = { file: "", maxBytes: 5 * 1024 * 1024 };

export type Logger = { warn: (message: string) => void };

/**
 * Appends decisions to a JSONL file.
 *
 * Writes are synchronous and small (a few hundred bytes). That is a deliberate
 * trade: an async write could be lost on an abrupt shutdown, and losing the
 * record of the very incident that killed the gateway would defeat the purpose.
 */
export class Recorder {
  readonly config: RecorderConfig;
  #logger: Logger;
  #failed = false;

  constructor(config: RecorderConfig, logger: Logger) {
    this.config = config;
    this.#logger = logger;
  }

  get enabled(): boolean {
    return Boolean(this.config.file) && !this.#failed;
  }

  write(record: Record): void {
    if (!this.enabled) return;
    try {
      this.#rotateIfNeeded();
      mkdirSync(dirname(this.config.file), { recursive: true });
      // Rebuild the object field by field: nothing reaches disk that is not on
      // this list, whatever the caller passed in.
      const line = JSON.stringify({
        t: record.t,
        scope: record.scope,
        rung: record.rung,
        trigger: record.trigger,
        observed: record.observed,
        limit: record.limit,
        reason: record.reason,
        action: record.action,
      });
      appendFileSync(this.config.file, `${line}\n`, { mode: 0o600 });
    } catch (err) {
      // Report once, then go quiet. A full disk must not produce one warning per
      // model call on top of whatever else is already going wrong.
      this.#failed = true;
      this.#logger.warn(
        `[belay] flight recorder disabled: cannot write ${this.config.file}: ${String(err)}`,
      );
    }
  }

  #rotateIfNeeded(): void {
    try {
      const { size } = statSync(this.config.file);
      if (size < this.config.maxBytes) return;
      // One backup only. This is a diagnostic trail, not an archive, and an
      // unbounded log on someone's VM would be a bug we shipped.
      renameSync(this.config.file, `${this.config.file}.1`);
    } catch {
      // Missing file is the normal first-write case.
    }
  }
}

/** Turn a decision into a record. Kept separate so it can be tested purely. */
export function toRecord(
  at: number,
  scope: string,
  rung: RungName,
  trigger: Trigger,
  observed: number,
  limit: number,
  reason: string,
): Record {
  const action: Record["action"] =
    rung === "pause" ? "paused" : rung === "endRun" ? "ended" : rung === "blockTool" ? "blocked" : "logged";
  return {
    t: new Date(at).toISOString(),
    scope,
    rung,
    trigger,
    observed,
    limit,
    reason,
    action,
  };
}

/**
 * Parse a JSONL trail back into records, skipping anything unreadable.
 *
 * Lenient by design: the last line of a file killed mid-write is expected to be
 * truncated, and one bad line must never prevent reading the rest.
 */
export function parseTrail(contents: string): Record[] {
  const out: Record[] = [];
  for (const line of contents.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as Record;
      if (typeof parsed?.t === "string" && typeof parsed.scope === "string") out.push(parsed);
    } catch {
      continue;
    }
  }
  return out;
}
