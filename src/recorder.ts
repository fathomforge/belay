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
  /**
   * What Belay actually did about it, at the hook that wrote this record.
   *
   * `escalated` is the important one: the ladder reached a blocking rung during
   * a *notification* hook, which cannot stop anything. Enforcement follows at
   * the next applicable gate. Recording that as "ended" would claim an
   * enforcement event that had not happened.
   */
  action: "logged" | "escalated" | "blocked" | "ended" | "paused";
  /**
   * Record schema version. Absent on records written by <= 0.4.0, whose
   * `action` was derived from the rung alone and so may claim enforcement that
   * never occurred. Readers should treat an unversioned `blocked`/`ended` as
   * unverified rather than as evidence.
   */
  v?: number;
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
      const stat = statSync(this.config.file);
      // Only ever rotate a regular file. A directory reports a size of its own
      // (4096 on Linux, ~96 on macOS), so without this check a misconfigured
      // path pointing at a directory would be *renamed* out of the way and then
      // written over. Caught by CI, where the platform difference made it fire.
      if (!stat.isFile()) return;
      if (stat.size < this.config.maxBytes) return;
      // One backup only. This is a diagnostic trail, not an archive, and an
      // unbounded log on someone's VM would be a bug we shipped.
      renameSync(this.config.file, `${this.config.file}.1`);
    } catch {
      // Missing file is the normal first-write case.
    }
  }
}

/** Turn a decision into a record. Kept separate so it can be tested purely. */
/**
 * What the hook that is writing this record actually did.
 *
 * Deriving this from the rung alone was wrong, and wrong in the direction that
 * matters: `model_call` is a notification hook that returns nothing, so a model
 * storm reaching `endRun` there recorded `action: "ended"` while no run had
 * been ended by anyone. The CLI then presented that as evidence of enforcement.
 *
 * So the surface decides, matching exactly what each gate does with a rung:
 *   agent_run  refuses only endRun/pause; blockTool passes through
 *   tool_call  refuses anything above warn
 *   model_call refuses nothing -- it can only escalate
 */
function actionFor(surface: RecordSurface, rung: RungName): Record["action"] {
  if (rung === "none" || rung === "warn") return "logged";
  switch (surface) {
    case "agent_run":
      return rung === "endRun" || rung === "pause" ? "ended" : "logged";
    case "tool_call":
      return "blocked";
    default:
      return "escalated";
  }
}

/** Which hook is writing the record. Mirrors the enforcer's `Surface`. */
export type RecordSurface = "agent_run" | "tool_call" | "model_call";

export function toRecord(
  at: number,
  scope: string,
  rung: RungName,
  trigger: Trigger,
  observed: number,
  limit: number,
  reason: string,
  surface: RecordSurface,
): Record {
  // A blocking rung records "ended", never "paused": whether the account also
  // stopped is not known until the gateway answers, and a trail that claims a
  // pause which failed is the same lie the alerts used to tell. A successful
  // pause is written as its own record.
  return {
    t: new Date(at).toISOString(),
    scope,
    rung,
    trigger,
    observed,
    limit,
    reason,
    action: actionFor(surface, rung),
    v: 2,
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
