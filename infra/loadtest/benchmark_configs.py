"""Benchmark latency and output consistency across thinking and resolution configs.

Evaluates 20 sequential calls per configuration on the real terminal block image:
- verify: default (1280 px, default thinking)
- verify: lowest thinking (1280 px, thinking_level=LOW)
- verify: lowest thinking + 1024 px
- verify: lowest thinking + 768 px
- point: default (1280 px, default thinking)
- point: lowest thinking (1280 px, thinking_level=LOW)
"""

import io
import json
import logging
import os
import statistics
import sys
import time
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from google import genai
from google.cloud import secretmanager
from google.genai import types
from PIL import Image

from services.api.config import MODEL_FLASH, MODEL_ROBOTICS_ER
from services.api.images import clamp_point_coordinates
from services.api.prompts import (
    POINTER_PROMPT_TEMPLATE,
    PointerResponse,
    VERIFIER_PROMPT_TEMPLATE,
    VerifierResponse,
)

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("benchmark")


def get_genai_client() -> genai.Client:
    sm = secretmanager.SecretManagerServiceClient()
    key = (
        sm.access_secret_version(request={"name": "projects/takumi-cup-2026/secrets/GEMINI_API_KEY/versions/latest"})
        .payload.data.decode("utf-8")
        .strip()
    )
    return genai.Client(api_key=key, http_options={"api_version": "v1beta"})


def load_resized_image(max_px: int) -> bytes:
    temp_dir = os.environ.get("TEMP", os.environ.get("TMP", "/tmp"))
    full_path = Path(temp_dir) / "terminal_block_full.jpg"
    img_path = full_path if full_path.exists() else (Path(temp_dir) / "terminal_block_640.jpg")
    with open(img_path, "rb") as f:
        img = Image.open(f)
        if img.mode != "RGB":
            img = img.convert("RGB")
        w, h = img.size
        scale = min(1.0, max_px / max(w, h)) if max(w, h) > max_px else 1.0
        if scale < 1.0:
            new_size = (int(round(w * scale)), int(round(h * scale)))
            img = img.resize(new_size, Image.Resampling.LANCZOS)
        buf = io.BytesIO()
        img.save(buf, format="JPEG", quality=85)
        logger.info("Prepared image for max_px=%d: size=%s, bytes=%d", max_px, img.size, len(buf.getvalue()))
        return buf.getvalue()


def run_verify_benchmark(
    client: genai.Client,
    config_name: str,
    max_px: int,
    thinking_level: types.ThinkingLevel | None,
    num_runs: int = 20,
) -> dict[str, Any]:
    logger.info("Starting benchmark for %s (%d runs)...", config_name, num_runs)
    jpeg_bytes = load_resized_image(max_px)
    prompt = VERIFIER_PROMPT_TEMPLATE.format(
        step=1,
        instruction="Insert wire with blue ferrule into terminal 1",
        success_criteria="Blue ferrule fully seated in terminal 1",
        safety_rules_text="None listed.",
    )

    thinking_config = types.ThinkingConfig(thinking_level=thinking_level) if thinking_level else None
    cfg = types.GenerateContentConfig(
        response_mime_type="application/json",
        response_schema=VerifierResponse,
        thinking_config=thinking_config,
    )

    latencies: list[float] = []
    answers: list[dict[str, Any]] = []

    for i in range(1, num_runs + 1):
        t0 = time.perf_counter()
        try:
            r = client.models.generate_content(
                model=MODEL_FLASH,
                contents=[prompt, types.Part.from_bytes(data=jpeg_bytes, mime_type="image/jpeg")],
                config=cfg,
            )
            lat_ms = (time.perf_counter() - t0) * 1000
            latencies.append(lat_ms)
            parsed = json.loads(r.text)
            answers.append({
                "passed": parsed.get("passed"),
                "visible": parsed.get("visible"),
                "reason": parsed.get("reason"),
            })
            if i % 5 == 0 or i == 1:
                logger.info("  [%s] Run %d/%d: %.1f ms | passed=%s", config_name, i, num_runs, lat_ms, parsed.get("passed"))
        except Exception as e:
            logger.error("  [%s] Run %d failed: %s", config_name, i, e)

    latencies.sort()
    n = len(latencies)
    p50 = latencies[int(n * 0.50)] if n else 0
    p90 = latencies[min(n - 1, int(n * 0.90))] if n else 0

    return {
        "config": config_name,
        "max_px": max_px,
        "thinking": "LOW" if thinking_level else "DEFAULT",
        "p50_ms": round(p50, 1),
        "p90_ms": round(p90, 1),
        "mean_ms": round(statistics.mean(latencies), 1) if latencies else 0,
        "sample_answer": answers[0] if answers else {},
        "all_answers_consistent": all(a == answers[0] for a in answers) if answers else False,
        "answers_sample": answers[:3],
    }


def run_point_benchmark(
    client: genai.Client,
    config_name: str,
    max_px: int,
    thinking_level: types.ThinkingLevel | None,
    num_runs: int = 20,
) -> dict[str, Any]:
    logger.info("Starting benchmark for %s (%d runs)...", config_name, num_runs)
    jpeg_bytes = load_resized_image(max_px)
    prompt = POINTER_PROMPT_TEMPLATE.format(target="terminal 1 screw clamp")

    thinking_config = types.ThinkingConfig(thinking_level=thinking_level) if thinking_level else None
    cfg = types.GenerateContentConfig(
        response_mime_type="application/json",
        response_schema=PointerResponse,
        thinking_config=thinking_config,
    )

    latencies: list[float] = []
    points: list[list[int]] = []

    for i in range(1, num_runs + 1):
        t0 = time.perf_counter()
        try:
            r = client.models.generate_content(
                model=MODEL_ROBOTICS_ER,
                contents=[prompt, types.Part.from_bytes(data=jpeg_bytes, mime_type="image/jpeg")],
                config=cfg,
            )
            lat_ms = (time.perf_counter() - t0) * 1000
            latencies.append(lat_ms)
            parsed = json.loads(r.text)
            pt_list = parsed.get("points", [])
            coords = pt_list[0].get("point", []) if pt_list else []
            points.append(coords[:2])
            if i % 5 == 0 or i == 1:
                logger.info("  [%s] Run %d/%d: %.1f ms | point=%s", config_name, i, num_runs, lat_ms, coords[:2])
        except Exception as e:
            logger.error("  [%s] Run %d failed: %s", config_name, i, e)

    latencies.sort()
    n = len(latencies)
    p50 = latencies[int(n * 0.50)] if n else 0
    p90 = latencies[min(n - 1, int(n * 0.90))] if n else 0

    return {
        "config": config_name,
        "max_px": max_px,
        "thinking": "LOW" if thinking_level else "DEFAULT",
        "p50_ms": round(p50, 1),
        "p90_ms": round(p90, 1),
        "mean_ms": round(statistics.mean(latencies), 1) if latencies else 0,
        "sample_point": points[0] if points else [],
        "points_sample": points[:3],
    }


def main():
    client = get_genai_client()
    results = {}

    # 1. verify: default
    results["verify_default"] = run_verify_benchmark(client, "verify: default (1280px, default thinking)", 1280, None, 20)

    # 2. verify: lowest thinking
    results["verify_low_1280"] = run_verify_benchmark(client, "verify: lowest thinking (1280px, LOW)", 1280, types.ThinkingLevel.LOW, 20)

    # 3. verify: lowest thinking + 1024 px
    results["verify_low_1024"] = run_verify_benchmark(client, "verify: lowest thinking + 1024px", 1024, types.ThinkingLevel.LOW, 20)

    # 4. verify: lowest thinking + 768 px
    results["verify_low_768"] = run_verify_benchmark(client, "verify: lowest thinking + 768px", 768, types.ThinkingLevel.LOW, 20)

    # 5. point: default
    results["point_default"] = run_point_benchmark(client, "point: default (1280px, default thinking)", 1280, None, 20)

    # 6. point: lowest thinking
    results["point_low_1280"] = run_point_benchmark(client, "point: lowest thinking (1280px, LOW)", 1280, types.ThinkingLevel.LOW, 20)

    out_file = Path(__file__).resolve().parent / "benchmark_results.json"
    with open(out_file, "w", encoding="utf-8") as f:
        json.dump(results, f, indent=2)

    logger.info("Benchmark complete. Results saved to %s", out_file)
    print("\n=== FINAL BENCHMARK SUMMARY TABLE ===")
    print(f"{'Configuration':<45} | {'p50 (ms)':<10} | {'p90 (ms)':<10} | {'Answer / Point':<40}")
    print("-" * 115)
    for k, v in results.items():
        if "sample_answer" in v:
            ans_str = f"passed={v['sample_answer'].get('passed')}, visible={v['sample_answer'].get('visible')}"
        else:
            ans_str = f"point={v.get('sample_point')}"
        print(f"{v['config']:<45} | {v['p50_ms']:<10.1f} | {v['p90_ms']:<10.1f} | {ans_str:<40}")


if __name__ == "__main__":
    main()
