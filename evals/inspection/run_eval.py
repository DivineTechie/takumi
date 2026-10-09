"""Offline evaluation script for TAKUMI End-of-Line Quality Inspection (P15).

Evaluates the dual-stage multimodal inspection pipeline on the VisA dataset
across all 12 categories, computing precision, recall, F1, accuracy, and latency metrics.

Supports:
- --backend: vertex (default, ADC) or gemini_api (GEMINI_API_KEY)
- --categories: comma-separated list or all 12
- --per-class: number of evaluation samples per category (e.g. 2 for smoke test)
- --mode: few_false_alarms (default) or catch_everything
- --output: path to markdown results file (default: evals/inspection/RESULTS.md)
"""

from __future__ import annotations

import argparse
import asyncio
import csv
import io
import os
from pathlib import Path
import statistics
import sys
import time
from typing import Any

# Ensure repo root is on sys.path
REPO_ROOT = Path(__file__).resolve().parent.parent.parent
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from google import genai
from PIL import Image

from services.api.config import GCP_PROJECT, GEMINI_API_KEY
from services.api.inspection import run_inspection_pipeline
from infra.load_visa_products import CATEGORIES_SPEC, find_ref_file, parse_defect_types, resize_image_jpeg


def init_eval_client(backend: str) -> genai.Client:
    """Initializes google-genai Client with Vertex AI or Gemini Developer API."""
    if backend == "vertex":
        print(f"Initializing Vertex AI client (project={GCP_PROJECT}, location=us-central1)...")
        return genai.Client(vertexai=True, project=GCP_PROJECT, location="us-central1")
    elif backend == "gemini_api":
        api_key = GEMINI_API_KEY or os.environ.get("GEMINI_API_KEY", "").strip()
        if not api_key:
            try:
                from google.cloud import secretmanager
                sm_client = secretmanager.SecretManagerServiceClient()
                name = f"projects/{GCP_PROJECT}/secrets/GEMINI_API_KEY/versions/latest"
                resp = sm_client.access_secret_version(request={"name": name})
                api_key = resp.payload.data.decode("UTF-8").strip()
            except Exception as e:
                raise ValueError(f"Failed to retrieve GEMINI_API_KEY from environment or Secret Manager: {e}")
        print("Initializing Gemini API client with GEMINI_API_KEY...")
        return genai.Client(api_key=api_key, http_options={"api_version": "v1beta"})
    else:
        raise ValueError(f"Unknown backend '{backend}'. Choose 'vertex' or 'gemini_api'.")


def load_eval_samples(
    category_dir: Path,
    spec: dict[str, Any],
    per_class: int,
) -> list[dict[str, Any]]:
    """Loads a balanced sample of normal and anomaly images excluding the 3 reference files."""
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

            # Check if this image is one of the references
            is_ref = any(r in img_rel for r in ref_ids)
            if is_ref:
                continue

            img_path = category_dir.parent / img_rel
            if not img_path.is_file():
                # Try relative to category_dir
                img_path = category_dir / Path(img_rel).name
                if not img_path.is_file():
                    # Search inside Images
                    matches = list(category_dir.glob(f"**/Images/**/*{Path(img_rel).name}*"))
                    if matches:
                        img_path = matches[0]
                    else:
                        continue

            item = {
                "path": img_path,
                "rel_path": img_rel,
                "label": label,
                "is_defective": label.lower() != "normal",
            }

            if label.lower() == "normal":
                normals.append(item)
            else:
                anomalies.append(item)

    n_normal = max(1, per_class // 2)
    n_anomaly = max(1, per_class - n_normal)

    sampled: list[dict[str, Any]] = []
    sampled.extend(normals[:n_normal])
    sampled.extend(anomalies[:n_anomaly])
    return sampled[:per_class]


async def evaluate_image(
    client: genai.Client,
    spec: dict[str, Any],
    defect_types: list[str],
    ref_bytes_list: list[bytes],
    sample: dict[str, Any],
    mode: str,
) -> dict[str, Any]:
    """Runs evaluation on a single candidate image and records performance."""
    cand_bytes = resize_image_jpeg(sample["path"])
    t0 = time.perf_counter()

    try:
        res = await run_inspection_pipeline(
            product_description=spec["description"],
            defect_types=defect_types,
            candidate_bytes=cand_bytes,
            reference_bytes_list=ref_bytes_list,
            mode=mode,
            client=client,
        )
    except Exception as exc:
        print(f"    Error during inspection of {sample['path'].name}: {exc}", file=sys.stderr)
        res = {
            "ai_verdict": "needs_review",
            "defect": None,
            "where": None,
            "confidence": 0.0,
            "screen": None,
            "confirm": None,
            "total_ms": int(round((time.perf_counter() - t0) * 1000)),
        }

    gt_defective = sample["is_defective"]
    pred_defective = res["ai_verdict"] == "defective"
    # Note: if needs_review, in safety-first quality inspection we flag for review, but strictly compare binary:
    match = (gt_defective == pred_defective)

    return {
        "file_name": sample["path"].name,
        "label": sample["label"],
        "gt_defective": gt_defective,
        "pred_defective": pred_defective,
        "ai_verdict": res["ai_verdict"],
        "defect": res.get("defect"),
        "where": res.get("where"),
        "confidence": res.get("confidence", 0.0),
        "match": match,
        "total_ms": res["total_ms"],
    }


async def run_evaluation(args: argparse.Namespace) -> None:
    client = init_eval_client(args.backend)
    categories = (
        [c.strip() for c in args.categories.split(",") if c.strip()]
        if args.categories != "all"
        else list(CATEGORIES_SPEC.keys())
    )

    all_results: list[dict[str, Any]] = []
    category_summaries: list[dict[str, Any]] = []

    print(f"\n--- Starting Evaluation: {len(categories)} categories, {args.per_class} per category, mode={args.mode} ---\n")

    for cat_id in categories:
        if cat_id not in CATEGORIES_SPEC:
            print(f"Warning: Category '{cat_id}' not in spec. Skipping.", file=sys.stderr)
            continue

        spec = CATEGORIES_SPEC[cat_id]
        cat_dir = args.visa_dir / cat_id
        anno_path = cat_dir / "image_anno.csv"
        defect_types = parse_defect_types(anno_path)

        # Load reference images
        ref_bytes_list: list[bytes] = []
        for r_id in spec["refs"]:
            ref_path = find_ref_file(cat_dir, r_id)
            ref_bytes_list.append(resize_image_jpeg(ref_path))

        samples = load_eval_samples(cat_dir, spec, args.per_class)
        print(f"Evaluating {cat_id} ({len(samples)} samples)...")

        cat_evals: list[dict[str, Any]] = []
        for sample in samples:
            ev = await evaluate_image(client, spec, defect_types, ref_bytes_list, sample, args.mode)
            ev["category"] = cat_id
            cat_evals.append(ev)
            all_results.append(ev)
            match_str = "OK" if ev["match"] else "MISMATCH"
            print(f"  [{match_str}] {ev['file_name']} (GT: {ev['label']}) -> AI: {ev['ai_verdict']} ({ev['total_ms']}ms)")

        # Summary for category
        tp = sum(1 for e in cat_evals if e["gt_defective"] and e["pred_defective"])
        fp = sum(1 for e in cat_evals if not e["gt_defective"] and e["pred_defective"])
        tn = sum(1 for e in cat_evals if not e["gt_defective"] and not e["pred_defective"])
        fn = sum(1 for e in cat_evals if e["gt_defective"] and not e["pred_defective"])
        total = len(cat_evals)
        acc = (tp + tn) / total if total > 0 else 0.0
        prec = tp / (tp + fp) if (tp + fp) > 0 else 1.0
        rec = tp / (tp + fn) if (tp + fn) > 0 else 1.0
        f1 = (2 * prec * rec) / (prec + rec) if (prec + rec) > 0 else 0.0
        latencies = [e["total_ms"] for e in cat_evals]
        p50 = statistics.median(latencies) if latencies else 0
        p90 = statistics.quantiles(latencies, n=10)[8] if len(latencies) >= 10 else max(latencies, default=0)

        category_summaries.append({
            "category": cat_id,
            "total": total,
            "normal": tn + fp,
            "anomaly": tp + fn,
            "accuracy": acc,
            "precision": prec,
            "recall": rec,
            "f1": f1,
            "p50_ms": p50,
            "p90_ms": p90,
        })

    # Overall summary metrics
    total_evals = len(all_results)
    tp = sum(1 for e in all_results if e["gt_defective"] and e["pred_defective"])
    fp = sum(1 for e in all_results if not e["gt_defective"] and e["pred_defective"])
    tn = sum(1 for e in all_results if not e["gt_defective"] and not e["pred_defective"])
    fn = sum(1 for e in all_results if e["gt_defective"] and not e["pred_defective"])
    overall_acc = (tp + tn) / total_evals if total_evals > 0 else 0.0
    overall_prec = tp / (tp + fp) if (tp + fp) > 0 else 1.0
    overall_rec = tp / (tp + fn) if (tp + fn) > 0 else 1.0
    overall_f1 = (2 * overall_prec * overall_rec) / (overall_prec + overall_rec) if (overall_prec + overall_rec) > 0 else 0.0
    all_lat = [e["total_ms"] for e in all_results]
    overall_p50 = statistics.median(all_lat) if all_lat else 0
    overall_p90 = statistics.quantiles(all_lat, n=10)[8] if len(all_lat) >= 10 else max(all_lat, default=0)

    # Generate Markdown Report
    lines = [
        "# TAKUMI End-of-Line Quality Inspection — Offline Benchmark Evaluation",
        "",
        f"- **Dataset**: VisA (Visual Anomaly Benchmark, CC BY 4.0)",
        f"- **Backend**: `{args.backend}`",
        f"- **Inspection Mode**: `{args.mode}`",
        f"- **Pipeline**: Dual-Stage Multimodal Vision (Stage 1: `gemini-3.5-flash-lite` with 3 references, Stage 2: `gemini-3.8-flash`)",
        f"- **Total Categories Evaluated**: {len(category_summaries)}",
        f"- **Total Units Evaluated**: {total_evals}",
        "",
        "## Overall Benchmark Summary",
        "",
        "| Metric | Value |",
        "| :--- | :--- |",
        f"| **Overall Accuracy** | {overall_acc * 100:.1f}% ({tp + tn}/{total_evals}) |",
        f"| **Precision** | {overall_prec * 100:.1f}% |",
        f"| **Recall (Defect Detection)** | {overall_rec * 100:.1f}% |",
        f"| **F1 Score** | {overall_f1:.3f} |",
        f"| **p50 Latency** | {overall_p50:.0f} ms |",
        f"| **p90 Latency** | {overall_p90:.0f} ms |",
        "",
        "## Per-Category Results Breakdown",
        "",
        "| Category | Units | Normal | Anomaly | Accuracy | Precision | Recall | F1 | p50 Latency |",
        "| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |",
    ]

    for c in category_summaries:
        lines.append(
            f"| `{c['category']}` | {c['total']} | {c['normal']} | {c['anomaly']} | "
            f"{c['accuracy']*100:.1f}% | {c['precision']*100:.1f}% | {c['recall']*100:.1f}% | "
            f"{c['f1']:.3f} | {c['p50_ms']:.0f} ms |"
        )

    lines.extend([
        "",
        "## Sample Evaluation Details",
        "",
        "| Category | Image | Ground Truth | AI Verdict | Detected Defect | Match | Latency |",
        "| :--- | :--- | :--- | :--- | :--- | :---: | :---: |",
    ])

    for e in all_results:
        defect_str = e["defect"] or "—"
        match_str = "PASSED" if e["match"] else "FAILED"
        lines.append(
            f"| `{e['category']}` | `{e['file_name']}` | {e['label']} | `{e['ai_verdict']}` | "
            f"{defect_str} | **{match_str}** | {e['total_ms']} ms |"
        )

    lines.append("")
    report_content = "\n".join(lines)

    output_path = Path(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with open(output_path, "w", encoding="utf-8") as f:
        f.write(report_content)

    print(f"\nEvaluation complete. Report written to {output_path.resolve()}\n")
    print(f"Overall Accuracy: {overall_acc*100:.1f}% | Precision: {overall_prec*100:.1f}% | Recall: {overall_rec*100:.1f}% | p50: {overall_p50:.0f} ms")


def main() -> None:
    parser = argparse.ArgumentParser(description="Evaluate dual-stage inspection against VisA benchmark")
    parser.add_argument("--backend", choices=["vertex", "gemini_api"], default="gemini_api", help="Inference backend")
    parser.add_argument("--categories", default="all", help="Comma-separated category names or 'all'")
    parser.add_argument("--per-class", type=int, default=2, help="Number of test units per category")
    parser.add_argument("--mode", choices=["few_false_alarms", "catch_everything"], default="few_false_alarms", help="Inspection mode")
    parser.add_argument(
        "--visa-dir",
        type=Path,
        default=Path(os.environ.get("VISA_DATA_DIR", r"C:\Users\tusha\takumi-data\VisA")),
        help="Path to VisA dataset root directory",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=Path("evals/inspection/RESULTS.md"),
        help="Output markdown report path",
    )
    args = parser.parse_args()

    asyncio.run(run_evaluation(args))


if __name__ == "__main__":
    main()
