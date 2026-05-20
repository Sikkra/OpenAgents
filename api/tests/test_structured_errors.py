"""Focused tests for structured API error responses."""

import sys
from pathlib import Path

from fastapi import HTTPException
from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from api.errors import ErrorCode
from api.main import app


@app.get("/__test/auth-failed")
async def auth_failed():
    raise HTTPException(status_code=401, detail="Invalid token")


@app.get("/__test/rate-limited")
async def rate_limited():
    raise HTTPException(status_code=429, detail="Rate limit exceeded")


@app.get("/__test/internal-error")
async def internal_error():
    raise RuntimeError("boom")


client = TestClient(app, raise_server_exceptions=False)


def assert_error_schema(response, expected_code):
    body = response.json()
    assert set(body) == {"code", "message", "details", "request_id"}
    assert body["code"] == expected_code
    assert isinstance(body["message"], str)
    assert isinstance(body["details"], dict)
    assert body["request_id"]
    assert response.headers["X-Request-ID"] == body["request_id"]
    return body


def test_not_found_error_shape_and_request_id():
    response = client.get("/agents/missing", headers={"X-Request-ID": "req-not-found"})

    body = assert_error_schema(response, ErrorCode.NOT_FOUND.value)
    assert response.status_code == 404
    assert body["message"] == "Agent not found"
    assert body["request_id"] == "req-not-found"


def test_validation_error_has_field_details():
    response = client.get("/tasks/not-an-int")

    body = assert_error_schema(response, ErrorCode.VALIDATION_ERROR.value)
    assert response.status_code == 422
    assert body["message"] == "Request validation failed"
    assert body["details"]["fields"]
    assert any("task_id" in field["field"] for field in body["details"]["fields"])


def test_auth_failed_error_code():
    response = client.get("/__test/auth-failed")

    body = assert_error_schema(response, ErrorCode.AUTH_FAILED.value)
    assert response.status_code == 401
    assert body["message"] == "Invalid token"


def test_rate_limited_error_code():
    response = client.get("/__test/rate-limited")

    body = assert_error_schema(response, ErrorCode.RATE_LIMITED.value)
    assert response.status_code == 429
    assert body["message"] == "Rate limit exceeded"


def test_internal_error_code():
    response = client.get("/__test/internal-error")

    body = assert_error_schema(response, ErrorCode.INTERNAL_ERROR.value)
    assert response.status_code == 500
    assert body["message"] == "Internal server error"
    assert body["details"]["error_type"] == "RuntimeError"


def test_error_code_documentation_endpoint():
    response = client.get("/errors/codes")

    assert response.status_code == 200
    codes = response.json()["codes"]
    for code in ErrorCode:
        assert code.value in codes
        assert codes[code.value]


if __name__ == "__main__":
    test_not_found_error_shape_and_request_id()
    test_validation_error_has_field_details()
    test_auth_failed_error_code()
    test_rate_limited_error_code()
    test_internal_error_code()
    test_error_code_documentation_endpoint()
    print("Structured API error checks passed")
