# Calibrating cost estimation: the experiment, the data, and what it does not support

Belay estimates cost from request size when a provider reports no token usage. This document is
the full working behind that estimate: how it was measured, what the numbers say, the mistake the
first measurement led me into, and the honest limits of the result.

Everything here is reproducible. The generator, the runner and the raw data are in
[`tools/calibration/`](../tools/calibration).

## Why estimate at all

On a production OpenClaw 2026.8.2 gateway running `google/gemini-3.8-flash`, the `llm_output` hook
delivers `usage: undefined`, and the assistant transcript entry's usage object is present but all
zeros. Configuring `models.providers.google.models[].cost` does not change this. With no token
counts, every spend cap is inert.

`model_call_ended` does carry `requestPayloadBytes` and `responseStreamBytes` — the size of the
request and response, never their content. The estimator converts bytes to tokens with a single
divisor, `estimation.bytesPerToken`, and prices the result normally.

The question this document answers: **what divisor, and how wrong is it?**

## Method

1. Generate samples of known byte length spanning the content types a real request carries.
2. Get **exact** token counts from the provider's own tokenizer — Gemini's `countTokens` endpoint,
   which is free and does no generation.
3. Compute `bytes ÷ tokens` for each sample, and the error each candidate divisor would produce.

Two samples (`mixed_5k`, `mixed_40k`) come from the same generator at different sizes, to check
whether the relationship is a clean ratio or carries a fixed offset.

Separately, on the live gateway, paired agent turns in fresh sessions — identical except one
carried 20,005 characters of known text — showed Belay's cost rising by exactly $0.0037950, twice,
reproducible to seven decimal places. Working back through the estimator gives 20,240 payload bytes
for 20,005 bytes of text: **a payload-to-text ratio of 1.0117**. So `requestPayloadBytes` tracks
actual content to about 1%, and essentially all estimation error lives in the divisor, not in the
byte measurement.

## Results

`google/gemini-3.8-flash`, 2026-09-02, exact counts from `countTokens`:

| sample | bytes/token | err @ ÷4 | err @ ÷3.5 | err @ ÷3 | err @ ÷2.5 |
|---|---|---|---|---|---|
| prose_varied_20k | 7.88 | +97% | +125% | +163% | +215% |
| markdown_20k | 6.31 | +58% | +80% | +110% | +152% |
| prose_common_20k | 5.71 | +43% | +63% | +90% | +128% |
| spanish_20k | 5.07 | +27% | +45% | +69% | +103% |
| mixed_20k | 3.60 | −10% | +3% | +20% | +44% |
| mixed_40k | 3.39 | −15% | −3% | +13% | +36% |
| code_20k | 3.38 | −16% | −3% | +13% | +35% |
| mixed_5k | 2.62 | −34% | −25% | −13% | +5% |
| json_20k | 2.33 | −42% | −33% | −22% | −7% |
| ids_random_20k | 1.39 | −65% | −60% | −54% | −44% |

**Range: 1.39 to 7.88 bytes per token — a 5.7× spread.**

## What the data does not support

**There is no single divisor that is accurate across content types.** Any value that avoids
under-counting JSON and identifier-heavy payloads over-counts prose by two to three times, and any
value that is fair to prose under-counts structured content by half. This is not a tuning problem;
it is a property of tokenizers. Byte length simply does not determine token count.

So Belay does not claim an accurate cost figure when estimating. It claims a **useful-magnitude**
one, and labels it.

### The mistake this experiment corrected

The first sample measured was `prose_common` — repetitive, common English words. It gave 5.71
bytes/token and suggested the default divisor of 4 **overestimated by 45%**, which sounded like a
safe bias: a cap that trips early.

That conclusion was wrong, and the sample was unrepresentative. Repetitive common words tokenize
unusually well. On the content that dominates a real agent request — JSON tool arguments, message
envelopes, ids, code — the same divisor **underestimates**, by 42% for JSON and 65% for identifier
heavy text. That is under-protection: caps trip late, or not at all.

Widening the sample set is what caught it. A single measurement pointed confidently in the wrong
direction.

## The chosen default, and why

`estimation.bytesPerToken` defaults to **3.5**.

It is the centre of the realistic-payload band (2.33–3.60 for JSON, code and mixed content), where
its error is −33% to +3%. It over-counts prose-heavy traffic — by 45% to 125% — which is the
tolerable direction, since it makes caps trip early rather than late.

It is a compromise chosen from measured data, not a derived constant. Operators whose traffic skews
one way should change it, and the table above says which way.

| your traffic looks like | suggested `bytesPerToken` |
|---|---|
| Chat and prose-heavy assistants | 5.0 |
| Mixed agent work: tools, code, some prose (default) | 3.5 |
| Heavy structured output, JSON, large tool schemas | 2.5 |
| Hashes, ids, base64, embeddings-like payloads | 1.5 |

## Honest limits

1. **The estimate is order-of-magnitude, not accounting.** Treat an estimated figure as ±50% on
   realistic content, and worse at the extremes. Do not reconcile it against a provider invoice.
2. **Set estimated caps with margin.** If a $5/day cap matters, and your content sits at the dense
   end, real spend at the moment it trips could be materially higher than $5.
3. **This calibration is for `google/gemini-3.8-flash` only.** Every provider has its own
   tokenizer, so the divisor does not transfer. Anthropic, OpenAI and local models each need their
   own measurement. The saving grace is that Belay only estimates for models it has actually
   observed reporting no usage — a provider that reports real numbers is measured, never estimated,
   and needs no calibration at all.
4. **Rate limits are unaffected.** Model-call storms, tool-call rates, identical repeated calls and
   error storms are counted directly and involve no estimation. They are exact regardless of
   provider, and they are what catch a runaway loop.

## Reproducing this, or calibrating your own provider

```bash
# 1. Generate the samples (writes to /tmp/belay-cal)
python3 tools/calibration/gen_samples.py

# 2. Count tokens with your provider's tokenizer.
#    run_cal.sh targets Gemini's countTokens; adapt the endpoint for others.
#    Supply the key yourself so the script never reads your secrets file:
read -rs KEY && export KEY && bash tools/calibration/run_cal.sh > results.tsv

# 3. Analyse
python3 tools/calibration/analyse.py results.tsv
```

If you calibrate a provider Belay does not yet cover, a pull request adding your results TSV and a
per-provider default would be welcome — that is how this table gets better.
