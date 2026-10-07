"""Test script for:
1. Safety path: /api/watch 10x on terminal_wire_done_1280.jpg with seed step 1
2. /api/verify with criteria (b) ("A black wire's ferrule enters terminal 1")
   Testing budgets: LOW, 256, 512, 1024
   Both before and after adding the ferrule/bare-copper instruction to VERIFIER_PROMPT_TEMPLATE.
"""

import io
import json
import logging
import os
from pathlib import Path
import statistics
import sys
import time
from typing import Any

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from google import genai
from google.genai import types

from services.api.config import MODEL_FLASH, MODEL_FLASH_LITE
from services.api.gemini import match_closest_safety_rule
from services.api.prompts import (
    VERIFIER_PROMPT_TEMPLATE,
    VerifierResponse,
    WATCHER_PROMPT_TEMPLATE,
    WatcherResponse,
)

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("safety_and_budgets")


def get_genai_client() -> genai.Client:
    key = os.environ.get("GEMINI_API_KEY")
    if not key:
        import subprocess
        res = subprocess.run(
            ["gcloud", "secrets", "versions", "access", "latest", "--secret=GEMINI_API_KEY", "--project=takumi-cup-2026"],
            capture_output=True,
            text=True,
            check=True,
            shell=True,
        )
        key = res.stdout.strip()
    return genai.Client(api_key=key, http_options={"api_version": "v1beta"})


def get_image_bytes() -> bytes:
    temp_dir = os.environ.get("TEMP", os.environ.get("TMP", "/tmp"))
    img_path = Path(temp_dir) / "terminal_wire_done_1280.jpg"
    with open(img_path, "rb") as f:
        return f.read()


def run_watch_test(client: genai.Client, image_bytes: bytes, num_runs: int = 10) -> dict[str, Any]:
    logger.info("=== Running /api/watch on photo with seed step 1 (%d runs) ===", num_runs)
    step = 1
    instruction = "Insert the blue wire into terminal 1 and tighten its screw."
    success_criteria = "A blue wire's ferrule enters terminal 1, the leftmost terminal."
    common_mistakes = [{"description": "Wire in terminal 2", "visual_cue": "blue wire in the second slot"}]
    safety_rules = [
        "No bare copper visible outside a terminal",
        "Panel power must be off",
    ]

    mistakes_str = "\n".join(
        f"- {m['description']}: {m['visual_cue']}" for m in common_mistakes
    )
    safety_str = "\n".join(f"- {rule}" for rule in safety_rules)

    prompt = WATCHER_PROMPT_TEMPLATE.format(
        step=step,
        instruction=instruction,
        success_criteria=success_criteria,
        common_mistakes_text=mistakes_str,
        safety_rules_text=safety_str,
    )

    cfg = types.GenerateContentConfig(
        response_mime_type="application/json",
        response_schema=WatcherResponse,
    )

    results = []
    state_counts = {}

    for i in range(1, num_runs + 1):
        t0 = time.perf_counter()
        try:
            r = client.models.generate_content(
                model=MODEL_FLASH_LITE,
                contents=[prompt, types.Part.from_bytes(data=image_bytes, mime_type="image/jpeg")],
                config=cfg,
            )
            lat_ms = (time.perf_counter() - t0) * 1000
            parsed = json.loads(r.text)
            state = str(parsed.get("state", "error"))
            reason = str(parsed.get("reason", ""))
            fix = str(parsed.get("fix", ""))
            raw_rule = parsed.get("rule")
            matched_rule = match_closest_safety_rule(str(raw_rule) if raw_rule else None, safety_rules) if state == "hazard" else None

            results.append({
                "run": i,
                "state": state,
                "reason": reason,
                "fix": fix,
                "raw_rule": raw_rule,
                "matched_rule": matched_rule,
                "latency_ms": round(lat_ms, 1),
            })
            state_counts[state] = state_counts.get(state, 0) + 1
            logger.info("  [watch run %d/%d] state=%s | rule=%s | reason=%s (%.1f ms)", i, num_runs, state, matched_rule, reason, lat_ms)
        except Exception as e:
            logger.error("  [watch run %d/%d] Error: %s", i, num_runs, e)
            results.append({"run": i, "error": str(e)})

        time.sleep(0.3)

    return {
        "endpoint": "watch",
        "total_runs": num_runs,
        "state_counts": state_counts,
        "results": results,
    }


def run_verify_budget_test(
    client: genai.Client,
    image_bytes: bytes,
    prompt_template: str,
    budget_setting: str | int,
    num_runs: int = 10,
) -> dict[str, Any]:
    logger.info("--- Running verify test for budget setting: %s (%d runs) ---", budget_setting, num_runs)
    instruction = "Insert the black wire into terminal 1 and tighten its screw."
    success_criteria = "A black wire's ferrule enters terminal 1, the leftmost terminal."
    safety_str = "None listed."

    prompt = prompt_template.format(
        step=1,
        instruction=instruction,
        success_criteria=success_criteria,
        safety_rules_text=safety_str,
    )

    if budget_setting == "low":
        thinking_cfg = types.ThinkingConfig(thinking_level=types.ThinkingLevel.LOW)
    elif budget_setting == "default":
        thinking_cfg = None
    else:
        thinking_cfg = types.ThinkingConfig(thinking_budget=int(budget_setting))

    cfg = types.GenerateContentConfig(
        response_mime_type="application/json",
        response_schema=VerifierResponse,
        thinking_config=thinking_cfg,
    )

    results = []
    latencies = []

    for i in range(1, num_runs + 1):
        t0 = time.perf_counter()
        try:
            r = client.models.generate_content(
                model=MODEL_FLASH,
                contents=[prompt, types.Part.from_bytes(data=image_bytes, mime_type="image/jpeg")],
                config=cfg,
            )
            lat_ms = (time.perf_counter() - t0) * 1000
            latencies.append(lat_ms)
            parsed = json.loads(r.text)
            passed = bool(parsed.get("passed", False))
            visible = bool(parsed.get("visible", False))
            reason = str(parsed.get("reason", ""))
            fix = str(parsed.get("fix", ""))

            # Is this a correct rejection due to missing ferrule / bare copper?
            reason_lower = reason.lower()
            is_correct_rejection = (passed is False) and any(
                w in reason_lower for w in ["ferrule", "copper", "bare", "strand"]
            )

            results.append({
                "run": i,
                "passed": passed,
                "visible": visible,
                "reason": reason,
                "fix": fix,
                "is_correct_rejection": is_correct_rejection,
                "latency_ms": round(lat_ms, 1),
            })
            logger.info("  [%s run %d/%d] passed=%s | correct_rejection=%s (%.1f ms) - %s", budget_setting, i, num_runs, passed, is_correct_rejection, lat_ms, reason[:70])
        except Exception as e:
            logger.error("  [%s run %d/%d] Error: %s", budget_setting, i, num_runs, e)
            results.append({"run": i, "error": str(e)})

        time.sleep(0.3)

    latencies_sorted = sorted(latencies)
    n = len(latencies_sorted)
    p50 = latencies_sorted[int(n * 0.50)] if n else 0
    p90 = latencies_sorted[min(n - 1, int(n * 0.90))] if n else 0
    correct_rejections = sum(1 for r in results if r.get("is_correct_rejection") is True)
    passed_count = sum(1 for r in results if r.get("passed") is True)
    failed_count = sum(1 for r in results if r.get("passed") is False)

    return {
        "budget_setting": budget_setting,
        "total_runs": num_runs,
        "passed_count": passed_count,
        "failed_count": failed_count,
        "correct_rejections": correct_rejections,
        "correct_rejection_rate": f"{correct_rejections}/{num_runs}",
        "p50_ms": round(p50, 1),
        "p90_ms": round(p90, 1),
        "mean_ms": round(statistics.mean(latencies), 1) if latencies else 0,
        "results": results,
    }


def main():
    import argparse
    from infra.loadtest.cost_guard import add_cost_guard_args, enforce_cost_guard

    parser = argparse.ArgumentParser(description="Test safety path and verify budgets")
    add_cost_guard_args(parser, default_max_calls=50)
    args = parser.parse_args()

    # 10 watch + 40 current prompt + 40 updated prompt = 90 calls
    enforce_cost_guard(
        total_calls=90,
        max_calls=args.max_calls,
        is_default_thinking_verify=False,
        i_know_this_costs=args.i_know_this_costs,
    )

    client = get_genai_client()
    image_bytes = get_image_bytes()

    all_data = {}

    # 1. Watcher safety path test (10 runs)
    watch_data = run_watch_test(client, image_bytes, 10)
    all_data["watch_test"] = watch_data

    # 2. Verify budget test with CURRENT prompt (LOW, 256, 512, 1024)
    logger.info("=== Testing budgets with CURRENT prompt ===")
    budgets = ["low", 256, 512, 1024]
    current_prompt_results = {}
    for b in budgets:
        current_prompt_results[str(b)] = run_verify_budget_test(
            client, image_bytes, VERIFIER_PROMPT_TEMPLATE, b, 10
        )
    all_data["current_prompt_budgets"] = current_prompt_results

    # 3. Verify budget test with UPDATED prompt (including ferrule/bare copper rule)
    logger.info("=== Testing budgets with UPDATED prompt (ferrule rule added) ===")
    prompt_addition = " If a success criterion names a part (for example a ferrule), confirm you can actually see that part. If you cannot see it, passed must be false. Visible bare copper strands mean there is no ferrule."
    # Inject into INSPECTION INSTRUCTIONS right after the attribute check
    updated_template = VERIFIER_PROMPT_TEMPLATE.replace(
        "passed must be false.\n",
        f"passed must be false.\n- {prompt_addition.strip()}\n",
    )
    updated_prompt_results = {}
    for b in budgets:
        updated_prompt_results[str(b)] = run_verify_budget_test(
            client, image_bytes, updated_template, b, 10
        )
    all_data["updated_prompt_budgets"] = updated_prompt_results

    out_file = Path(__file__).resolve().parent / "safety_and_budgets_results.json"
    with open(out_file, "w", encoding="utf-8") as f:
        json.dump(all_data, f, indent=2)

    logger.info("All tests completed. Saved to %s", out_file)


if __name__ == "__main__":
    main()
