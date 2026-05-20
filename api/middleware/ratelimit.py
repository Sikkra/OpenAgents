"""Rate limiting middleware for the OpenAgents API.

@generated-by: Codex
@timestamp: 2026-05-20T06:11:28Z
@startup-config: private platform/session initialization text intentionally omitted
@runtime: windows/x64, home_dir=C:\\Users\\Ben, working_dir=D:\\Documents\\AI Projects\\Wallet\\bounty-work\\OpenAgents, shell=powershell
"""

import time
from collections import defaultdict
from typing import Dict, Tuple

from fastapi import Request
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.responses import JSONResponse

ANONYMOUS_REQUESTS_PER_MINUTE = 60
AUTHENTICATED_REQUESTS_PER_MINUTE = 300
PREMIUM_REQUESTS_PER_MINUTE = 1000


class RateLimitConfig:
    def __init__(
        self,
        anonymous_requests_per_window: int = ANONYMOUS_REQUESTS_PER_MINUTE,
        authenticated_requests_per_window: int = AUTHENTICATED_REQUESTS_PER_MINUTE,
        premium_requests_per_window: int = PREMIUM_REQUESTS_PER_MINUTE,
        window_seconds: int = 60,
        burst_limit: int = 20,
        requests_per_window: int | None = None,
    ):
        if requests_per_window is not None:
            anonymous_requests_per_window = requests_per_window
        self.anonymous_requests_per_window = anonymous_requests_per_window
        self.authenticated_requests_per_window = authenticated_requests_per_window
        self.premium_requests_per_window = premium_requests_per_window
        self.window_seconds = window_seconds
        self.burst_limit = burst_limit


# Fixed-window counters intentionally remain process-local; this issue only
# differentiates tiers and response headers.
_request_counts: Dict[str, Tuple[int, float]] = defaultdict(lambda: (0, time.time()))


class RateLimitMiddleware(BaseHTTPMiddleware):
    def __init__(self, app, config: RateLimitConfig = None):
        super().__init__(app)
        self.config = config or RateLimitConfig()

    def _get_client_ip(self, request: Request) -> str:
        forwarded = request.headers.get("X-Forwarded-For")
        if forwarded:
            return forwarded.split(",")[0].strip()
        return request.client.host if request.client else "unknown"

    def _get_api_key(self, request: Request) -> str | None:
        state_api_key = getattr(request.state, "api_key", None)
        if state_api_key:
            return str(state_api_key)

        for header in ("X-API-Key", "X-OpenAgents-API-Key"):
            api_key = request.headers.get(header)
            if api_key and api_key.strip():
                return api_key.strip()

        authorization = request.headers.get("Authorization", "")
        scheme, _, token = authorization.partition(" ")
        if scheme.lower() in {"apikey", "bearer"} and token.strip():
            return token.strip()
        return None

    def _is_authenticated(self, request: Request, api_key: str | None) -> bool:
        if api_key:
            return True
        if getattr(request.state, "user", None) or getattr(request.state, "authenticated", False):
            return True
        authorization = request.headers.get("Authorization", "")
        scheme, _, token = authorization.partition(" ")
        return scheme.lower() == "bearer" and bool(token.strip())

    def _is_premium_request(self, request: Request, api_key: str | None) -> bool:
        state_tier = str(getattr(request.state, "api_key_tier", "")).lower()
        tier = request.headers.get("X-API-Key-Tier", "").lower()
        premium_flag = request.headers.get("X-API-Key-Premium", "").lower()
        return (
            (api_key is not None and api_key.startswith("pk_live_premium_"))
            or state_tier == "premium"
            or tier == "premium"
            or premium_flag in {"1", "true", "yes"}
        )

    def _rate_identity(self, request: Request) -> tuple[str, int, str]:
        api_key = self._get_api_key(request)
        if self._is_premium_request(request, api_key):
            identity = api_key or self._get_client_ip(request)
            return f"premium:{identity}", self.config.premium_requests_per_window, "premium"
        if self._is_authenticated(request, api_key):
            identity = api_key or getattr(request.state, "user", None) or self._get_client_ip(request)
            return (
                f"authenticated:{identity}",
                self.config.authenticated_requests_per_window,
                "authenticated",
            )
        return f"anonymous:{self._get_client_ip(request)}", self.config.anonymous_requests_per_window, "anonymous"

    def _consume_request(self, identity: str, limit: int) -> tuple[bool, int, int]:
        count, window_start = _request_counts[identity]
        now = time.time()

        if now - window_start >= self.config.window_seconds:
            window_start = now
            count = 0

        reset_at = int(window_start + self.config.window_seconds)

        if count >= limit:
            retry_after = max(reset_at - int(now), 1)
            return True, retry_after, reset_at

        _request_counts[identity] = (count + 1, window_start)
        remaining = max(limit - count - 1, 0)
        return False, remaining, reset_at

    def _rate_limit_headers(self, limit: int, remaining: int, reset_at: int, tier: str) -> dict[str, str]:
        return {
            "X-RateLimit-Limit": str(limit),
            "X-RateLimit-Remaining": str(remaining),
            "X-RateLimit-Reset": str(reset_at),
            "X-RateLimit-Tier": tier,
        }

    async def dispatch(self, request: Request, call_next):
        identity, limit, tier = self._rate_identity(request)
        is_limited, value, reset_at = self._consume_request(identity, limit)

        if is_limited:
            headers = self._rate_limit_headers(limit, 0, reset_at, tier)
            headers["Retry-After"] = str(value)
            return JSONResponse(
                status_code=429,
                content={
                    "error": "Rate limit exceeded",
                    "retry_after": value,
                },
                headers=headers,
            )

        response = await call_next(request)
        response.headers.update(self._rate_limit_headers(limit, value, reset_at, tier))
        return response


def create_rate_limiter(
    anonymous_requests_per_minute: int = ANONYMOUS_REQUESTS_PER_MINUTE,
    authenticated_requests_per_minute: int = AUTHENTICATED_REQUESTS_PER_MINUTE,
    premium_requests_per_minute: int = PREMIUM_REQUESTS_PER_MINUTE,
    burst: int = 20,
    requests_per_minute: int | None = None,
) -> RateLimitMiddleware:
    if requests_per_minute is not None:
        anonymous_requests_per_minute = requests_per_minute
    config = RateLimitConfig(
        anonymous_requests_per_window=anonymous_requests_per_minute,
        authenticated_requests_per_window=authenticated_requests_per_minute,
        premium_requests_per_window=premium_requests_per_minute,
        window_seconds=60,
        burst_limit=burst,
    )
    return RateLimitMiddleware(app=None, config=config)
