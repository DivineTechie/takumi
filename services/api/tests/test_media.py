"""Unit tests for GET /api/skills/{skill_id}/media (master & mistake clips)."""

from unittest.mock import MagicMock, patch
import pytest
from fastapi.testclient import TestClient

from services.api.main import app

client = TestClient(app)


@pytest.fixture
def mock_published_skill():
    return {
        "id": "skill_terminal_wiring_v1",
        "title": "Wire a DIN rail terminal block",
        "status": "published",
        "source_language": "en",
        "video_uri": "gs://takumi-cup-2026.firebasestorage.app/skills/skill_terminal_wiring_v1/video.mp4",
        "steps": [
            {
                "n": 1,
                "instruction": "Insert ferrule into terminal 1",
                "why": "A bootlace ferrule prevents stray strands from spreading.",
                "clip": {
                    "start_s": 14.2,
                    "end_s": 22.8,
                },
                "mistake_clip_uri": "gs://takumi-cup-2026.firebasestorage.app/skills/skill_terminal_wiring_v1/mistakes/step1.mp4",
                "translations": {
                    "hi": {
                        "instruction": "टर्मिनल 1 में फेरूल डालें",
                        "why": "फेरूल तारों को बिखरने से रोकता है।",
                    }
                },
            },
            {
                "n": 2,
                "instruction": "Tighten terminal screw",
                "why": "Prevents loose contact.",
                # No clip, no mistake_clip_uri
            },
        ],
    }


def test_get_media_unauthenticated():
    res = client.get("/api/skills/skill_wiring/media?step=1&kind=master_clip")
    assert res.status_code == 401


def test_get_media_skill_not_found():
    mock_db = MagicMock()
    skill_doc = MagicMock()
    skill_doc.exists = False
    mock_db.collection.return_value.document.return_value.get.return_value = skill_doc

    with patch("services.api.auth.auth.verify_id_token", return_value={"uid": "trainee_1", "role": "trainee"}), \
         patch("services.api.main.get_firestore_client", return_value=mock_db):
        res = client.get(
            "/api/skills/nonexistent/media?step=1&kind=master_clip",
            headers={"Authorization": "Bearer token"},
        )
        assert res.status_code == 404
        assert res.json()["detail"] == "Skill not found"


def test_get_media_skill_not_published(mock_published_skill):
    mock_skill_draft = dict(mock_published_skill)
    mock_skill_draft["status"] = "draft"

    mock_db = MagicMock()
    skill_doc = MagicMock()
    skill_doc.exists = True
    skill_doc.to_dict.return_value = mock_skill_draft
    mock_db.collection.return_value.document.return_value.get.return_value = skill_doc

    with patch("services.api.auth.auth.verify_id_token", return_value={"uid": "trainee_1", "role": "trainee"}), \
         patch("services.api.main.get_firestore_client", return_value=mock_db):
        res = client.get(
            "/api/skills/skill_terminal_wiring_v1/media?step=1&kind=master_clip",
            headers={"Authorization": "Bearer token"},
        )
        assert res.status_code == 404
        assert res.json()["detail"] == "Skill is not published"


def test_get_media_step_not_found(mock_published_skill):
    mock_db = MagicMock()
    skill_doc = MagicMock()
    skill_doc.exists = True
    skill_doc.to_dict.return_value = mock_published_skill
    mock_db.collection.return_value.document.return_value.get.return_value = skill_doc

    with patch("services.api.auth.auth.verify_id_token", return_value={"uid": "trainee_1", "role": "trainee"}), \
         patch("services.api.main.get_firestore_client", return_value=mock_db):
        res = client.get(
            "/api/skills/skill_terminal_wiring_v1/media?step=99&kind=master_clip",
            headers={"Authorization": "Bearer token"},
        )
        assert res.status_code == 404
        assert res.json()["detail"] == "not available"


def test_get_master_clip_success_with_translation(mock_published_skill):
    mock_db = MagicMock()
    skill_doc = MagicMock()
    skill_doc.exists = True
    skill_doc.to_dict.return_value = mock_published_skill
    mock_db.collection.return_value.document.return_value.get.return_value = skill_doc

    fake_signed_url = "https://storage.googleapis.com/test-bucket/video.mp4?signature=xyz"

    with patch("services.api.auth.auth.verify_id_token", return_value={"uid": "trainee_1", "role": "trainee"}), \
         patch("services.api.main.get_firestore_client", return_value=mock_db), \
         patch("services.api.main.get_signed_url_for_gs_uri", return_value=fake_signed_url) as mock_sign:
        res = client.get(
            "/api/skills/skill_terminal_wiring_v1/media?step=1&kind=master_clip&lang=hi",
            headers={"Authorization": "Bearer token"},
        )
        assert res.status_code == 200
        data = res.json()
        assert data["url"] == fake_signed_url
        assert data["start_s"] == 14.2
        assert data["end_s"] == 22.8
        assert data["why"] == "फेरूल तारों को बिखरने से रोकता है।"
        assert data["why_lang"] == "hi"
        assert data["translated"] is True
        mock_sign.assert_called_once_with(mock_published_skill["video_uri"], expires_minutes=15)


def test_get_master_clip_fallback_when_translation_missing(mock_published_skill):
    mock_db = MagicMock()
    skill_doc = MagicMock()
    skill_doc.exists = True
    skill_doc.to_dict.return_value = mock_published_skill
    mock_db.collection.return_value.document.return_value.get.return_value = skill_doc

    fake_signed_url = "https://storage.googleapis.com/test-bucket/video.mp4?signature=xyz"

    with patch("services.api.auth.auth.verify_id_token", return_value={"uid": "trainee_1", "role": "trainee"}), \
         patch("services.api.main.get_firestore_client", return_value=mock_db), \
         patch("services.api.main.get_signed_url_for_gs_uri", return_value=fake_signed_url):
        # Request Japanese ("ja"), which is not in translations
        res = client.get(
            "/api/skills/skill_terminal_wiring_v1/media?step=1&kind=master_clip&lang=ja",
            headers={"Authorization": "Bearer token"},
        )
        assert res.status_code == 200
        data = res.json()
        assert data["url"] == fake_signed_url
        assert data["why"] == "A bootlace ferrule prevents stray strands from spreading."
        assert data["why_lang"] == "en"
        assert data["translated"] is False


def test_get_master_clip_not_available_on_step_without_clip(mock_published_skill):
    mock_db = MagicMock()
    skill_doc = MagicMock()
    skill_doc.exists = True
    skill_doc.to_dict.return_value = mock_published_skill
    mock_db.collection.return_value.document.return_value.get.return_value = skill_doc

    with patch("services.api.auth.auth.verify_id_token", return_value={"uid": "trainee_1", "role": "trainee"}), \
         patch("services.api.main.get_firestore_client", return_value=mock_db):
        res = client.get(
            "/api/skills/skill_terminal_wiring_v1/media?step=2&kind=master_clip",
            headers={"Authorization": "Bearer token"},
        )
        assert res.status_code == 404
        assert res.json()["detail"] == "not available"


def test_get_mistake_clip_success(mock_published_skill):
    mock_db = MagicMock()
    skill_doc = MagicMock()
    skill_doc.exists = True
    skill_doc.to_dict.return_value = mock_published_skill
    mock_db.collection.return_value.document.return_value.get.return_value = skill_doc

    fake_signed_url = "https://storage.googleapis.com/test-bucket/mistakes/step1.mp4?signature=xyz"

    with patch("services.api.auth.auth.verify_id_token", return_value={"uid": "trainee_1", "role": "trainee"}), \
         patch("services.api.main.get_firestore_client", return_value=mock_db), \
         patch("services.api.main.get_signed_url_for_gs_uri", return_value=fake_signed_url) as mock_sign:
        res = client.get(
            "/api/skills/skill_terminal_wiring_v1/media?step=1&kind=mistake_clip",
            headers={"Authorization": "Bearer token"},
        )
        assert res.status_code == 200
        data = res.json()
        assert data["url"] == fake_signed_url
        assert data["label"] == "AI-generated example of the wrong way"
        mock_sign.assert_called_once_with(
            mock_published_skill["steps"][0]["mistake_clip_uri"],
            expires_minutes=15,
        )


def test_get_mistake_clip_not_available(mock_published_skill):
    mock_db = MagicMock()
    skill_doc = MagicMock()
    skill_doc.exists = True
    skill_doc.to_dict.return_value = mock_published_skill
    mock_db.collection.return_value.document.return_value.get.return_value = skill_doc

    with patch("services.api.auth.auth.verify_id_token", return_value={"uid": "trainee_1", "role": "trainee"}), \
         patch("services.api.main.get_firestore_client", return_value=mock_db):
        res = client.get(
            "/api/skills/skill_terminal_wiring_v1/media?step=2&kind=mistake_clip",
            headers={"Authorization": "Bearer token"},
        )
        assert res.status_code == 404
        assert res.json()["detail"] == "not available"
