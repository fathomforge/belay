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
import { createBelay, guard } from "./belay.ts";
import type { AgentCtx, Logger } from "./belay.ts";
import { parseConfig } from "./config.ts";
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

    const belay = createBelay(config, logger);

    if (config.stateFile) {
      const { data, error } = loadState(config.stateFile);
      if (error) logger.warn(`[${PLUGIN_ID}] ${error}`);
      if (data) belay.meter.load(data.scopes);
      const writer = new StateWriter(config.stateFile, (m) => logger.warn(`[${PLUGIN_ID}] ${m}`));
      writer.start(() => ({ version: 1, scopes: belay.meter.toJSON() }));
      // `session_end` allows 2 seconds TOTAL across every session and handler,
      // so this flush must stay synchronous and small.
      api.registerHook("session_end", () => {
        guard(logger, "session_end", () => writer.flush());
      });
    }

    api.registerHook("before_agent_run", (_event: unknown, ctx: AgentCtx) =>
      guard(logger, "before_agent_run", () => belay.beforeAgentRun(ctx), {
        outcome: "pass" as const,
      }),
    );

    api.registerHook(
      "before_tool_call",
      (event: { toolName: string; params?: unknown }, ctx: AgentCtx) =>
        guard(logger, "before_tool_call", () => belay.beforeToolCall(ctx, event), {}),
    );

    api.registerHook("after_tool_call", (event: { error?: unknown }, ctx: AgentCtx) => {
      guard(logger, "after_tool_call", () => belay.afterToolCall(ctx, event));
    });

    api.registerHook("model_call_started", (_event: unknown, ctx: AgentCtx) => {
      guard(logger, "model_call_started", () => belay.modelCallStarted(ctx));
    });

    api.registerHook("llm_output", (event: { usage?: HookUsage }, ctx: AgentCtx) => {
      guard(logger, "llm_output", () => belay.llmOutput(ctx, event));
    });

    api.registerHook("agent_end", (_event: unknown, ctx: AgentCtx) => {
      guard(logger, "agent_end", () => belay.agentEnd(ctx));
    });

    logger.info(
      `[${PLUGIN_ID}] active: caps=${JSON.stringify(config.limits)} tz=${config.timeZone} ` +
        `agents=${Object.keys(config.agents).length}`,
    );
  },
});
