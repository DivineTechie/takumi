import json
import logging
import socket
import urllib.error
import urllib.request
from typing import Any

import google.auth
from google.auth.transport.requests import Request as GoogleAuthRequest

logger = logging.getLogger("model_armor")

MODEL_ARMOR_PROJECT = "takumi-cup-2026"
MODEL_ARMOR_LOCATION = "asia-southeast1"
MODEL_ARMOR_TEMPLATE = "takumi-user-text"
MODEL_ARMOR_URL = (
    f"https://modelarmor.{MODEL_ARMOR_LOCATION}.rep.googleapis.com/v1/"
    f"projects/{MODEL_ARMOR_PROJECT}/locations/{MODEL_ARMOR_LOCATION}/templates/"
    f"{MODEL_ARMOR_TEMPLATE}:sanitizeUserPrompt"
)

_credentials: Any = None


def get_model_armor_token() -> str:
    global _credentials
    if _credentials is None:
        _credentials, _ = google.auth.default(
            scopes=["https://www.googleapis.com/auth/cloud-platform"]
        )
    if not _credentials.valid:
        _credentials.refresh(GoogleAuthRequest())
    return _credentials.token


def extract_matched_categories(filter_results: dict[str, Any]) -> list[str]:
    categories: list[str] = []
    if not isinstance(filter_results, dict):
        return categories

    # Prompt injection / jailbreak
    pi = filter_results.get("pi_and_jailbreak", {}).get("piAndJailbreakFilterResult", {})
    if pi.get("matchState") == "MATCH_FOUND":
        categories.append("prompt_injection")

    # Malicious URIs
    uris = filter_results.get("malicious_uris", {}).get("maliciousUriFilterResult", {})
    if uris.get("matchState") == "MATCH_FOUND":
        categories.append("malicious_uris")

    # CSAM
    csam = filter_results.get("csam", {}).get("csamFilterFilterResult", {})
    if csam.get("matchState") == "MATCH_FOUND":
        categories.append("csam")

    # Responsible AI
    rai = filter_results.get("rai", {}).get("raiFilterResult", {})
    if rai.get("matchState") == "MATCH_FOUND":
        type_results = rai.get("raiFilterTypeResults", {})
        for cat_name, details in type_results.items():
            if isinstance(details, dict) and details.get("matchState") == "MATCH_FOUND":
                categories.append(f"rai_{cat_name}")
        if not categories:
            categories.append("rai")

    return categories


def screen_text(text: str, purpose: str = "point_target") -> dict[str, Any]:
    """Screen untrusted user-supplied text through Google Cloud Model Armor.

    Policy:
      - purpose="question" (e.g. /api/ask): Fail-CLOSED on block, timeout, or error.
      - purpose="point_target" (e.g. /api/point): Fail-OPEN on timeout/error with structured warning;
        Fail-CLOSED if Model Armor explicitly identifies a security block.
    Timeout: 1.5 s.
    Returns: {"allowed": bool, "categories": list[str]}
    """
    if not text or not text.strip():
        return {"allowed": True, "categories": []}

    try:
        token = get_model_armor_token()
        payload = json.dumps({"user_prompt_data": {"text": text}}).encode("utf-8")
        req = urllib.request.Request(
            MODEL_ARMOR_URL,
            data=payload,
            headers={
                "Authorization": f"Bearer {token}",
                "Content-Type": "application/json",
            },
            method="POST",
        )

        with urllib.request.urlopen(req, timeout=1.5) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            sanitization = data.get("sanitizationResult", {})
            match_state = sanitization.get("filterMatchState")

            if match_state == "MATCH_FOUND":
                cats = extract_matched_categories(sanitization.get("filterResults", {}))
                # Log structured warning: purpose and categories only, NEVER raw text
                logger.warning(
                    "Model Armor blocked untrusted text",
                    extra={
                        "event": "model_armor_block",
                        "purpose": purpose,
                        "categories": cats,
                    },
                )
                return {"allowed": False, "categories": cats}

            return {"allowed": True, "categories": []}

    except (urllib.error.URLError, TimeoutError, socket.timeout) as exc:
        is_timeout = isinstance(exc, (TimeoutError, socket.timeout)) or (
            isinstance(exc, urllib.error.URLError) and isinstance(exc.reason, socket.timeout)
        )
        reason_label = "timeout" if is_timeout else "network_error"

        if purpose == "question":
            # Fail-CLOSED for free-form questions
            logger.warning(
                "Model Armor screening failed (fail-closed)",
                extra={"event": "model_armor_fail_closed", "purpose": purpose, "reason": reason_label},
            )
            return {"allowed": False, "categories": [reason_label]}
        else:
            # Fail-OPEN for /api/point targets so coach does not break
            logger.warning(
                "Model Armor screening failed (fail-open)",
                extra={"event": "model_armor_fail_open", "purpose": purpose, "reason": reason_label},
            )
            return {"allowed": True, "categories": []}

    except Exception as exc:
        logger.error(
            "Model Armor screening unexpected error",
            extra={"event": "model_armor_error", "purpose": purpose, "error_type": type(exc).__name__},
        )
        if purpose == "question":
            return {"allowed": False, "categories": ["error"]}
        else:
            return {"allowed": True, "categories": []}
