"""Offline evaluation benchmark for TAKUMI End-of-Line Quality Inspection (P15).

Evaluates the dual-stage vision pipeline on the VisA dataset across all 12 categories,
running BOTH stages on every image and deriving all 4 configurations:
1. Flash single (gemini-3.8-flash on candidate alone)
2. Flash-Lite + 3 refs (gemini-3.5-flash-lite on candidate + 3 references)
3. catch_everything (parallel screen + confirm, defective if either flags)
4. few_false_alarms (screen first, confirm only if screen flags, defective only if both flag)

Prices (Vertex AI global intro pricing until Dec 31 2026):
- gemini-3.5-flash-lite: $0.30 / 1M input tokens
- gemini-3.8-flash: $0.75 / 1M input tokens, $3.75 / 1M output tokens (including thinking)
"""

from __future__ import annotations

import argparse
import asyncio
import csv
import io
import os
from pathlib import Path
import random
import statistics
import sys
import time
from typing import Any

# Ensure repo root is on sys.path
REPO_ROOT = Path(__file__).resolve().parent.parent.parent
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from google import genai
from google.genai import types

from services.api.config import (
    GCP_PROJECT,
    INSPECT_JPEG_QUALITY,
    INSPECT_MAX_PX,
    MODEL_FLASH,
    MODEL_FLASH_LITE,
    TIMEOUT_INSPECT_CONFIRM_S,
    TIMEOUT_INSPECT_SCREEN_S,
)
from services.api.prompts import InspectionStageResponse, build_inspection_prompt
from services.api.telemetry import elapsed_ms
from infra.load_visa_products import CATEGORIES_SPEC, find_ref_file, parse_defect_types, resize_image_jpeg


PRICE_FLASH_LITE_INPUT_PER_M = 0.30
PRICE_FLASH_INPUT_PER_M = 0.75
PRICE_FLASH_OUTPUT_PER_M = 3.75


def init_eval_client(backend: str) -> genai.Client:
    """Initializes google-genai Client with Gemini Developer API or Vertex AI (global)."""
    if backend == "gemini_api":
        api_key = os.environ.get("GEMINI_API_KEY", "").strip()
        if not api_key:
            raise ValueError(
                "GEMINI_API_KEY environment variable is required when using --backend gemini_api. "
                "Please export GEMINI_API_KEY in your shell environment."
            )
        print("Initializing Gemini API client from GEMINI_API_KEY environment variable...")
        return genai.Client(api_key=api_key, http_options={"api_version": "v1beta"})
    elif backend == "vertex":
        print(f"Initializing Vertex AI client (project={GCP_PROJECT}, location=global)...")
        return genai.Client(vertexai=True, project=GCP_PROJECT, location="global")
    else:
        raise ValueError(f"Unknown backend '{backend}'. Choose 'gemini_api' or 'vertex'.")


def load_eval_samples(
    category_dir: Path,
    spec: dict[str, Any],
    per_class: int,
    rng: random.Random,
) -> list[dict[str, Any]]:
    """Loads N normal + N anomaly images per category (excluding reference units), sampled deterministically."""
    anno_path = category_dir / "image_anno.csv"
    if not anno_path.is_file():
        raise FileNotFoundError(f"image_anno.csv not found in {category_dir}")

    ref_ids = set(spec["refs"])
    normals: list[dict[str, Any]] = []
    anomalies: list[dict[str, Any]] = []

    with open(anno_path, "r", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        for row in reader:
            img_rel = row.get("image", "").strip()
            label = row.get("label", "").strip()
            if not img_rel:
                continue

            if any(r in img_rel for r in ref_ids):
                continue

            img_path = category_dir.parent / img_rel
            if not img_path.is_file():
                img_path = category_dir / Path(img_rel).name
                if not img_path.is_file():
                    matches = list(category_dir.glob(f"**/Images/**/*{Path(img_rel).name}*"))
                    if matches:
                        img_path = matches[0]
                    else:
                        continue

            item = {
                "path": img_path,
                "label": label,
                "is_defective": label.lower() != "normal",
            }

            if label.lower() == "normal":
                normals.append(item)
            else:
                anomalies.append(item)

    rng.shuffle(normals)
    rng.shuffle(anomalies)

    sampled = []
    sampled.extend(normals[:per_class])
    sampled.extend(anomalies[:per_class])
    return sampled


async def call_screen_raw(
    client: genai.Client,
    product_description: str,
    defect_types: list[str],
    candidate_bytes: bytes,
    ref_bytes_list: list[bytes],
) -> tuple[dict[str, Any], int, int]:
    """Runs Stage 1 Screen and returns (result_dict, input_tokens, output_tokens)."""
    t0 = time.perf_counter()
    prompt_text = build_inspection_prompt(product_description, defect_types, stage="screen")
    contents: list[Any] = [prompt_text]
    for ref_b in ref_bytes_list:
        contents.append(types.Part.from_bytes(data=ref_b, mime_type="image/jpeg"))
    contents.append(types.Part.from_bytes(data=candidate_bytes, mime_type="image/jpeg"))

    cfg = types.GenerateContentConfig(
        response_schema=InspectionStageResponse,
        response_mime_type="application/json",
        media_resolution=types.MediaResolution.MEDIA_RESOLUTION_MEDIUM,
    )

    resp = await asyncio.wait_for(
        asyncio.to_thread(client.models.generate_content, model=MODEL_FLASH_LITE, contents=contents, config=cfg),
        timeout=TIMEOUT_INSPECT_SCREEN_S,
    )
    ms = elapsed_ms(t0)
    import json
    data = json.loads(resp.text)

    usage = getattr(resp, "usage_metadata", None)
    in_tok = getattr(usage, "prompt_token_count", 0) or 0
    out_tok = getattr(usage, "candidates_token_count", 0) or 0

    return {
        "model": MODEL_FLASH_LITE,
        "defective": bool(data.get("defective", False)),
        "confidence": float(data.get("confidence", 0.0)),
        "defect": data.get("defect"),
        "where": data.get("where"),
        "ms": ms,
    }, in_tok, out_tok


async def call_confirm_raw(
    client: genai.Client,
    product_description: str,
    defect_types: list[str],
    candidate_bytes: bytes,
) -> tuple[dict[str, Any], int, int]:
    """Runs Stage 2 Confirm and returns (result_dict, input_tokens, output_tokens)."""
    t0 = time.perf_counter()
    prompt_text = build_inspection_prompt(product_description, defect_types, stage="confirm")
    contents = [
        prompt_text,
        types.Part.from_bytes(data=candidate_bytes, mime_type="image/jpeg"),
    ]

    cfg = types.GenerateContentConfig(
        response_schema=InspectionStageResponse,
        response_mime_type="application/json",
        media_resolution=types.MediaResolution.MEDIA_RESOLUTION_MEDIUM,
    )

    resp = await asyncio.wait_for(
        asyncio.to_thread(client.models.generate_content, model=MODEL_FLASH, contents=contents, config=cfg),
        timeout=TIMEOUT_INSPECT_CONFIRM_S,
    )
    ms = elapsed_ms(t0)
    import json
    data = json.loads(resp.text)

    usage = getattr(resp, "usage_metadata", None)
    in_tok = getattr(usage, "prompt_token_count", 0) or 0
    out_tok = getattr(usage, "candidates_token_count", 0) or 0

    return {
        "model": MODEL_FLASH,
        "defective": bool(data.get("defective", False)),
        "confidence": float(data.get("confidence", 0.0)),
        "defect": data.get("defect"),
        "where": data.get("where"),
        "ms": ms,
    }, in_tok, out_tok


async def evaluate_single_image(
    client: genai.Client,
    spec: dict[str, Any],
    defect_types: list[str],
    ref_bytes_list: list[bytes],
    sample: dict[str, Any],
) -> dict[str, Any]:
    """Runs BOTH stages on a single candidate image and computes results across all 4 modes."""
    cand_bytes = resize_image_jpeg(sample["path"])

    screen_res, screen_in_tok, screen_out_tok = None, 0, 0
    screen_error = False
    try:
        screen_res, screen_in_tok, screen_out_tok = await call_screen_raw(
            client, spec["description"], defect_types, cand_bytes, ref_bytes_list
        )
    except Exception as exc:
        print(f"    Screen stage failed on {sample['path'].name}: {exc}", file=sys.stderr)
        screen_error = True
        screen_res = {"defective": False, "ms": 5000, "error": str(exc)}

    confirm_res, confirm_in_tok, confirm_out_tok = None, 0, 0
    confirm_error = False
    try:
        confirm_res, confirm_in_tok, confirm_out_tok = await call_confirm_raw(
            client, spec["description"], defect_types, cand_bytes
        )
    except Exception as exc:
        print(f"    Confirm stage failed on {sample['path'].name}: {exc}", file=sys.stderr)
        confirm_error = True
        confirm_res = {"defective": False, "ms": 5000, "error": str(exc)}

    # Cost calculations
    cost_lite = screen_in_tok * (PRICE_FLASH_LITE_INPUT_PER_M / 1_000_000)
    cost_flash = confirm_in_tok * (PRICE_FLASH_INPUT_PER_M / 1_000_000) + confirm_out_tok * (PRICE_FLASH_OUTPUT_PER_M / 1_000_000)

    gt_defective = sample["is_defective"]

    # 1. Flash single (Confirm only)
    flash_single_def = confirm_res["defective"]
    flash_single_err = confirm_error
    flash_single_ms = confirm_res["ms"]
    flash_single_cost = cost_flash

    # 2. Flash-Lite + 3 refs (Screen only)
    flash_lite_def = screen_res["defective"]
    flash_lite_err = screen_error
    flash_lite_ms = screen_res["ms"]
    flash_lite_cost = cost_lite

    # 3. catch_everything (Screen or Confirm flags; error -> needs_review)
    catch_all_err = screen_error or confirm_error
    catch_all_def = (screen_res["defective"] or confirm_res["defective"]) if not catch_all_err else False
    catch_all_ms = max(screen_res["ms"], confirm_res["ms"])
    catch_all_cost = cost_lite + cost_flash

    # 4. few_false_alarms (Screen first; confirm only if screen flags; defective only if both flag)
    few_false_err = screen_error or (screen_res["defective"] and confirm_error)
    if few_false_err:
        few_false_def = False
        few_false_ms = screen_res["ms"]
        few_false_cost = cost_lite
    else:
        if not screen_res["defective"]:
            few_false_def = False
            few_false_ms = screen_res["ms"]
            few_false_cost = cost_lite
        else:
            few_false_def = confirm_res["defective"]
            few_false_ms = screen_res["ms"] + confirm_res["ms"]
            few_false_cost = cost_lite + cost_flash

    return {
        "file_name": sample["path"].name,
        "label": sample["label"],
        "gt_defective": gt_defective,
        # Config 1: Flash single
        "flash_single": {
            "pred_defective": flash_single_def,
            "error": flash_single_err,
            "latency_ms": flash_single_ms,
            "cost_usd": flash_single_cost,
        },
        # Config 2: Flash-Lite + 3 refs
        "flash_lite": {
            "pred_defective": flash_lite_def,
            "error": flash_lite_err,
            "latency_ms": flash_lite_ms,
            "cost_usd": flash_lite_cost,
        },
        # Config 3: catch_everything
        "catch_everything": {
            "pred_defective": catch_all_def,
            "error": catch_all_err,
            "latency_ms": catch_all_ms,
            "cost_usd": catch_all_cost,
        },
        # Config 4: few_false_alarms
        "few_false_alarms": {
            "pred_defective": few_false_def,
            "error": few_false_err,
            "latency_ms": few_false_ms,
            "cost_usd": few_false_cost,
        },
    }


def compute_metrics(eval_items: list[dict[str, Any]], config_key: str) -> dict[str, Any]:
    """Computes accuracy, defects caught, false alarms, errors, latency, and cost for a config."""
    total = len(eval_items)
    if total == 0:
        return {}

    tp, fp, tn, fn, errors = 0, 0, 0, 0, 0
    latencies: list[int] = []
    costs: list[float] = []

    for item in eval_items:
        cfg = item[config_key]
        gt = item["gt_defective"]
        pred = cfg["pred_defective"]
        err = cfg["error"]
        latencies.append(cfg["latency_ms"])
        costs.append(cfg["cost_usd"])

        if err:
            errors += 1
            if gt:
                fn += 1
            else:
                tn += 1
        elif gt and pred:
            tp += 1
        elif not gt and pred:
            fp += 1
        elif not gt and not pred:
            tn += 1
        else:
            fn += 1

    accuracy = (tp + tn) / total
    p50 = statistics.median(latencies) if latencies else 0
    p90 = statistics.quantiles(latencies, n=10)[8] if len(latencies) >= 10 else max(latencies, default=0)
    avg_cost = sum(costs) / total if total > 0 else 0.0

    return {
        "total": total,
        "accuracy": accuracy,
        "defects_caught": tp,
        "total_defects": tp + fn,
        "false_alarms": fp,
        "total_normal": tn + fp,
        "errors": errors,
        "p50_ms": p50,
        "p90_ms": p90,
        "cost_per_image": avg_cost,
    }


async def run_evaluation(args: argparse.Namespace) -> None:
    client = init_eval_client(args.backend)
    rng = random.Random(args.seed)

    categories = (
        [c.strip() for c in args.categories.split(",") if c.strip()]
        if args.categories != "all"
        else list(CATEGORIES_SPEC.keys())
    )

    print(f"\n--- Starting Evaluation: {len(categories)} categories, {args.per_class} normal + {args.per_class} anomaly per category (seed={args.seed}, workers={args.workers}, backend={args.backend}) ---\n")

    all_evaluated: list[dict[str, Any]] = []
    category_results: dict[str, list[dict[str, Any]]] = {}
    sem = asyncio.Semaphore(args.workers)

    async def _eval_sample(cat_id: str, spec: dict[str, Any], defect_types: list[str], ref_bytes_list: list[bytes], sample: dict[str, Any]) -> dict[str, Any]:
        async with sem:
            item = await evaluate_single_image(client, spec, defect_types, ref_bytes_list, sample)
            item["category"] = cat_id
            return item

    for cat_id in categories:
        if cat_id not in CATEGORIES_SPEC:
            continue

        spec = CATEGORIES_SPEC[cat_id]
        cat_dir = args.visa_dir / cat_id
        anno_path = cat_dir / "image_anno.csv"
        defect_types = parse_defect_types(anno_path)

        ref_bytes_list: list[bytes] = []
        for r_id in spec["refs"]:
            ref_path = find_ref_file(cat_dir, r_id)
            ref_bytes_list.append(resize_image_jpeg(ref_path))

        samples = load_eval_samples(cat_dir, spec, args.per_class, rng)
        print(f"Evaluating {cat_id} ({len(samples)} samples with {args.workers} workers)...")

        cat_items = await asyncio.gather(
            *(_eval_sample(cat_id, spec, defect_types, ref_bytes_list, sample) for sample in samples)
        )
        for item in cat_items:
            all_evaluated.append(item)

        category_results[cat_id] = list(cat_items)

    # Compute metrics for all 4 configurations
    configs = [
        ("flash_single", "Flash single"),
        ("flash_lite", "Flash-Lite + 3 refs"),
        ("catch_everything", "catch_everything"),
        ("few_false_alarms", "few_false_alarms"),
    ]

    summary_rows: list[dict[str, Any]] = []
    for key, name in configs:
        m = compute_metrics(all_evaluated, key)
        m["name"] = name
        summary_rows.append(m)

    # Format Markdown
    backend_desc = (
        "`gemini_api` (Developer API via GEMINI_API_KEY environment variable)"
        if args.backend == "gemini_api"
        else f"`vertex` (Vertex AI global endpoint)"
    )
    lines = [
        "# TAKUMI End-of-Line Quality Inspection — VisA Offline Benchmark",
        "",
        f"- **Dataset**: VisA (Visual Anomaly Benchmark, CC BY 4.0)",
        f"- **Backend**: {backend_desc}",
        f"- **Workers**: `{args.workers}`",
        f"- **Seed**: `{args.seed}`",
        f"- **Categories**: {len(categories)}",
        f"- **Total Units Evaluated**: {len(all_evaluated)} ({args.per_class} normal + {args.per_class} anomaly per category)",
        "",
        "## Overall Configuration Comparison",
        "",
        "| Configuration | Accuracy | Defects Caught | False Alarms | Errors | p50 Latency | p90 Latency | Cost / Image |",
        "| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: |",
    ]

    for s in summary_rows:
        lines.append(
            f"| **{s['name']}** | {s['accuracy']*100:.1f}% | {s['defects_caught']}/{s['total_defects']} | "
            f"{s['false_alarms']}/{s['total_normal']} | {s['errors']} | {s['p50_ms']:.0f} ms | "
            f"{s['p90_ms']:.0f} ms | ${s['cost_per_image']:.5f} |"
        )

    lines.extend([
        "",
        "## Per-Category Breakdown (few_false_alarms vs catch_everything)",
        "",
        "| Category | Units | FFA Acc | FFA Caught | FFA False Alarms | CE Acc | CE Caught | CE False Alarms |",
        "| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: |",
    ])

    for cat_id, items in category_results.items():
        ffa = compute_metrics(items, "few_false_alarms")
        ce = compute_metrics(items, "catch_everything")
        lines.append(
            f"| `{cat_id}` | {len(items)} | {ffa['accuracy']*100:.1f}% | {ffa['defects_caught']}/{ffa['total_defects']} | "
            f"{ffa['false_alarms']} | {ce['accuracy']*100:.1f}% | {ce['defects_caught']}/{ce['total_defects']} | {ce['false_alarms']} |"
        )

    lines.append("")
    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as f:
        f.write("\n".join(lines))

    print(f"\nEvaluation benchmark written to {out_path.resolve()}\n")


def main() -> None:
    parser = argparse.ArgumentParser(description="Evaluate dual-stage inspection against VisA benchmark")
    parser.add_argument(
        "--backend",
        choices=["gemini_api", "vertex"],
        default="gemini_api",
        help="Inference backend (default: gemini_api, reads GEMINI_API_KEY from environment)",
    )
    parser.add_argument(
        "--workers",
        type=int,
        default=2,
        help="Number of concurrent image evaluation workers (default: 2)",
    )
    parser.add_argument("--categories", default="all", help="Comma-separated category names or 'all'")
    parser.add_argument("--per-class", type=int, default=2, help="N normal and N anomaly test units per category")
    parser.add_argument("--seed", type=int, default=42, help="Random seed for reproducible sampling")
    parser.add_argument(
        "--visa-dir",
        type=Path,
        default=Path(os.environ.get("VISA_DATA_DIR", r"C:\Users\tusha\takumi-data\VisA")),
        help="Path to VisA dataset root directory",
    )
    parser.add_argument(
        "--out",
        type=Path,
        default=Path("evals/inspection/RESULTS.md"),
        help="Output markdown report path",
    )
    args = parser.parse_args()

    asyncio.run(run_evaluation(args))


if __name__ == "__main__":
    main()
