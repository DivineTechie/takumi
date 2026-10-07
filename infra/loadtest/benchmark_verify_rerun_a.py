"""Re-run experiment (a) after adding attribute-matching instruction to verifier prompt.

Attribute prompt addition:
"Check every attribute named in the success criteria (wire colour, terminal number, position). If any one does not match what you see, passed must be false."

Tests (a):
  instruction = "Insert the blue wire into terminal 1 and tighten its screw."
  success_criteria = "A blue wire's ferrule enters terminal 1, the leftmost terminal."
  image = terminal_wire_done_1280.jpg (black wire in terminal 1)
  expected = passed=False (wrong wire colour)

Runs 10x with LOW thinking and 10x with DEFAULT thinking.
"""

import json
import logging
import os
from pathlib import Path
import sys
import time
from typing import Any

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from google import genai
from google.genai import types

from services.api.config import MODEL_FLASH
from services.api.prompts import (
    VERIFIER_PROMPT_TEMPLATE,
    VerifierResponse,
)

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("rerun_a")


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


def run_experiment(
    client: genai.Client,
    image_bytes: bytes,
    prompt_template: str,
    instruction: str,
    success_criteria: str,
    thinking_level: str,
    num_runs: int = 10,
    label: str = "",
) -> dict[str, Any]:
    logger.info("Starting experiment: %s (%s, %d runs)...", label, thinking_level, num_runs)
    prompt = prompt_template.format(
        step=1,
        instruction=instruction,
        success_criteria=success_criteria,
        safety_rules_text="None listed.",
    )

    thinking_cfg = (
        types.ThinkingConfig(thinking_level=types.ThinkingLevel.LOW)
        if thinking_level == "low"
        else None
    )

    cfg = types.GenerateContentConfig(
        response_mime_type="application/json",
        response_schema=VerifierResponse,
        thinking_config=thinking_cfg,
    )

    results: list[dict[str, Any]] = []

    for i in range(1, num_runs + 1):
        t0 = time.perf_counter()
        try:
            r = client.models.generate_content(
                model=MODEL_FLASH,
                contents=[prompt, types.Part.from_bytes(data=image_bytes, mime_type="image/jpeg")],
                config=cfg,
            )
            lat_ms = (time.perf_counter() - t0) * 1000
            parsed = json.loads(r.text)
            passed = bool(parsed.get("passed", False))
            visible = bool(parsed.get("visible", False))
            reason = str(parsed.get("reason", ""))
            results.append({
                "run": i,
                "passed": passed,
                "visible": visible,
                "reason": reason,
                "latency_ms": round(lat_ms, 1),
            })
            logger.info("  [%s run %d/%d] passed=%s (%.1f ms) - reason: %s", thinking_level, i, num_runs, passed, lat_ms, reason[:80])
        except Exception as e:
            logger.error("  [%s run %d/%d] Error: %s", thinking_level, i, num_runs, e)
            results.append({
                "run": i,
                "error": str(e),
            })

        time.sleep(0.5)

    passed_count = sum(1 for r in results if r.get("passed") is True)
    return {
        "label": label,
        "thinking_level": thinking_level,
        "instruction": instruction,
        "success_criteria": success_criteria,
        "total_runs": num_runs,
        "passed_count": passed_count,
        "failed_count": num_runs - passed_count,
        "results": results,
    }


def main():
    import argparse
    from infra.loadtest.cost_guard import add_cost_guard_args, enforce_cost_guard

    parser = argparse.ArgumentParser(description="Post prompt rerun A benchmark")
    add_cost_guard_args(parser, default_max_calls=50)
    args = parser.parse_args()

    total_calls = 20
    default_verify_calls = 10
    enforce_cost_guard(
        total_calls=total_calls,
        max_calls=args.max_calls,
        is_default_thinking_verify=(default_verify_calls > 20),
        i_know_this_costs=args.i_know_this_costs,
    )

    client = get_genai_client()
    image_bytes = get_image_bytes()

    crit_a_instruction = "Insert the blue wire into terminal 1 and tighten its screw."
    crit_a_success = "A blue wire's ferrule enters terminal 1, the leftmost terminal."

    results = {}

    # 1. Rerun (a) with LOW thinking (post prompt update)
    results["post_prompt_crit_a_low"] = run_experiment(
        client, image_bytes, VERIFIER_PROMPT_TEMPLATE,
        crit_a_instruction, crit_a_success,
        thinking_level="low", num_runs=10,
        label="(a) Post-prompt update - LOW thinking [Expected: passed=False]",
    )

    # 2. Rerun (a) with DEFAULT thinking (post prompt update)
    results["post_prompt_crit_a_default"] = run_experiment(
        client, image_bytes, VERIFIER_PROMPT_TEMPLATE,
        crit_a_instruction, crit_a_success,
        thinking_level="default", num_runs=10,
        label="(a) Post-prompt update - DEFAULT thinking [Expected: passed=False]",
    )

    out_file = Path(__file__).resolve().parent / "post_prompt_rerun_a_results.json"
    with open(out_file, "w", encoding="utf-8") as f:
        json.dump(results, f, indent=2)

    logger.info("Saved post-prompt results to %s", out_file)
    print("\n=== POST-PROMPT RE-RUN (a) SUMMARY ===")
    for k, v in results.items():
        print(f"{v['label']}: passed={v['passed_count']}/{v['total_runs']} (failed={v['failed_count']}/{v['total_runs']})")


if __name__ == "__main__":
    main()
