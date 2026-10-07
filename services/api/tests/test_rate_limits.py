"""Unit tests for Firestore daily rate limiting."""

from unittest.mock import MagicMock, patch
import pytest
from fastapi import HTTPException
from services.api.auth import check_rate_limit


def test_rate_limit_within_bounds():
    mock_db = MagicMock()
    mock_doc = MagicMock()
    mock_snap = MagicMock()
    mock_snap.exists = True
    mock_snap.to_dict.return_value = {"live_tokens": 10, "checks": 50}
    mock_doc.get.return_value = mock_snap

    mock_db.collection.return_value.document.return_value = mock_doc
    mock_txn = MagicMock()
    mock_db.transaction.return_value = mock_txn

    with patch("services.api.auth.get_firestore_client", return_value=mock_db):
        with patch("google.cloud.firestore.transactional", lambda f: lambda txn: f(txn)):
            # Should not raise
            check_rate_limit("test_user", "live_tokens")
            check_rate_limit("test_user", "checks")


def test_rate_limit_exceeded_raises_429_with_retry_after():
    mock_db = MagicMock()
    mock_doc = MagicMock()
    mock_snap = MagicMock()
    mock_snap.exists = True
    mock_snap.to_dict.return_value = {"live_tokens": 60, "checks": 3000}
    mock_doc.get.return_value = mock_snap

    mock_db.collection.return_value.document.return_value = mock_doc
    mock_txn = MagicMock()
    mock_db.transaction.return_value = mock_txn

    with patch("services.api.auth.get_firestore_client", return_value=mock_db):
        with patch("google.cloud.firestore.transactional", lambda f: lambda txn: f(txn)):
            with pytest.raises(HTTPException) as exc_info:
                check_rate_limit("test_user", "live_tokens")

            assert exc_info.value.status_code == 429
            assert "Daily rate limit" in exc_info.value.detail
            assert "Retry-After" in exc_info.value.headers
            retry_after = int(exc_info.value.headers["Retry-After"])
            assert retry_after > 0
