"""Benchmark for thinking budget 0 (verify & point) and positive verification test.

1. Budget 0 benchmark:
   - 20 sequential calls for verify (gemini-3.8-flash, thinking_budget=0, 1280px)
   - 20 sequential calls for point (gemini-robotics-er-2-preview, thinking_budget=0, 1280px)
   on the original terminal-block image.

2. Positive verification benchmark (step IS done):
   - 10 sequential calls for verify (gemini-3.8-flash, thinking_level=LOW, 1280px)
   on a public-domain photo of a wire fully connected into terminal 1.
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
import urllib.request

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from google import genai
from google.cloud import secretmanager
from google.genai import types
from PIL import Image

from services.api.config import MODEL_FLASH, MODEL_ROBOTICS_ER
from services.api.prompts import (
    POINTER_PROMPT_TEMPLATE,
    PointerResponse,
    VERIFIER_PROMPT_TEMPLATE,
    VerifierResponse,
)

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("benchmark_budget0")


def get_genai_client() -> genai.Client:
    sm = secretmanager.SecretManagerServiceClient()
    key = (
        sm.access_secret_version(request={"name": "projects/takumi-cup-2026/secrets/GEMINI_API_KEY/versions/latest"})
        .payload.data.decode("utf-8")
        .strip()
    )
    return genai.Client(api_key=key, http_options={"api_version": "v1beta"})


def load_original_image(max_px: int = 1280) -> bytes:
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
        return buf.getvalue()


def get_or_download_connected_image(max_px: int = 1280) -> bytes:
    temp_dir = os.environ.get("TEMP", os.environ.get("TMP", "/tmp"))
    out_file = Path(temp_dir) / "terminal_wire_done_1280.jpg"
    if not out_file.exists():
        logger.info("Downloading public-domain connected terminal block photo from Wikimedia...")
        url = "https://upload.wikimedia.org/wikipedia/commons/5/57/Cabinet_Terminal_Block.jpg"
        req = urllib.request.Request(url, headers={"User-Agent": "TakumiApp/1.0 (dev@takumi.local)"})
        with urllib.request.urlopen(req, timeout=20) as resp:
            data = resp.read()
        img = Image.open(io.BytesIO(data))
        if img.mode != "RGB":
            img = img.convert("RGB")
        w, h = img.size
        scale = min(1.0, max_px / max(w, h)) if max(w, h) > max_px else 1.0
        if scale < 1.0:
            new_size = (int(round(w * scale)), int(round(h * scale)))
            img = img.resize(new_size, Image.Resampling.LANCZOS)
        buf = io.BytesIO()
        img.save(buf, format="JPEG", quality=85)
        with open(out_file, "wb") as f:
            f.write(buf.getvalue())
        logger.info("Saved connected image to %s (%d bytes)", out_file, len(buf.getvalue()))
        return buf.getvalue()
    else:
        with open(out_file, "rb") as f:
            return f.read()


def run_verify_budget0_benchmark(client: genai.Client, num_runs: int = 20) -> dict[str, Any]:
    logger.info("Starting verify benchmark with thinking_budget=0 (%d runs)...", num_runs)
    jpeg_bytes = load_original_image(1280)
    prompt = VERIFIER_PROMPT_TEMPLATE.format(
        step=1,
        instruction="Insert wire with blue ferrule into terminal 1",
        success_criteria="Blue ferrule fully seated in terminal 1",
        safety_rules_text="None listed.",
    )
    cfg = types.GenerateContentConfig(
        response_mime_type="application/json",
        response_schema=VerifierResponse,
        thinking_config=types.ThinkingConfig(thinking_budget=0),
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
                logger.info("  [verify budget=0] Run %d/%d: %.1f ms | passed=%s", i, num_runs, lat_ms, parsed.get("passed"))
        except Exception as e:
            logger.error("  [verify budget=0] Run %d failed: %s", i, e)

    latencies.sort()
    n = len(latencies)
    p50 = latencies[int(n * 0.50)] if n else 0
    p90 = latencies[min(n - 1, int(n * 0.90))] if n else 0

    return {
        "config": "verify: budget 0 (1280px, thinking_budget=0)",
        "p50_ms": round(p50, 1),
        "p90_ms": round(p90, 1),
        "mean_ms": round(statistics.mean(latencies), 1) if latencies else 0,
        "sample_answer": answers[0] if answers else {},
        "answers_sample": answers[:3],
    }


def run_point_budget0_benchmark(client: genai.Client, num_runs: int = 20) -> dict[str, Any]:
    logger.info("Starting point benchmark with thinking_budget=0 (%d runs)...", num_runs)
    jpeg_bytes = load_original_image(1280)
    prompt = POINTER_PROMPT_TEMPLATE.format(target="terminal 1 screw clamp")
    cfg = types.GenerateContentConfig(
        response_mime_type="application/json",
        response_schema=PointerResponse,
        thinking_config=types.ThinkingConfig(thinking_budget=0),
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
                logger.info("  [point budget=0] Run %d/%d: %.1f ms | point=%s", i, num_runs, lat_ms, coords[:2])
        except Exception as e:
            logger.error("  [point budget=0] Run %d failed: %s", i, e)

    latencies.sort()
    n = len(latencies)
    p50 = latencies[int(n * 0.50)] if n else 0
    p90 = latencies[min(n - 1, int(n * 0.90))] if n else 0

    return {
        "config": "point: budget 0 (1280px, thinking_budget=0)",
        "p50_ms": round(p50, 1),
        "p90_ms": round(p90, 1),
        "mean_ms": round(statistics.mean(latencies), 1) if latencies else 0,
        "sample_point": points[0] if points else [],
        "points_sample": points[:3],
    }


def run_positive_verify_benchmark(client: genai.Client, num_runs: int = 10) -> dict[str, Any]:
    logger.info("Starting positive verify benchmark (step IS done, 10 runs)...")
    jpeg_bytes = get_or_download_connected_image(1280)
    prompt = VERIFIER_PROMPT_TEMPLATE.format(
        step=1,
        instruction="Insert and connect wire to terminal 1 of the terminal block",
        success_criteria="Wire is inserted and connected to terminal 1",
        safety_rules_text="None listed.",
    )
    cfg = types.GenerateContentConfig(
        response_mime_type="application/json",
        response_schema=VerifierResponse,
        thinking_config=types.ThinkingConfig(thinking_level=types.ThinkingLevel.LOW),
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
            passed = bool(parsed.get("passed", False))
            answers.append({
                "passed": passed,
                "visible": parsed.get("visible"),
                "reason": parsed.get("reason"),
            })
            logger.info("  [positive verify LOW@1280] Run %d/%d: %.1f ms | passed=%s", i, num_runs, lat_ms, passed)
        except Exception as e:
            logger.error("  [positive verify LOW@1280] Run %d failed: %s", i, e)

    latencies.sort()
    n = len(latencies)
    p50 = latencies[int(n * 0.50)] if n else 0
    p90 = latencies[min(n - 1, int(n * 0.90))] if n else 0
    passed_count = sum(1 for a in answers if a.get("passed") is True)

    return {
        "config": "verify: LOW@1280 on positive image (step IS done)",
        "total_runs": num_runs,
        "passed_count": passed_count,
        "passed_rate_pct": round((passed_count / num_runs) * 100.0, 1) if num_runs else 0,
        "p50_ms": round(p50, 1),
        "p90_ms": round(p90, 1),
        "mean_ms": round(statistics.mean(latencies), 1) if latencies else 0,
        "sample_answer": answers[0] if answers else {},
        "answers_sample": answers[:3],
    }


def main():
    client = get_genai_client()
    results = {}

    # 1. verify: budget 0
    results["verify_budget0"] = run_verify_budget0_benchmark(client, 20)

    # 2. point: budget 0
    results["point_budget0"] = run_point_budget0_benchmark(client, 20)

    # 3. verify: positive image (step IS done) with LOW@1280
    results["verify_positive_done"] = run_positive_verify_benchmark(client, 10)

    out_file = Path(__file__).resolve().parent / "benchmark_budget0_and_done_results.json"
    with open(out_file, "w", encoding="utf-8") as f:
        json.dump(results, f, indent=2)

    logger.info("Benchmark complete. Results saved to %s", out_file)
    print("\n=== BENCHMARK RESULTS SUMMARY ===")
    for k, v in results.items():
        print(f"\n[{v['config']}]")
        print(f"  p50: {v['p50_ms']} ms | p90: {v['p90_ms']} ms | mean: {v['mean_ms']} ms")
        if "passed_count" in v:
            print(f"  passed=True: {v['passed_count']}/{v['total_runs']} ({v['passed_rate_pct']}%)")
        if "sample_answer" in v:
            print(f"  sample answer: passed={v['sample_answer'].get('passed')} | reason='{v['sample_answer'].get('reason')}'")
        if "sample_point" in v:
            print(f"  sample point: {v['sample_point']}")


if __name__ == "__main__":
    main()
