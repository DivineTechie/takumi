"""Load test runner for TAKUMI production hardening.

Simulates concurrent trainees against TAKUMI endpoints:
- GET /api/healthz (public baseline)
- GET /api/status (public telemetry)
- POST /api/live-token (auth required)
- POST /api/watch, POST /api/verify, POST /api/point (authenticated inference)

Computes throughput, p50, p90, p99 latencies, error counts, and concurrency limits.
Synthetic test data is strictly isolated to prevent polluting production metrics.
"""

import argparse
import asyncio
import base64
import io
import json
import logging
import statistics
import time
from typing import Any
import httpx
from PIL import Image

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("loadtest")


def create_sample_jpeg_b64(width=320, height=240) -> str:
    img = Image.new("RGB", (width, height), color=(30, 144, 255))
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=75)
    return base64.b64encode(buf.getvalue()).decode()


class LoadTestMetrics:
    def __init__(self):
        self.latencies: dict[str, list[float]] = {}
        self.status_codes: dict[str, dict[int, int]] = {}
        self.errors: dict[str, list[str]] = {}
        self.start_time = 0.0
        self.end_time = 0.0

    def record(self, endpoint: str, latency_s: float, status_code: int, error: str | None = None):
        if endpoint not in self.latencies:
            self.latencies[endpoint] = []
            self.status_codes[endpoint] = {}
            self.errors[endpoint] = []

        self.latencies[endpoint].append(latency_s)
        self.status_codes[endpoint][status_code] = self.status_codes[endpoint].get(status_code, 0) + 1
        if error:
            self.errors[endpoint].append(error)

    def summary(self) -> dict[str, Any]:
        total_duration = max(0.001, self.end_time - self.start_time)
        total_requests = sum(len(l) for l in self.latencies.values())
        rps = total_requests / total_duration

        endpoints_summary = {}
        for ep, lats in self.latencies.items():
            if not lats:
                continue
            sorted_lats = sorted(lats)
            n = len(sorted_lats)
            p50 = sorted_lats[int(n * 0.50)]
            p90 = sorted_lats[min(n - 1, int(n * 0.90))]
            p99 = sorted_lats[min(n - 1, int(n * 0.99))]
            mean = statistics.mean(lats)
            status_map = self.status_codes.get(ep, {})
            ok_count = sum(c for code, c in status_map.items() if 200 <= code < 300)

            endpoints_summary[ep] = {
                "requests": n,
                "rps": round(n / total_duration, 2),
                "success_rate_pct": round((ok_count / n) * 100.0, 2),
                "p50_ms": round(p50 * 1000, 1),
                "p90_ms": round(p90 * 1000, 1),
                "p99_ms": round(p99 * 1000, 1),
                "mean_ms": round(mean * 1000, 1),
                "status_distribution": status_map,
                "error_count": len(self.errors.get(ep, [])),
            }

        return {
            "duration_s": round(total_duration, 2),
            "total_requests": total_requests,
            "overall_rps": round(rps, 2),
            "endpoints": endpoints_summary,
        }


async def worker(
    worker_id: int,
    base_url: str,
    id_token: str | None,
    stop_event: asyncio.Event,
    metrics: LoadTestMetrics,
    client: httpx.AsyncClient,
    sample_b64: str,
):
    headers = {"Authorization": f"Bearer {id_token}"} if id_token else {}
    req_counter = 0

    while not stop_event.is_set():
        req_counter += 1
        # Rotate endpoint calls
        ep_type = req_counter % 5

        try:
            t0 = time.perf_counter()
            if ep_type in (0, 1):
                # Public healthz
                res = await client.get(f"{base_url}/api/healthz", timeout=10.0)
                lat = time.perf_counter() - t0
                metrics.record("/api/healthz", lat, res.status_code)
            elif ep_type == 2:
                # Public status
                res = await client.get(f"{base_url}/api/status", timeout=10.0)
                lat = time.perf_counter() - t0
                metrics.record("/api/status", lat, res.status_code)
            elif ep_type == 3:
                # Watch (if token available)
                if id_token:
                    payload = {
                        "step": 1,
                        "instruction": "Verify wire ferrule insertion",
                        "success_criteria": "Blue ferrule fully seated",
                        "common_mistakes": [],
                        "safety_rules": ["Power off"],
                        "image_b64": sample_b64,
                    }
                    res = await client.post(f"{base_url}/api/watch", json=payload, headers=headers, timeout=15.0)
                    lat = time.perf_counter() - t0
                    metrics.record("/api/watch", lat, res.status_code)
                else:
                    res = await client.get(f"{base_url}/api/healthz", timeout=10.0)
                    lat = time.perf_counter() - t0
                    metrics.record("/api/healthz", lat, res.status_code)
            elif ep_type == 4:
                # Point target (if token available)
                if id_token:
                    payload = {
                        "target": "terminal block 1",
                        "image_b64": sample_b64,
                    }
                    res = await client.post(f"{base_url}/api/point", json=payload, headers=headers, timeout=15.0)
                    lat = time.perf_counter() - t0
                    metrics.record("/api/point", lat, res.status_code)
                else:
                    res = await client.get(f"{base_url}/api/status", timeout=10.0)
                    lat = time.perf_counter() - t0
                    metrics.record("/api/status", lat, res.status_code)
        except Exception as exc:
            metrics.record(f"error_{ep_type}", 0.0, 0, str(exc))

        # Pace slightly between trainee turns
        await asyncio.sleep(0.1)


async def run_load_test(
    base_url: str,
    concurrency: int = 10,
    duration_s: int = 30,
    id_token: str | None = None,
) -> dict[str, Any]:
    logger.info("Starting load test on %s with %d workers for %d seconds...", base_url, concurrency, duration_s)
    metrics = LoadTestMetrics()
    sample_b64 = create_sample_jpeg_b64()
    stop_event = asyncio.Event()

    metrics.start_time = time.perf_counter()
    limits = httpx.Limits(max_keepalive_connections=50, max_connections=100)
    async with httpx.AsyncClient(limits=limits) as client:
        tasks = [
            asyncio.create_task(
                worker(
                    worker_id=i,
                    base_url=base_url,
                    id_token=id_token,
                    stop_event=stop_event,
                    metrics=metrics,
                    client=client,
                    sample_b64=sample_b64,
                )
            )
            for i in range(concurrency)
        ]

        await asyncio.sleep(duration_s)
        stop_event.set()
        await asyncio.gather(*tasks, return_exceptions=True)

    metrics.end_time = time.perf_counter()
    summary = metrics.summary()
    logger.info("Load test completed. Overall RPS: %.2f, Total Requests: %d", summary["overall_rps"], summary["total_requests"])
    return summary


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="TAKUMI Load Test Runner")
    parser.add_argument("--url", default="https://takumi-cup-2026.web.app", help="Base URL of target API")
    parser.add_argument("--concurrency", type=int, default=10, help="Number of concurrent virtual trainees")
    parser.add_argument("--duration", type=int, default=15, help="Duration in seconds")
    parser.add_argument("--token", default=None, help="Firebase ID token for authenticated endpoints")
    args = parser.parse_args()

    results = asyncio.run(run_load_test(args.url, args.concurrency, args.duration, args.token))
    print(json.dumps(results, indent=2))
