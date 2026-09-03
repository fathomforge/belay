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
| **Spend caps** | Per run, per hour, per calendar day, per agent |
| **Model-call rate** | The storm: dozens of calls a minute from one stuck turn |
| **Tool-call rate** | Runaway tool use |
| **Identical-call limit** | The same call repeated across a run — the retry-loop signature |
| **Tool-error rate** | Error storms, which usually precede cost storms |
| **The pause ladder** | Escalates only as far as it needs to, and steps back down when things go quiet |
| **Flight recorder** | A local JSONL line per decision, readable with `belay incidents` |

## Install

```bash
openclaw plugins install npm:@fathomforge/belay
```

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

Restart the gateway, then **verify — don't assume**:

```bash
openclaw config get plugins.entries.belay
openclaw logs --limit 50 | grep belay      # expect a "belay active: ..." line
```

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

## See what it's doing

```bash
belay status
belay incidents --hours 24
belay incidents --agent my-group-bot --json
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

Set `ladder.maxRung: "endRun"` to opt out of automatic pausing entirely while keeping everything
else.

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

Two situations produce an honest "I don't know" rather than a wrong number, and Belay tells you
about both:

- **The model isn't in the table** and you haven't set a price override.
- **The provider reported only a token total**, with no input/output split. Those are priced up to
  5× apart, so no honest dollar figure exists.

In both cases the tokens are still metered and your rate limits still work — but you'll be warned
that your spend caps are incomplete. Fix it with a `prices` override.

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
