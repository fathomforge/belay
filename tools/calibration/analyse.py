#!/usr/bin/env python3
"""Turn a calibration TSV into the bytes-per-token table and error bands.

    python3 tools/calibration/analyse.py tools/calibration/results-*.tsv
"""
import sys

def main(path: str) -> None:
    rows = []
    for line in open(path):
        if line.startswith("#") or line.startswith("sample") or not line.strip():
            continue
        name, chars, byts, tokens = line.split("\t")
        rows.append((name, int(byts), int(tokens)))

    divisors = (4.0, 3.5, 3.0, 2.5)
    head = f"{'sample':20}{'bytes/token':>12}" + "".join(f"{'err @ /'+str(d):>12}" for d in divisors)
    print(head)
    for name, byts, tokens in rows:
        line = f"{name:20}{byts/tokens:>12.2f}"
        for d in divisors:
            line += f"{(byts/d - tokens)/tokens*100:>11.0f}%"
        print(line)

    ratios = [b / t for _, b, t in rows]
    print(f"\nrange: {min(ratios):.2f} to {max(ratios):.2f} bytes/token "
          f"({max(ratios)/min(ratios):.1f}x spread)")
    realistic = [b / t for n, b, t in rows if n.startswith(("json", "code", "mixed"))]
    if realistic:
        print(f"realistic payload types: {min(realistic):.2f} to {max(realistic):.2f}")

if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "tools/calibration/results-gemini-3.8-flash-2026-09-02.tsv")
