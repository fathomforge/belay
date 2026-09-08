# Changelog

All notable changes to Belay are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project uses
[semantic versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] - 2026-09-07

An independent first-customer review found that the CLI reported a clean bill of health it had not
earned, and that several documented claims contradicted the project's own documented limits. This
release fixes the CLI behaviour and corrects the claims.

### Changed — breaking for scripts

- **`belay incidents` and `belay status` no longer treat "could not read anything" as "nothing
  happened".** An unconfigured path, an absent file and a file that was read and found empty are now
  three distinct outcomes. Previously all three printed `No incidents in the last 24h.` and exited
  0, so an operator whose recorder was never configured was told everything was fine — the exact
  failure this project exists to prevent.
- **New exit code 2**: the files could not be read, so the absence of incidents is not evidence.
  Exit 0 now means the report reflects files actually read; exit 1 remains usage errors.
- **`incidents --json` now emits an object**, `{ source, path, hours, agent, error, incidents }`,
  instead of a bare array. A bare `[]` could not distinguish "read the trail, found nothing" from
  "never read anything", and a consumer treating the second as the first is the same silent
  all-clear in machine-readable form.
- An empty trail is now reported as empty *and* labelled as insufficient evidence that metering is
  working, pointing at the gateway log check that actually settles it.

### Fixed — documentation claims that did not hold

- Request-size limits were described as working "on any provider" while the provider table showed
  byte data absent for OpenAI. Now qualified, and the exactness of byte *counting* is separated from
  the single paired-turn experiment measuring how well those bytes track text.
- Estimation accuracy was stated as ±50%. The project's own published calibration table shows
  −60% to +125% at the default divisor, with four of ten samples outside ±50%. Corrected everywhere.
- "The agent cannot spend" overstated what ending a run does. A new **Where enforcement actually
  lands** section states that limits are checked when a hook fires, that the crossing call still
  completes, and that a model-only loop is stopped at the next run rather than mid-run.
- Privacy wording claimed non-access was "structurally impossible". Belay is privileged in-process
  code, not a sandbox; the docs now describe auditable restraint and say plainly what a bug could
  reach. The blanket "cannot access credentials" claim is narrowed to the alert token it is given.
- Pricing precedence is now documented in order: Belay's own `prices`, then the gateway's
  `models.providers.*.models[].cost`, then the bundled table, then unpriced.
- Estimation is no longer described as an automatic fallback before the later note that it is off
  by default.
- The pause rung's unavailability on 2026.8.2 is noted at the first mention of the ladder rather
  than only in a later section.
- Remaining bare `belay ...` command references corrected to `npx @fathomforge/belay ...`.
- `docs/CALIBRATION.md` cited an issue that was closed as superseded; it now also cites the
  canonical open one.
- `SECURITY.md` described dev dependencies as pinned; they are pinned by the lockfile, and the
  manifest carries a caret range.

### Added

- **Prove it is actually metering** — a before/after acceptance check, because a startup line only
  proves the plugin loaded, not that its hooks were registered.
- CLI regression tests covering unconfigured, absent, unreadable and read-but-empty sources for both
  commands, in text and JSON, including exit codes.

## [0.1.0] - 2026-09-07

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
- **Request-size limits** (`requestBytesPerRun` / `PerMinute` / `PerDay`): exact ceilings on the
  bytes an agent can push at a model. Measured to about 1% and independent of whether the provider
  reports token usage, so they work everywhere. These are the precise alternative to a spend cap.
- **Cost estimation from request size**, off by default, for providers that report no token usage. Uses transport
  metadata (`requestPayloadBytes` / `responseStreamBytes`) only, never content. Only models
  observed reporting nothing are estimated, so measured and estimated figures never double-count,
  and every estimated figure is labelled as one. Accuracy was measured against the provider's own
  tokenizer and is roughly ±50% on realistic content; the full experiment, data and reasoning are
  published in [docs/CALIBRATION.md](docs/CALIBRATION.md).
- **Flight recorder**: one JSONL line per decision, rotated, with `belay status` and
  `belay incidents` reading the files directly so they work when the gateway is down.
- **Alerts** to Telegram and generic webhooks, both opt-in, rate-limited and deduplicated.
  Plaintext webhook URLs are refused; inline bot tokens are accepted but warned about.
- **Account pausing** via the gateway's in-process `channels.stop`. Off by default, at most one
  stop per account until a human resumes, and a partial target is refused rather than guessed.
- **Restart settling window**: breaches in the first two minutes after gateway startup warn but
  never escalate, because a restart drains the channel ingress spool as a burst.
- **`belay reset [--agent <id>]`**: clears a stuck ladder rung. The top rung is deliberately sticky,
  which left no way down once a scope reached it.
- **Prices are read from `models.providers.*.models[].cost`**, so pricing is not configured twice.

### Known limitations

- **The pause rung cannot fire on OpenClaw 2026.8.2.** Gateway method dispatch is reserved for
  plugin HTTP routes, and a hook handler is not a request scope, so `channels.stop` is refused. The
  ladder therefore tops out at `endRun` by default. Ending a run already blocks the offending run
  and every later one while the breach persists.
- **`google/gemini-3.8-flash` reports no token usage**, so dollar caps cannot work on it without
  estimation ([#141581](https://github.com/openclaw/openclaw/issues/141581)). Request-size limits
  are exact and unaffected.
- **Anthropic models are unusable on 2026.8.2**
  ([#141582](https://github.com/openclaw/openclaw/issues/141582)), so Belay's behaviour with them
  is untested.
- Estimated costs carry roughly ±50% error; see [docs/CALIBRATION.md](docs/CALIBRATION.md).

### Notes

Verified against openclaw 2026.8.2 and dogfooded for a week on a live five-agent production
gateway. Enforcement, blocking, alert delivery, the flight recorder, deduplication and account
stop/resume were all exercised against real traffic rather than only in tests, and the shipped
thresholds are derived from what that week measured.

Fifteen bugs were found and fixed during that period, most of them in the class where a guardrail
looks installed and silently enforces nothing.

Belay never reads prompts, replies or tool parameters. Tool calls are hashed before counting, and
no type in the plugin has a field for message content.
