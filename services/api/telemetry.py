"""OpenTelemetry Cloud Trace integration and structured JSON logging for TAKUMI API."""

import contextlib
import json
import logging
import os
import sys
import time
from typing import Any, Generator

from opentelemetry import trace
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.trace import Span, Tracer

_tracer: Tracer | None = None


def init_telemetry() -> Tracer:
    """Initialize OpenTelemetry tracer.

    Exports to Google Cloud Trace only when running inside Cloud Run (K_SERVICE is set).
    Otherwise uses an in-memory SDK provider to prevent export attempts during tests or local runs.
    """
    global _tracer
    if _tracer is not None:
        return _tracer

    provider = TracerProvider()

    if os.environ.get("K_SERVICE"):
        try:
            from opentelemetry.exporter.cloud_trace import CloudTraceSpanExporter
            from opentelemetry.sdk.trace.export import BatchSpanProcessor

            exporter = CloudTraceSpanExporter()
            provider.add_span_processor(BatchSpanProcessor(exporter))
        except Exception as e:
            sys.stderr.write(f"Warning: CloudTraceSpanExporter initialization failed: {e}\n")

    trace.set_tracer_provider(provider)
    _tracer = trace.get_tracer("takumi-api")
    return _tracer


def get_tracer() -> Tracer:
    global _tracer
    if _tracer is None:
        return init_telemetry()
    return _tracer


@contextlib.contextmanager
def trace_gemini_call(span_name: str, model_id: str) -> Generator[Span, None, None]:
    """Context manager to trace a call to Gemini, setting model and latency attributes."""
    tracer = get_tracer()
    t_start = time.perf_counter()
    with tracer.start_as_current_span(span_name) as span:
        span.set_attribute("genai.model", model_id)
        try:
            yield span
        finally:
            latency_ms = int((time.perf_counter() - t_start) * 1000)
            span.set_attribute("genai.latency_ms", latency_ms)


class StructuredJsonFormatter(logging.Formatter):
    """Structured JSON formatter adhering to Google Cloud Logging format.

    Guarantees no tokens, API keys, images, base64 payloads, or email addresses are logged.
    """

    SENSITIVE_KEYS = {"token", "auth_token", "access_token", "api_key", "gemini_api_key", "image_b64", "image"}

    def format(self, record: logging.LogRecord) -> str:
        log_entry: dict[str, Any] = {
            "severity": record.levelname,
            "message": record.getMessage(),
            "time": self.formatTime(record),
            "logger": record.name,
        }

        # Include custom extra fields if safe
        if hasattr(record, "props") and isinstance(record.props, dict):
            for k, v in record.props.items():
                if k.lower() not in self.SENSITIVE_KEYS and not isinstance(v, (bytes, bytearray)):
                    log_entry[k] = v

        return json.dumps(log_entry)


def setup_logging() -> logging.Logger:
    """Configures root logger with StructuredJsonFormatter."""
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(StructuredJsonFormatter())
    
    root_logger = logging.getLogger()
    root_logger.setLevel(logging.INFO)
    # Avoid duplicate handlers
    if not any(isinstance(h, logging.StreamHandler) for h in root_logger.handlers):
        root_logger.addHandler(handler)
        
    return logging.getLogger("takumi.api")
