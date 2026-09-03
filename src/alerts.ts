/**
 * Alert delivery: the only part of Belay that is allowed to touch the network,
 * and only to endpoints the operator explicitly configured.
 *
 * Rules this module exists to enforce:
 *  - **Zero network by default.** With no alert config, nothing here ever opens
 *    a socket. That is a testable property, not a promise (see alerts.test.ts).
 *  - **One incident, one message.** The ladder already deduplicates decisions,
 *    but a bug upstream must not be able to send 300 Telegram messages, so there
 *    is a hard hourly ceiling here as a second line of defence.
 *  - **Never throw, never block.** A failed alert must not fail the agent turn
 *    that triggered it. Every send is time-limited and its errors are swallowed
 *    into the log.
 *  - **No content, ever.** Alerts carry scope, rung, trigger and numbers. Never
 *    prompts, replies, tool parameters or file paths.
 */
import type { RungName, Trigger } from "./types.ts";

export type AlertEvent = {
  /** Agent id, or the session key when the agent is unknown. */
  scope: string;
  rung: RungName;
  trigger: Trigger;
  /** Plain-English explanation, built from numbers only. */
  reason: string;
  at: number;
};

/** A place to send an alert. Must resolve; rejections are caught by the caller. */
export type Transport = {
  name: string;
  send: (text: string, event: AlertEvent) => Promise<void>;
};

export type TelegramConfig = { botToken: string; chatId: string };
export type WebhookConfig = { url: string; headers?: Record<string, string> };

export type AlertsConfig = {
  /** Lowest rung worth sending. Below this, decisions are logged only. */
  minRung: RungName;
  /** Hard ceiling on messages per hour across all transports. */
  maxPerHour: number;
  telegram?: TelegramConfig;
  webhook?: WebhookConfig;
};

export const DEFAULT_ALERTS: AlertsConfig = {
  // `warn` is the first rung an operator would want to hear about; `none` never fires.
  minRung: "warn",
  maxPerHour: 20,
};

const RUNG_ORDER: Record<RungName, number> = {
  none: 0,
  warn: 1,
  blockTool: 2,
  endRun: 3,
  pause: 4,
};

/** Human-readable one-liner. Deliberately boring, and free of any content. */
export function formatAlert(event: AlertEvent): string {
  const when = new Date(event.at).toISOString().replace("T", " ").slice(0, 19);
  const headline: Record<RungName, string> = {
    none: "Belay: notice",
    warn: "Belay: warning",
    blockTool: "Belay: blocked a tool call",
    endRun: "Belay: ended a run",
    // Deliberately future tense: this alert is emitted when the ladder reaches
    // the top rung, before the gateway has confirmed the account actually
    // stopped. A separate alert reports what really happened. Claiming a
    // completed action that then fails is worse than saying nothing.
    pause: "Belay: pausing an account",
  };
  return `${headline[event.rung]}\nagent: ${event.scope}\nwhy: ${event.reason}\nrule: ${event.trigger}\nat: ${when} UTC`;
}

/** Minimal `fetch` shape, injected so tests never touch the network. */
export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number }>;

const SEND_TIMEOUT_MS = 5_000;

function timeoutSignal(ms: number): AbortSignal | undefined {
  // AbortSignal.timeout exists on Node 18+, but stay defensive: a missing
  // signal must degrade to "no timeout", never to a crash.
  const ctor = AbortSignal as unknown as { timeout?: (ms: number) => AbortSignal };
  return typeof ctor.timeout === "function" ? ctor.timeout(ms) : undefined;
}

export function telegramTransport(config: TelegramConfig, fetchImpl: FetchLike): Transport {
  return {
    name: "telegram",
    async send(text) {
      const signal = timeoutSignal(SEND_TIMEOUT_MS);
      const res = await fetchImpl(
        `https://api.telegram.org/bot${config.botToken}/sendMessage`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            chat_id: config.chatId,
            text,
            disable_web_page_preview: true,
          }),
          ...(signal ? { signal } : {}),
        },
      );
      if (!res.ok) {
        // The status is safe to surface; the token is not, and never appears here.
        throw new Error(`telegram responded ${res.status}`);
      }
    },
  };
}

export function webhookTransport(config: WebhookConfig, fetchImpl: FetchLike): Transport {
  return {
    name: "webhook",
    async send(text, event) {
      const signal = timeoutSignal(SEND_TIMEOUT_MS);
      const res = await fetchImpl(config.url, {
        method: "POST",
        headers: { "content-type": "application/json", ...config.headers },
        body: JSON.stringify({
          source: "belay",
          scope: event.scope,
          rung: event.rung,
          trigger: event.trigger,
          reason: event.reason,
          at: event.at,
          text,
        }),
        ...(signal ? { signal } : {}),
      });
      if (!res.ok) throw new Error(`webhook responded ${res.status}`);
    },
  };
}

export type Logger = {
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
};

/**
 * Sends alerts to every configured transport, subject to a rung floor and an
 * hourly ceiling. `notify` is fire-and-forget by design: the caller is inside an
 * agent turn and must not wait on a network round trip.
 */
export class Alerter {
  readonly config: AlertsConfig;
  readonly transports: Transport[];
  #logger: Logger;
  #sentAt: number[] = [];
  #suppressedReported = false;

  constructor(config: AlertsConfig, transports: Transport[], logger: Logger) {
    this.config = config;
    this.transports = transports;
    this.#logger = logger;
  }

  /** True when this event clears the rung floor and the hourly ceiling. */
  shouldSend(event: AlertEvent, now: number): boolean {
    if (RUNG_ORDER[event.rung] < RUNG_ORDER[this.config.minRung]) return false;
    if (RUNG_ORDER[event.rung] === 0) return false;
    const hourAgo = now - 3_600_000;
    this.#sentAt = this.#sentAt.filter((t) => t > hourAgo);
    return this.#sentAt.length < this.config.maxPerHour;
  }

  /**
   * Deliver an alert. Returns a promise for tests; production callers ignore it.
   * Never rejects.
   */
  async notify(event: AlertEvent, now: number = Date.now()): Promise<void> {
    if (RUNG_ORDER[event.rung] === 0) return;
    if (!this.shouldSend(event, now)) {
      if (!this.#suppressedReported && RUNG_ORDER[event.rung] >= RUNG_ORDER[this.config.minRung]) {
        this.#suppressedReported = true;
        this.#logger.warn(
          `[belay] alert ceiling of ${this.config.maxPerHour}/hour reached; further alerts are ` +
            "logged only until the hour rolls off.",
        );
      }
      return;
    }
    this.#sentAt.push(now);
    this.#suppressedReported = false;

    const text = formatAlert(event);
    // Always leave a local trace, even when every transport fails.
    this.#logger.warn(`[belay] alert: ${text.replace(/\n/g, " | ")}`);

    await Promise.all(
      this.transports.map(async (t) => {
        try {
          await t.send(text, event);
        } catch (err) {
          // An unreachable alert endpoint is not an agent problem.
          this.#logger.error(`[belay] alert via ${t.name} failed: ${String(err)}`);
        }
      }),
    );
  }
}

/**
 * Build the transports an operator actually configured.
 *
 * Returns an empty array when nothing is configured, which is what makes
 * "zero network by default" true rather than aspirational.
 */
export function buildTransports(config: AlertsConfig, fetchImpl?: FetchLike): Transport[] {
  const transports: Transport[] = [];
  if (!fetchImpl) return transports;
  if (config.telegram) transports.push(telegramTransport(config.telegram, fetchImpl));
  if (config.webhook) transports.push(webhookTransport(config.webhook, fetchImpl));
  return transports;
}
