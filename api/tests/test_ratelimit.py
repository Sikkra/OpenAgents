from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.middleware.ratelimit import RateLimitConfig, RateLimitMiddleware, _request_counts


def setup_function():
    _request_counts.clear()


def build_client(config: RateLimitConfig) -> TestClient:
    app = FastAPI()
    app.add_middleware(RateLimitMiddleware, config=config)

    @app.get("/resource")
    async def resource():
        return {"ok": True}

    return TestClient(app)


def test_default_limits_match_authenticated_tiers():
    config = RateLimitConfig()
    legacy_config = RateLimitConfig(requests_per_window=42)

    assert config.anonymous_requests_per_window == 60
    assert config.authenticated_requests_per_window == 300
    assert config.premium_requests_per_window == 1000
    assert legacy_config.anonymous_requests_per_window == 42


def test_anonymous_requests_use_anonymous_limit():
    client = build_client(RateLimitConfig(anonymous_requests_per_window=2))

    first = client.get("/resource")
    second = client.get("/resource")
    third = client.get("/resource")

    assert first.status_code == 200
    assert first.headers["X-RateLimit-Limit"] == "2"
    assert first.headers["X-RateLimit-Tier"] == "anonymous"
    assert second.status_code == 200
    assert third.status_code == 429


def test_api_key_requests_use_authenticated_limit_and_identity():
    client = build_client(RateLimitConfig(anonymous_requests_per_window=1, authenticated_requests_per_window=3))

    for _ in range(3):
        response = client.get("/resource", headers={"X-API-Key": "key-a"})
        assert response.status_code == 200
        assert response.headers["X-RateLimit-Limit"] == "3"
        assert response.headers["X-RateLimit-Tier"] == "authenticated"

    assert client.get("/resource", headers={"X-API-Key": "key-a"}).status_code == 429
    assert client.get("/resource", headers={"X-API-Key": "key-b"}).status_code == 200


def test_premium_api_key_requests_use_premium_limit():
    client = build_client(RateLimitConfig(authenticated_requests_per_window=1, premium_requests_per_window=3))

    for _ in range(3):
        response = client.get(
            "/resource",
            headers={"X-API-Key": "premium-key", "X-API-Key-Tier": "premium"},
        )
        assert response.status_code == 200
        assert response.headers["X-RateLimit-Limit"] == "3"
        assert response.headers["X-RateLimit-Tier"] == "premium"

    assert client.get(
        "/resource",
        headers={"X-API-Key": "premium-key", "X-API-Key-Tier": "premium"},
    ).status_code == 429


def test_premium_marker_without_api_key_stays_anonymous():
    client = build_client(RateLimitConfig(anonymous_requests_per_window=1, premium_requests_per_window=3))

    response = client.get("/resource", headers={"X-API-Key-Tier": "premium"})

    assert response.status_code == 200
    assert response.headers["X-RateLimit-Limit"] == "1"
    assert response.headers["X-RateLimit-Tier"] == "anonymous"
