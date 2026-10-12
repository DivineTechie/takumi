"""google-genai client and bounded model calls for the Standard Work Studio.

The key comes from GEMINI_API_KEY, which Cloud Run mounts from Secret Manager; it is never logged.
Every call has a timeout, so a Studio run cannot hang on a model.
"""

import asyncio
import logging
import random
from collections.abc import Awaitable, Callable
from typing import Any, TypeVar

from google import genai
from google.genai import types
from pydantic import BaseModel, ValidationError

from services.forge.config import GEMINI_API_KEY

logger = logging.getLogger("forge.gemini")

T = TypeVar("T")
M = TypeVar("M", bound=BaseModel)

_client: genai.Client | None = None
RETRY_DELAY_S = 1.0


class StudioModelError(RuntimeError):
    """A model call failed or returned something unusable. The message is safe to show to the master."""


class StudioTimeout(StudioModelError):
    """A model call did not answer in time (not retried: it would only double the wait)."""


def get_client() -> genai.Client:
    global _client
    if _client is None:
        if not GEMINI_API_KEY:
            raise StudioModelError("Gemini is not configured on the Studio service")
        _client = genai.Client(api_key=GEMINI_API_KEY, http_options={"api_version": "v1beta"})
    return _client


def json_config(schema: Any, thinking_level: str | None = None) -> types.GenerateContentConfig:
    return types.GenerateContentConfig(
        response_mime_type="application/json",
        response_schema=schema,
        thinking_config=types.ThinkingConfig(thinking_level=thinking_level) if thinking_level else None,
    )


def strip_fence(text: str | None) -> str:
    """Removes a ```json fence if the model added one."""
    raw = (text or "").strip()
    if raw.startswith("```"):
        raw = raw[3:]
        raw = raw[raw.find("\n") + 1:] if "\n" in raw else ""
        raw = raw.rstrip().removesuffix("```")
    return raw.strip()


def parse_json(text: str | None, schema: type[M]) -> M:
    raw = strip_fence(text)
    if not raw:
        raise StudioModelError("the model returned an empty answer")
    try:
        return schema.model_validate_json(raw)
    except ValidationError as e:
        raise StudioModelError(f"the model's answer did not match the expected structure ({e.error_count()} problems)") from e


async def _call_once(model: str, contents: list[Any], config: types.GenerateContentConfig, timeout_s: float) -> str:
    client = get_client()
    try:
        response = await asyncio.wait_for(
            client.aio.models.generate_content(model=model, contents=contents, config=config),
            timeout=timeout_s,
        )
    except asyncio.TimeoutError:
        raise StudioTimeout(f"{model} did not answer within {int(timeout_s)} s") from None
    except Exception as e:
        raise StudioModelError(f"{model} call failed ({type(e).__name__}: {str(e)[:200]})") from e
    text = response.text or ""
    if not text.strip():
        raise StudioModelError(f"{model} returned an empty answer")
    return text


async def _with_retry(call: Callable[[], Awaitable[T]], model: str, attempts: int) -> T:
    last: StudioModelError | None = None
    for attempt in range(1, attempts + 1):
        try:
            return await call()
        except StudioTimeout:
            raise
        except StudioModelError as e:
            last = e
            if attempt < attempts:
                logger.warning("Retrying %s after: %s", model, e)
                await asyncio.sleep(RETRY_DELAY_S * (1.0 + random.random()))
    assert last is not None
    raise last


async def generate_text(
    model: str,
    contents: list[Any],
    config: types.GenerateContentConfig,
    *,
    timeout_s: float,
    attempts: int = 2,
) -> str:
    """One model call with a timeout; a failed call is retried once."""
    return await _with_retry(lambda: _call_once(model, contents, config, timeout_s), model, attempts)


async def generate_json(
    model: str,
    contents: list[Any],
    schema: type[M],
    *,
    timeout_s: float,
    thinking_level: str | None = None,
    attempts: int = 2,
) -> M:
    """Structured call: the answer must parse into `schema`; a malformed answer counts as a failed attempt."""
    config = json_config(schema, thinking_level)

    async def once() -> M:
        return parse_json(await _call_once(model, contents, config, timeout_s), schema)

    return await _with_retry(once, model, attempts)
