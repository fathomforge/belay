"""Generate calibration samples spanning the content types a real request carries.

Each sample is written as a Gemini countTokens payload plus a manifest row with
its exact character and UTF-8 byte count, so bytes-per-token can be computed
without trusting anything but the API's own answer.
"""
import json, os, random, string

OUT = "/tmp/belay-cal"
os.makedirs(OUT, exist_ok=True)
random.seed(11)

COMMON = """the quick brown fox jumps over a lazy dog while several engineers review
production logs and discuss whether the agent should retry the failing request""".split()

VARIED = """acknowledge baseline calibrate deviation ephemeral fallback gateway heuristic
idempotent journal kernel latency manifest normalise orchestrate provenance quiesce
reconcile scheduler threshold upstream validate workspace yield zone anomaly bracket
concurrency dependency envelope fingerprint granularity handshake instrumentation
photosynthesis quixotic bureaucratic entrepreneurial onomatopoeia serendipitous""".split()

SPANISH = """el agente respondio con un mensaje breve porque la solicitud fue limitada
durante la noche mientras revisabamos los registros de produccion y ajustabamos""".split()


def words(vocab, n):
    return " ".join(random.choice(vocab) for _ in range(n))


def prose(vocab, target):
    out = []
    while sum(len(p) for p in out) < target:
        out.append(words(vocab, random.randint(8, 18)) + ". ")
    return "".join(out)[:target]


def json_blob(target):
    out = []
    while sum(len(p) for p in out) < target:
        out.append(json.dumps({
            "tool": random.choice(VARIED),
            "args": {"path": "/srv/" + random.choice(VARIED) + ".json",
                     "limit": random.randint(1, 999),
                     "enabled": random.choice([True, False])},
            "id": "".join(random.choices(string.hexdigits.lower(), k=16)),
        }) + "\n")
    return "".join(out)[:target]


def code(target):
    out = []
    while sum(len(p) for p in out) < target:
        out.append(
            f"export async function {random.choice(VARIED)}(ctx: Context) {{\n"
            f"  const {random.choice(VARIED)} = await ctx.{random.choice(VARIED)}"
            f"({{ retries: {random.randint(1,9)}, timeoutMs: {random.randint(100,9999)} }});\n"
            f"  if (!{random.choice(VARIED)}) throw new Error('{random.choice(VARIED)} failed');\n}}\n")
    return "".join(out)[:target]


def ids(target):
    out = []
    while sum(len(p) for p in out) < target:
        out.append("".join(random.choices(string.ascii_letters + string.digits + "-_", k=32)) + "\n")
    return "".join(out)[:target]


def markdown(target):
    out = []
    while sum(len(p) for p in out) < target:
        out.append(f"## {words(VARIED, 4)}\n\n- **{random.choice(VARIED)}**: "
                   f"{words(VARIED, 12)}\n- `{random.choice(VARIED)}` -> {words(VARIED, 6)}\n\n")
    return "".join(out)[:target]


def mixed(target):
    out = []
    while sum(len(p) for p in out) < target:
        k = random.random()
        if k < 0.35:
            out.append(prose(VARIED, 400))
        elif k < 0.60:
            out.append(json_blob(400))
        elif k < 0.85:
            out.append(code(400))
        else:
            out.append(ids(200))
    return "".join(out)[:target]


SAMPLES = {
    "prose_common_20k": prose(COMMON, 20005),
    "prose_varied_20k": prose(VARIED, 20005),
    "spanish_20k": prose(SPANISH, 20005),
    "json_20k": json_blob(20005),
    "code_20k": code(20005),
    "ids_random_20k": ids(20005),
    "markdown_20k": markdown(20005),
    "mixed_20k": mixed(20005),
    # Size variants of the same generator, to check the relationship is linear
    # and carries no fixed offset.
    "mixed_5k": mixed(5000),
    "mixed_40k": mixed(40000),
}

manifest = []
for name, text in SAMPLES.items():
    path = os.path.join(OUT, name + ".json")
    json.dump({"contents": [{"parts": [{"text": text}]}]}, open(path, "w"))
    manifest.append({"name": name, "chars": len(text), "bytes": len(text.encode("utf-8"))})

json.dump(manifest, open(os.path.join(OUT, "manifest.json"), "w"), indent=2)
for row in manifest:
    print(f"{row['name']}\t{row['chars']}\t{row['bytes']}")
