# Belay as a security control

Belay is usually described as a cost tool. That undersells it. **Cost is the symptom people notice
first; the underlying property is bounded agent behaviour**, and that is a security control.

Every other layer of your infrastructure already has this. Your web server has rate limits. Your
database has connection caps. Your API gateway has quotas. Your cloud account has spending alerts
and service limits. **The agent layer has none of it** — an autonomous process with tool access, a
48-hour default timeout, and no ceiling on what it can do per minute.

Belay is the rate limiter, quota and circuit breaker for the agent layer.

---

## The security model in one line

**Belay does not try to stop an agent doing the wrong thing. It bounds how much wrong it can do
before a human finds out.**

That distinction matters, because the dominant agent security risk — prompt injection — has no
reliable preventive fix. Content filters are bypassable, instruction hierarchies leak, and the
attack surface is every piece of text an agent reads. Bounding is the control that still works when
prevention fails.

## What it maps to

Using the vocabulary of the OWASP guidance for LLM applications:

| Risk | Belay's role |
|---|---|
| **Unbounded consumption** | **Direct mitigation.** Spend caps, request-size limits, model-call and tool-call rate limits, identical-call limits. This is the risk Belay exists for, and the ecosystem has essentially no off-the-shelf tooling for it |
| **Prompt injection** | **Impact bounding.** Injection succeeds; the resulting loop, spend or data volume is capped, and you are alerted within a minute rather than a month |
| **Excessive agency** | **Complementary.** Tool allowlists constrain *what* an agent may do. Belay constrains *how much* and *how fast*. Neither substitutes for the other |
| **Sensitive information disclosure** | **Volume bounding.** Request-size limits cap how many bytes an agent can push to an external model provider per run, minute and day |
| **Supply chain** | **Posture.** Zero runtime dependencies, no install scripts, no telemetry, no network by default — the control does not become a new attack surface |

## Five concrete scenarios

### 1. Prompt injection turns your agent into a data pump

A group member, a web page, or a document your agent reads contains instructions telling it to
gather files and summarise them. The agent complies — it has file tools, and the instruction looks
like a task.

Nothing in a tool allowlist stops this: reading files *is* an allowed action. What Belay does is cap
the volume. `requestBytesPerMinute` and `requestBytesPerDay` bound how much data can be pushed to
the model provider before the run is stopped and you are alerted. **The exfiltration is bounded in
size and duration rather than unlimited.**

Bounded, not prevented, and the bound is loose: the call that crosses the threshold still completes,
and if the agent is not calling tools the stop lands at the next run rather than mid-run. Size the
limit as "how much am I willing to lose", not "how much will be sent".

This is deliberately a volume control, not a content control. Belay never reads what is in the
request — see "Honest limits" below.

### 2. A compromised or malicious skill causes a quiet runaway

Skills and plugins are the ecosystem's soft underbelly, and a supply-chain compromise there is a
realistic threat. A malicious or buggy skill that puts an agent into a tool loop is
indistinguishable, from the outside, from an ordinary bug.

Belay's identical-call limit, tool-error rate and model-call rate catch the *behaviour* regardless of
its cause. It does not need to know the skill is malicious; it only needs to notice that something
is doing the same thing 40 times in a run.

### 3. An untrusted group baits your bot

A bot serving people you do not fully control is an abuse surface. Someone works out that a
particular phrasing sends it into a long, expensive reasoning loop, and repeats it.

Per-agent limits mean the group bot has its own budget and its own rate ceiling, isolated from your
other agents. The blast radius of abusing one bot is one bot's budget — provided you set per-agent
limits; a single global limit is a shared pool that one noisy agent can exhaust for the others.

### 4. Provider degradation becomes self-inflicted denial of service

A provider starts rate-limiting or erroring. The agent retries. Retries burn quota. Quota
exhaustion takes down *every* agent sharing that key — a noisy-neighbour outage caused by your own
retry behaviour.

Tool-error-rate and model-call-rate limits break that loop early, protecting the availability of
everything else on the same credentials.

### 5. Incident response with actual evidence

Something went wrong at 3am. Which agent, when, how much, and what stopped it?

Belay's flight recorder is a local append-only JSONL trail — one line per decision, with the agent,
the rule, the measured value and the threshold. `npx @fathomforge/belay incidents --hours 168` reconstructs the
timeline. It works when the gateway is down, because it reads files rather than asking the gateway.

Most agent deployments have no answer to those questions at all.

## Why the control itself is trustworthy

A security control that expands your attack surface is a bad trade. Belay is built so it does not:

- **Zero runtime dependencies.** Nothing third-party is installed into your gateway.
- **No install scripts**, npm provenance, signed tags, and a CI job that fails the build if a runtime
  dependency or install script ever appears.
- **No network by default.** With no alert configuration, no HTTP transport object is constructed at
  all. This is asserted by a test, not merely intended.
- **No telemetry, ever.** No phone-home, no update check, no analytics.
- **It cannot read your content.** Prompts and replies are never read. Tool parameters are
  SHA-256 hashed before counting; the hash is what is stored. The recorder rebuilds every record
  field by field, so a bug elsewhere cannot smuggle text onto disk. There is a test that passes a
  sensitive value through and asserts it never reaches the file.
- **Fail open on bugs, fail closed on policy.** A defect in Belay degrades to *no guardrail* — never
  to a downed gateway or a blocked message. Your availability never depends on this code being
  bug-free; only your cost protection does.

## Honest limits

A security document that only lists strengths is marketing. These are the boundaries:

1. **Belay is a bounding and detective control, not a preventive one.** It will not stop a prompt
   injection, detect a malicious instruction, or tell you *what* was sent. It caps volume and rate,
   and it tells you when something crossed a line.
2. **It cannot see content, by design.** That is what makes it safe to install, and it is also why
   it cannot distinguish an agent sending 10 MB of public documentation from 10 MB of your private
   files. It bounds size, not sensitivity.
3. **An operator with config write access can disable it.** It is a safety belt for your own agents,
   not a control that constrains a hostile administrator. Protect `openclaw.json` accordingly.
4. **It does not replace tool allowlists, sandboxing, or a security audit.** Those constrain what an
   agent can reach. Belay constrains how much it can do. You want both.
5. **Enforcement points are limited by the host.** Belay can act when a run starts and before a tool
   call. A runaway consisting purely of model calls with no tool use is stopped at the *next* run,
   not mid-run. Pausing a channel account outright is not currently possible from a plugin hook on
   OpenClaw 2026.8.2 — see the README.

## For compliance conversations

If you are asked "what controls do you have on autonomous agents?", the honest pre-Belay answer for
most deployments is "none, and we would find out from the invoice."

Belay gives three answerable things:

- **Preventive-ish:** documented, enforced ceilings on spend, request volume and call rate, per
  agent, with the configuration reviewable in version control.
- **Detective:** an append-only local decision log with timestamps, thresholds and measured values.
- **Responsive:** a documented escalation path with alerting, and a manual containment procedure.

That is not a compliance product, and this document is not a certification. It is the difference
between "we have no controls" and "here is the control, here is its configuration, and here is the
log of every time it fired."

## One-line positioning

> Your web server has rate limits. Your database has connection caps. Your cloud account has
> spending alerts. Your AI agent — which runs autonomously, holds tool access, and has a 48-hour
> default timeout — has nothing. Belay is that control.
