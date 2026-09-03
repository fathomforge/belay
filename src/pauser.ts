/**
 * The top rung: stopping a channel account without restarting the gateway.
 *
 * This is the only thing Belay does with real, visible side effects, so it is
 * the most conservative module in the project:
 *
 *  - **Off unless explicitly enabled.** Nobody's bot goes silent because they
 *    installed a plugin and left the defaults alone.
 *  - **One stop per account, ever, until a human resumes.** Repeated pause rungs
 *    must not re-issue `channels.stop`, both because it is pointless and because
 *    of a real operational hazard: while an account is stopped, inbound messages
 *    accumulate in the ingress spool and drain as a burst on restart. Every extra
 *    stop/start cycle risks another burst.
 *  - **Resume is a human action.** There is a `resume()` here for a future CLI
 *    command, but nothing calls it automatically. A gateway that pauses and
 *    un-pauses itself on a timer would flap, and a crash-loop breaker upstream
 *    can make a `channels.start` silently no-op anyway.
 *
 * The gateway call itself is injected rather than imported, so this file stays
 * free of the OpenClaw SDK and fully testable. `index.ts` supplies the real
 * `dispatchGatewayMethod` from `openclaw/plugin-sdk/gateway-method-runtime`.
 */

/** Mirrors `GatewayMethodDispatchResponse` from the SDK, narrowed. */
export type DispatchResponse = {
  ok: boolean;
  payload?: unknown;
  error?: { code: string; message: string; retryable?: boolean; retryAfterMs?: number };
};

export type Dispatch = (
  method: string,
  params?: unknown,
  options?: { expectFinal?: boolean; timeoutMs?: number },
) => Promise<DispatchResponse>;

export type PauseTarget = { channel: string; accountId: string };

export type PauserConfig = {
  /** Must be turned on deliberately. Default false. */
  enabled: boolean;
  /** Fallback target when a hook context does not carry one. */
  target?: PauseTarget;
};

export const DEFAULT_PAUSER: PauserConfig = { enabled: false };

export type Logger = {
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
};

export type PauseOutcome =
  | { status: "paused"; target: PauseTarget }
  | { status: "already-paused"; target: PauseTarget }
  | { status: "disabled" }
  | { status: "no-target" }
  | { status: "failed"; target: PauseTarget; error: string };

function key(target: PauseTarget): string {
  return `${target.channel}:${target.accountId}`;
}

export class Pauser {
  readonly config: PauserConfig;
  #dispatch: Dispatch | undefined;
  #logger: Logger;
  /** Accounts this process has stopped and not resumed. */
  #paused = new Set<string>();

  constructor(config: PauserConfig, dispatch: Dispatch | undefined, logger: Logger) {
    this.config = config;
    this.#dispatch = dispatch;
    this.#logger = logger;
  }

  isPaused(target: PauseTarget): boolean {
    return this.#paused.has(key(target));
  }

  pausedAccounts(): string[] {
    return [...this.#paused];
  }

  /**
   * Stop an account. Safe to call repeatedly: only the first call for a given
   * account actually dispatches.
   */
  async pause(target: PauseTarget | undefined, reason: string): Promise<PauseOutcome> {
    if (!this.config.enabled) return { status: "disabled" };

    const resolved = target ?? this.config.target;
    // Pausing the wrong account is worse than not pausing at all, so a missing
    // or partial target is refused rather than guessed at.
    if (!resolved?.channel || !resolved.accountId) return { status: "no-target" };
    if (this.isPaused(resolved)) return { status: "already-paused", target: resolved };
    if (!this.#dispatch) {
      return { status: "failed", target: resolved, error: "no gateway dispatch available" };
    }

    // Mark before dispatching. If the call throws halfway, we must not retry in
    // a loop -- a stuck agent would otherwise hammer channels.stop.
    this.#paused.add(key(resolved));

    try {
      const res = await this.#dispatch(
        "channels.stop",
        { channel: resolved.channel, accountId: resolved.accountId },
        { expectFinal: true, timeoutMs: 10_000 },
      );
      if (!res.ok) {
        const message = res.error?.message ?? res.error?.code ?? "unknown gateway error";
        // Un-mark so a later breach can try again. Marking before dispatch stops
        // a stuck agent hammering the gateway, but leaving a *failed* attempt
        // marked meant the account was never paused and never retried, while
        // Belay believed it had acted. Retries are paced by the ladder.
        this.#paused.delete(key(resolved));
        this.#logger.error(`[belay] channels.stop failed for ${key(resolved)}: ${message}`);
        return { status: "failed", target: resolved, error: message };
      }
      this.#logger.warn(
        `[belay] PAUSED ${key(resolved)}: ${reason}. Messages will queue while stopped; ` +
          "resume with: openclaw gateway call channels.start " +
          `--params '{"channel":"${resolved.channel}","accountId":"${resolved.accountId}"}'`,
      );
      return { status: "paused", target: resolved };
    } catch (err) {
      const message = String(err);
      this.#paused.delete(key(resolved));
      this.#logger.error(`[belay] channels.stop threw for ${key(resolved)}: ${message}`);
      return { status: "failed", target: resolved, error: message };
    }
  }

  /**
   * Resume an account. Not called automatically anywhere.
   *
   * Note for whoever wires this to a CLI: a `started: true` response is not
   * proof. If the gateway's crash-loop breaker is tripped, the start can be a
   * no-op, so the operator must verify with `openclaw channels status --probe`.
   */
  async resume(target: PauseTarget): Promise<PauseOutcome> {
    if (!this.#dispatch) {
      return { status: "failed", target, error: "no gateway dispatch available" };
    }
    try {
      const res = await this.#dispatch(
        "channels.start",
        { channel: target.channel, accountId: target.accountId },
        { expectFinal: true, timeoutMs: 10_000 },
      );
      if (!res.ok) {
        const message = res.error?.message ?? res.error?.code ?? "unknown gateway error";
        return { status: "failed", target, error: message };
      }
      this.#paused.delete(key(target));
      this.#logger.info(
        `[belay] resumed ${key(target)}. Verify with: openclaw channels status --probe`,
      );
      return { status: "paused", target };
    } catch (err) {
      return { status: "failed", target, error: String(err) };
    }
  }
}
