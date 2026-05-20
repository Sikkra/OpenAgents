from pathlib import Path
from types import SimpleNamespace

from fastapi import FastAPI

from api.middleware.ratelimit import RateLimitConfig, RateLimitMiddleware


def _middleware(tmp_path: Path, **kwargs) -> RateLimitMiddleware:
    app = FastAPI()
    config = RateLimitConfig(storage_path=str(tmp_path / "ratelimit.sqlite3"), **kwargs)
    return RateLimitMiddleware(app, config=config)


def test_x_forwarded_for_is_ignored_without_trusted_proxy(tmp_path):
    middleware = _middleware(tmp_path)
    request = SimpleNamespace(
        client=SimpleNamespace(host="203.0.113.10"),
        headers={"X-Forwarded-For": "198.51.100.99"},
    )

    assert middleware._get_client_ip(request) == "203.0.113.10"


def test_x_forwarded_for_allowed_for_trusted_proxy(tmp_path):
    middleware = _middleware(tmp_path, trusted_proxies={"203.0.113.10"})
    request = SimpleNamespace(
        client=SimpleNamespace(host="203.0.113.10"),
        headers={"X-Forwarded-For": "198.51.100.99, 203.0.113.10"},
    )

    assert middleware._get_client_ip(request) == "198.51.100.99"


def test_sliding_window_smooths_boundary(tmp_path):
    now = [1000.0]
    middleware = _middleware(
        tmp_path,
        requests_per_window=2,
        window_seconds=10,
        time_fn=lambda: now[0],
    )

    assert middleware._is_rate_limited("ip", "/tasks") == (False, 1, 2)
    now[0] = 1001.0
    assert middleware._is_rate_limited("ip", "/tasks") == (False, 0, 2)
    now[0] = 1002.0
    assert middleware._is_rate_limited("ip", "/tasks") == (True, 8, 2)
    now[0] = 1010.1
    assert middleware._is_rate_limited("ip", "/tasks") == (False, 0, 2)


def test_rate_limits_survive_middleware_restart(tmp_path):
    first = _middleware(tmp_path, requests_per_window=1, window_seconds=60)
    assert first._is_rate_limited("ip", "/agents") == (False, 0, 1)

    restarted = _middleware(tmp_path, requests_per_window=1, window_seconds=60)
    limited, retry_after, limit = restarted._is_rate_limited("ip", "/agents")

    assert limited is True
    assert retry_after > 0
    assert limit == 1


def test_per_endpoint_limits(tmp_path):
    middleware = _middleware(
        tmp_path,
        requests_per_window=10,
        window_seconds=60,
        endpoint_limits={"/payments": (1, 60)},
    )

    assert middleware._is_rate_limited("ip", "/payments/claim") == (False, 0, 1)
    assert middleware._is_rate_limited("ip", "/payments/claim")[0] is True

    assert middleware._is_rate_limited("ip", "/agents") == (False, 9, 10)
