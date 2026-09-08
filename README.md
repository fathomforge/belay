# Belay

**A seatbelt for OpenClaw agents.** Spend caps, model-call and tool-call rate limits, and a
graceful pause ladder — running inside your gateway, with no server, no account, no telemetry, and
no network calls except the alerts you configure yourself.

*Not affiliated with the OpenClaw Foundation.*

```
warn  →  block a tool call  →  end the run  →  pause the account
                                               └─ not available on OpenClaw 2026.8.2; the
                                                  shipped ladder tops out at "end the run"
```

Your agent doesn't get killed. It gets caught. Enforcement lands between calls, not mid-call —
[what that does and doesn't buy you](#where-enforcement-actually-lands).

---

## Why this exists

OpenClaw has no spend cap, no model-call rate limit, no cross-session budget, and no graceful
pause. The default agent runtime timeout is **48 hours**. Built-in loop detection is off by
default, tool-only, and single-run. Both upstream requests for spending controls were closed as
"not planned" — including one from an operator who lost **$169 in a single session** when a
failover re-sent a 517K-token context down a chain of pricier models.

Meanwhile the failure modes are mundane and recurring: an agent invents a task and loops on it, a
hallucinated URL 404s and gets retried 700 times, an hourly heartbeat quietly reprocesses a 174K
context all month.

Belay is the layer that notices and steps in — gradually.

## What it does

| Guard | What it catches |
|---|---|
| **Request-size limits** | Bytes sent to models per run, per minute, per day — **counted exactly**, wherever your gateway reports transport bytes ([which is not everywhere](#provider-support)) |
| **Spend caps** | Per run, per hour, per calendar day, per agent (needs a provider that reports token usage) |
| **Model-call rate** | The storm: dozens of calls a minute from one stuck turn |
| **Tool-call rate** | Runaway tool use |
| **Identical-call limit** | The same call repeated across a run — the retry-loop signature |
| **Tool-error rate** | Error storms, which usually precede cost storms |
| **The pause ladder** | Escalates only as far as it needs to, and steps back down when things go quiet |
| **Flight recorder** | A local JSONL line per decision, readable with `npx @fathomforge/belay incidents` |

## Install

```bash
openclaw plugins install npm:@fathomforge/belay --force --accept-capabilities
```

`--force --accept-capabilities` is required because Belay is not in ClawHub's review metadata, and
because it asks for hook capabilities. OpenClaw wants explicit consent for both, which is the right
default for anything that can block your agents.

**Installing from source** (for contributors, or to run an unreleased commit):

```bash
git clone https://github.com/fathomforge/belay && cd belay
npm ci && npm run build
openclaw plugins install --link "$PWD" --force --accept-capabilities
```

The build step is not optional. `dist/` is deliberately not committed, so
`openclaw plugins install git:github.com/fathomforge/belay` fails with
`extension entry not found: ./dist/index.js` — install from npm or build it yourself.

Then add to `openclaw.json`:

```json
{
  "plugins": {
    "entries": {
      "belay": {
        "enabled": true,
        "config": {
          "mode": "observe",
          "timeZone": "America/Los_Angeles",
          "limits": { "spendPerDayUsd": 5, "modelCallsPerMinute": 30 },
          "recorder": { "file": "/home/node/.openclaw/belay-trail.jsonl" },
          "stateFile": "/home/node/.openclaw/belay-state.json"
        }
      }
    }
  }
}
```

**Grant conversation-hook access** — Belay cannot meter anything without it:

```bash
openclaw config patch --stdin <<'JSON'
{ plugins: { entries: { belay: { hooks: { allowConversationAccess: true } } } } }
JSON
```

Non-bundled plugins are blocked from typed conversation hooks unless you opt in. Without this the
plugin loads, reports itself active, and silently does nothing — you'll see
`typed hook "llm_output" blocked because ...` in the gateway log.

Restart the gateway, then **verify — don't assume**:

```bash
openclaw config get plugins.entries.belay
openclaw logs --limit 200 | grep 'belay\] active'   # expect a "[belay] active: caps=..." line
```

A smaller `--limit` often misses it: the line is written once at startup, and a busy gateway
produces enough channel-polling output to push it out of a short tail.

> [!WARNING]
> **Setting `"enabled": true` for a plugin that isn't actually installed will block your gateway
> from becoming ready.** Install first, then enable. If your gateway won't start after editing
> config, this is the first thing to check.

### Start in observe mode

`"mode": "observe"` meters, records and alerts, but **never blocks, ends or pauses anything**.
Run it that way for a week. Check `npx @fathomforge/belay incidents` to see what it *would* have done. When the
reports look right, switch to `"mode": "enforce"`.

This matters most if your gateway serves real users. A guardrail you don't trust yet should not be
able to interrupt anyone.

**Per-agent modes** let you enforce where it's safe and observe where it isn't:

```json
{
  "mode": "enforce",
  "agents": {
    "my-private-bot": { "spendPerDayUsd": 2 },
    "my-group-bot":   { "mode": "observe" }
  }
}
```

A global `"mode": "observe"` always wins over a per-agent `enforce`, so a gateway-wide safety
setting can't be defeated by a stale override.

## Where enforcement actually lands

Belay runs on the gateway's hooks, so it acts at the points those hooks give it: **before a tool
call**, and **before a run**. It is not in the network path to your provider, and it cannot
interrupt a model call that is already in flight.

What that means concretely:

- **A limit is checked when a hook fires, so the call that crosses the line still completes.**
  Expect overshoot of roughly one call beyond the threshold. Set caps below the number that would
  actually hurt, not at it.
- **A tool-driven loop is stopped quickly**, because every tool call passes through a gate.
- **A model-only loop — one that never calls a tool — is stopped at the boundary of the next run,
  not mid-run.** This is the weakest case, and it is the one a runaway agent is most likely to hit.
  Rate and byte limits still record and alert throughout; the *blocking* arrives at the next run.
- **None of these are hard ceilings on your invoice.** They bound how far a breach runs, not how
  much the breach in progress can cost.

If you need a hard ceiling, put it where hard ceilings live: your provider's own spend limits.
Belay is the layer that tells you and slows things down; it is not a billing kill switch.

## Prove it is actually metering

The startup line only proves the plugin loaded. The README above warns that a plugin can report
itself active while its hooks are blocked — so confirm a real turn moved a counter:

```bash
# 1. Note the current byte total (or "no state yet")
npx @fathomforge/belay status --state <stateFile> --trail <trailFile>

# 2. Send one ordinary turn through any agent
openclaw agent --agent <your-agent> --message "Reply with the single word: ok"

# 3. The same command should now show a larger figure for that agent
npx @fathomforge/belay status --state <stateFile> --trail <trailFile>
```

If the number does not move, Belay is loaded but seeing nothing. In order of likelihood:
`hooks.allowConversationAccess` is not set; the plugin entry is disabled; or the gateway was not
restarted after the config change.

An empty incident trail is **not** evidence of metering — a plugin that never registered a hook
also records nothing. That is why the CLI distinguishes "read the trail, found nothing" from
"could not read anything", and exits non-zero for the second.

## See what it's doing

Belay ships a CLI in the same package. Installing the plugin does **not** put `belay` on your
`PATH` — OpenClaw installs plugins into its own managed npm prefix — so run it with `npx`:

```bash
npx @fathomforge/belay status
npx @fathomforge/belay incidents --hours 24
npx @fathomforge/belay incidents --agent my-group-bot --json
```

It reads the two files you configured, which it cannot guess. Pass them explicitly:

```bash
npx @fathomforge/belay status \
  --state /home/node/.openclaw/belay-state.json \
  --trail /home/node/.openclaw/belay-trail.jsonl
```

…or set `BELAY_STATE_FILE` and `BELAY_TRAIL_FILE` once and drop the flags. With neither, `belay`
tells you the paths are unconfigured rather than pretending there is nothing to report.

If your gateway runs in Docker, run it inside the container, where those paths exist:

```bash
docker exec -e BELAY_STATE_FILE=/home/node/.openclaw/belay-state.json \
            -e BELAY_TRAIL_FILE=/home/node/.openclaw/belay-trail.jsonl \
            <container> npx @fathomforge/belay status
```

```
Belay status

  Spend recorded today (per agent):
    main                    $0.8421  (2026-09-02)
    group-bot                  $2.1  (2026-09-02)  <- PAUSED

  Decisions in the last 24h: 3
    logged: 1
    blocked: 1
    paused: 1
```

Both commands read local files directly, so they work even when the gateway is down — which is
when you most want them.

## Configuration

Every limit is optional. **An unset limit is not enforced** — it is never treated as zero.

```json
{
  "mode": "enforce",
  "timeZone": "America/Los_Angeles",
  "limits": {
    "spendPerRunUsd": 0.5,
    "spendPerHourUsd": 2,
    "spendPerDayUsd": 5,
    "modelCallsPerMinute": 30,
    "toolCallsPerMinute": 60,
    "identicalToolCalls": 20,
    "toolErrorsPerMinute": 30
  },
  "agents": {
    "my-group-bot": { "spendPerDayUsd": 1 }
  },
  "ladder": {
    "cooldownMs": 60000,
    "decayMs": 900000,
    "renotifyMs": 21600000,
    "maxRung": "endRun"
  },
  "alerts": {
    "minRung": "warn",
    "telegram": { "botTokenEnv": "BELAY_TELEGRAM_TOKEN", "chatId": "<your chat id>" }
  },
  "pause": { "enabled": false },
  "recorder": { "file": "/home/node/.openclaw/belay-trail.jsonl" },
  "stateFile": "/home/node/.openclaw/belay-state.json"
}
```

**Defaults are deliberately timid.** No spend cap is enabled out of the box — Belay can't know what
*you* consider expensive, and a tool that blocks work on install gets uninstalled. Rate limits ship
on but set well above any sane workload. Account pausing is off unless you turn it on.

### Pausing an account

The ladder's top rung stops a channel account outright. **On OpenClaw 2026.8.2 this does not work,
and Belay ships with the ladder topping out at `endRun` because of it.**

`channels.stop` is reached through the gateway's method dispatch, which is reserved for plugin HTTP
routes — a hook handler is not an authenticated request scope, so the call is refused:

```
Gateway method dispatch is reserved for plugin HTTP routes that declare
contracts.gatewayMethodDispatch: ["authenticated-request"]
```

Declaring that contract is not sufficient; the call site is the problem. Verified on a live gateway.

This costs less than it sounds. **Ending the run already blocks the offending run and every
subsequent one while the breach persists**. Pausing additionally stops the channel accepting new
inbound messages, which is a smaller increment than it appears.

Be clear about *when* that bites, though — see [Where enforcement actually
lands](#where-enforcement-actually-lands). Ending a run stops the next run, not the model call
already in flight.

If you set `ladder.maxRung: "pause"` and `pause.enabled: true` anyway, Belay will attempt it, and
**will tell you plainly when it fails**, including the exact command to stop the account by hand:

```
PAUSE FAILED (...) -- the account is still running.
Stop it by hand: openclaw gateway call channels.stop --params '{"channel":"telegram","accountId":"default"}'
```

An alert that claimed a pause which never happened would be worse than no alert at all.

**Use `botTokenEnv`, not `botToken`.** An inline token ends up in config backups, in
`openclaw config get` output, and in any screenshot you post while asking for help. Belay accepts
an inline token but will warn you about it every startup.

## What Belay can and cannot see

This is a guardrail plugin running inside your gateway, so the honest answer matters.

First, the honest framing: **Belay is privileged in-process code, not a sandbox.** It runs inside
your gateway with the access the gateway hands its hooks, and some of those hook payloads do carry
conversation content. What follows describes what the code *does* with that — deliberate restraint
you can audit, not a boundary that makes misbehaviour impossible.

**It does not read or retain:**
- Your prompts or your agents' replies. The hook payload carries them; Belay reads named numeric
  and metadata fields off it and never touches those.
- Tool parameters in the clear — they are SHA-256 hashed before counting, and only the hash is
  retained. Hashing does mean the values pass through memory.

**It does not read your provider credentials.** The one secret it touches is the alert token you
give it yourself, read from the environment variable you name in `alerts.*.botTokenEnv`, and used
only to send alerts to the endpoint you configured.

**It makes no network connection** except to those alert endpoints.

**It can see:** token counts, model and provider names, tool *names*, timings, and your Belay
config. The flight recorder stores decisions — scope, rung, rule, the number that broke it — and
has no field for content. It rebuilds every record field by field, so content cannot ride along in
a passed-through object.

None of this is enforced by a privilege boundary. A bug in this code, or a malicious change to it,
could read what the hook payload contains. That is true of every in-process plugin in your gateway,
which is why the source is small, dependency-free and auditable — and why you should read it rather
than take this section's word for it.

**If Belay itself has a bug, it gets out of the way.** Every hook handler is wrapped so an
exception is logged and treated as "pass". A defect degrades to *no guardrail*, never to a downed
gateway or a blocked message. Your gateway's availability never depends on this code being
bug-free — only your cost protection does.

## Costs and pricing

Belay computes cost from token counts and a price per model. It looks for that price in three
places, in this order:

1. **Belay's own `prices` block**, if you set one.
2. **Your gateway's `models.providers.*.models[].cost`**, adopted automatically — so you do not
   configure pricing twice.
3. **A small bundled price table**, as a fallback for common models.

A model priced in none of the three is reported as **unpriced**, never guessed at. The bundled table
exists because OpenClaw only records dollar figures when you have configured costs yourself, and
most people haven't — a meter that simply trusted those numbers would report $0.00 and enforce
nothing.

Three situations produce an honest "I don't know" rather than a wrong number, and Belay warns about
each of them:

- **Your provider reports no token usage at all.** Verified for `google/gemini-3.8-flash` on
  OpenClaw 2026.8.2 and reported upstream as
  [#141581](https://github.com/openclaw/openclaw/issues/141581). Check yours with
  `openclaw status --usage`.
- **The model isn't in the price table** and you haven't set a `prices` override.
- **The provider reported only a token total**, with no input/output split. Those are priced up to
  5× apart, so no honest dollar figure exists.

### Provider support

What a provider reports decides which controls work. Measured on OpenClaw 2026.8.2:

| provider | token usage | request size | use |
|---|---|---|---|
| **OpenAI** (`gpt-5.4-nano`) | **✓ reported** | ✗ absent | **Exact dollar caps.** Set prices and go |
| **Google** (`gemini-3.8-flash`) | ✗ absent | **✓ reported** | **Exact request-size limits** |
| Anthropic | untestable | untestable | OpenClaw 2026.8.2 could not complete a request to any Anthropic model, so neither signal could be observed ([#134951](https://github.com/openclaw/openclaw/issues/134951)) |

**Neither provider gives both signals**, which is why Belay carries both mechanisms and uses
whichever is available. If your provider reports usage you get exact spend caps; if it reports
sizes you get exact request-size limits; rate limits work on everything.

See [Costs and pricing](#costs-and-pricing) for where prices come from and in what order.

### Exact limits vs estimated ones

Belay measures two things very differently, and it is worth knowing which is which:

|  | accuracy | works when the provider reports no usage |
|---|---|---|
| Rate limits (calls, repeats, errors) | exact | yes |
| **Request-size limits** (`requestBytesPer*`) | **exact count of reported bytes** | **yes — if bytes are reported** |
| Spend caps from reported usage | exact | no |
| Spend caps from estimation | **−60% to +125%** | yes, opt-in |

Two separate things get called "accurate" there, so to be precise about the byte row: Belay counts
the byte numbers the gateway hands it, and that count is exact. Separately, in one paired-turn
experiment on one provider, those reported bytes tracked the underlying text to about 1%. The first
is a property of the code; the second is a single measurement, not a guarantee for every provider.

If your provider reports token usage, use spend caps. If it does not — and many do not — **use
request-size limits.** They catch the same failures a spend cap catches (runaway loops, context
bloat, an agent hammering a model) and they are measured rather than inferred:

```json
{ "limits": { "requestBytesPerRun": 20000000, "requestBytesPerMinute": 10000000 } }
```

A rough anchor for choosing numbers: on the gateway this was developed against, an ordinary
conversational turn sent a few hundred kB, and the runaway incidents in the incident library would
have pushed tens of MB within a minute.

### When your provider reports no token usage

Some providers and harnesses report no token counts at all — Belay saw exactly this on a live
gateway, where `llm_output.usage` was `undefined` and the transcript entry's usage was all zeros.
A spend cap with no numbers is inert, so Belay can **estimate cost from request size** instead —
but only if you switch it on, with `"estimation": { "enabled": true }`. It is off by default.

`model_call_ended` carries `requestPayloadBytes` and `responseStreamBytes` — the *size* of the
request and response, never their content. Belay converts bytes to tokens, prices the result
normally, and labels every figure it produces:

```
this run has spent $0.62, reaching the $0.50 cap (estimated from request size)
```

**How accurate is that?** We measured it against Gemini's own tokenizer across ten content types.
The honest answer: **bytes do not determine tokens.** The true ratio ranges from 1.39 bytes/token
for identifier-heavy text to 7.88 for varied English prose — a 5.7× spread — so no single divisor
is accurate for everything.

At the default divisor of 3.5, the error across those ten samples ran from **−60% to +125%**. Four
of the ten fell outside ±50%, and three of those four were ordinary prose — the most common thing a
chat agent sends. So treat an estimated figure as **the right order of magnitude and nothing
finer**, and set estimated caps with a wide margin. The per-sample errors are in the table in
[docs/CALIBRATION.md](docs/CALIBRATION.md); check your own content type against it before trusting
a number.

The full experiment, the raw data, the arithmetic and the reasoning behind the chosen default are
published in **[docs/CALIBRATION.md](docs/CALIBRATION.md)**, with the scripts in
[`tools/calibration/`](tools/calibration) so you can rerun it yourself.

Details worth knowing:

- **It only estimates models it has actually seen report nothing.** A model that reports real usage
  is trusted permanently and is never estimated on top of, so nothing is ever double-counted.
- **It reads two integers of transport metadata.** No prompt, no reply, no tool parameters, and no
  extra hook permissions.
- **The default divisor (`estimation.bytesPerToken`, 3.5) is calibrated for
  `google/gemini-3.8-flash`.** Every provider has its own tokenizer, so it does not transfer. If
  your traffic skews to prose, raise it toward 5; to JSON and ids, lower it toward 2.5.
- **It is off by default.** Turn it on with `"estimation": { "enabled": true }` when an approximate
  spend cap is more useful to you than none. Shipping a number that can be off by +125% as if it
  were accounting is not something this project is willing to do by default.
- **Rate limits involve no estimation at all** and are exact on every provider.

> [!IMPORTANT]
> **Rate limits never depend on usage reporting at all.** Model-call storms, tool-call rates,
> identical repeated calls and error storms are counted directly, so they work regardless — and
> they're what catch a runaway loop, which is usually the failure that costs the most.

## Verified in production

Belay was developed against the real OpenClaw 2026.8.2 type definitions and then dogfooded on a
live five-agent gateway serving real users. Things that only showed up there, and are fixed:

- Typed hooks must be registered with `api.on`, not `api.registerHook`. The wrong one is accepted,
  logged as ignored, and never invoked — the plugin loads, reports itself active, and does nothing.
- Non-bundled plugins are blocked from conversation hooks until
  `hooks.allowConversationAccess: true` is set.
- Some hook contexts carry `agentId`, others only `sessionKey`; scoping naively on both metered one
  agent as two, so neither reached its cap.
- The provider reported no token usage at all, which made every spend cap silently inert. Hence
  estimation from request size.
- A gateway restart drains the ingress spool as a burst, so the first minutes after startup are not
  representative traffic. Hence the settling window.

Metering, enforcement, tool blocking, run-ending and the flight recorder have all been exercised
against a live gateway, not only in tests. The `channels.stop` pause rung was exercised too — and
**refused by the gateway**, which is how the limitation above was found. It is documented as not
working rather than listed as verified.

## Requirements

- OpenClaw `>= 2026.8.2`
- Node 20+
- **Zero runtime dependencies.** Nothing third-party is installed into your gateway.

## Uninstall

```bash
openclaw plugins uninstall belay
```

Remove the `plugins.entries.belay` block from `openclaw.json` and restart. Belay leaves behind only
the two files you configured (`stateFile`, `recorder.file`); delete them if you want it gone
entirely. Nothing else is touched.

## Security

See [SECURITY.md](SECURITY.md) for the threat model and how to report a vulnerability.

## License

MIT. Provided as-is, with no warranty — see [LICENSE](LICENSE).
