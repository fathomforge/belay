/**
 * Belay's own configuration: parsing, defaults, and validation.
 *
 * Everything here is pure and total -- it never throws on bad operator input.
 * A malformed cap must degrade to "no cap, and say so loudly", never to a crash
 * inside the gateway's startup path. That is the fail-open half of the contract;
 * the fail-closed half is that a cap which *does* parse is enforced exactly.
 */
import { DEFAULT_LADDER } from "./ladder.ts";
import type { LadderConfig } from "./ladder.ts";
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

export type BelayConfig = {
  enabled: boolean;
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

  return {
    config: {
      enabled: src["enabled"] !== false,
      timeZone,
      limits,
      agents,
      ladder,
      rungs: { ...DEFAULT_CONFIG.rungs },
      prices,
      stateFile: typeof src["stateFile"] === "string" ? src["stateFile"] : "",
    },
    issues,
  };
}

/** Effective limits for one agent: per-agent overrides merged over the global set. */
export function limitsFor(config: BelayConfig, agentId: string | undefined): Limits {
  const overrides = agentId ? config.agents[agentId] : undefined;
  return overrides ? { ...config.limits, ...overrides } : config.limits;
}
