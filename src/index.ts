/**
 * The plugin entry point: the only file that imports the OpenClaw SDK.
 *
 * Its whole job is registration plus the fail-open boundary. Fail open on bugs,
 * fail closed on policy: every handler body is wrapped so a defect in Belay can
 * never take down the gateway or block a legitimate turn. A *decision* to block
 * is deliberate and is returned; an *exception* is swallowed, logged, and
 * treated as "pass". The gateway also blocks by default when a gate hook times
 * out (15 s), which is another reason handlers stay synchronous and light.
 *
 * Verified against openclaw@2026.8.2. See docs/openclaw-plugin-sdk.md.
 */
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { Alerter, buildTransports } from "./alerts.ts";
import { createBelay, guard } from "./belay.ts";
import type { AgentCtx, Effects, Logger } from "./belay.ts";
import { parseConfig } from "./config.ts";
import { Pauser } from "./pauser.ts";
import type { Dispatch } from "./pauser.ts";
import { Recorder } from "./recorder.ts";
import { loadState, StateWriter } from "./store.ts";
import type { HookUsage } from "./types.ts";

const PLUGIN_ID = "belay";

export { createBelay } from "./belay.ts";

export default definePluginEntry({
  id: PLUGIN_ID,
  name: "Belay",
  description: "Spend caps, rate limits and a graceful pause ladder for OpenClaw agents.",
  register(api) {
    const logger: Logger = api.logger ?? {
      info: () => {},
      warn: () => {},
      error: () => {},
    };

    const { config, issues } = parseConfig(api.pluginConfig ?? {});
    for (const issue of issues) {
      // Never throw on bad config: a plugin that refuses to load blocks gateway
      // readiness in v2 (incident #11). Complain loudly, run with what parsed.
      logger.warn(`[${PLUGIN_ID}] config ${issue.path}: ${issue.message}`);
    }
    if (!config.enabled) {
      logger.info(`[${PLUGIN_ID}] disabled by config; no hooks registered.`);
      return;
    }

    // Side effects are constructed only when configured. With a default config
    // this block produces no transports, no files and no gateway calls, which is
    // what makes "zero network, zero side effects by default" structural.
    const transports = buildTransports(
      config.alerts,
      typeof globalThis.fetch === "function"
        ? (globalThis.fetch as unknown as Parameters<typeof buildTransports>[1])
        : undefined,
    );
    const effects: Effects = {};
    if (transports.length > 0) effects.alerter = new Alerter(config.alerts, transports, logger);
    if (config.recorder.file) effects.recorder = new Recorder(config.recorder, logger);
    if (config.pause.enabled) {
      effects.pauser = new Pauser(config.pause, resolveDispatch(logger), logger);
    }

    const belay = createBelay(config, logger, Date.now, effects);

    if (config.mode === "observe") {
      logger.info(
        `[${PLUGIN_ID}] OBSERVE MODE: nothing will be blocked, ended or paused. ` +
          "Belay will only report what it would have done. Switch to " +
          'mode: "enforce" once the reports look right.',
      );
    }

    if (config.stateFile) {
      const { data, error } = loadState(config.stateFile);
      if (error) logger.warn(`[${PLUGIN_ID}] ${error}`);
      if (data) belay.meter.load(data.scopes);
      const writer = new StateWriter(config.stateFile, (m) => logger.warn(`[${PLUGIN_ID}] ${m}`));
      writer.start(() => ({ version: 1, scopes: belay.meter.toJSON() }));
      // `session_end` allows 2 seconds TOTAL across every session and handler,
      // so this flush must stay synchronous and small.
      api.on("session_end", () => {
        guard(logger, "session_end", () => writer.flush());
      });
    }

    api.on("before_agent_run", (_event: unknown, ctx: AgentCtx) =>
      guard(logger, "before_agent_run", () => belay.beforeAgentRun(ctx), {
        outcome: "pass" as const,
      }),
    );

    api.on(
      "before_tool_call",
      (event: { toolName: string; params?: unknown }, ctx: AgentCtx) =>
        guard(logger, "before_tool_call", () => belay.beforeToolCall(ctx, event), {}),
    );

    api.on(
      "after_tool_call",
      (event: { error?: unknown }, ctx: AgentCtx) => {
        guard(logger, "after_tool_call", () => belay.afterToolCall(ctx, event));
      },
    );

    api.on(
      "model_call_started",
      (_event: unknown, ctx: AgentCtx) => {
        guard(logger, "model_call_started", () => belay.modelCallStarted(ctx));
      },
    );

    api.on(
      "model_call_ended",
      (event: Record<string, unknown>, ctx: AgentCtx) => {
        guard(logger, "model_call_ended", () => belay.modelCallEnded(ctx, event));
      },
    );

    api.on(
      "llm_output",
      (event: { usage?: HookUsage }, ctx: AgentCtx) => {
        guard(logger, "llm_output", () => belay.llmOutput(ctx, event));
      },
    );

    api.on(
      "agent_end",
      (_event: unknown, ctx: AgentCtx) => {
        guard(logger, "agent_end", () => belay.agentEnd(ctx));
      },
    );

    logger.info(
      `[${PLUGIN_ID}] active: caps=${JSON.stringify(config.limits)} tz=${config.timeZone} ` +
        `mode=${config.mode} ` +
        `agents=${Object.keys(config.agents).length} ` +
        `alerts=${transports.map((t) => t.name).join(",") || "log-only"} ` +
        `recorder=${config.recorder.file ? "on" : "off"} ` +
        `autopause=${config.pause.enabled ? "on" : "off"}`,
    );
  },
});

/**
 * A dispatcher that loads the gateway RPC module on first use.
 *
 * Two reasons this is lazy rather than a top-level import. Only operators who
 * opt into automatic pausing ever need it, so an eager import would make every
 * install depend on a module most installs never call. And it must be a dynamic
 * `import()`, not `require()`: this package is ESM, where `require` is not
 * defined at all -- a detail that would only have surfaced the first time
 * someone's agent actually breached the top rung, which is the worst possible
 * moment to discover it.
 *
 * Failure degrades to "cannot pause", reported once, never to a crash.
 */
function resolveDispatch(logger: Logger): Dispatch {
  let cached: Dispatch | undefined;
  let failed = false;

  return async (method, params, options) => {
    if (!cached && !failed) {
      try {
        const mod = await import("openclaw/plugin-sdk/gateway-method-runtime");
        if (typeof mod.dispatchGatewayMethod === "function") {
          cached = mod.dispatchGatewayMethod;
        } else {
          failed = true;
          logger.warn(`[${PLUGIN_ID}] gateway dispatch unavailable; cannot pause accounts.`);
        }
      } catch (err) {
        failed = true;
        logger.warn(
          `[${PLUGIN_ID}] cannot load gateway dispatch (${String(err)}); cannot pause accounts.`,
        );
      }
    }
    if (!cached) {
      return {
        ok: false,
        error: { code: "belay_no_dispatch", message: "gateway dispatch unavailable" },
      };
    }
    return cached(method, params, options);
  };
}
