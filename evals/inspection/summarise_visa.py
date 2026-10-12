"""Summarise a VisA inspection benchmark run into the files the /evals page and README use.

Input: the per-image JSONL written by the benchmark runner: one line per test image with the
category, the dataset label and both stage results ("lite_ref" = gemini-3.5-flash-lite with 3
known-good references, "flash_single" = gemini-3.8-flash on the unit alone), each with
{result: {defective, ...}, ms, in, out, think} or {error}. When an image appears more than once, the
last line wins (reruns of failed calls).

Outputs:
  apps/web/src/evals/visaResults.json   summary for the /evals page
  evals/inspection/visa_12cat_per_image.csv   one row per image (no personal data)

Usage: python -m evals.inspection.summarise_visa <results.jsonl>
"""

from __future__ import annotations

import csv
import json
import math
import statistics
import sys
from collections import defaultdict
from datetime import date
from pathlib import Path
from typing import Any

# USD per 1M tokens on the global endpoint, Oct 2026 (thinking tokens bill as output).
# gemini-3.8-flash: introductory price until 31 Dec 2026. Flash-Lite output price is an assumption
# (about 30 output tokens per call, so it hardly moves the total).
PRICES = {"lite_ref": (0.30, 1.50), "flash_single": (0.75, 3.75)}
SETUPS = {
    "few_false_alarms": "Few false alarms (default): Flash-Lite screens, Flash confirms",
    "catch_everything": "Catch everything: defective if either flags",
    "lite_ref": "Flash-Lite + 3 references only",
    "flash_single": "Flash on the unit only",
}
REPO = Path(__file__).resolve().parents[2]


def load(path: str) -> dict[str, dict[str, Any]]:
    latest: dict[str, dict[str, Any]] = {}
    with open(path, encoding="utf-8") as f:
        for line in f:
            rec = json.loads(line)
            latest[rec["image"]] = rec
    return latest


def _call_cost(call: dict[str, Any], kind: str) -> float:
    p_in, p_out = PRICES[kind]
    return (call.get("in", 0) * p_in + (call.get("out", 0) + call.get("think", 0)) * p_out) / 1e6


def verdicts(rec: dict[str, Any]) -> dict[str, bool] | None:
    try:
        lite = bool(rec["lite_ref"]["result"]["defective"])
        flash = bool(rec["flash_single"]["result"]["defective"])
    except (KeyError, TypeError):
        return None
    return {"lite_ref": lite, "flash_single": flash, "catch_everything": lite or flash, "few_false_alarms": lite and flash}


def cost(rec: dict[str, Any], setup: str) -> float:
    lite = _call_cost(rec["lite_ref"], "lite_ref")
    flash = _call_cost(rec["flash_single"], "flash_single")
    if setup == "lite_ref":
        return lite
    if setup == "flash_single":
        return flash
    if setup == "catch_everything":
        return lite + flash
    return lite + (flash if rec["lite_ref"]["result"]["defective"] else 0.0)  # confirm only when screened positive


def score(recs: list[dict[str, Any]], setup: str) -> dict[str, Any]:
    tp = fn = fp = tn = 0
    total_cost = 0.0
    for rec in recs:
        pred = verdicts(rec)[setup]
        bad = rec["label"] == "anomaly"
        tp += bad and pred
        fn += bad and not pred
        fp += (not bad) and pred
        tn += (not bad) and not pred
        total_cost += cost(rec, setup)
    n = tp + fn + fp + tn
    acc = (tp + tn) / n if n else None
    recall = tp / (tp + fn) if tp + fn else None
    fpr = fp / (fp + tn) if fp + tn else None
    return {
        "n": n,
        "normal": fp + tn,
        "anomaly": tp + fn,
        "accuracy": acc,
        "accuracy_ci95": 1.96 * math.sqrt(acc * (1 - acc) / n) if n else None,
        "balanced_accuracy": (recall + 1 - fpr) / 2 if recall is not None and fpr is not None else None,
        "defects_caught": recall,
        "false_alarms": fpr,
        "cost_per_image_usd": total_cost / n if n else None,
    }


def summarise(latest: dict[str, dict[str, Any]]) -> dict[str, Any]:
    scored = [r for r in latest.values() if verdicts(r) is not None]
    by_cat: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for r in scored:
        by_cat[r["category"]].append(r)

    def pct(xs: list[int], q: float) -> int | None:
        xs = sorted(xs)
        return xs[min(len(xs) - 1, int(q * len(xs)))] if xs else None

    lite_ms = [r["lite_ref"]["ms"] for r in scored]
    flash_ms = [r["flash_single"]["ms"] for r in scored]
    return {
        "label": "PUBLIC DATA: VisA (Amazon), CC BY 4.0",
        "dataset_url": "https://github.com/amazon-science/spot-diff",
        "split": "VisA 1cls test split",
        "generated": date.today().isoformat(),
        "images_total": len(latest),
        "images_scored": len(scored),
        "images_failed": len(latest) - len(scored),
        "categories": len(by_cat),
        "models": {"screen": "gemini-3.5-flash-lite", "confirm": "gemini-3.8-flash"},
        "method": [
            "Same prompt, models, settings and 3 known-good reference images (train split) as the shipped inspection service.",
            "Images resized to at most 1024 px (JPEG quality 90), media resolution MEDIUM, default thinking, no temperature.",
            "Both stages run on every image so all four setups are scored from one run; costs count the confirm stage only where that setup calls it.",
        ],
        "caveats": [
            "Clean, evenly lit lab photos; real lines have more glare and clutter.",
            "The test split is about 55% defective; real lines are usually 1-5%, so few false alarms matters more than raw accuracy.",
            "Every flagged unit is confirmed or overridden by a person in the product.",
        ],
        "prices_usd_per_million_tokens": {"gemini-3.5-flash-lite": {"input": 0.30, "output_assumed": 1.50},
                                          "gemini-3.8-flash": {"input": 0.75, "output": 3.75, "note": "introductory price until 31 Dec 2026"}},
        "latency_ms": {"screen_p50": pct(lite_ms, 0.5), "screen_p90": pct(lite_ms, 0.9),
                       "confirm_p50": pct(flash_ms, 0.5), "confirm_p90": pct(flash_ms, 0.9),
                       "note": "Measured during the batch run with 2-12 parallel requests."},
        "setups": {k: {"name": v, **score(scored, k)} for k, v in SETUPS.items()},
        "by_category": {
            cat: {k: score(recs, k) for k in SETUPS} for cat, recs in sorted(by_cat.items())
        },
    }


def write_per_image(latest: dict[str, dict[str, Any]], path: Path) -> None:
    with open(path, "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["image", "category", "dataset_label", "screen_defective", "confirm_defective", "screen_ms", "confirm_ms", "error"])
        for img, r in sorted(latest.items()):
            v = verdicts(r)
            err = r["lite_ref"].get("error") or r["flash_single"].get("error") or ""
            w.writerow([img, r["category"], r["label"],
                        "" if v is None else int(v["lite_ref"]), "" if v is None else int(v["flash_single"]),
                        r["lite_ref"].get("ms", ""), r["flash_single"].get("ms", ""), err[:80]])


def main() -> None:
    latest = load(sys.argv[1])
    summary = summarise(latest)
    out = REPO / "apps/web/src/evals/visaResults.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(summary, indent=1) + "\n", encoding="utf-8")
    write_per_image(latest, REPO / "evals/inspection/visa_12cat_per_image.csv")
    d = summary["setups"]["few_false_alarms"]
    print(f"{summary['images_scored']}/{summary['images_total']} scored; default mode accuracy {d['accuracy']:.3f}, "
          f"caught {d['defects_caught']:.3f}, false alarms {d['false_alarms']:.3f}, ${d['cost_per_image_usd']:.4f}/image")
    print("median latency (ms):", statistics.median([r['lite_ref']['ms'] for r in latest.values() if verdicts(r)]))


if __name__ == "__main__":
    main()
