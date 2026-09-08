# Security

Belay runs inside your OpenClaw gateway, in the same process as your agents. That is a privileged
position, and this document is the honest account of what it means.

## Reporting a vulnerability

Open a [GitHub security advisory](https://github.com/fathomforge/belay/security/advisories/new) —
this reports privately, not as a public issue.

Please include what you did, what happened, and what you expected. A proof of concept helps but
isn't required. Expect an acknowledgement within 72 hours and an initial assessment within a week.

Coordinated disclosure: I'll agree a timeline with you, default 90 days, and credit you unless you'd
rather I didn't. **If a finding turns out to be in OpenClaw itself rather than in Belay, I'll report
it upstream to the OpenClaw project** and tell you that's what happened.

## What Belay can access

**By design, it never reads:**

Belay is privileged in-process code, not a sandbox. Some hook payloads it receives do carry
conversation content; the table below describes auditable restraint in what the code reads and
keeps, not a privilege boundary that would make a bug or a malicious change harmless.

| Not read or retained | How the code avoids it |
|---|---|
| Prompts | The `llm_output` hook carries `prompt`; Belay's usage type has no field for it |
| Agent replies | Same — `assistantTexts` is never read |
| Tool parameters | Hashed (SHA-256, truncated) before counting; only the hash is retained |
| Credentials, API keys | Never read from config or environment, except an alert token you name yourself |
| Session transcripts | Never opened |

**It does read:** token counts, provider and model names, tool *names*, timings, run and session
identifiers, and its own configuration block.

**It writes** exactly two files, both only if you configure them, both mode `0600`:

- `stateFile` — per-agent daily spend totals and ladder positions
- `recorder.file` — one JSONL line per decision: scope, rung, rule, the number that broke it, and
  a plain-English reason built from numbers

Neither has a field for message content. The recorder rebuilds each record field by field, so a bug
elsewhere in the plugin cannot cause content to be written.

## Network

**Belay makes no network calls by default.** With no alert configuration, no HTTP transport object
is constructed at all — this is asserted by a test, not just intended.

When you configure alerts, it contacts exactly what you named:

- **Telegram** — `api.telegram.org` only. The bot token appears in the request URL, as that API
  requires, and never in a request body.
- **Webhook** — the URL you set. **Plaintext `http://` is refused**; alerts describe security
  incidents and shouldn't cross the network in the clear.

Alert payloads contain scope, rung, rule name, numbers and a reason string. No message content.

There is no telemetry, no phone-home, no update check, and no analytics. There never will be — if
that changes, it would be a different product with a different name.

## Failure behaviour

**Fail open on bugs, fail closed on policy.**

- An exception inside any hook handler is caught, logged, and treated as "pass". A defect in Belay
  degrades to *no guardrail* — never to a downed gateway or a blocked message.
- A deliberate policy decision to block is returned as a block. That's the part that's allowed to
  stop your agent.
- Malformed configuration never throws. Bad values are dropped, reported at startup, and the rest
  of your config still applies. A plugin that refuses to load will block gateway readiness, so
  Belay always loads.
- A corrupt or unwritable state file degrades to in-memory-only accounting with a warning.
- An unwritable flight recorder disables itself after one warning rather than logging on every call.

The one thing Belay does with external side effects — `channels.stop` — is **off unless you enable
it**, issues at most one stop per account until a human resumes, and refuses to act on a partial or
missing target rather than guessing which account to pause.

## Supply chain

A guardrail plugin with a backdoor would be the worst possible outcome, so:

- **Zero runtime dependencies.** Nothing third-party is installed into your gateway.
- **No `postinstall` or `preinstall` scripts.**
- Dev dependencies are limited to TypeScript and `@types/node`, and are pinned by the committed
  lockfile (`package.json` carries a caret range for `@types/node`; `npm ci` installs the locked
  version).
- Releases are published with npm provenance and signed tags.
- `npm pack` contents are reviewed before release; the published package contains only `dist/`,
  `bin/`, the manifest, and documentation.

Verify a release yourself:

```bash
npm view @fathomforge/belay dist.integrity
npm pack @fathomforge/belay && tar -tzf fathomforge-belay-*.tgz
```

## Threat model

**Belay defends against:** an agent spending more than you intended, calling models or tools in a
runaway loop, retrying a failing operation indefinitely, and doing any of the above unnoticed
because nothing was watching.

**Belay does not defend against:** prompt injection, a compromised model provider, a malicious
plugin running alongside it, someone with write access to your `openclaw.json`, or an agent that
does something harmful *within* its limits. It counts and it caps — it does not judge intent. Tool
allowlists, sandboxing and `openclaw security audit` cover different ground and you still need them.

**An important limitation:** an operator with config write access can disable Belay. It is a safety
belt for your own agents, not a control that constrains a hostile administrator.

## Scope for reports

**In scope:** anything that causes Belay to leak message content, credentials or tool parameters;
to make an unconfigured network call; to crash or hang the gateway; to fail to enforce a configured
limit; or to be bypassed by an agent's own behaviour.

**Out of scope:** OpenClaw core issues (report those upstream, and tell me), missing features,
and the documented limitation that a config-file writer can turn Belay off.
