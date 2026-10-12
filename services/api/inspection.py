"""End-of-line quality inspection pipeline.

Implements dual-stage visual inspection with:
- Stage 1 'screen': gemini-3.5-flash-lite with candidate + 3 reference images
- Stage 2 'confirm': gemini-3.8-flash on candidate alone
- Modes:
    - few_false_alarms (DEFAULT): screen first; confirm ONLY if screen flags; defective ONLY if both flag.
    - catch_everything: screen and confirm in parallel on EVERY image; defective if EITHER flags.
"""

import asyncio
import io
import json
import logging
import time
from typing import Any

from collections import OrderedDict
from PIL import Image
from google import genai
from google.genai import types

from services.api.config import (
    INSPECT_JPEG_QUALITY,
    INSPECT_MAX_PX,
    MODEL_FLASH,
    MODEL_FLASH_LITE,
    TIMEOUT_INSPECT_CONFIRM_S,
    TIMEOUT_INSPECT_SCREEN_S,
)
from services.api.gemini import get_genai_client
from services.api.prompts import InspectionStageResponse, build_inspection_prompt
from services.api.telemetry import elapsed_ms, trace_gemini_call

logger = logging.getLogger("takumi.inspection")

# In-memory cache for resized product reference images (keyed by product_id + ref_paths, max 32 entries)
_REF_CACHE: OrderedDict[tuple[str, tuple[str, ...]], list[bytes]] = OrderedDict()
_REF_CACHE_MAX_ENTRIES = 32


def get_cached_references(product_id: str, ref_paths: list[str]) -> list[bytes] | None:
    """Retrieves cached resized reference images for product if present."""
    key = (product_id, tuple(ref_paths[:3]))
    if key in _REF_CACHE:
        _REF_CACHE.move_to_end(key)
        return _REF_CACHE[key]
    return None


def cache_references(product_id: str, ref_paths: list[str], refs: list[bytes]) -> None:
    """Stores resized reference images in LRU cache (max 32 entries)."""
    key = (product_id, tuple(ref_paths[:3]))
    _REF_CACHE[key] = refs
    if len(_REF_CACHE) > _REF_CACHE_MAX_ENTRIES:
        _REF_CACHE.popitem(last=False)


def get_or_load_references(product_id: str, ref_paths: list[str]) -> list[bytes]:
    """Retrieves cached reference images or downloads and pre-resizes them from Cloud Storage."""
    cached = get_cached_references(product_id, ref_paths)
    if cached is not None:
        return cached

    from services.api.storage_client import download_blob_bytes

    resized_refs: list[bytes] = []
    for path in ref_paths[:3]:
        raw_b = download_blob_bytes(path)
        resized_refs.append(resize_inspection_image(raw_b))

    cache_references(product_id, ref_paths, resized_refs)
    return resized_refs


def resize_inspection_image(image_bytes: bytes, max_long_side: int = INSPECT_MAX_PX, quality: int = INSPECT_JPEG_QUALITY) -> bytes:
    """Decodes and resizes an image so its longest side does not exceed max_long_side at specified JPEG quality."""
    with Image.open(io.BytesIO(image_bytes)) as img:
        img = img.convert("RGB")
        w, h = img.size
        long_side = max(w, h)
        if long_side > max_long_side:
            scale = max_long_side / float(long_side)
            new_w = max(1, int(round(w * scale)))
            new_h = max(1, int(round(h * scale)))
            img = img.resize((new_w, new_h), Image.Resampling.LANCZOS)
        buf = io.BytesIO()
        img.save(buf, format="JPEG", quality=quality)
        return buf.getvalue()


def _clean_str(val: Any) -> str | None:
    if val is None:
        return None
    s = str(val).strip()
    if s.lower() in ("none", "null", ""):
        return None
    return s


async def call_inspect_screen(
    product_description: str,
    defect_types: list[str],
    candidate_bytes: bytes,
    reference_bytes_list: list[bytes],
    client: genai.Client | None = None,
) -> dict[str, Any]:
    """Runs Stage 1 'screen' with gemini-3.5-flash-lite, 3 references, and 1 candidate image."""
    t0 = time.perf_counter()
    if client is None:
        client = get_genai_client()

    prompt_text = build_inspection_prompt(product_description, defect_types, stage="screen")
    contents: list[Any] = [prompt_text]
    for ref_b in reference_bytes_list:
        contents.append(types.Part.from_bytes(data=ref_b, mime_type="image/jpeg"))
    contents.append(types.Part.from_bytes(data=candidate_bytes, mime_type="image/jpeg"))

    cfg = types.GenerateContentConfig(
        response_schema=InspectionStageResponse,
        response_mime_type="application/json",
        media_resolution=types.MediaResolution.MEDIA_RESOLUTION_MEDIUM,
    )

    def _sync():
        with trace_gemini_call("inspect.screen", MODEL_FLASH_LITE):
            return client.models.generate_content(
                model=MODEL_FLASH_LITE,
                contents=contents,
                config=cfg,
            )

    resp = await asyncio.wait_for(asyncio.to_thread(_sync), timeout=TIMEOUT_INSPECT_SCREEN_S)
    ms = elapsed_ms(t0)
    data = json.loads(resp.text)
    return {
        "model": MODEL_FLASH_LITE,
        "defective": bool(data.get("defective", False)),
        "confidence": float(data.get("confidence", 0.0)),
        "defect": _clean_str(data.get("defect")),
        "where": _clean_str(data.get("where")),
        "ms": ms,
    }


async def call_inspect_confirm(
    product_description: str,
    defect_types: list[str],
    candidate_bytes: bytes,
    client: genai.Client | None = None,
) -> dict[str, Any]:
    """Runs Stage 2 'confirm' with gemini-3.8-flash on candidate image alone."""
    t0 = time.perf_counter()
    if client is None:
        client = get_genai_client()

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

    def _sync():
        with trace_gemini_call("inspect.confirm", MODEL_FLASH):
            return client.models.generate_content(
                model=MODEL_FLASH,
                contents=contents,
                config=cfg,
            )

    resp = await asyncio.wait_for(asyncio.to_thread(_sync), timeout=TIMEOUT_INSPECT_CONFIRM_S)
    ms = elapsed_ms(t0)
    data = json.loads(resp.text)
    return {
        "model": MODEL_FLASH,
        "defective": bool(data.get("defective", False)),
        "confidence": float(data.get("confidence", 0.0)),
        "defect": _clean_str(data.get("defect")),
        "where": _clean_str(data.get("where")),
        "ms": ms,
    }


async def run_inspection_pipeline(
    product_description: str,
    defect_types: list[str],
    candidate_bytes: bytes,
    reference_bytes_list: list[bytes],
    mode: str = "few_false_alarms",
    client: genai.Client | None = None,
) -> dict[str, Any]:
    """Executes the dual-stage factory inspection pipeline with mode logic and timeout fallback."""
    t_start = time.perf_counter()

    # Preprocess / resize images to at most 1024 px at JPEG quality 90
    cand_processed = resize_inspection_image(candidate_bytes)
    refs_processed = [resize_inspection_image(r) for r in reference_bytes_list]

    screen_res: dict[str, Any] | None = None
    confirm_res: dict[str, Any] | None = None
    ai_verdict = "ok"

    if mode == "catch_everything":
        # Run screen AND confirm on EVERY image in parallel
        results = await asyncio.gather(
            call_inspect_screen(product_description, defect_types, cand_processed, refs_processed, client=client),
            call_inspect_confirm(product_description, defect_types, cand_processed, client=client),
            return_exceptions=True,
        )
        res_screen, res_confirm = results[0], results[1]

        if isinstance(res_screen, Exception) or isinstance(res_confirm, Exception):
            logger.warning("catch_everything stage exception: screen=%s, confirm=%s", res_screen, res_confirm)
            ai_verdict = "needs_review"
            screen_res = res_screen if not isinstance(res_screen, Exception) else {
                "model": MODEL_FLASH_LITE,
                "defective": False,
                "confidence": 0.0,
                "defect": None,
                "where": None,
                "ms": elapsed_ms(t_start),
            }
            confirm_res = res_confirm if not isinstance(res_confirm, Exception) else {
                "model": MODEL_FLASH,
                "defective": False,
                "confidence": 0.0,
                "defect": None,
                "where": None,
                "ms": elapsed_ms(t_start),
            }
        else:
            screen_res = res_screen
            confirm_res = res_confirm
            if screen_res["defective"] or confirm_res["defective"]:
                ai_verdict = "defective"
            else:
                ai_verdict = "ok"

    else:
        # few_false_alarms (DEFAULT)
        # 1. Run screen first
        try:
            screen_res = await call_inspect_screen(
                product_description, defect_types, cand_processed, refs_processed, client=client
            )
        except Exception as e:
            logger.warning("Screen stage failed or timed out: %s", e)
            ai_verdict = "needs_review"
            screen_res = {
                "model": MODEL_FLASH_LITE,
                "defective": False,
                "confidence": 0.0,
                "defect": None,
                "where": None,
                "ms": elapsed_ms(t_start),
            }

        if ai_verdict != "needs_review":
            if not screen_res["defective"]:
                # Screen says clean -> verdict ok, confirm is skipped
                ai_verdict = "ok"
                confirm_res = None
            else:
                # Screen flagged defect -> run confirm
                try:
                    confirm_res = await call_inspect_confirm(
                        product_description, defect_types, cand_processed, client=client
                    )
                    if confirm_res["defective"]:
                        ai_verdict = "defective"
                    else:
                        ai_verdict = "ok"
                except Exception as e:
                    logger.warning("Confirm stage failed or timed out: %s", e)
                    ai_verdict = "needs_review"
                    confirm_res = {
                        "model": MODEL_FLASH,
                        "defective": False,
                        "confidence": 0.0,
                        "defect": None,
                        "where": None,
                        "ms": elapsed_ms(t_start),
                    }

    total_ms = elapsed_ms(t_start)

    # Resolve overall defect, where, and confidence
    defect: str | None = None
    where: str | None = None
    confidence = 0.0

    if ai_verdict == "defective":
        if confirm_res and confirm_res.get("defective"):
            defect = confirm_res.get("defect") or (screen_res.get("defect") if screen_res else None) or "defect"
            where = confirm_res.get("where") or (screen_res.get("where") if screen_res else None)
            confidence = confirm_res.get("confidence", 0.8)
        elif screen_res and screen_res.get("defective"):
            defect = screen_res.get("defect") or "defect"
            where = screen_res.get("where")
            confidence = screen_res.get("confidence", 0.8)
    elif ai_verdict == "ok":
        defect = None
        where = None
        confidence = confirm_res.get("confidence", 0.9) if confirm_res else (screen_res.get("confidence", 0.9) if screen_res else 0.9)
    else:  # needs_review
        defect = None
        where = None
        confidence = 0.0

    return {
        "ai_verdict": ai_verdict,
        "screen": screen_res,
        "confirm": confirm_res,
        "defect": defect,
        "where": where,
        "confidence": round(confidence, 2),
        "mode": mode,
        "total_ms": total_ms,
    }
