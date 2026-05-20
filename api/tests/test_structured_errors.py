from fastapi import FastAPI, HTTPException, Query
from fastapi.testclient import TestClient

try:
    from api.errors import register_exception_handlers
    from api.main import app as main_app
except ImportError:
    from errors import register_exception_handlers
    from main import app as main_app


def assert_error_schema(payload, expected_code, request_id):
    assert payload["code"] == expected_code
    assert isinstance(payload["message"], str)
    assert isinstance(payload["details"], dict)
    assert payload["request_id"] == request_id


def test_validation_error_includes_field_details_and_request_id():
    client = TestClient(main_app)

    response = client.get(
        "/agents",
        params={"limit": "not-an-int"},
        headers={"X-Request-ID": "req-validation"},
    )

    assert response.status_code == 422
    assert response.headers["X-Request-ID"] == "req-validation"
    payload = response.json()
    assert_error_schema(payload, "VALIDATION_ERROR", "req-validation")
    assert payload["details"]["errors"][0]["field"] == "query.limit"


def test_not_found_error_uses_structured_schema():
    client = TestClient(main_app)

    response = client.get("/missing-route", headers={"X-Request-ID": "req-not-found"})

    assert response.status_code == 404
    assert_error_schema(response.json(), "NOT_FOUND", "req-not-found")


def test_auth_failed_and_rate_limited_codes():
    app = FastAPI()
    register_exception_handlers(app)

    @app.get("/auth")
    async def auth_failed():
        raise HTTPException(status_code=401, detail="Invalid token")

    @app.get("/limited")
    async def limited():
        raise HTTPException(
            status_code=429,
            detail={"message": "Rate limit exceeded", "details": {"retry_after": 30}},
            headers={"Retry-After": "30"},
        )

    client = TestClient(app)

    auth_response = client.get("/auth", headers={"X-Request-ID": "req-auth"})
    limited_response = client.get("/limited", headers={"X-Request-ID": "req-rate"})

    assert auth_response.status_code == 401
    assert_error_schema(auth_response.json(), "AUTH_FAILED", "req-auth")
    assert limited_response.status_code == 429
    assert limited_response.headers["Retry-After"] == "30"
    assert_error_schema(limited_response.json(), "RATE_LIMITED", "req-rate")
    assert limited_response.json()["details"]["retry_after"] == 30


def test_internal_error_uses_stable_response_without_exception_details():
    app = FastAPI()
    register_exception_handlers(app)

    @app.get("/boom")
    async def boom(required: int = Query(1)):
        raise RuntimeError("database password leaked here")

    client = TestClient(app, raise_server_exceptions=False)

    response = client.get("/boom", headers={"X-Request-ID": "req-internal"})

    assert response.status_code == 500
    payload = response.json()
    assert_error_schema(payload, "INTERNAL_ERROR", "req-internal")
    assert payload["message"] == "Internal server error"
    assert "database password" not in response.text
