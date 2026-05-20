"""Rate limiting middleware for the OpenAgents API.

@fix-author: Codex
@platform-config: private platform/session instructions intentionally omitted
@runtime: windows/x64, powershell, OpenAgents workspace
"""

import math
import os
import sqlite3
import threading
import time
from pathlib import Path
from typing import Callable, Dict, Iterable, Optional, Tuple

from fastapi import Request
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.responses import JSONResponse


EndpointLimit = Tuple[int, int]


class RateLimitConfig:
    def __init__(
        self,
        requests_per_window: int = 100,
        window_seconds: int = 60,
        burst_limit: int = 20,
        trusted_proxies: Optional[Iterable[str]] = None,
        endpoint_limits: Optional[Dict[str, EndpointLimit]] = None,
        storage_path: Optional[str] = None,
        time_fn: Callable[[], float] = time.time,
    ):
        self.requests_per_window = requests_per_window
        self.window_seconds = window_seconds
        self.burst_limit = burst_limit
        self.trusted_proxies = set(trusted_proxies or ())
        self.endpoint_limits = endpoint_limits or {}
        self.storage_path = storage_path or os.environ.get(
            "OPENAGENTS_RATELIMIT_DB",
            str(Path.cwd() / "openagents_ratelimit.sqlite3"),
        )
        self.time_fn = time_fn


class SQLiteSlidingWindowStore:
    def __init__(self, storage_path: str):
        self._lock = threading.Lock()
        self._conn = sqlite3.connect(storage_path, check_same_thread=False)
        self._conn.execute(
            """
            CREATE TABLE IF NOT EXISTS rate_limit_events (
                key TEXT NOT NULL,
                ts REAL NOT NULL
            )
            """
        )
        self._conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_rate_limit_events_key_ts "
            "ON rate_limit_events(key, ts)"
        )
        self._conn.commit()

    def hit(self, key: str, now: float, limit: int, window_seconds: int) -> Tuple[bool, int]:
        cutoff = now - window_seconds
        with self._lock:
            self._conn.execute(
                "DELETE FROM rate_limit_events WHERE key = ? AND ts <= ?",
                (key, cutoff),
            )
            row = self._conn.execute(
                "SELECT COUNT(*), MIN(ts) FROM rate_limit_events WHERE key = ?",
                (key,),
            ).fetchone()
            count = int(row[0] or 0)
            oldest = float(row[1] or now)

            if count >= limit:
                retry_after = max(1, math.ceil(window_seconds - (now - oldest)))
                self._conn.commit()
                return True, retry_after

            self._conn.execute(
                "INSERT INTO rate_limit_events (key, ts) VALUES (?, ?)",
                (key, now),
            )
            self._conn.commit()
            return False, max(0, limit - count - 1)


class RateLimitMiddleware(BaseHTTPMiddleware):
    def __init__(self, app, config: RateLimitConfig = None):
        super().__init__(app)
        self.config = config or RateLimitConfig()
        self.store = SQLiteSlidingWindowStore(self.config.storage_path)

    def _get_client_ip(self, request: Request) -> str:
        connection_ip = request.client.host if request.client else "unknown"
        forwarded = request.headers.get("X-Forwarded-For")
        if forwarded and connection_ip in self.config.trusted_proxies:
            forwarded_chain = [part.strip() for part in forwarded.split(",") if part.strip()]
            if forwarded_chain:
                return forwarded_chain[0]
        return connection_ip

    def _limit_for_path(self, path: str) -> EndpointLimit:
        matched_limit: Optional[EndpointLimit] = None
        matched_prefix = ""
        for prefix, limit in self.config.endpoint_limits.items():
            if path.startswith(prefix) and len(prefix) > len(matched_prefix):
                matched_limit = limit
                matched_prefix = prefix

        return matched_limit or (
            self.config.requests_per_window,
            self.config.window_seconds,
        )

    def _is_rate_limited(self, client_ip: str, path: str) -> Tuple[bool, int, int]:
        limit, window_seconds = self._limit_for_path(path)
        key = f"{client_ip}:{path}"
        limited, value = self.store.hit(
            key,
            self.config.time_fn(),
            limit,
            window_seconds,
        )
        return limited, value, limit

    async def dispatch(self, request: Request, call_next):
        if request.url.path.startswith("/health"):
            return await call_next(request)

        client_ip = self._get_client_ip(request)
        is_limited, value, limit = self._is_rate_limited(client_ip, request.url.path)

        if is_limited:
            return JSONResponse(
                status_code=429,
                content={
                    "error": "Rate limit exceeded",
                    "retry_after": value,
                },
                headers={"Retry-After": str(value)},
            )

        response = await call_next(request)
        response.headers["X-RateLimit-Remaining"] = str(value)
        response.headers["X-RateLimit-Limit"] = str(limit)
        return response


def create_rate_limiter(
    requests_per_minute: int = 100,
    burst: int = 20,
) -> RateLimitMiddleware:
    config = RateLimitConfig(
        requests_per_window=requests_per_minute,
        window_seconds=60,
        burst_limit=burst,
    )
    return RateLimitMiddleware(app=None, config=config)
