# Changelog

All notable changes to Belay are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project uses
[semantic versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-09-02

First release. Spend caps, rate limits and a graceful pause ladder for OpenClaw agents, running
in-process with zero runtime dependencies and no network calls except the alerts you configure.

### Added

- **Spend caps** per run, per rolling hour, and per calendar day in your configured timezone, with
  per-agent overrides.
- **Rate limits**: model calls per minute, tool calls per minute, identical repeated tool calls
  within a run, and tool errors per minute.
- **The pause ladder**: warn, block a tool call, end the run, pause the account. Quiet time steps
  it back down; a pause is sticky until a human resumes it. Repeats inside a cooldown are
  deduplicated, and a persistent breach is re-reported on a slow cadence rather than every time.
- **Observe mode**, globally or per agent: meter, record and alert, but never block, end or pause.
  A global `observe` always wins over a per-agent `enforce`.
- **Cost estimation from request size** for providers that report no token usage. Uses transport
  metadata (`requestPayloadBytes` / `responseStreamBytes`) only, never content. Only models
  observed reporting nothing are estimated, so measured and estimated figures never double-count,
  and every estimated figure is labelled as one.
- **Flight recorder**: one JSONL line per decision, rotated, with `belay status` and
  `belay incidents` reading the files directly so they work when the gateway is down.
- **Alerts** to Telegram and generic webhooks, both opt-in, rate-limited and deduplicated.
  Plaintext webhook URLs are refused; inline bot tokens are accepted but warned about.
- **Account pausing** via the gateway's in-process `channels.stop`. Off by default, at most one
  stop per account until a human resumes, and a partial target is refused rather than guessed.
- **Restart settling window**: breaches in the first two minutes after gateway startup warn but
  never escalate, because a restart drains the channel ingress spool as a burst.

### Notes

Verified against openclaw 2026.8.2 and dogfooded on a live five-agent production gateway, where
enforcement, blocking, the flight recorder, `channels.stop` and resume were all exercised for real.

Belay never reads prompts, replies or tool parameters. Tool calls are hashed before counting, and
no type in the plugin has a field for message content.
