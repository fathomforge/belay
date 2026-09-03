/**
 * Belay's own configuration: parsing, defaults, and validation.
 *
 * Everything here is pure and total -- it never throws on bad operator input.
 * A malformed cap must degrade to "no cap, and say so loudly", never to a crash
 * inside the gateway's startup path. That is the fail-open half of the contract;
 * the fail-closed half is that a cap which *does* parse is enforced exactly.
 */
import { DEFAULT_ALERTS } from "./alerts.ts";
import type { AlertsConfig } from "./alerts.ts";
import { DEFAULT_LADDER } from "./ladder.ts";
import type { LadderConfig } from "./ladder.ts";
import { DEFAULT_PAUSER } from "./pauser.ts";
import type { PauserConfig } from "./pauser.ts";
import { DEFAULT_RECORDER } from "./recorder.ts";
import type { RecorderConfig } from "./recorder.ts";
import type { ModelPrice, RungName, Trigger } from "./types.ts";

/** A cap of `undefined` means "not configured", which always means "do not enforce". */
export type Limits = {
  /** USD ceiling for a single agent run. */
  spendPerRunUsd?: number;
  /** USD ceiling over a rolling hour. */
  spendPerHourUsd?: number;
  /** USD ceiling for one calendar day in `timeZone`. */
  spendPerDayUsd?: number;
  /** Model calls per minute per scope -- incident #1 ran at ~11/min for minutes. */
  modelCallsPerMinute?: number;
  /** Tool calls per minute per scope. */
  toolCallsPerMinute?: number;
  /** Repeats of one identical tool call within a run -- incident #2 hit 245-700. */
  identicalToolCalls?: number;
  /** Failed tool calls per minute -- the error-storm signature of incident #2. */
  toolErrorsPerMinute?: number;
  /** Context tokens in a single call -- incident #4's 174k hourly heartbeat. */
  contextTokensPerCall?: number;
};

/**
 * `observe` meters, records and alerts, but never blocks, ends or pauses
 * anything. It is the posture for a first install on a gateway with real users
 * on it: you find out what Belay *would* have done before it can do it.
 */
export type Mode = "observe" | "enforce";

export type BelayConfig = {
  enabled: boolean;
  mode: Mode;
  /** IANA zone for daily rollover. Never read from the process -- see incident #5. */
  timeZone: string;
  limits: Limits;
  /** Per-agent overrides, merged over `limits`. */
  agents: Record<string, Limits>;
  ladder: LadderConfig;
  /** Which rung a first breach of each trigger lands on. */
  rungs: Record<Trigger, RungName>;
  /** Operator price overrides, keyed `provider/model`. */
  prices: Record<string, ModelPrice>;
  /** Absolute path for cross-session state. Empty string disables persistence. */
  stateFile: string;
  alerts: AlertsConfig;
  pause: PauserConfig;
  recorder: RecorderConfig;
};

/**
 * Defaults are deliberately conservative on *behaviour* and empty on *money*.
 *
 * No spend cap ships enabled: Belay cannot know what a given operator considers
 * expensive, and a guardrail that blocks work on install gets uninstalled. The
 * rate limits do ship on, set well above any sane workload, because "700 calls
 * for one photo" is not a preference -- it is a malfunction on any budget.
 */
export const DEFAULT_CONFIG: BelayConfig = {
  enabled: true,
  mode: "enforce",
  timeZone: "UTC",
  limits: {
    modelCallsPerMinute: 30,
    toolCallsPerMinute: 60,
    identicalToolCalls: 20,
    toolErrorsPerMinute: 30,
  },
  agents: {},
  ladder: DEFAULT_LADDER,
  rungs: {
    spend_run: "endRun",
    spend_hour: "blockTool",
    spend_day: "endRun",
    model_call_rate: "warn",
    tool_call_rate: "warn",
    identical_tool_call: "blockTool",
    tool_error_rate: "warn",
    failover_context: "blockTool",
  },
  prices: {},
  stateFile: "",
  alerts: DEFAULT_ALERTS,
  pause: DEFAULT_PAUSER,
  recorder: DEFAULT_RECORDER,
};

/** Problems found while parsing. Surfaced to the operator; never thrown. */
export type ConfigIssue = { path: string; message: string };

function positiveNumber(
  value: unknown,
  path: string,
  issues: ConfigIssue[],
): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    issues.push({ path, message: `expected a positive number, got ${JSON.stringify(value)}` });
    return undefined;
  }
  return value;
}

const LIMIT_KEYS = [
  "spendPerRunUsd",
  "spendPerHourUsd",
  "spendPerDayUsd",
  "modelCallsPerMinute",
  "toolCallsPerMinute",
  "identicalToolCalls",
  "toolErrorsPerMinute",
  "contextTokensPerCall",
] as const;

function parseLimits(raw: unknown, path: string, issues: ConfigIssue[]): Limits {
  const out: Limits = {};
  if (raw === undefined) return out;
  if (typeof raw !== "object" || raw === null) {
    issues.push({ path, message: "expected an object of limits" });
    return out;
  }
  const src = raw as Record<string, unknown>;
  for (const key of Object.keys(src)) {
    if (!(LIMIT_KEYS as readonly string[]).includes(key)) {
      // A typo'd cap is the quietest possible failure: the operator believes
      // they are protected and they are not. Always report it.
      issues.push({ path: `${path}.${key}`, message: "unknown limit; it will not be enforced" });
    }
  }
  for (const key of LIMIT_KEYS) {
    const v = positiveNumber(src[key], `${path}.${key}`, issues);
    if (v !== undefined) out[key] = v;
  }
  return out;
}

function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export type ParsedConfig = { config: BelayConfig; issues: ConfigIssue[] };

/** Parse operator config. Always returns a usable config plus a list of issues. */
export function parseConfig(raw: unknown): ParsedConfig {
  const issues: ConfigIssue[] = [];
  const src = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;

  let timeZone = DEFAULT_CONFIG.timeZone;
  if (typeof src["timeZone"] === "string") {
    if (isValidTimeZone(src["timeZone"])) {
      timeZone = src["timeZone"];
    } else {
      issues.push({ path: "timeZone", message: `unknown timezone; falling back to ${timeZone}` });
    }
  }

  const limits = { ...DEFAULT_CONFIG.limits, ...parseLimits(src["limits"], "limits", issues) };

  const agents: Record<string, Limits> = {};
  const rawAgents = src["agents"];
  if (typeof rawAgents === "object" && rawAgents !== null) {
    for (const [agentId, value] of Object.entries(rawAgents as Record<string, unknown>)) {
      agents[agentId] = parseLimits(value, `agents.${agentId}`, issues);
    }
  } else if (rawAgents !== undefined) {
    issues.push({ path: "agents", message: "expected an object keyed by agent id" });
  }

  const rawLadder = (src["ladder"] ?? {}) as Record<string, unknown>;
  const ladder: LadderConfig = {
    cooldownMs: positiveNumber(rawLadder["cooldownMs"], "ladder.cooldownMs", issues) ??
      DEFAULT_LADDER.cooldownMs,
    decayMs: positiveNumber(rawLadder["decayMs"], "ladder.decayMs", issues) ??
      DEFAULT_LADDER.decayMs,
    renotifyMs: positiveNumber(rawLadder["renotifyMs"], "ladder.renotifyMs", issues) ??
      DEFAULT_LADDER.renotifyMs,
    maxRung: DEFAULT_LADDER.maxRung,
  };
  const maxRung = rawLadder["maxRung"];
  if (typeof maxRung === "string") {
    if (maxRung in DEFAULT_CONFIG.rungs || ["none", "warn", "blockTool", "endRun", "pause"].includes(maxRung)) {
      ladder.maxRung = maxRung as RungName;
    } else {
      issues.push({ path: "ladder.maxRung", message: `unknown rung ${JSON.stringify(maxRung)}` });
    }
  }

  const prices: Record<string, ModelPrice> = {};
  const rawPrices = src["prices"];
  if (typeof rawPrices === "object" && rawPrices !== null) {
    for (const [key, value] of Object.entries(rawPrices as Record<string, unknown>)) {
      const p = (typeof value === "object" && value !== null ? value : {}) as Record<string, unknown>;
      const input = positiveNumber(p["input"], `prices.${key}.input`, issues);
      const output = positiveNumber(p["output"], `prices.${key}.output`, issues);
      if (input === undefined || output === undefined) {
        issues.push({ path: `prices.${key}`, message: "needs both input and output rates; ignored" });
        continue;
      }
      const price: ModelPrice = { input, output };
      const cacheRead = positiveNumber(p["cacheRead"], `prices.${key}.cacheRead`, issues);
      const cacheWrite = positiveNumber(p["cacheWrite"], `prices.${key}.cacheWrite`, issues);
      if (cacheRead !== undefined) price.cacheRead = cacheRead;
      if (cacheWrite !== undefined) price.cacheWrite = cacheWrite;
      prices[key.toLowerCase()] = price;
    }
  }

  let mode: Mode = DEFAULT_CONFIG.mode;
  const rawMode = src["mode"];
  if (typeof rawMode === "string") {
    if (rawMode === "observe" || rawMode === "enforce") mode = rawMode;
    else issues.push({ path: "mode", message: `expected "observe" or "enforce", got ${JSON.stringify(rawMode)}` });
  }

  const pause = parsePause(src["pause"], issues);
  if (mode === "observe") {
    // Belt and braces. Capping the ladder is what actually prevents a block,
    // but an operator who wrote mode:"observe" must not be able to be surprised
    // by an account going silent because pause was also enabled.
    ladder.maxRung = "warn";
    if (pause.enabled) {
      issues.push({
        path: "pause.enabled",
        message: 'ignored while mode is "observe": nothing is paused in observe mode',
      });
      pause.enabled = false;
    }
  }

  return {
    config: {
      enabled: src["enabled"] !== false,
      mode,
      timeZone,
      limits,
      agents,
      ladder,
      rungs: { ...DEFAULT_CONFIG.rungs },
      prices,
      stateFile: typeof src["stateFile"] === "string" ? src["stateFile"] : "",
      alerts: parseAlerts(src["alerts"], issues),
      pause,
      recorder: parseRecorder(src["recorder"], issues),
    },
    issues,
  };
}

/** Effective limits for one agent: per-agent overrides merged over the global set. */
export function limitsFor(config: BelayConfig, agentId: string | undefined): Limits {
  const overrides = agentId ? config.agents[agentId] : undefined;
  return overrides ? { ...config.limits, ...overrides } : config.limits;
}

const RUNG_NAMES_LIST = ["none", "warn", "blockTool", "endRun", "pause"];

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

/**
 * Read a secret from the environment by name, preferring `<field>Env` over an
 * inline literal.
 *
 * A bot token pasted into `openclaw.json` ends up in config backups, in `config
 * get` output, and in any screenshot the operator posts while asking for help.
 * Belay accepts it, because refusing would just make people give up, but it
 * says so once and loudly.
 */
function secret(
  src: Record<string, unknown>,
  field: string,
  path: string,
  issues: ConfigIssue[],
): string | undefined {
  const envName = str(src[`${field}Env`]);
  if (envName) {
    const value = str(process.env[envName]);
    if (!value) {
      issues.push({ path: `${path}.${field}Env`, message: `environment variable ${envName} is not set` });
      return undefined;
    }
    return value;
  }
  const inline = str(src[field]);
  if (inline) {
    issues.push({
      path: `${path}.${field}`,
      message:
        `prefer ${field}Env with the name of an environment variable: an inline secret ends up ` +
        "in config backups, `openclaw config get` output and screenshots",
    });
    return inline;
  }
  return undefined;
}

function parseAlerts(raw: unknown, issues: ConfigIssue[]): AlertsConfig {
  const out: AlertsConfig = { ...DEFAULT_ALERTS };
  if (raw === undefined) return out;
  if (typeof raw !== "object" || raw === null) {
    issues.push({ path: "alerts", message: "expected an object" });
    return out;
  }
  const src = raw as Record<string, unknown>;

  const minRung = str(src["minRung"]);
  if (minRung) {
    if (RUNG_NAMES_LIST.includes(minRung)) out.minRung = minRung as RungName;
    else issues.push({ path: "alerts.minRung", message: `unknown rung ${JSON.stringify(minRung)}` });
  }
  const maxPerHour = positiveNumber(src["maxPerHour"], "alerts.maxPerHour", issues);
  if (maxPerHour !== undefined) out.maxPerHour = maxPerHour;

  const tg = src["telegram"];
  if (typeof tg === "object" && tg !== null) {
    const t = tg as Record<string, unknown>;
    const botToken = secret(t, "botToken", "alerts.telegram", issues);
    const chatId = str(t["chatId"]);
    if (botToken && chatId) out.telegram = { botToken, chatId };
    else {
      issues.push({
        path: "alerts.telegram",
        message: "needs both a bot token and chatId; Telegram alerts are off",
      });
    }
  }

  const wh = src["webhook"];
  if (typeof wh === "object" && wh !== null) {
    const w = wh as Record<string, unknown>;
    const url = str(w["url"]);
    if (!url) {
      issues.push({ path: "alerts.webhook.url", message: "missing; webhook alerts are off" });
    } else if (!/^https:\/\//i.test(url)) {
      // Alerts describe security incidents. Sending them in the clear would be
      // a poor look for a plugin whose whole pitch is not leaking anything.
      issues.push({ path: "alerts.webhook.url", message: "must be https; webhook alerts are off" });
    } else {
      const headers: Record<string, string> = {};
      const rawHeaders = w["headers"];
      if (typeof rawHeaders === "object" && rawHeaders !== null) {
        for (const [k, v] of Object.entries(rawHeaders as Record<string, unknown>)) {
          const value = str(v);
          if (value) headers[k] = value;
        }
      }
      out.webhook = Object.keys(headers).length > 0 ? { url, headers } : { url };
    }
  }
  return out;
}

function parsePause(raw: unknown, issues: ConfigIssue[]): PauserConfig {
  const out: PauserConfig = { ...DEFAULT_PAUSER };
  if (raw === undefined) return out;
  if (typeof raw !== "object" || raw === null) {
    issues.push({ path: "pause", message: "expected an object" });
    return out;
  }
  const src = raw as Record<string, unknown>;
  out.enabled = src["enabled"] === true;
  const channel = str(src["channel"]);
  const accountId = str(src["accountId"]);
  if (channel && accountId) out.target = { channel, accountId };
  else if (channel || accountId) {
    issues.push({
      path: "pause",
      message: "channel and accountId must be set together; falling back to the hook's own account",
    });
  }
  if (out.enabled && !out.target) {
    issues.push({
      path: "pause",
      message:
        "enabled without channel/accountId: Belay will only pause when the triggering hook " +
        "identifies its own account",
    });
  }
  return out;
}

function parseRecorder(raw: unknown, issues: ConfigIssue[]): RecorderConfig {
  const out: RecorderConfig = { ...DEFAULT_RECORDER };
  if (raw === undefined) return out;
  if (typeof raw !== "object" || raw === null) {
    issues.push({ path: "recorder", message: "expected an object" });
    return out;
  }
  const src = raw as Record<string, unknown>;
  const file = str(src["file"]);
  if (file) out.file = file;
  const maxBytes = positiveNumber(src["maxBytes"], "recorder.maxBytes", issues);
  if (maxBytes !== undefined) out.maxBytes = maxBytes;
  return out;
}
