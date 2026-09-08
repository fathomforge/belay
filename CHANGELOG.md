# Changelog

All notable changes to Belay are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project uses
[semantic versioning](https://semver.org/spec/v2.0.0.html).

## [0.4.0] - 2026-09-07

A third review pass. The 0.3.0 enforcement fix held; these are three places where the *previous*
round of reporting fixes was incomplete.

### Fixed

- **The metering check no longer misdiagnoses a token-only provider.** 0.3.0 told you to watch the
  request-bytes counter and treated a frozen one as "loaded but seeing nothing" — but this
  project's own provider table says OpenAI reports token usage and *not* transport bytes, so a
  perfectly healthy install on that provider would have been condemned by its own acceptance check.
  This was the mirror image of the bug the byte column was added to fix. The procedure now names
  both signals, says which to watch for which provider, and reports "inconclusive" rather than
  "broken" when a provider reports neither.
- **`belay status --json`** emits exact, unrounded counters. The human table rounds to kB/MB/GB, so
  a genuine increase could be invisible on a large total — making the before/after comparison
  unreliable exactly where totals are biggest. It also reports `decisionsLast24h: null` when the
  trail could not be read, rather than `0`.
- **Partial trail corruption is now disclosed on every output path.** 0.3.0 counted skipped records
  but only mentioned them in text output, and only when at least one record survived the requested
  filter. So `incidents --json` returned `source: "ok"` with no hint of loss, a filtered window with
  no surviving matches reported a clean empty result, and `status` reported a decision count drawn
  from a damaged file. The skipped line could be the very incident being looked for. JSON now
  carries `complete` and `skipped`; text warns before reporting an empty window; `status` marks its
  count incomplete.
- **A stale record can no longer corroborate a current ladder rung.** The lookup kept only the last
  action string per scope, ignoring the record's rung and timestamp, so a `blockTool` from two days
  ago made `status` print "ended a run" for an `endRun` rung reached later in observe mode — while
  the same report said there had been zero decisions in 24h. Corroboration now requires a record
  for the *same* rung, no older than the ladder action it claims to evidence.

### Added

- Regression tests for stale-versus-matching corroboration, partial corruption across JSON/status/
  filtered-empty paths, provider-neutral metering advice, and exact `--json` counters.

## [0.3.0] - 2026-09-07

A second independent review pass. The headline item is an enforcement gap, not a wording problem:
the model-storm incident this project was built around met no gate at all.

### Fixed — enforcement

- **A model-call-rate breach now gates the next run.** `model_call_rate` and
  `request_bytes_minute` were evaluated only on the tool and model-call surfaces, so an agent that
  looped without ever calling a tool met no gate: the ladder climbed to `endRun` and the following
  run was still allowed through. Spend and byte budgets did not cover it either — spend needs a
  provider that reports usage, and the byte limits are unset by default. Both triggers are now on
  the run gate, so a persistent storm is refused while it is still inside the window and allowed
  again once it ages out. `modelCallsPerMinute` ships on by default, so this is covered on a stock
  install. Tool-gate-only triggers (`identicalToolCalls`, `toolCallsPerMinute`,
  `toolErrorsPerMinute`) are unchanged and still cannot bound a model-only loop.

### Fixed — reporting

- **`belay status` shows a request-bytes column.** The metering acceptance procedure added in 0.2.0
  told you to watch a byte total that the command never printed. Worse, on a provider that reports
  no token usage the only visible figure — spend — sits at `$0` forever, and the README diagnosed
  an unchanged figure as "Belay is seeing nothing". A healthy install could not pass its own check.
- **`$0` spend against non-zero bytes is now explained** in the status output as the signature of a
  provider that reports no usage, rather than left to read as "nothing was spent".
- **A corrupt trail is no longer reported as an empty one.** A file whose lines all fail to parse,
  or a record whose timestamp cannot be parsed, is `unreadable` with exit 2 instead of a clean
  zero-incident result. Partially damaged trails still report their surviving records, and now
  disclose how many were skipped.
- **A stored ladder rung is no longer described as an action that happened.** Observe mode advances
  the ladder without acting, so with no corroborating trail record `status` says
  `ladder at endRun; action unverified` instead of `ended a run`.
- **A malformed `--hours` is rejected** with exit 1. `Number("garbage")` is `NaN` and every
  `>= NaN` comparison is false, so an unvalidated value silently discarded every real incident and
  still reported success.
- The empty-trail advice in both commands now points at the request-bytes counter, which settles
  whether metering is happening, instead of the startup log line, which only proves the plugin
  loaded.

### Fixed — documentation

- Enforcement overshoot is no longer described as "roughly one call": a burst can put several calls
  in flight between gate evaluations, and the startup settling window suppresses escalation.
- `docs/SECURITY-CONTROLS.md` said "it cannot read your content" and "it cannot see content, by
  design" while the README had already been corrected to say hook payloads carry content. Both now
  describe auditable restraint rather than isolation, as does `SECURITY.md`'s recorder paragraph.
- The claim that a single global limit is "a shared pool that one noisy agent can exhaust for the
  others" was wrong — metering is scoped per agent and a global limit is the default threshold for
  each scope. Corrected, with the genuinely shared upstream resources described separately.
- The 0.1.0 changelog entry now carries a note identifying the descriptions that later releases
  corrected, rather than leaving them standing as unqualified history.

### Added

- `CHANGELOG.md` ships in the npm package.
- Tests for run-gate model-rate enforcement and window ageing, and CLI regression tests for corrupt
  trails, unparseable timestamps, unverified ladder actions, the byte column and `--hours`
  validation.

## [0.2.1] - 2026-09-07

### Fixed

- The "Prove it is actually metering" procedure added in 0.2.0 told you to re-read the state file
  immediately after sending a test turn. The state file flushes about every 10 seconds, so a
  correctly working install showed an unchanged number and looked broken. The procedure now waits,
  and names the flush as the first thing to suspect. Found by running the documented steps against
  a live gateway rather than reasoning about them.

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
  working. (Corrected twice since: 0.3.0 replaced the startup-log advice with the request-bytes
  counter, and 0.4.0 made that provider-aware — bytes or spend, whichever your provider reports.)

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

> [!NOTE]
> Some descriptions in this 0.1.0 entry were later found to be wrong and were corrected in 0.2.0
> and 0.3.0. Specifically: request-size limits were described as working on any provider (they need
> the gateway to report transport bytes, which not every provider does); estimation error was given
> as ±50% (the measured range is −60% to +125% at the default divisor); and `channels.stop` and
> resume were listed as verified when the pause rung is in fact refused on 2026.8.2. The entry is
> left as published, with this note, rather than silently rewritten.


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
