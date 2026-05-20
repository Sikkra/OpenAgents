"""Rate limiting middleware for the OpenAgents API."""

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
        api_key = request.headers.get("X-API-Key")
        if api_key:
            return api_key.strip()

        authorization = request.headers.get("Authorization", "")
        scheme, _, token = authorization.partition(" ")
        if scheme.lower() in {"apikey", "bearer"} and token.strip():
            return token.strip()
        return None

    def _is_premium_request(self, request: Request) -> bool:
        tier = request.headers.get("X-API-Key-Tier", "").lower()
        premium_flag = request.headers.get("X-API-Key-Premium", "").lower()
        return tier == "premium" or premium_flag in {"1", "true", "yes"}

    def _rate_identity(self, request: Request) -> tuple[str, int, str]:
        api_key = self._get_api_key(request)
        if api_key:
            if self._is_premium_request(request):
                return f"premium:{api_key}", self.config.premium_requests_per_window, "premium"
            return f"authenticated:{api_key}", self.config.authenticated_requests_per_window, "authenticated"

        return f"anonymous:{self._get_client_ip(request)}", self.config.anonymous_requests_per_window, "anonymous"

    def _is_rate_limited(self, identity: str, limit: int) -> Tuple[bool, int]:
        count, window_start = _request_counts[identity]
        now = time.time()

        if now - window_start >= self.config.window_seconds:
            _request_counts[identity] = (1, now)
            return False, limit - 1

        if count >= limit:
            retry_after = int(self.config.window_seconds - (now - window_start))
            return True, retry_after

        _request_counts[identity] = (count + 1, window_start)
        remaining = limit - count - 1
        return False, remaining

    async def dispatch(self, request: Request, call_next):
        if request.url.path.startswith("/health"):
            return await call_next(request)

        identity, limit, tier = self._rate_identity(request)
        is_limited, value = self._is_rate_limited(identity, limit)

        if is_limited:
            return JSONResponse(
                status_code=429,
                content={
                    "error": "Rate limit exceeded",
                    "retry_after": value,
                },
                headers={
                    "Retry-After": str(value),
                    "X-RateLimit-Limit": str(limit),
                    "X-RateLimit-Tier": tier,
                },
            )

        response = await call_next(request)
        response.headers["X-RateLimit-Remaining"] = str(value)
        response.headers["X-RateLimit-Limit"] = str(limit)
        response.headers["X-RateLimit-Tier"] = tier
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
