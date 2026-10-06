"""Gemini API client integrations for live-token, watch, verify, and point."""

import asyncio
from datetime import datetime, timedelta, timezone
import json
import logging
import random
import time
from typing import Any

from google import genai
from google.genai import types

from services.api.config import (
    GEMINI_API_KEY,
    MODEL_FLASH,
    MODEL_FLASH_LITE,
    MODEL_LIVE,
    MODEL_ROBOTICS_ER,
    TIMEOUT_LIVE_TOKEN_S,
    TIMEOUT_POINT_S,
    TIMEOUT_VERIFY_S,
    TIMEOUT_WATCH_S,
)
from services.api.images import clamp_point_coordinates
from services.api.prompts import (
    POINTER_PROMPT_TEMPLATE,
    PointerResponse,
    VERIFIER_PROMPT_TEMPLATE,
    VerifierResponse,
    WATCHER_PROMPT_TEMPLATE,
    WatcherResponse,
)
from services.api.telemetry import trace_gemini_call

logger = logging.getLogger("takumi.gemini")

_genai_client: genai.Client | None = None


def get_genai_client() -> genai.Client:
    """Returns singleton genai.Client initialized with stripped GEMINI_API_KEY."""
    global _genai_client
    if _genai_client is None:
        _genai_client = genai.Client(
            api_key=GEMINI_API_KEY,
            http_options={"api_version": "v1beta"},
        )
    return _genai_client


def _truncate_words(text: str, max_words: int) -> str:
    """Truncates string to at most max_words words."""
    words = text.split()
    if len(words) <= max_words:
        return text
    return " ".join(words[:max_words])


async def create_live_token(purpose: str) -> dict[str, Any]:
    """Issues a single-use Gemini Live ephemeral token with 10s timeout.

    Configured with uses=1, expire_time=now+12m, new_session_expire_time=now+1m,
    live_connect_constraints={model: gemini-3.8-live, config: {response_modalities: [AUDIO]}}.
    Never logs the token.
    """
    client = get_genai_client()
    now = datetime.now(timezone.utc)

    config = types.CreateAuthTokenConfig(
        uses=1,
        expire_time=now + timedelta(minutes=12),
        new_session_expire_time=now + timedelta(minutes=1),
        live_connect_constraints=types.LiveConnectConstraints(
            model=MODEL_LIVE,
            config=types.LiveConnectConfig(
                response_modalities=["AUDIO"],
            ),
        ),
        lock_additional_fields=[],
        http_options={"api_version": "v1beta"},
    )

    def _sync_create():
        with trace_gemini_call("auth_tokens.create", MODEL_LIVE):
            return client.auth_tokens.create(config=config)

    auth_token = await asyncio.wait_for(
        asyncio.to_thread(_sync_create),
        timeout=TIMEOUT_LIVE_TOKEN_S,
    )

    # Return token dictionary without logging the token value
    return {
        "token": auth_token.name,
        "model": MODEL_LIVE,
        "max_minutes": 10,
    }


def match_closest_safety_rule(raw_rule: str | None, safety_rules: list[str]) -> str | None:
    """Matches raw_rule to the closest safety_rule from request's safety_rules.

    Strategy:
    1. Exact match (case-insensitive stripped).
    2. Substring match (raw_rule in rule or rule in raw_rule).
    3. Best word overlap (highest number of shared words with at least 1 word match).
    4. If nothing matches, returns None and logs warning.
    """
    if not raw_rule or not safety_rules:
        return None

    cleaned_raw = raw_rule.strip().lower()
    if not cleaned_raw:
        return None

    # 1. Exact match (case-insensitive)
    for rule in safety_rules:
        if rule.strip().lower() == cleaned_raw:
            return rule

    # 2. Substring match
    for rule in safety_rules:
        cleaned_rule = rule.strip().lower()
        if cleaned_raw in cleaned_rule or cleaned_rule in cleaned_raw:
            return rule

    # 3. Best word overlap
    raw_words = set(cleaned_raw.split())
    best_match: str | None = None
    best_overlap = 0

    for rule in safety_rules:
        rule_words = set(rule.strip().lower().split())
        overlap = len(raw_words.intersection(rule_words))
        if overlap > best_overlap:
            best_overlap = overlap
            best_match = rule

    if best_match and best_overlap > 0:
        return best_match

    logger.warning("Hazard rule '%s' could not be mapped to any safety_rules: %s", raw_rule, safety_rules)
    return None


async def call_watch(
    step: int,
    instruction: str,
    success_criteria: str,
    common_mistakes: list[dict[str, str]],
    safety_rules: list[str],
    jpeg_bytes: bytes,
) -> dict[str, Any]:
    """Calls gemini-3.5-flash-lite for live frame watching with a 6-second timeout.

    On any model or parse error, immediately returns state 'error' with error class name.
    Server-side enforces max 12 words for reason and max 10 words for fix.
    """
    t_start = time.perf_counter()

    # Format common mistakes
    if common_mistakes:
        mistakes_str = "\n".join(
            f"- Mistake: {m.get('description', '')} (Visual cue: {m.get('visual_cue', '')})"
            for m in common_mistakes
        )
    else:
        mistakes_str = "None listed."

    # Format safety rules
    if safety_rules:
        safety_str = "\n".join(f"- {rule}" for rule in safety_rules)
    else:
        safety_str = "None listed."

    prompt_text = WATCHER_PROMPT_TEMPLATE.format(
        step=step,
        instruction=instruction,
        success_criteria=success_criteria,
        common_mistakes_text=mistakes_str,
        safety_rules_text=safety_str,
    )

    client = get_genai_client()

    def _sync_generate():
        with trace_gemini_call("watch.generate_content", MODEL_FLASH_LITE):
            return client.models.generate_content(
                model=MODEL_FLASH_LITE,
                contents=[
                    prompt_text,
                    types.Part.from_bytes(data=jpeg_bytes, mime_type="image/jpeg"),
                ],
                config=types.GenerateContentConfig(
                    response_mime_type="application/json",
                    response_schema=WatcherResponse,
                ),
            )

    try:
        response = await asyncio.wait_for(
            asyncio.to_thread(_sync_generate),
            timeout=TIMEOUT_WATCH_S,
        )

        secs = round(time.perf_counter() - t_start, 2)
        parsed = json.loads(response.text)
        
        state = str(parsed.get("state", "error"))
        reason = _truncate_words(str(parsed.get("reason", "")), 12)
        fix = _truncate_words(str(parsed.get("fix", "")), 10)

        rule: str | None = None
        if state == "hazard":
            raw_rule = parsed.get("rule")
            rule = match_closest_safety_rule(str(raw_rule) if raw_rule else None, safety_rules)

        # Log state and latency, never the image
        logger.info(
            "Watch call completed",
            extra={"props": {"endpoint": "watch", "state": state, "latency_s": secs, "rule": rule}},
        )

        return {
            "state": state,
            "reason": reason,
            "fix": fix,
            "rule": rule,
            "secs": secs,
        }

    except Exception as e:
        secs = round(time.perf_counter() - t_start, 2)
        error_class = type(e).__name__
        logger.warning(
            "Watch call failed fast",
            extra={"props": {"endpoint": "watch", "error_class": error_class, "latency_s": secs}},
        )
        return {
            "state": "error",
            "reason": error_class,
            "fix": "",
            "rule": None,
            "secs": secs,
        }


async def call_verify(
    step: int,
    instruction: str,
    success_criteria: str,
    safety_rules: list[str],
    jpeg_bytes: bytes,
) -> dict[str, Any]:
    """Calls gemini-3.8-flash for strict verification with 15s timeout and 1 retry with jitter."""
    t_start = time.perf_counter()

    safety_str = "\n".join(f"- {rule}" for rule in safety_rules) if safety_rules else "None listed."
    prompt_text = VERIFIER_PROMPT_TEMPLATE.format(
        step=step,
        instruction=instruction,
        success_criteria=success_criteria,
        safety_rules_text=safety_str,
    )

    client = get_genai_client()

    def _sync_generate():
        with trace_gemini_call("verify.generate_content", MODEL_FLASH):
            return client.models.generate_content(
                model=MODEL_FLASH,
                contents=[
                    prompt_text,
                    types.Part.from_bytes(data=jpeg_bytes, mime_type="image/jpeg"),
                ],
                config=types.GenerateContentConfig(
                    response_mime_type="application/json",
                    response_schema=VerifierResponse,
                ),
            )

    attempts = 0
    last_err = None
    while attempts < 2:
        attempts += 1
        try:
            response = await asyncio.wait_for(
                asyncio.to_thread(_sync_generate),
                timeout=TIMEOUT_VERIFY_S,
            )
            secs = round(time.perf_counter() - t_start, 2)
            parsed = json.loads(response.text)
            return {
                "passed": bool(parsed.get("passed", False)),
                "visible": bool(parsed.get("visible", False)),
                "reason": str(parsed.get("reason", "")),
                "fix": str(parsed.get("fix", "")),
                "secs": secs,
            }
        except Exception as e:
            last_err = e
            if attempts == 1:
                await asyncio.sleep(random.uniform(0.5, 1.5))

    raise last_err or RuntimeError("Verify call failed")


async def call_point(
    target: str,
    jpeg_bytes: bytes,
) -> dict[str, Any]:
    """Calls gemini-robotics-er-2-preview for target spatial pointing with 15s timeout and 1 retry."""
    t_start = time.perf_counter()

    prompt_text = POINTER_PROMPT_TEMPLATE.format(target=target)
    client = get_genai_client()

    def _sync_generate():
        with trace_gemini_call("point.generate_content", MODEL_ROBOTICS_ER):
            return client.models.generate_content(
                model=MODEL_ROBOTICS_ER,
                contents=[
                    prompt_text,
                    types.Part.from_bytes(data=jpeg_bytes, mime_type="image/jpeg"),
                ],
                config=types.GenerateContentConfig(
                    response_mime_type="application/json",
                    response_schema=PointerResponse,
                ),
            )

    attempts = 0
    last_err = None
    while attempts < 2:
        attempts += 1
        try:
            response = await asyncio.wait_for(
                asyncio.to_thread(_sync_generate),
                timeout=TIMEOUT_POINT_S,
            )
            secs = round(time.perf_counter() - t_start, 2)
            parsed = json.loads(response.text)
            raw_points = parsed.get("points", [])
            clamped = clamp_point_coordinates(raw_points)
            return {
                "points": clamped,
                "secs": secs,
            }
        except Exception as e:
            last_err = e
            if attempts == 1:
                await asyncio.sleep(random.uniform(0.5, 1.5))

    raise last_err or RuntimeError("Point call failed")
