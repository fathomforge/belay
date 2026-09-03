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
 */
import { readFileSync } from "node:fs";
import { argv, exit, stdout } from "node:process";

const USAGE = `belay - read the local Belay flight recorder

Usage:
  belay status    [--state <file>] [--trail <file>]
  belay incidents [--trail <file>] [--hours N] [--agent <id>] [--json]

Both files are the paths set in openclaw.json under
plugins.entries.belay.config.stateFile and .recorder.file
(or via BELAY_STATE_FILE / BELAY_TRAIL_FILE).

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

function readTrail(file) {
  if (!file) return [];
  let raw;
  try {
    raw = readFileSync(file, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
  const out = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed.t === "string") out.push(parsed);
    } catch {
      // A file killed mid-write ends in a partial line. Skip it, keep the rest.
    }
  }
  return out;
}

function readState(file) {
  if (!file) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    return parsed && parsed.version === 1 ? parsed : undefined;
  } catch {
    return undefined;
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
  const state = readState(opts.state);
  const trail = readTrail(opts.trail);

  const lines = ["Belay status", ""];

  if (!state) {
    lines.push("  No saved state found.");
    lines.push("  Either Belay has not run yet, or stateFile is not configured.");
  } else {
    lines.push("  Spend recorded today (per agent):");
    const scopes = state.scopes ?? [];
    if (scopes.length === 0) lines.push("    (nothing yet)");
    for (const s of scopes) {
      const rung = s.ladder?.rung ?? "none";
      const flag = rung === "none" ? "" : `  <- ${RUNG_LABEL[rung] ?? rung}`;
      lines.push(`    ${s.key.padEnd(20)} ${money(s.day?.total ?? 0).padStart(10)}  (${s.day?.day ?? "?"})${flag}`);
    }
  }

  lines.push("");
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
  } else if (opts.trail) {
    // The good case, and it needs saying out loud or it reads as "broken".
    lines.push("    Nothing tripped. That is what a healthy day looks like.");
  } else {
    lines.push("    (recorder.file is not configured, so there is no trail to read)");
  }

  stdout.write(`${lines.join("\n")}\n`);
}

function incidents(opts) {
  const cutoff = Date.now() - opts.hours * 3600_000;
  let trail = readTrail(opts.trail).filter((r) => Date.parse(r.t) >= cutoff);
  if (opts.agent) trail = trail.filter((r) => r.scope === opts.agent);

  if (opts.json) {
    stdout.write(`${JSON.stringify(trail, null, 2)}\n`);
    return;
  }
  if (trail.length === 0) {
    stdout.write(`No incidents in the last ${opts.hours}h.\n`);
    return;
  }
  const lines = [`Belay incidents, last ${opts.hours}h (${trail.length})`, ""];
  for (const r of trail) {
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
  exit(command ? 0 : 1);
}

try {
  if (command === "status") status(opts);
  else if (command === "incidents") incidents(opts);
  else {
    stdout.write(`Unknown command "${command}".\n\n${USAGE}\n`);
    exit(1);
  }
} catch (err) {
  stdout.write(`belay: ${err.message}\n`);
  exit(1);
}
