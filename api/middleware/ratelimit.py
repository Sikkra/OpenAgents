"""Rate limiting middleware for the OpenAgents API."""

import ipaddress
import os
import sqlite3
import time
from pathlib import Path
from threading import Lock
from typing import Callable, Dict, Iterable, Tuple

from fastapi import Request
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.responses import JSONResponse


class RateLimitConfig:
    def __init__(
        self,
        requests_per_window: int = 100,
        window_seconds: int = 60,
        burst_limit: int = 20,
        storage_path: str | None = None,
        trusted_proxies: Iterable[str] | None = None,
        endpoint_limits: Dict[str, Tuple[int, int]] | None = None,
        clock: Callable[[], float] | None = None,
    ):
        self.requests_per_window = requests_per_window
        self.window_seconds = window_seconds
        self.burst_limit = burst_limit
        self.storage_path = storage_path or os.getenv("RATE_LIMIT_DB", "ratelimit.sqlite3")
        self.trusted_proxy_networks = set()
        self.trusted_proxy_hosts = set()
        for proxy in trusted_proxies or []:
            try:
                self.trusted_proxy_networks.add(ipaddress.ip_network(proxy, strict=False))
            except ValueError:
                self.trusted_proxy_hosts.add(str(proxy))
        self.endpoint_limits = endpoint_limits or {}
        self.clock = clock or time.time


class SQLiteRateLimitStore:
    def __init__(self, path: str):
        self.path = path
        self._lock = Lock()
        db_path = Path(path)
        if db_path.parent and str(db_path.parent) != ".":
            db_path.parent.mkdir(parents=True, exist_ok=True)
        self._initialize()

    def _connect(self):
        conn = sqlite3.connect(self.path, timeout=5)
        conn.execute("PRAGMA journal_mode=WAL")
        return conn

    def _initialize(self) -> None:
        with self._connect() as conn:
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS rate_limit_hits (
                    client_id TEXT NOT NULL,
                    endpoint TEXT NOT NULL,
                    timestamp REAL NOT NULL
                )
                """
            )
            conn.execute(
                """
                CREATE INDEX IF NOT EXISTS idx_rate_limit_hits_window
                ON rate_limit_hits (client_id, endpoint, timestamp)
                """
            )

    def hit(
        self,
        client_id: str,
        endpoint: str,
        now: float,
        max_requests: int,
        window_seconds: int,
    ) -> Tuple[bool, int]:
        cutoff = now - window_seconds
        with self._lock:
            with self._connect() as conn:
                conn.execute("DELETE FROM rate_limit_hits WHERE timestamp <= ?", (cutoff,))
                rows = conn.execute(
                    """
                    SELECT timestamp
                    FROM rate_limit_hits
                    WHERE client_id = ? AND endpoint = ? AND timestamp > ?
                    ORDER BY timestamp ASC
                    """,
                    (client_id, endpoint, cutoff),
                ).fetchall()
                if len(rows) >= max_requests:
                    retry_after = max(1, int(rows[0][0] + window_seconds - now + 0.999))
                    return True, retry_after
                conn.execute(
                    """
                    INSERT INTO rate_limit_hits (client_id, endpoint, timestamp)
                    VALUES (?, ?, ?)
                    """,
                    (client_id, endpoint, now),
                )
                remaining = max_requests - len(rows) - 1
                return False, remaining


class RateLimitMiddleware(BaseHTTPMiddleware):
    def __init__(self, app, config: RateLimitConfig = None):
        super().__init__(app)
        self.config = config or RateLimitConfig()
        self.store = SQLiteRateLimitStore(self.config.storage_path)

    def _is_trusted_proxy(self, client_ip: str) -> bool:
        try:
            parsed = ipaddress.ip_address(client_ip)
        except ValueError:
            return client_ip in self.config.trusted_proxy_hosts
        return any(parsed in proxy for proxy in self.config.trusted_proxy_networks)

    def _first_valid_forwarded_ip(self, forwarded: str) -> str | None:
        for value in forwarded.split(","):
            candidate = value.strip()
            try:
                ipaddress.ip_address(candidate)
            except ValueError:
                continue
            return candidate
        return None

    def _get_client_ip(self, request: Request) -> str:
        peer_ip = request.client.host if request.client else "unknown"
        forwarded = request.headers.get("X-Forwarded-For")
        if forwarded and self._is_trusted_proxy(peer_ip):
            forwarded_ip = self._first_valid_forwarded_ip(forwarded)
            if forwarded_ip:
                return forwarded_ip
        return peer_ip

    def _endpoint_key(self, request: Request) -> str:
        return f"{request.method.upper()} {request.url.path}"

    def _limit_for(self, request: Request) -> Tuple[int, int]:
        method_key = self._endpoint_key(request)
        path_key = request.url.path
        if method_key in self.config.endpoint_limits:
            return self.config.endpoint_limits[method_key]
        if path_key in self.config.endpoint_limits:
            return self.config.endpoint_limits[path_key]
        return self.config.requests_per_window, self.config.window_seconds

    def _is_rate_limited(self, client_ip: str, request: Request) -> Tuple[bool, int, int]:
        limit, window = self._limit_for(request)
        endpoint = self._endpoint_key(request)
        is_limited, value = self.store.hit(
            client_id=client_ip,
            endpoint=endpoint,
            now=self.config.clock(),
            max_requests=limit,
            window_seconds=window,
        )
        return is_limited, value, limit

    async def dispatch(self, request: Request, call_next):
        if request.url.path.startswith("/health"):
            return await call_next(request)

        client_ip = self._get_client_ip(request)
        is_limited, value, limit = self._is_rate_limited(client_ip, request)

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
    storage_path: str | None = None,
    trusted_proxies: Iterable[str] | None = None,
    endpoint_limits: Dict[str, Tuple[int, int]] | None = None,
) -> RateLimitMiddleware:
    config = RateLimitConfig(
        requests_per_window=requests_per_minute,
        window_seconds=60,
        burst_limit=burst,
        storage_path=storage_path,
        trusted_proxies=trusted_proxies,
        endpoint_limits=endpoint_limits,
    )
    return RateLimitMiddleware(app=None, config=config)
