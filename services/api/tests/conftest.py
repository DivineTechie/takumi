"""Pytest fixtures for TAKUMI API unit tests."""

import pytest


@pytest.fixture(autouse=True)
def prevent_telemetry_streaming_to_bigquery(monkeypatch):
    """Safety guard: prevents any test from streaming test metrics or session events to BigQuery."""
    monkeypatch.setattr("services.api.main.stream_api_call", lambda row: None)
    monkeypatch.setattr("services.api.bigquery_client.stream_api_call", lambda row: None)
