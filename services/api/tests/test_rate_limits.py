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


def test_guest_limits_are_smaller_and_share_a_pool():
    """A guest is capped by its own smaller allowance and by the pool all guests share."""
    def run(user_used, pool_used):
        mock_db = MagicMock()
        docs = {}
        def document(doc_id):
            d = MagicMock()
            snap = MagicMock(exists=True)
            snap.to_dict.return_value = {"checks": pool_used if doc_id.startswith("guests_") else user_used}
            d.get.return_value = snap
            docs[doc_id] = d
            return d
        mock_db.collection.return_value.document.side_effect = document
        with patch("services.api.auth.get_firestore_client", return_value=mock_db):
            with patch("google.cloud.firestore.transactional", lambda f: lambda txn: f(txn)):
                check_rate_limit("guest_1", "checks", guest=True)
        return docs

    docs = run(user_used=10, pool_used=100)
    assert any(k.startswith("guests_") for k in docs)
    with pytest.raises(HTTPException) as e:
        run(user_used=300, pool_used=100)  # guest allowance is 300, not 3,000
    assert e.value.status_code == 429
    with pytest.raises(HTTPException) as e:
        run(user_used=10, pool_used=4000)  # the shared guest pool is full
    assert "shared limit" in e.value.detail
