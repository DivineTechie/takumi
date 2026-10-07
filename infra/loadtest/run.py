"""Production Load Testing & Concurrency Runner for TAKUMI.

Exercises:
1. 10 Authenticated Trainee Workers for 3 minutes:
   - /api/watch every ~2.3s with a real 640px JPEG of a terminal block
   - /api/verify about once a minute per worker
   - /api/point about once a minute per worker
2. Live Concurrency Test:
   - 10 concurrent Gemini Live WebSockets
   - Setup + 1 text turn, held for 30s
   - Quota and close-code tracking
3. Firestore cleanup for loadtest-1..10 users
"""

import argparse
import asyncio
import base64
import json
import logging
import os
import random
import statistics
import sys
import time
from pathlib import Path
from typing import Any

import firebase_admin
from firebase_admin import auth, firestore
import httpx
import websockets

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from infra.smoke_api import get_web_api_key, SA_EMAIL, PROJECT_ID

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("loadtest")

WS_LIVE_URL = "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained"


def init_firebase() -> firestore.Client:
    if not firebase_admin._apps:
        firebase_admin.initialize_app(
            options={
                "serviceAccountId": SA_EMAIL,
                "projectId": PROJECT_ID,
            }
        )
    return firestore.client()


def get_token_for_user(uid: str) -> str:
    """Acquires a valid Firebase ID token for a loadtest user. Fails loudly on any error."""
    try:
        user = auth.get_user(uid)
        if (user.custom_claims or {}).get("role") != "trainee":
            auth.set_custom_user_claims(uid, {"role": "trainee"})
    except auth.UserNotFoundError:
        auth.create_user(uid=uid)
        auth.set_custom_user_claims(uid, {"role": "trainee"})

    custom_token = auth.create_custom_token(uid, {"role": "trainee"})
    custom_token_str = custom_token.decode("utf-8") if isinstance(custom_token, bytes) else str(custom_token)
    web_api_key = get_web_api_key()
    url = f"https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key={web_api_key}"
    resp = httpx.post(url, json={"token": custom_token_str, "returnSecureToken": True}, timeout=15.0)
    if resp.status_code != 200:
        raise RuntimeError(f"IdentityToolkit error for {uid} ({resp.status_code}): {resp.text}")
    return resp.json()["idToken"]


def acquire_worker_tokens(num_workers: int = 10) -> dict[str, str]:
    """Generates tokens for loadtest-1..10. Fails loudly if any worker token fails."""
    init_firebase()
    logger.info("Acquiring Firebase ID tokens for loadtest-1..%d...", num_workers)
    tokens: dict[str, str] = {}
    for i in range(1, num_workers + 1):
        uid = f"loadtest-{i}"
        token = get_token_for_user(uid)
        if not token:
            raise RuntimeError(f"CRITICAL: Failed to acquire ID token for worker {uid}")
        tokens[uid] = token
    logger.info("Successfully acquired %d worker tokens.", len(tokens))
    return tokens


def get_terminal_block_image_b64() -> str:
    """Reads the real 640px terminal block image from %TEMP%\\terminal_block_640.jpg."""
    temp_dir = os.environ.get("TEMP", os.environ.get("TMP", "/tmp"))
    img_path = Path(temp_dir) / "terminal_block_640.jpg"
    if not img_path.exists():
        raise FileNotFoundError(f"Real terminal block image not found at {img_path}")
    with open(img_path, "rb") as f:
        data = f.read()
    return base64.b64encode(data).decode("utf-8")


class EndpointStats:
    def __init__(self, name: str):
        self.name = name
        self.latencies: list[float] = []
        self.model_latencies: list[float] = []
        self.status_codes: dict[int, int] = {}
        self.errors: list[str] = []

    def record(self, latency_s: float, status: int, model_s: float | None = None, err: str | None = None):
        self.latencies.append(latency_s)
        if model_s is not None:
            self.model_latencies.append(model_s)
        self.status_codes[status] = self.status_codes.get(status, 0) + 1
        if err or status >= 400:
            self.errors.append(err or f"HTTP {status}")

    def summary(self) -> dict[str, Any]:
        n = len(self.latencies)
        if n == 0:
            return {"requests": 0, "status_codes": {}, "error_rate_pct": 0.0}

        sorted_lats = sorted(self.latencies)
        p50 = sorted_lats[int(n * 0.50)]
        p90 = sorted_lats[min(n - 1, int(n * 0.90))]
        p99 = sorted_lats[min(n - 1, int(n * 0.99))]
        mean = statistics.mean(self.latencies)

        err_count = sum(c for code, c in self.status_codes.items() if code >= 400) + len(
            [e for e in self.errors if not e.startswith("HTTP")]
        )
        err_rate = round((err_count / n) * 100.0, 2)

        res: dict[str, Any] = {
            "requests": n,
            "status_codes": self.status_codes,
            "p50_ms": round(p50 * 1000, 1),
            "p90_ms": round(p90 * 1000, 1),
            "p99_ms": round(p99 * 1000, 1),
            "mean_ms": round(mean * 1000, 1),
            "error_rate_pct": err_rate,
            "error_samples": self.errors[:5],
        }

        if self.model_latencies:
            sorted_model = sorted(self.model_latencies)
            nm = len(sorted_model)
            res["model_p50_ms"] = round(sorted_model[int(nm * 0.50)] * 1000, 1)
            res["model_p90_ms"] = round(sorted_model[min(nm - 1, int(nm * 0.90))] * 1000, 1)

        return res


async def worker_loop(
    worker_id: int,
    uid: str,
    id_token: str,
    base_url: str,
    image_b64: str,
    duration_s: int,
    stats: dict[str, EndpointStats],
    client: httpx.AsyncClient,
):
    headers = {"Authorization": f"Bearer {id_token}"}
    start_time = time.monotonic()
    last_verify_time = start_time - random.uniform(0, 30)  # Stagger initial verify/point
    last_point_time = start_time - random.uniform(0, 30)

    watch_payload = {
        "step": 1,
        "instruction": "Insert wire with blue ferrule into terminal 1",
        "success_criteria": "Blue ferrule fully seated in terminal 1",
        "common_mistakes": [{"description": "Wrong terminal", "visual_cue": "Wire in slot 2"}],
        "safety_rules": ["Verify power is isolated before wiring"],
        "image_b64": image_b64,
    }

    verify_payload = {
        "step": 1,
        "instruction": "Insert wire with blue ferrule into terminal 1",
        "success_criteria": "Blue ferrule fully seated in terminal 1",
        "safety_rules": ["Verify power is isolated before wiring"],
        "image_b64": image_b64,
    }

    point_payload = {
        "target": "terminal 1 screw clamp",
        "image_b64": image_b64,
    }

    while (time.monotonic() - start_time) < duration_s:
        loop_start = time.monotonic()

        # 1. Check if it's time for verify (~every 60s per worker)
        now = time.monotonic()
        if now - last_verify_time >= 60.0:
            last_verify_time = now
            t0 = time.perf_counter()
            try:
                r = await client.post(f"{base_url}/api/verify", json=verify_payload, headers=headers, timeout=25.0)
                tot = time.perf_counter() - t0
                body = r.json() if r.status_code == 200 else {}
                model_s = float(body.get("secs", 0.0)) if "secs" in body else None
                stats["verify"].record(tot, r.status_code, model_s=model_s)
            except Exception as e:
                stats["verify"].record(time.perf_counter() - t0, 599, err=str(e))

        # 2. Check if it's time for point (~every 60s per worker)
        now = time.monotonic()
        if now - last_point_time >= 60.0:
            last_point_time = now
            t0 = time.perf_counter()
            try:
                r = await client.post(f"{base_url}/api/point", json=point_payload, headers=headers, timeout=20.0)
                tot = time.perf_counter() - t0
                body = r.json() if r.status_code == 200 else {}
                model_s = float(body.get("secs", 0.0)) if "secs" in body else None
                stats["point"].record(tot, r.status_code, model_s=model_s)
            except Exception as e:
                stats["point"].record(time.perf_counter() - t0, 599, err=str(e))

        # 3. Always call watch (~every 2.3s)
        t0 = time.perf_counter()
        try:
            r = await client.post(f"{base_url}/api/watch", json=watch_payload, headers=headers, timeout=12.0)
            tot = time.perf_counter() - t0
            body = r.json() if r.status_code == 200 else {}
            model_s = float(body.get("secs", 0.0)) if "secs" in body else None
            stats["watch"].record(tot, r.status_code, model_s=model_s)
        except Exception as e:
            stats["watch"].record(time.perf_counter() - t0, 599, err=str(e))

        # Sleep to achieve ~2.3s watch cadence
        elapsed = time.monotonic() - loop_start
        sleep_needed = max(0.05, 2.3 - elapsed + random.uniform(-0.1, 0.1))
        await asyncio.sleep(sleep_needed)


async def run_coach_load_test(
    base_url: str,
    duration_s: int = 180,
    num_workers: int = 10,
) -> dict[str, Any]:
    logger.info("=== STARTING AUTHENTICATED LOAD TEST ===")
    logger.info("Workers: %d, Duration: %d seconds, Base URL: %s", num_workers, duration_s, base_url)

    tokens = acquire_worker_tokens(num_workers)
    image_b64 = get_terminal_block_image_b64()
    logger.info("Loaded real terminal block image (%d bytes b64)", len(image_b64))

    stats = {
        "watch": EndpointStats("watch"),
        "verify": EndpointStats("verify"),
        "point": EndpointStats("point"),
    }

    limits = httpx.Limits(max_keepalive_connections=50, max_connections=100)
    async with httpx.AsyncClient(limits=limits) as client:
        tasks = []
        for i in range(1, num_workers + 1):
            uid = f"loadtest-{i}"
            tasks.append(
                asyncio.create_task(
                    worker_loop(
                        worker_id=i,
                        uid=uid,
                        id_token=tokens[uid],
                        base_url=base_url,
                        image_b64=image_b64,
                        duration_s=duration_s,
                        stats=stats,
                        client=client,
                    )
                )
            )

        logger.info("All %d workers launched. Running for %d seconds...", num_workers, duration_s)
        await asyncio.gather(*tasks)

    logger.info("Load test completed. Aggregating results...")
    return {
        "duration_s": duration_s,
        "workers": num_workers,
        "endpoints": {k: v.summary() for k, v in stats.items()},
    }


async def test_live_websocket_connection(
    worker_id: int,
    base_url: str,
    id_token: str,
    hold_duration_s: int = 30,
) -> dict[str, Any]:
    """Tests one Gemini Live WebSocket session with setup + 1 text turn held for 30s."""
    headers = {"Authorization": f"Bearer {id_token}"}
    async with httpx.AsyncClient() as client:
        tok_res = await client.post(
            f"{base_url}/api/live-token",
            json={"purpose": "coach"},
            headers=headers,
            timeout=10.0,
        )
        if tok_res.status_code != 200:
            return {
                "worker_id": worker_id,
                "token_status": tok_res.status_code,
                "token_error": tok_res.text,
                "setup_complete": False,
                "turn_complete": False,
                "held_30s": False,
            }

        live_token = tok_res.json()["token"]

    ws_url = f"{WS_LIVE_URL}?access_token={live_token}"
    setup_msg = {
        "setup": {
            "model": "models/gemini-3.8-live",
            "generationConfig": {
                "responseModalities": ["AUDIO"],
            },
            "systemInstruction": {
                "parts": [{"text": "You are TAKUMI live master coach."}],
            },
        }
    }

    turn_msg = {
        "clientContent": {
            "turns": [
                {
                    "role": "user",
                    "parts": [{"text": "Hello coach, I am ready."}],
                }
            ],
            "turnComplete": True,
        }
    }

    result = {
        "worker_id": worker_id,
        "token_status": 200,
        "setup_complete": False,
        "turn_complete": False,
        "held_30s": False,
        "close_code": None,
        "close_reason": None,
    }

    try:
        async with websockets.connect(ws_url, close_timeout=5.0) as ws:
            # 1. Send Setup
            await ws.send(json.dumps(setup_msg))

            # 2. Wait for setupComplete
            raw_setup = await asyncio.wait_for(ws.recv(), timeout=8.0)
            parsed_setup = json.loads(raw_setup)
            if "setupComplete" in parsed_setup:
                result["setup_complete"] = True

            # 3. Send short text turn
            await ws.send(json.dumps(turn_msg))

            # Receive model response / turn complete
            t_turn_start = time.monotonic()
            while time.monotonic() - t_turn_start < 10.0:
                raw_resp = await asyncio.wait_for(ws.recv(), timeout=6.0)
                resp_json = json.loads(raw_resp)
                if "serverContent" in resp_json:
                    sc = resp_json["serverContent"]
                    if sc.get("turnComplete"):
                        result["turn_complete"] = True
                        break

            # 4. Hold connection for 30s total
            remaining = hold_duration_s - (time.monotonic() - t_turn_start)
            if remaining > 0:
                await asyncio.sleep(remaining)

            result["held_30s"] = True

    except websockets.exceptions.ConnectionClosed as cc:
        result["close_code"] = cc.code
        result["close_reason"] = cc.reason
    except Exception as e:
        result["error"] = str(e)

    return result


async def run_live_concurrency_test(base_url: str, num_concurrent: int = 10) -> dict[str, Any]:
    logger.info("=== STARTING LIVE CONCURRENCY TEST ===")
    logger.info("Opening %d simultaneous Gemini Live WebSockets (setup + text turn, 30s hold)...", num_concurrent)

    tokens = acquire_worker_tokens(num_concurrent)
    tasks = [
        test_live_websocket_connection(
            worker_id=i,
            base_url=base_url,
            id_token=tokens[f"loadtest-{i}"],
            hold_duration_s=30,
        )
        for i in range(1, num_concurrent + 1)
    ]

    results = await asyncio.gather(*tasks)

    setup_successes = sum(1 for r in results if r.get("setup_complete"))
    turn_successes = sum(1 for r in results if r.get("turn_complete"))
    held_30s = sum(1 for r in results if r.get("held_30s"))
    close_codes = [r.get("close_code") for r in results if r.get("close_code") is not None]

    summary = {
        "concurrent_attempts": num_concurrent,
        "setup_complete_count": setup_successes,
        "turn_complete_count": turn_successes,
        "held_30s_count": held_30s,
        "close_codes": close_codes,
        "results": results,
    }
    logger.info(
        "Live Concurrency Summary: setupComplete=%d/%d, turnComplete=%d/%d, held30s=%d/%d",
        setup_successes,
        num_concurrent,
        turn_successes,
        num_concurrent,
        held_30s,
        num_concurrent,
    )
    return summary


def cleanup_firestore_loadtest_data():
    """Deletes all sessions and event subcollections created by loadtest-1..10 in Firestore."""
    logger.info("Cleaning up Firestore session data for loadtest-1..10...")
    db = init_firebase()
    deleted_sessions = 0
    deleted_events = 0

    for i in range(1, 11):
        uid = f"loadtest-{i}"
        sessions_query = db.collection("sessions").where("trainee_uid", "==", uid).stream()
        for doc in sessions_query:
            # Delete events subcollection
            events_ref = doc.reference.collection("events").stream()
            for ev in events_ref:
                ev.reference.delete()
                deleted_events += 1
            doc.reference.delete()
            deleted_sessions += 1

    logger.info("Firestore cleanup complete: deleted %d sessions, %d events.", deleted_sessions, deleted_events)


if __name__ == "__main__":
    from infra.loadtest.cost_guard import add_cost_guard_args, enforce_cost_guard

    parser = argparse.ArgumentParser(description="TAKUMI Authenticated Load Test & Live Concurrency")
    parser.add_argument("--url", default="https://takumi-cup-2026.web.app", help="Base URL of target API")
    parser.add_argument("--duration", type=int, default=180, help="Load test duration in seconds (default 180)")
    parser.add_argument("--workers", type=int, default=10, help="Number of concurrent workers (default 10)")
    parser.add_argument("--skip-live", action="store_true", help="Skip Live WebSocket concurrency test")
    add_cost_guard_args(parser, default_max_calls=50)
    args = parser.parse_args()

    # Estimate verify calls: (duration_s / 60) * workers
    est_verify_calls = int((args.duration / 60) * args.workers)
    # Estimate total calls: watch every 2.3s + verify + point
    est_total_calls = int((args.duration / 2.3) * args.workers) + (est_verify_calls * 2)

    enforce_cost_guard(
        total_calls=est_total_calls,
        max_calls=args.max_calls,
        is_default_thinking_verify=(est_verify_calls > 20),
        i_know_this_costs=args.i_know_this_costs,
    )

    # 1. Run 10-Worker Coach Load Test (3 minutes)
    load_results = asyncio.run(run_coach_load_test(args.url, duration_s=args.duration, num_workers=args.workers))
    print("\n--- LOAD TEST RESULTS ---")
    print(json.dumps(load_results, indent=2))

    # 2. Run Live Concurrency Test (10 simultaneous WebSockets, 30s hold)
    if not args.skip_live:
        live_results = asyncio.run(run_live_concurrency_test(args.url, num_concurrent=args.workers))
        print("\n--- LIVE CONCURRENCY RESULTS ---")
        print(json.dumps(live_results, indent=2))

    # 3. Cleanup Firestore Data
    cleanup_firestore_loadtest_data()
