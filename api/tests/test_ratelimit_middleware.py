from pathlib import Path

from fastapi import FastAPI
from fastapi.testclient import TestClient

try:
    from api.middleware.ratelimit import RateLimitConfig, RateLimitMiddleware
except ImportError:
    from middleware.ratelimit import RateLimitConfig, RateLimitMiddleware


class MutableClock:
    def __init__(self, value=1000.0):
        self.value = value

    def __call__(self):
        return self.value

    def advance(self, seconds):
        self.value += seconds


def build_client(config):
    app = FastAPI()

    @app.get("/limited")
    async def limited():
        return {"ok": True}

    @app.get("/strict")
    async def strict():
        return {"ok": True}

    app.add_middleware(RateLimitMiddleware, config=config)
    return TestClient(app)


def test_untrusted_x_forwarded_for_does_not_bypass_limit(tmp_path: Path):
    config = RateLimitConfig(
        requests_per_window=1,
        window_seconds=60,
        storage_path=str(tmp_path / "ratelimit.sqlite3"),
    )
    client = build_client(config)

    first = client.get("/limited", headers={"X-Forwarded-For": "1.1.1.1"})
    second = client.get("/limited", headers={"X-Forwarded-For": "2.2.2.2"})

    assert first.status_code == 200
    assert second.status_code == 429


def test_trusted_proxy_uses_valid_forwarded_client_ip(tmp_path: Path):
    config = RateLimitConfig(
        requests_per_window=1,
        window_seconds=60,
        storage_path=str(tmp_path / "ratelimit.sqlite3"),
        trusted_proxies={"testclient"},
    )
    client = build_client(config)

    first = client.get("/limited", headers={"X-Forwarded-For": "1.1.1.1"})
    second = client.get("/limited", headers={"X-Forwarded-For": "2.2.2.2"})

    assert first.status_code == 200
    assert second.status_code == 200


def test_sliding_window_expires_old_hits_smoothly(tmp_path: Path):
    clock = MutableClock()
    config = RateLimitConfig(
        requests_per_window=2,
        window_seconds=10,
        storage_path=str(tmp_path / "ratelimit.sqlite3"),
        clock=clock,
    )
    client = build_client(config)

    assert client.get("/limited").status_code == 200
    clock.advance(5)
    assert client.get("/limited").status_code == 200
    clock.advance(4)
    assert client.get("/limited").status_code == 429
    clock.advance(2)
    assert client.get("/limited").status_code == 200


def test_limits_survive_middleware_restart(tmp_path: Path):
    db_path = str(tmp_path / "ratelimit.sqlite3")
    first_client = build_client(
        RateLimitConfig(requests_per_window=1, window_seconds=60, storage_path=db_path)
    )
    second_client = build_client(
        RateLimitConfig(requests_per_window=1, window_seconds=60, storage_path=db_path)
    )

    assert first_client.get("/limited").status_code == 200
    assert second_client.get("/limited").status_code == 429


def test_per_endpoint_limit_overrides_default(tmp_path: Path):
    config = RateLimitConfig(
        requests_per_window=10,
        window_seconds=60,
        storage_path=str(tmp_path / "ratelimit.sqlite3"),
        endpoint_limits={"GET /strict": (1, 60)},
    )
    client = build_client(config)

    assert client.get("/strict").status_code == 200
    limited = client.get("/strict")

    assert limited.status_code == 429
    assert limited.headers["Retry-After"] == "60"
