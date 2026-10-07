"""Skill Passport issuance rule, name validation, and IP rate limiting."""

from datetime import datetime, timezone
import logging
import secrets
import time
from typing import Any
import unicodedata

from fastapi import HTTPException, Request, status
from google.cloud import firestore

from services.api.badges import generate_and_store_badge_if_needed

logger = logging.getLogger("takumi.passports")


def validate_trainee_name(name: str) -> bool:
    r"""Validates certificate first name according to Unicode requirements:
    ^[\p{L}\p{M}' \-]{1,30}$ with unicode flag.
    \p{M} is required for Devanagari vowel signs and Vietnamese combining accents.
    Rejects strings with '@', digits, or length > 30.
    """
    if not name or not (1 <= len(name) <= 30):
        return False
    if "@" in name or any(c.isdigit() for c in name):
        return False
    return all(
        unicodedata.category(c).startswith(("L", "M")) or c in ("'", " ", "-")
        for c in name
    )


def evaluate_passport_eligibility(
    completed_sessions: list[dict[str, Any]], total_steps: int
) -> tuple[bool, list[str]]:
    """Pure issuance rule for Skill Passport:
    - Count sessions with status 'completed' where recomputed result has
      steps_done == total_steps and safety_stops == 0.
    - Issue when at least 3 such clean sessions exist AND the most recent of them
      has result.mistakes <= 1.
    - Returns (is_eligible, clean_session_ids).
    """
    clean_sessions = []
    for s in completed_sessions:
        if s.get("preview") is True:
            continue
        if s.get("status") != "completed":
            continue
        res = s.get("result") or {}
        steps_done = res.get("steps_done", 0)
        safety_stops = res.get("safety_stops", 0)

        if steps_done == total_steps and safety_stops == 0:
            clean_sessions.append(s)

    # Sort qualifying sessions by completed timestamp (ended_at, falling back to started_at)
    def _sort_key(s: dict[str, Any]) -> str:
        return str(s.get("ended_at") or s.get("started_at") or "")

    clean_sessions.sort(key=_sort_key)
    clean_session_ids = [s.get("id") for s in clean_sessions if s.get("id")]

    if len(clean_sessions) < 3:
        return False, clean_session_ids

    most_recent = clean_sessions[-1]
    most_recent_mistakes = (most_recent.get("result") or {}).get("mistakes", 0)

    if most_recent_mistakes <= 1:
        return True, clean_session_ids

    return False, clean_session_ids


def issue_passport_if_eligible(
    db: firestore.Client,
    trainee_uid: str,
    skill_id: str,
    current_session: dict[str, Any],
    user_display_name: str | None = None,
    background_tasks: Any = None,
) -> tuple[str | None, int]:
    """Evaluates passport issuance rule and idempotently issues a passport under concurrency lock.

    Returns (passport_id, clean_runs_count).
    """
    if current_session.get("preview") is True:
        return None, 0
    lock_id = f"{trainee_uid}_{skill_id}"
    lock_ref = db.collection("passport_locks").document(lock_id)

    # Fetch all trainee's sessions for this skill
    sessions_stream = (
        db.collection("sessions")
        .where("trainee_uid", "==", trainee_uid)
        .where("skill_id", "==", skill_id)
        .stream()
    )
    all_sessions = [doc.to_dict() or {} for doc in sessions_stream]

    # Ensure current completed session is present in all_sessions
    curr_id = current_session.get("id")
    found = False
    for idx, s in enumerate(all_sessions):
        if s.get("id") == curr_id:
            all_sessions[idx] = current_session
            found = True
            break
    if not found:
        all_sessions.append(current_session)

    # Fetch skill details for total steps and title
    skill_doc = db.collection("skills").document(skill_id).get()
    skill_data = skill_doc.to_dict() or {} if skill_doc.exists else {}
    skill_steps = skill_data.get("steps", [])
    total_steps = len(skill_steps) if skill_steps else len(current_session.get("steps", []))
    if total_steps == 0:
        total_steps = 4  # Default fallback

    is_eligible, clean_session_ids = evaluate_passport_eligibility(all_sessions, total_steps)
    clean_runs_count = len(clean_session_ids)

    if not is_eligible:
        return None, clean_runs_count

    # Check existing lock document before starting transaction (idempotency fast-path)
    if lock_ref.get().exists:
        return None, clean_runs_count

    # Resolve trainee first name
    display_first_name = "Trainee"
    if user_display_name and user_display_name.strip():
        first_word = user_display_name.strip().split()[0]
        if validate_trainee_name(first_word):
            display_first_name = first_word

    # Resolve master display name
    master_name = skill_data.get("author_name") or skill_data.get("master_name")
    if not master_name:
        master_uid = skill_data.get("master_uid")
        if master_uid:
            try:
                import firebase_admin.auth as fb_auth
                rec = fb_auth.get_user(master_uid)
                master_name = rec.display_name
            except Exception:
                pass
    if not master_name:
        master_name = "Master Craftsperson"

    last_mistakes = (current_session.get("result") or {}).get("mistakes", 0)
    now = datetime.now(timezone.utc)
    passport_id = f"pp_{secrets.token_urlsafe(12)}"
    passport_ref = db.collection("passports").document(passport_id)

    passport_doc_dict = {
        "id": passport_id,
        "trainee_uid": trainee_uid,
        "skill_id": skill_id,
        "issued_at": now.isoformat(),
        "session_ids": clean_session_ids,
        "verify_url": f"https://takumi-cup-2026.web.app/passport/{passport_id}",
        "display_first_name": display_first_name,
        "skill_title": skill_data.get("title", skill_id),
        "master_display_name": master_name,
        "language": current_session.get("language", "en"),
        "mistakes_last_run": last_mistakes,
        "badge_path": f"passports/badges/{skill_id}.png",
    }

    # Atomic transaction creating lock and passport
    @firestore.transactional
    def txn_issue(txn: firestore.Transaction) -> str | None:
        lock_snap = lock_ref.get(transaction=txn)
        if lock_snap.exists:
            return None
        txn.create(
            lock_ref,
            {
                "created_at": now.isoformat(),
                "trainee_uid": trainee_uid,
                "skill_id": skill_id,
                "passport_id": passport_id,
            },
        )
        txn.set(passport_ref, passport_doc_dict)
        return passport_id

    try:
        issued_id = txn_issue(db.transaction())
    except Exception as e:
        logger.warning("Conflict/error issuing passport under lock %s: %s", lock_id, e)
        return None, clean_runs_count

    if issued_id and background_tasks is not None:
        skill_title = skill_data.get("title", skill_id)
        background_tasks.add_task(generate_and_store_badge_if_needed, skill_id, skill_title)

    return issued_id, clean_runs_count


# In-memory sliding window rate limiter per IP for public endpoints
_public_rate_limits: dict[str, list[float]] = {}


def check_public_rate_limit(
    request: Request, limit: int = 60, window_s: int = 60
) -> None:
    """Enforces rate limiting on public endpoints keyed on the FIRST address in
    X-Forwarded-For (falling back to client host).
    """
    xff = request.headers.get("x-forwarded-for")
    if xff:
        client_ip = xff.split(",")[0].strip()
    elif request.client and request.client.host:
        client_ip = request.client.host
    else:
        client_ip = "127.0.0.1"

    now = time.time()
    history = _public_rate_limits.setdefault(client_ip, [])
    cutoff = now - window_s
    # Prune timestamps older than window_s
    active_timestamps = [t for t in history if t > cutoff]
    _public_rate_limits[client_ip] = active_timestamps

    if len(active_timestamps) >= limit:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail="Rate limit exceeded. Maximum 60 requests per minute.",
            headers={"Retry-After": str(window_s)},
        )

    _public_rate_limits[client_ip].append(now)
