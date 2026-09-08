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
  belay status    [--state <file>] [--trail <file>]
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
      if (parsed && typeof parsed.t === "string") records.push(parsed);
      else skipped += 1;
    } catch {
      // A file killed mid-write ends in a partial line. Skip it, keep the rest.
      skipped += 1;
    }
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

function status(opts) {
  const stateRes = readState(opts.state);
  const trailRes = readTrail(opts.trail);
  const trail = trailRes.records;

  const lines = ["Belay status", ""];

  if (stateRes.source !== "ok") {
    lines.push(...explainMissing(stateRes, "state file", "plugins.entries.belay.config.stateFile", "--state", "BELAY_STATE_FILE"));
  } else {
    lines.push("  Spend recorded today (per agent):");
    const scopes = stateRes.state.scopes ?? [];
    if (scopes.length === 0) lines.push("    (nothing yet)");

    // An agent in observe mode still climbs the ladder internally, so that its
    // reports can say what *would* have happened. Labelling that as "ended a
    // run" would claim something that never occurred, so check what was
    // actually recorded before describing it.
    const lastAction = new Map();
    for (const r of trail) lastAction.set(r.scope, r.action);

    for (const s of scopes) {
      const rung = s.ladder?.rung ?? "none";
      const acted = lastAction.get(s.key);
      const label = RUNG_LABEL[rung] ?? rung;
      const flag =
        rung === "none"
          ? ""
          : acted === "logged"
            ? `  <- would have ${label}`
            : `  <- ${label}`;
      lines.push(`    ${s.key.padEnd(20)} ${money(s.day?.total ?? 0).padStart(10)}  (${s.day?.day ?? "?"})${flag}`);
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
      lines.push("    An empty trail means no decision was recorded. To confirm Belay is");
      lines.push('    actually metering, check the gateway log for "[belay] active".');
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
    stdout.write(
      `No incidents recorded in the last ${opts.hours}h, reading ${res.path}.\n` +
        "An empty trail means no decision was recorded. To confirm Belay is\n" +
        'actually metering, check the gateway log for "[belay] active".\n',
    );
    return;
  }
  const lines = [`Belay incidents, last ${opts.hours}h (${records.length})`, ""];
  for (const r of records) {
    lines.push(`${r.t}  ${(RUNG_LABEL[r.rung] ?? r.rung).padEnd(14)} ${r.scope}`);
    lines.push(`    ${r.reason}`);
    lines.push(`    rule=${r.trigger} observed=${r.observed} limit=${r.limit}`);
  }
  stdout.write(`${lines.join("\n")}\n`);
}

const opts = parseArgs(argv.slice(2));
opts.state = opts.state ?? process.env.BELAY_STATE_FILE;
opts.trail = opts.trail ?? process.env.BELAY_TRAIL_FILE;

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
