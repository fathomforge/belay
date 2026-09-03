/**
 * Minimal ambient types for the slice of the OpenClaw plugin SDK that Belay uses.
 *
 * Why vendored rather than `npm i -D openclaw`:
 *  - The package declares `engines: >=22.22.3 <23 || >=24.15.0 <25 || >=25.9.0`
 *    and refuses to install on Node 24.11.x, which is what the dev Mac runs.
 *  - It is 206 MB unpacked with `preinstall` and `postinstall` scripts. Pulling
 *    that into a project whose pitch is supply-chain hygiene, purely to typecheck
 *    six hook registrations, is a bad trade even in devDependencies.
 *  - `openclaw` stays a *peer* dependency; the real implementation is whatever
 *    the gateway loads at runtime.
 *
 * These declarations were transcribed from the shipped types of openclaw@2026.8.2
 * (`dist/plugin-sdk/plugin-entry.d.ts` -> `dist/agent-harness-runtime-*.d.ts`,
 * `dist/hook-runner-global-*.d.ts`). They are deliberately narrower than the real
 * API: only what this plugin calls. To re-verify after an OpenClaw upgrade:
 *
 *   npm pack openclaw@<version>
 *   tar -xzf openclaw-<version>.tgz 'package/dist/plugin-sdk/plugin-entry.d.ts'
 *
 * Note the bundle chunk filenames are content-hashed and change every release,
 * so follow the imports rather than hardcoding them.
 */
declare module "openclaw/plugin-sdk/plugin-entry" {
  /** `PluginLogger`. `debug` is optional; the other three are not. */
  export type PluginLogger = {
    debug?: (message: string) => void;
    info: (message: string) => void;
    warn: (message: string) => void;
    error: (message: string) => void;
  };

  /**
   * `PluginHookAgentContext`, narrowed.
   *
   * `agentId` really is optional upstream -- per-agent scoping must tolerate its
   * absence. `accountId` identifies the channel account, which is what
   * `channels.stop` needs when the pause rung is implemented.
   */
  export type PluginHookAgentContext = {
    runId?: string;
    agentId?: string;
    sessionKey?: string;
    sessionId?: string;
    accountId?: string;
    channel?: string;
    chatId?: string;
    senderId?: string;
    contextTokenBudget?: number;
  };

  /** Options for `api.on`, the typed hook registrar. */
  export type PluginHookRegistrationOptions = {
    priority?: number;
    registrationId?: string;
    timeoutMs?: number;
    /** `before_tool_call` / `after_tool_call` only: canonical tool ids. */
    matcher?: unknown;
  };

  /** `OpenClawPluginApi`, narrowed to what Belay touches. */
  export type OpenClawPluginApi = {
    id: string;
    name: string;
    version?: string;
    /** This plugin's own `plugins.entries.<id>.config` block, unvalidated. */
    pluginConfig?: Record<string, unknown>;
    /** The whole gateway config. Belay reads only models.providers.*.models[].cost. */
    config?: unknown;
    logger: PluginLogger;
    /**
     * Register a typed hook. **This is the one to use.**
     *
     * `api.registerHook` also exists and is deliberately NOT declared here.
     * Typed hook events (`llm_output`, `before_tool_call`, `before_agent_run`
     * and friends) are dispatched by the typed hook runner only, so a
     * `registerHook` registration for one of them is accepted, logged as
     * ignored, and never invoked -- the plugin loads, reports itself active,
     * and silently does nothing. Found by installing on a real gateway; it
     * typechecked and every unit test passed.
     */
    on: (
      hookName: string,
      handler: (event: never, ctx: never) => unknown,
      opts?: PluginHookRegistrationOptions,
    ) => void;
  };

  export type OpenClawPluginDefinition = {
    id?: string;
    name?: string;
    description?: string;
    version?: string;
    configSchema?: unknown;
    register?: (api: OpenClawPluginApi) => void;
  };

  export function definePluginEntry(definition: OpenClawPluginDefinition): unknown;
}

/**
 * `channels.stop` / `channels.start` and every other gateway control-plane
 * method, callable in-process. Transcribed from
 * `dist/plugin-sdk/gateway-method-runtime.d.ts` in openclaw@2026.8.2.
 */
declare module "openclaw/plugin-sdk/gateway-method-runtime" {
  export type GatewayMethodDispatchError = {
    code: string;
    message: string;
    details?: unknown;
    retryable?: boolean;
    retryAfterMs?: number;
  };
  export type GatewayMethodDispatchResponse = {
    ok: boolean;
    payload?: unknown;
    error?: GatewayMethodDispatchError;
    meta?: Record<string, unknown>;
  };
  export type GatewayMethodDispatchOptions = { expectFinal?: boolean; timeoutMs?: number };
  export function dispatchGatewayMethod(
    method: string,
    params?: unknown,
    options?: GatewayMethodDispatchOptions,
  ): Promise<GatewayMethodDispatchResponse>;
}
