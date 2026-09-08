#!/usr/bin/env node
/**
 * `belay status` and `belay incidents` -- the proof-of-value surface.
 *
 * A guardrail that never fires looks exactly like one that isn't installed.
 * These two commands are the only thing that shows an operator what Belay saw
 * and did, which makes them load-bearing for adoption, not a nicety.
 *
 * Deliberately a standalone script rather than a plugin-registered CLI command:
 * it reads the same two files the plugin writes, so it works when the gateway is
 * down -- which is exactly when someone most wants to know what happened. It
 * also avoids depending on the SDK's CLI registration surface, whose signature
 * has not been verified against a live gateway.
 *
 * Reads only. Never contacts the network, never touches gateway config.
 *
 * The central rule here: **never report health that was not actually observed.**
 * An unconfigured path, a missing file and a file that was read and found empty
 * are three different facts, and only the last one is evidence of a quiet day.
 * Collapsing them into "no incidents" tells an operator whose recorder was never
 * configured that everything is fine -- the exact failure this project exists to
 * prevent, committed by its own reporting tool.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { argv, exit, stdout } from "node:process";

const USAGE = `belay - read the local Belay flight recorder

Usage:
  belay status    [--state <file>] [--trail <file>] [--json]
  belay incidents [--trail <file>] [--hours N] [--agent <id>] [--json]
  belay reset     [--state <file>] [--agent <id>]   clear a stuck ladder rung

Both files are the paths set in openclaw.json under
plugins.entries.belay.config.stateFile and .recorder.file
(or via BELAY_STATE_FILE / BELAY_TRAIL_FILE).

Exit codes:
  0  the files were read; the report reflects what they contained
  2  nothing could be read (unconfigured, missing or unreadable), so the
     absence of incidents is NOT evidence that none occurred
  1  usage error

Reads local files only. No network, no gateway access.`;

function parseArgs(args) {
  const out = { _: [], hours: 24, json: false };
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === "--json") out.json = true;
    else if (a === "--state") out.state = args[++i];
    else if (a === "--trail") out.trail = args[++i];
    else if (a === "--agent") out.agent = args[++i];
    else if (a === "--hours") out.hours = Number(args[++i]);
    else if (a === "-h" || a === "--help") out.help = true;
    else out._.push(a);
  }
  return out;
}

/**
 * Read the trail, reporting *where the answer came from*.
 *
 * `source` is one of:
 *   unconfigured - no path was given at all
 *   missing      - a path was given, nothing is there
 *   unreadable   - a path was given and reading it failed
 *   ok           - the file was read; `records` is what it held
 *
 * Only `ok` licenses any statement about whether incidents occurred.
 */
function readTrail(file) {
  if (!file) return { source: "unconfigured", records: [] };
  let raw;
  try {
    raw = readFileSync(file, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return { source: "missing", path: file, records: [] };
    return { source: "unreadable", path: file, records: [], error: err.message };
  }
  const records = [];
  let skipped = 0;
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed);
      // A record whose timestamp cannot be parsed would silently vanish from
      // every time-windowed view, which looks identical to "nothing happened".
      // Count it as damage rather than dropping it quietly.
      if (parsed && typeof parsed.t === "string" && Number.isFinite(Date.parse(parsed.t))) {
        records.push(parsed);
      } else {
        skipped += 1;
      }
    } catch {
      // A file killed mid-write ends in a partial line. Skip it, keep the rest.
      skipped += 1;
    }
  }
  // Lines were present and none survived: this is a damaged trail, not a quiet
  // one, and reporting "no incidents" from it would be a guess dressed as a fact.
  if (records.length === 0 && skipped > 0) {
    return { source: "unreadable", path: file, records, skipped, error: `${skipped} unreadable record(s), none usable` };
  }
  return { source: "ok", path: file, records, skipped };
}

/** Same contract as readTrail: say where the answer came from. */
function readState(file) {
  if (!file) return { source: "unconfigured" };
  let raw;
  try {
    raw = readFileSync(file, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return { source: "missing", path: file };
    return { source: "unreadable", path: file, error: err.message };
  }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || parsed.version !== 1) {
      return { source: "unreadable", path: file, error: "unrecognised state file format" };
    }
    return { source: "ok", path: file, state: parsed };
  } catch (err) {
    return { source: "unreadable", path: file, error: err.message };
  }
}

/** Lines explaining why there is no evidence, and what to do about it. */
function explainMissing(res, what, configKey, flag, envVar) {
  switch (res.source) {
    case "unconfigured":
      return [
        `  No ${what} configured, so nothing could be read.`,
        `  This is not the same as "nothing happened".`,
        `  Set ${configKey} in openclaw.json, or pass ${flag} / ${envVar}.`,
      ];
    case "missing":
      return [
        `  No ${what} at ${res.path}, so nothing could be read.`,
        `  This is not the same as "nothing happened": Belay may not have`,
        `  written one yet, or the path may be wrong.`,
      ];
    default:
      return [
        `  Could not read the ${what} at ${res.path}: ${res.error}`,
        `  This is not the same as "nothing happened".`,
      ];
  }
}

/** What each completed action did. Keyed by action, never by rung. */
const ACTION_LABEL = {
  blocked: "blocked a tool",
  ended: "ended a run",
  paused: "PAUSED an account",
};

/** How a rung reads when describing something hypothetical. */
const RUNG_LABEL = {
  none: "ok",
  warn: "warned",
  blockTool: "blocked a tool",
  endRun: "ended a run",
  pause: "PAUSED",
};

function money(n) {
  return `$${(Math.round(n * 10000) / 10000).toFixed(4).replace(/0+$/, "").replace(/\.$/, "")}`;
}

/** Matches the enforcer's formatting, so a report reads like the alert did. */
function BYTES(n) {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)} GB`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)} MB`;
  if (n >= 1_000) return `${Math.round(n / 1_000)} kB`;
  return `${Math.round(n)} B`;
}

/**
 * Find a trail record that actually corroborates a scope's *current* rung.
 *
 * Matching on scope alone is not enough. A `blockTool` record from two days ago
 * would otherwise license the label "ended a run" for a rung the agent reached
 * later in observe mode -- inventing an enforcement event out of an unrelated
 * older one. The record must be for the same rung, and no older than the ladder
 * action it claims to evidence (with a little slack, because the state file and
 * the trail are written by separate paths).
 *
 * Returns the corroborating record's `action`, or undefined when nothing in the
 * trail supports the stored rung.
 */
function corroboration(trail, scope) {
  const rung = scope.ladder?.rung ?? "none";
  if (rung === "none") return undefined;
  const since = (scope.ladder?.lastActionAt ?? 0) - 5000;
  let best;
  for (const r of trail) {
    if (r.scope !== scope.key || r.rung !== rung) continue;
    if (Date.parse(r.t) < since) continue;
    best = r;
  }
  return best;
}

/**
 * How one record reads, from what the writing hook actually did.
 *
 * Rendering the *rung* here was the same false-enforcement claim status used to
 * make: an `escalated` record from a model-call notification printed
 * "ended a run" although no gate had been called.
 */
function describeAction(r) {
  switch (r.action) {
    case "escalated":
      return `escalated to ${r.rung}`;
    case "logged":
      // Hypothetical, so the rung is the right thing to name.
      return `would have ${RUNG_LABEL[r.rung] ?? r.rung}`;
    case "blocked":
    case "ended":
    case "paused": {
      // Name what was *done*, not the rung. A tool gate refusing a call while
      // the ladder sits at endRun blocked a tool; it did not end a run.
      const label = ACTION_LABEL[r.action];
      return (r.v ?? 0) >= 2 ? label : `${label} (unverified)`;
    }
    default:
      return String(r.action ?? "recorded");
  }
}

/** Actions that mean a gate actually refused something. */
const ENFORCED = new Set(["blocked", "ended", "paused"]);

/**
 * Did a gate actually enforce, on the evidence available?
 *
 * Records written before schema v2 derived their action from the ladder rung
 * alone, so an "ended" among them may describe a rung reached during a
 * notification hook that stopped nothing. Those cannot settle the question and
 * are reported as unverified rather than believed.
 */
function enforcementProven(record) {
  if (!record || !ENFORCED.has(record.action)) return false;
  return (record.v ?? 0) >= 2;
}

function status(opts) {
  const stateRes = readState(opts.state);
  const trailRes = readTrail(opts.trail);
  const trail = trailRes.records;

  if (opts.json) {
    // Exact figures, for a before/after comparison the human table cannot
    // support: the display rounds to kB/MB/GB, so a real increase can be
    // invisible on a large total.
    const dayAgo = Date.now() - 24 * 3600_000;
    stdout.write(
      `${JSON.stringify(
        {
          state: { source: stateRes.source, path: stateRes.path, error: stateRes.error },
          trail: {
            source: trailRes.source,
            path: trailRes.path,
            error: trailRes.error,
            complete: (trailRes.skipped ?? 0) === 0,
            skipped: trailRes.skipped ?? 0,
          },
          scopes: (stateRes.state?.scopes ?? []).map((s) => ({
            agent: s.key,
            day: s.day?.day,
            spendUsd: s.day?.total ?? 0,
            requestBytes: s.dayBytes?.total ?? 0,
            ladderRung: s.ladder?.rung ?? "none",
            actionVerified: enforcementProven(corroboration(trail, s)),
          })),
          decisionsLast24h:
            trailRes.source === "ok" ? trail.filter((r) => Date.parse(r.t) >= dayAgo).length : null,
        },
        null,
        2,
      )}\n`,
    );
    if (stateRes.source !== "ok" || trailRes.source !== "ok") exit(2);
    return;
  }

  const lines = ["Belay status", ""];

  if (stateRes.source !== "ok") {
    lines.push(...explainMissing(stateRes, "state file", "plugins.entries.belay.config.stateFile", "--state", "BELAY_STATE_FILE"));
  } else {
    lines.push("  Recorded today (per agent):");
    lines.push(`    ${"agent".padEnd(20)} ${"spend".padStart(10)} ${"request bytes".padStart(14)}`);
    const scopes = stateRes.state.scopes ?? [];
    if (scopes.length === 0) lines.push("    (nothing yet)");

    // An agent in observe mode still climbs the ladder internally, so that its
    // reports can say what *would* have happened. Labelling that as "ended a
    // run" would claim something that never occurred. And without a trail there
    // is no evidence either way -- the stored rung is a policy position, not a
    // record that anything was done -- so say so rather than assuming.
    let anyBlindSpend = false;
    for (const s of scopes) {
      const rung = s.ladder?.rung ?? "none";
      const label = RUNG_LABEL[rung] ?? rung;
      const rec = corroboration(trail, s);
      const flag =
        rung === "none"
          ? ""
          : rec === undefined
            ? `  <- ladder at ${rung}; action unverified`
            : rec.action === "logged"
              ? `  <- would have ${label}`
              : rec.action === "escalated"
                ? `  <- ladder at ${rung}; enforced at the next gate`
                : enforcementProven(rec)
                  ? `  <- ${ACTION_LABEL[rec.action] ?? label}`
                  : `  <- ladder at ${rung}; action unverified (pre-v2 record)`;
      const spend = s.day?.total ?? 0;
      const bytes = s.dayBytes?.total ?? 0;
      if (bytes > 0 && spend === 0) anyBlindSpend = true;
      lines.push(
        `    ${s.key.padEnd(20)} ${money(spend).padStart(10)} ${BYTES(bytes).padStart(14)}  (${s.day?.day ?? "?"})${flag}`,
      );
    }

    // $0 next to real traffic is the signature of a provider that reports no
    // token usage. Left unexplained it reads as "nothing was spent", which is
    // the silent-inert-spend-cap trap this project exists to warn about.
    if (anyBlindSpend) {
      lines.push("");
      lines.push("  Some agents show $0 spend against non-zero bytes. That usually means the");
      lines.push("  provider reported no token usage, so spend caps cannot fire for them --");
      lines.push("  use requestBytesPer* limits there instead.");
    }
  }

  lines.push("");

  if (trailRes.source !== "ok") {
    lines.push("  Decisions in the last 24h: unknown");
    lines.push(...explainMissing(trailRes, "trail file", "plugins.entries.belay.config.recorder.file", "--trail", "BELAY_TRAIL_FILE"));
  } else {
    const dayAgo = Date.now() - 24 * 3600_000;
    const recent = trail.filter((r) => Date.parse(r.t) >= dayAgo);
    lines.push(`  Decisions in the last 24h: ${recent.length}`);
    // Partial damage has to reach every surface. A count drawn from a trail
    // that lost records is a floor, not a total, and the lost record may be
    // the one being looked for.
    if (trailRes.skipped > 0) {
      lines.push(`    (incomplete: ${trailRes.skipped} unreadable record(s) skipped)`);
    }
    if (recent.length > 0) {
      const counts = {};
      for (const r of recent) counts[r.action] = (counts[r.action] ?? 0) + 1;
      for (const [action, n] of Object.entries(counts)) lines.push(`    ${action}: ${n}`);
      lines.push("");
      lines.push("  Most recent:");
      for (const r of recent.slice(-3)) {
        lines.push(`    ${r.t}  ${r.scope}  ${r.reason}`);
      }
    } else {
      // The good case, and it needs saying out loud or it reads as "broken".
      // It is still only evidence that nothing was *recorded*: a plugin that
      // never registered its hooks also records nothing, so point at the check
      // that distinguishes the two rather than declaring victory outright.
      lines.push(`    Nothing tripped, reading ${trailRes.path}.`);
      lines.push("    An empty trail means no decision was recorded, which is not by itself");
      lines.push("    proof of metering. For that, send a turn and watch a column above");
      lines.push("    change: bytes where your provider reports transport size, spend where");
      lines.push("    it reports token usage. Many providers report one and not the other,");
      lines.push("    so a column frozen at zero is only meaningful if the other moves.");
    }
  }

  stdout.write(`${lines.join("\n")}\n`);
  // A report built from files that could not be read is not a clean bill of
  // health, and a wrapper script must be able to tell the difference.
  if (stateRes.source !== "ok" || trailRes.source !== "ok") exit(2);
}

/**
 * Clear a scope's ladder back to `none`.
 *
 * The top rung is deliberately sticky: an account that was stopped stays stopped
 * until a human says otherwise. But that left no way *down*. An agent that
 * reached the ceiling -- including one that reached it during testing -- carries
 * that rung indefinitely, and the next breach of any size is treated as maximal.
 *
 * `lastActionAt` is stamped with the current time so this survives a merge with
 * a gateway process still holding the old rung in memory (the newer action
 * wins). The gateway keeps its in-memory copy until it restarts, which is why
 * the reminder below is printed rather than implied.
 */
function reset(opts) {
  if (!opts.state) {
    stdout.write("belay reset: --state <file> is required (or set BELAY_STATE_FILE).\n");
    exit(1);
  }
  const res = readState(opts.state);
  if (res.source !== "ok") {
    stdout.write(`belay reset: no readable state at ${opts.state}\n`);
    exit(1);
  }
  const state = res.state;
  const now = Date.now();
  let cleared = 0;
  for (const scope of state.scopes ?? []) {
    if (opts.agent && scope.key !== opts.agent) continue;
    if (!scope.ladder || scope.ladder.rung === "none") continue;
    stdout.write(`  ${scope.key}: ${scope.ladder.rung} -> none\n`);
    scope.ladder = { rung: "none", lastTriggerAt: now, lastActionAt: now };
    cleared += 1;
  }
  if (cleared === 0) {
    stdout.write("Nothing to clear: every ladder is already at none.\n");
    return;
  }
  writeFileSync(opts.state, JSON.stringify(state), { mode: 0o600 });
  stdout.write(
    `\nCleared ${cleared} ladder(s).\n` +
      "Restart the gateway to drop the in-memory copy as well:\n" +
      "  docker compose up -d --force-recreate\n",
  );
}

function incidents(opts) {
  const res = readTrail(opts.trail);
  const cutoff = Date.now() - opts.hours * 3600_000;
  let records = res.records.filter((r) => Date.parse(r.t) >= cutoff);
  if (opts.agent) records = records.filter((r) => r.scope === opts.agent);

  if (opts.json) {
    // Deliberately an object rather than a bare array. A bare `[]` cannot say
    // whether it means "read the trail, found nothing" or "never read
    // anything", and a consumer treating the second as the first is exactly
    // the silent-all-clear this tool exists to avoid.
    stdout.write(
      `${JSON.stringify(
        {
          source: res.source,
          path: res.path,
          hours: opts.hours,
          agent: opts.agent,
          error: res.error,
          // A consumer must be able to tell a complete answer from a
          // partial one without parsing prose.
          complete: (res.skipped ?? 0) === 0,
          skipped: res.skipped ?? 0,
          incidents: records,
        },
        null,
        2,
      )}\n`,
    );
    if (res.source !== "ok") exit(2);
    return;
  }

  if (res.source !== "ok") {
    const lines = [`Belay incidents, last ${opts.hours}h: unknown`, ""];
    lines.push(...explainMissing(res, "trail file", "plugins.entries.belay.config.recorder.file", "--trail", "BELAY_TRAIL_FILE"));
    stdout.write(`${lines.join("\n")}\n`);
    exit(2);
  }

  if (records.length === 0) {
    // The skipped line could have been the incident being looked for, so this
    // has to be said before reporting a quiet window, not only alongside hits.
    if (res.skipped > 0) {
      stdout.write(
        `Warning: ${res.skipped} unreadable record(s) in ${res.path} were skipped.\n` +
          "The result below is incomplete.\n\n",
      );
    }
    stdout.write(
      `No incidents recorded in the last ${opts.hours}h, reading ${res.path}.\n` +
        "An empty trail means no decision was recorded, which is not by itself proof\n" +
        "of metering. Run `belay status` and check that a column moves after a turn --\n" +
        "bytes or spend, depending on what your provider reports.\n",
    );
    return;
  }
  const lines = [`Belay incidents, last ${opts.hours}h (${records.length})`, ""];
  if (res.skipped > 0) {
    lines.push(`  Warning: ${res.skipped} unreadable record(s) in ${res.path} were skipped.`);
    lines.push("  The list below may be incomplete.");
    lines.push("");
  }
  for (const r of records) {
    lines.push(`${r.t}  ${describeAction(r).padEnd(30)} ${r.scope}`);
    lines.push(`    ${r.reason}`);
    lines.push(`    rule=${r.trigger} observed=${r.observed} limit=${r.limit}`);
  }
  stdout.write(`${lines.join("\n")}\n`);
}

const opts = parseArgs(argv.slice(2));
opts.state = opts.state ?? process.env.BELAY_STATE_FILE;
opts.trail = opts.trail ?? process.env.BELAY_TRAIL_FILE;

if (!Number.isFinite(opts.hours) || opts.hours <= 0) {
  // Number("garbage") is NaN, and every `>= NaN` comparison is false, so an
  // unvalidated value silently discarded real incidents and reported success.
  stdout.write("belay: --hours must be a positive number.\n");
  exit(1);
}

const command = opts._[0];
if (opts.help || !command) {
  stdout.write(`${USAGE}\n`);
  // Asking for help is a success. Only being invoked with no command at all is
  // a usage error. Getting this backwards makes every wrapper script that runs
  // `belay --help` believe the tool is broken.
  exit(opts.help ? 0 : 1);
}

try {
  if (command === "status") status(opts);
  else if (command === "incidents") incidents(opts);
  else if (command === "reset") reset(opts);
  else {
    stdout.write(`Unknown command "${command}".\n\n${USAGE}\n`);
    exit(1);
  }
} catch (err) {
  stdout.write(`belay: ${err.message}\n`);
  exit(1);
}
