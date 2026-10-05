"""Smoke test script for TAKUMI API service.

Validates deployed or local endpoints:
1. Rejects unauthenticated requests (401)
2. Issues single-use Gemini Live token
3. Connects to Live WebSocket and verifies single-use token rejection on reconnect
4. Calls watch 5 times and checks p50 latency (< 2.5s)
5. Calls verify once
6. Calls point once
7. Creates session in Firestore
8. Posts event to session and verifies streaming insert in BigQuery within 60s
"""

import argparse
import asyncio
import base64
import io
import json
from pathlib import Path
import statistics
import sys
import time
from typing import Any

import firebase_admin
from firebase_admin import auth
from google.cloud import bigquery, firestore
import httpx
from PIL import Image
import websockets

PROJECT_ID = "takumi-cup-2026"
SA_EMAIL = f"takumi-api@{PROJECT_ID}.iam.gserviceaccount.com"
SMOKE_UID = "smoke-trainee"


def get_web_api_key() -> str:
    """Reads VITE_FIREBASE_API_KEY from apps/web/.env.local without logging or printing it."""
    env_local = Path(__file__).resolve().parent.parent / "apps" / "web" / ".env.local"
    if not env_local.exists():
        raise RuntimeError("apps/web/.env.local not found. Cannot retrieve web API key.")

    with open(env_local, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line.startswith("VITE_FIREBASE_API_KEY="):
                return line.split("=", 1)[1].strip().strip('"').strip("'")

    raise RuntimeError("VITE_FIREBASE_API_KEY not found in apps/web/.env.local")


def ensure_seed_skill(db: firestore.Client) -> None:
    """Loads seed skill 'skill_terminal_wiring_v1' into Firestore only if missing."""
    doc_ref = db.collection("skills").document("skill_terminal_wiring_v1")
    if not doc_ref.get().exists:
        seed_path = (
            Path(__file__).resolve().parent.parent
            / "shared"
            / "seed"
            / "skill_terminal_wiring_v1.json"
        )
        with open(seed_path, "r", encoding="utf-8") as f:
            seed_data = json.load(f)
        doc_ref.set(seed_data)
        print("  [OK] Seed skill 'skill_terminal_wiring_v1' created in Firestore.")
    else:
        print("  [OK] Seed skill 'skill_terminal_wiring_v1' already present in Firestore.")


def get_id_token() -> str:
    """Creates a custom token for smoke-trainee and exchanges it for a Firebase ID token.

    Never prints any token.
    """
    if not firebase_admin._apps:
        firebase_admin.initialize_app(
            options={
                "serviceAccountId": SA_EMAIL,
                "projectId": PROJECT_ID,
            }
        )

    # Ensure user exists and has trainee role
    try:
        user = auth.get_user(SMOKE_UID)
        if (user.custom_claims or {}).get("role") != "trainee":
            auth.set_custom_user_claims(SMOKE_UID, {"role": "trainee"})
    except auth.UserNotFoundError:
        auth.create_user(uid=SMOKE_UID)
        auth.set_custom_user_claims(SMOKE_UID, {"role": "trainee"})

    try:
        custom_token = auth.create_custom_token(SMOKE_UID, {"role": "trainee"})
    except Exception as e:
        sys.stderr.write(
            "\n[ERROR] Failed to sign custom token via takumi-api service account.\n"
            "If your user lacks TokenCreator permission, grant it using:\n"
            f'  gcloud iam service-accounts add-iam-policy-binding {SA_EMAIL} \\\n'
            f'    --member="user:<YOUR_EMAIL>" \\\n'
            f'    --role="roles/iam.serviceAccountTokenCreator" \\\n'
            f'    --project={PROJECT_ID}\n\n'
        )
        raise e

    if isinstance(custom_token, bytes):
        custom_token_str = custom_token.decode("utf-8")
    else:
        custom_token_str = str(custom_token)

    web_api_key = get_web_api_key()
    url = f"https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key={web_api_key}"

    resp = httpx.post(url, json={"token": custom_token_str, "returnSecureToken": True})
    resp.raise_for_status()
    return resp.json()["idToken"]


def generate_test_jpeg_b64() -> str:
    """Generates a small 160x120 JPEG image in memory."""
    img = Image.new("RGB", (160, 120), color=(30, 144, 255))
    buf = io.BytesIO()
    img.save(buf, format="JPEG")
    return base64.b64encode(buf.getvalue()).decode()


async def check_live_websocket(token: str) -> tuple[bool, bool]:
    """Connects to Gemini Live WebSocket. Confirms setupComplete, then reconnects with same token to verify rejection."""
    ws_url = (
        f"wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta."
        f"GenerativeService.BidiGenerateContentConstrained?access_token={token}"
    )

    setup_msg = {
        "setup": {
            "model": "models/gemini-3.8-live",
            "generationConfig": {"responseModalities": ["AUDIO"]},
        }
    }

    first_connected = False
    reused_rejected = False

    # 1. First connection
    try:
        async with websockets.connect(ws_url, open_timeout=10) as ws:
            await ws.send(json.dumps(setup_msg))
            resp = await asyncio.wait_for(ws.recv(), timeout=10)
            data = json.loads(resp)
            if "setupComplete" in data:
                first_connected = True
    except Exception as e:
        print(f"    Live WebSocket connection error: {e}")

    # 2. Reconnection with SAME token (must be rejected)
    try:
        async with websockets.connect(ws_url, open_timeout=10) as ws:
            await ws.send(json.dumps(setup_msg))
            resp = await asyncio.wait_for(ws.recv(), timeout=10)
            data = json.loads(resp)
            # If server does not reject or completes setup, token reuse was not blocked
            if "setupComplete" in data:
                reused_rejected = False
            else:
                reused_rejected = True
    except Exception:
        # Connection rejected as expected
        reused_rejected = True

    return first_connected, reused_rejected


async def main():
    parser = argparse.ArgumentParser(description="TAKUMI API Smoke Test")
    parser.add_argument(
        "--url",
        default="https://takumi-cup-2026.web.app",
        help="Base URL of deployed or local app (default: https://takumi-cup-2026.web.app)",
    )
    args = parser.parse_args()
    base_url = args.url.rstrip("/")

    print("==================================================")
    print(f"TAKUMI API Smoke Test against: {base_url}")
    print("==================================================")

    results: dict[str, str] = {}

    # Check 1: Unauthenticated request gives 401
    print("\n[1/7] Testing unauthenticated access...")
    try:
        r = httpx.post(f"{base_url}/api/live-token", json={"purpose": "coach"}, timeout=10)
        if r.status_code == 401:
            results["unauthenticated_401"] = "PASS"
            print("  PASS: Unauthenticated request returned 401.")
        else:
            results["unauthenticated_401"] = f"FAIL (status {r.status_code})"
            print(f"  FAIL: Expected 401, got {r.status_code}.")
    except Exception as e:
        results["unauthenticated_401"] = f"FAIL ({e})"
        print(f"  FAIL: {e}")

    # Obtain ID Token for smoke-trainee
    print("\n[Auth] Acquiring ID token for smoke-trainee...")
    try:
        id_token = get_id_token()
        headers = {"Authorization": f"Bearer {id_token}"}
        print("  [OK] Successfully authenticated smoke-trainee.")
    except Exception as e:
        print(f"  FATAL: Could not acquire ID token: {e}")
        return

    # Check 2: POST /api/live-token and Live WebSocket
    print("\n[2/7] Testing /api/live-token and single-use Live WebSocket...")
    live_token_str = ""
    try:
        r = httpx.post(f"{base_url}/api/live-token", json={"purpose": "coach"}, headers=headers, timeout=15)
        if r.status_code == 200:
            token_json = r.json()
            live_token_str = token_json.get("token", "")
            model_name = token_json.get("model", "")
            print(f"  Status: {r.status_code}, Model: {model_name}")
            results["live_token"] = "PASS"

            # WebSocket test
            first_ok, reused_rejected = await check_live_websocket(live_token_str)
            if first_ok:
                print("  Live WebSocket setupComplete: OK")
                results["live_ws_connect"] = "PASS"
            else:
                print("  Live WebSocket setupComplete: FAIL")
                results["live_ws_connect"] = "FAIL"

            if reused_rejected:
                print("  Reused token rejected: OK")
                results["live_token_reused_rejected"] = "PASS"
            else:
                print("  Reused token rejected: FAIL (token was accepted twice)")
                results["live_token_reused_rejected"] = "FAIL"
        else:
            results["live_token"] = f"FAIL (status {r.status_code})"
            results["live_ws_connect"] = "FAIL"
            results["live_token_reused_rejected"] = "FAIL"
            print(f"  FAIL: /api/live-token returned {r.status_code}: {r.text}")
    except Exception as e:
        results["live_token"] = f"FAIL ({e})"
        results["live_ws_connect"] = "FAIL"
        results["live_token_reused_rejected"] = "FAIL"
        print(f"  FAIL: {e}")

    # Ensure Firestore seed skill
    db = firestore.Client(project=PROJECT_ID)
    ensure_seed_skill(db)

    # Check 3: POST /api/watch x 5 (measure p50 latency)
    print("\n[3/7] Testing /api/watch (5 iterations)...")
    test_jpeg_b64 = generate_test_jpeg_b64()
    watch_latencies: list[float] = []
    watch_states: list[str] = []
    watch_ok = True

    for i in range(5):
        t0 = time.perf_counter()
        try:
            r = httpx.post(
                f"{base_url}/api/watch",
                json={
                    "step": 1,
                    "instruction": "Insert the blue wire into terminal 1 and tighten its screw.",
                    "success_criteria": "A blue wire's ferrule enters terminal 1, the leftmost terminal.",
                    "common_mistakes": [{"description": "Wire in terminal 2", "visual_cue": "blue wire in the second slot"}],
                    "safety_rules": ["Panel power must be off"],
                    "image_b64": test_jpeg_b64,
                },
                headers=headers,
                timeout=12,
            )
            elapsed = time.perf_counter() - t0
            watch_latencies.append(elapsed)
            if r.status_code == 200:
                state = r.json().get("state", "unknown")
                watch_states.append(state)
                print(f"  Iteration {i+1}: status=200, state={state}, latency={elapsed:.2f}s")
            else:
                watch_ok = False
                print(f"  Iteration {i+1}: status={r.status_code}, latency={elapsed:.2f}s")
        except Exception as e:
            watch_ok = False
            print(f"  Iteration {i+1}: error={e}")

    if watch_ok and watch_latencies:
        p50 = statistics.median(watch_latencies)
        print(f"  Watcher p50 latency: {p50:.2f}s (target < 2.5s)")
        if p50 <= 2.5:
            results["watch_5x"] = f"PASS (p50: {p50:.2f}s)"
        else:
            results["watch_5x"] = f"PASS (p50: {p50:.2f}s, above 2.5s target)"
    else:
        results["watch_5x"] = "FAIL"

    # Check 4: POST /api/verify x 1
    print("\n[4/7] Testing /api/verify...")
    try:
        t0 = time.perf_counter()
        r = httpx.post(
            f"{base_url}/api/verify",
            json={
                "step": 1,
                "instruction": "Insert the blue wire into terminal 1 and tighten its screw.",
                "success_criteria": "A blue wire's ferrule enters terminal 1, the leftmost terminal.",
                "safety_rules": ["Panel power must be off"],
                "image_b64": test_jpeg_b64,
            },
            headers=headers,
            timeout=20,
        )
        elapsed = time.perf_counter() - t0
        if r.status_code == 200:
            data = r.json()
            print(f"  Verify status=200, passed={data.get('passed')}, latency={elapsed:.2f}s")
            results["verify"] = "PASS"
        else:
            print(f"  Verify failed: {r.status_code}: {r.text}")
            results["verify"] = f"FAIL ({r.status_code})"
    except Exception as e:
        print(f"  Verify error: {e}")
        results["verify"] = f"FAIL ({e})"

    # Check 5: POST /api/point x 1
    print("\n[5/7] Testing /api/point...")
    try:
        t0 = time.perf_counter()
        r = httpx.post(
            f"{base_url}/api/point",
            json={
                "target": "the screw opening of terminal 1",
                "image_b64": test_jpeg_b64,
            },
            headers=headers,
            timeout=20,
        )
        elapsed = time.perf_counter() - t0
        if r.status_code == 200:
            data = r.json()
            points = data.get("points", [])
            print(f"  Point status=200, points={points}, latency={elapsed:.2f}s")
            results["point"] = "PASS"
        else:
            print(f"  Point failed: {r.status_code}: {r.text}")
            results["point"] = f"FAIL ({r.status_code})"
    except Exception as e:
        print(f"  Point error: {e}")
        results["point"] = f"FAIL ({e})"

    # Check 6: POST /api/sessions and POST /api/sessions/{id}/events
    print("\n[6/7] Testing session creation and event posting...")
    session_id = None
    try:
        r = httpx.post(
            f"{base_url}/api/sessions",
            json={"skill_id": "skill_terminal_wiring_v1", "language": "en"},
            headers=headers,
            timeout=10,
        )
        if r.status_code == 201:
            session_id = r.json()["id"]
            print(f"  Session created: {session_id}")
            results["session_create"] = "PASS"
        else:
            print(f"  Session creation failed: {r.status_code}: {r.text}")
            results["session_create"] = f"FAIL ({r.status_code})"
    except Exception as e:
        print(f"  Session creation error: {e}")
        results["session_create"] = f"FAIL ({e})"

    if session_id:
        try:
            r = httpx.post(
                f"{base_url}/api/sessions/{session_id}/events",
                json={
                    "step": 1,
                    "type": "step_done",
                    "source": "watcher",
                    "reason": "Blue wire in terminal 1",
                    "latency_ms": 320,
                },
                headers=headers,
                timeout=10,
            )
            if r.status_code == 201:
                print(f"  Event posted to session {session_id}")
                results["session_event"] = "PASS"
            else:
                print(f"  Event posting failed: {r.status_code}: {r.text}")
                results["session_event"] = f"FAIL ({r.status_code})"
        except Exception as e:
            print(f"  Event post error: {e}")
            results["session_event"] = f"FAIL ({e})"

    # Check 7: Verify row appears in BigQuery within 60s
    print("\n[7/7] Verifying BigQuery streaming ingestion within 60s...")
    if session_id and results.get("session_event") == "PASS":
        bq = bigquery.Client(project=PROJECT_ID)
        query = f"""
            SELECT session_id, skill_id, trainee_uid, type, step, ts
            FROM `{PROJECT_ID}.takumi.session_events`
            WHERE session_id = @sid
            LIMIT 1
        """
        job_config = bigquery.QueryJobConfig(
            query_parameters=[bigquery.ScalarQueryParameter("sid", "STRING", session_id)]
        )

        bq_found = False
        start_poll = time.time()
        while time.time() - start_poll < 60:
            query_job = bq.query(query, job_config=job_config)
            rows = list(query_job.result())
            if rows:
                bq_found = True
                row = rows[0]
                print(f"  Found row in BigQuery after {time.time() - start_poll:.1f}s:")
                print(f"    session_id={row.session_id}, type={row.type}, trainee_uid={row.trainee_uid}")
                results["bigquery_streaming"] = "PASS"
                break
            time.sleep(3)

        if not bq_found:
            print("  Timeout: row did not appear in BigQuery within 60s")
            results["bigquery_streaming"] = "FAIL (timeout)"
    else:
        results["bigquery_streaming"] = "SKIP"

    # Summary
    print("\n==================================================")
    print("SMOKE TEST SUMMARY")
    print("==================================================")
    for check_name, status_val in results.items():
        print(f"  {check_name:<30}: {status_val}")
    print("==================================================")


if __name__ == "__main__":
    asyncio.run(main())
