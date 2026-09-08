# Belay

**A seatbelt for OpenClaw agents.** Spend caps, model-call and tool-call rate limits, and a
graceful pause ladder — running inside your gateway, with no server, no account, no telemetry, and
no network calls except the alerts you configure yourself.

*Not affiliated with the OpenClaw Foundation.*

```
warn  →  block a tool call  →  end the run  →  pause the account
```

Your agent doesn't get killed. It gets caught.

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
| **Request-size limits** | Bytes sent to models per run, per minute, per day — **measured exactly**, on any provider |
| **Spend caps** | Per run, per hour, per calendar day, per agent (needs a provider that reports token usage) |
| **Model-call rate** | The storm: dozens of calls a minute from one stuck turn |
| **Tool-call rate** | Runaway tool use |
| **Identical-call limit** | The same call repeated across a run — the retry-loop signature |
| **Tool-error rate** | Error storms, which usually precede cost storms |
| **The pause ladder** | Escalates only as far as it needs to, and steps back down when things go quiet |
| **Flight recorder** | A local JSONL line per decision, readable with `belay incidents` |

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
Run it that way for a week. Check `belay incidents` to see what it *would* have done. When the
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
subsequent one while the breach persists** — the agent cannot spend. Pausing additionally stops the
channel accepting new inbound messages, which is a smaller increment than it appears.

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

**It cannot access:**
- Your prompts or your agents' replies
- Tool parameters — they are SHA-256 hashed before counting, and the hash is what's stored
- Your API keys or credentials
- Any network destination except the alert endpoints you configure

**It can see:** token counts, model and provider names, tool *names*, timings, and your Belay
config. The flight recorder stores decisions — scope, rung, rule, the number that broke it — and
has no field for content. It rebuilds every record field by field, so a bug elsewhere can't smuggle
text onto disk.

**If Belay itself has a bug, it gets out of the way.** Every hook handler is wrapped so an
exception is logged and treated as "pass". A defect degrades to *no guardrail*, never to a downed
gateway or a blocked message. Your gateway's availability never depends on this code being
bug-free — only your cost protection does.

## Costs and pricing

Belay computes cost from token counts using a small bundled price table, because OpenClaw only
records dollar figures when you've configured `models.providers.*.models[].cost` — and most people
haven't. A meter that trusted those numbers would report $0.00 and enforce nothing.

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

Prices come from your existing `models.providers.<id>.models[].cost` — Belay reads it, so you do
not configure pricing twice. A model priced nowhere is reported as unpriced rather than guessed at.

### Exact limits vs estimated ones

Belay measures two things very differently, and it is worth knowing which is which:

|  | accuracy | works when the provider reports no usage |
|---|---|---|
| Rate limits (calls, repeats, errors) | exact | yes |
| **Request-size limits** (`requestBytesPer*`) | **exact, ~1%** | **yes** |
| Spend caps from reported usage | exact | no |
| Spend caps from estimation | **±50%** | yes, opt-in |

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
A spend cap with no numbers is inert, so Belay falls back to **estimating cost from request size**.

`model_call_ended` carries `requestPayloadBytes` and `responseStreamBytes` — the *size* of the
request and response, never their content. Belay converts bytes to tokens, prices the result
normally, and labels every figure it produces:

```
this run has spent $0.62, reaching the $0.50 cap (estimated from request size)
```

**How accurate is that?** We measured it against Gemini's own tokenizer across ten content types.
The honest answer: **bytes do not determine tokens.** The true ratio ranges from 1.39 bytes/token
for identifier-heavy text to 7.88 for varied English prose — a 5.7× spread — so no single divisor
is accurate for everything. Treat an estimated figure as **±50% on realistic content**, and set
estimated caps with margin accordingly.

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
  spend cap is more useful to you than none. Shipping a ±50% number as if it were accounting is not
  something this project is willing to do by default.
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
