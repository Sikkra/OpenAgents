from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.middleware.ratelimit import RateLimitConfig, RateLimitMiddleware, _request_counts


def make_client():
    _request_counts.clear()
    app = FastAPI()
    app.add_middleware(
        RateLimitMiddleware,
        config=RateLimitConfig(
            anonymous_requests_per_window=2,
            authenticated_requests_per_window=3,
            premium_requests_per_window=4,
            window_seconds=60,
        ),
    )

    @app.get("/ok")
    async def ok():
        return {"ok": True}

    @app.get("/health")
    async def health():
        return {"status": "ok"}

    return TestClient(app)


def assert_rate_headers(response, limit, remaining, tier):
    assert response.headers["X-RateLimit-Limit"] == str(limit)
    assert response.headers["X-RateLimit-Remaining"] == str(remaining)
    assert response.headers["X-RateLimit-Tier"] == tier
    assert int(response.headers["X-RateLimit-Reset"]) > 0


def test_anonymous_limit_and_429_retry_after_headers():
    client = make_client()

    first = client.get("/ok")
    second = client.get("/ok")
    limited = client.get("/ok")

    assert first.status_code == 200
    assert_rate_headers(first, 2, 1, "anonymous")
    assert second.status_code == 200
    assert_rate_headers(second, 2, 0, "anonymous")
    assert limited.status_code == 429
    assert_rate_headers(limited, 2, 0, "anonymous")
    assert int(limited.headers["Retry-After"]) > 0


def test_authenticated_requests_get_higher_independent_limit():
    client = make_client()

    headers = {"Authorization": "Bearer jwt-token"}
    responses = [client.get("/ok", headers=headers) for _ in range(4)]

    assert [response.status_code for response in responses] == [200, 200, 200, 429]
    assert_rate_headers(responses[0], 3, 2, "authenticated")
    assert_rate_headers(responses[2], 3, 0, "authenticated")
    assert responses[3].headers["Retry-After"]


def test_premium_api_keys_get_premium_limit():
    client = make_client()

    headers = {"X-API-Key": "pk_live_abc", "X-API-Key-Tier": "premium"}
    responses = [client.get("/ok", headers=headers) for _ in range(5)]

    assert [response.status_code for response in responses] == [200, 200, 200, 200, 429]
    assert_rate_headers(responses[0], 4, 3, "premium")
    assert_rate_headers(responses[3], 4, 0, "premium")


def test_rate_limit_headers_are_added_to_health_responses():
    client = make_client()

    response = client.get("/health")

    assert response.status_code == 200
    assert_rate_headers(response, 2, 1, "anonymous")
