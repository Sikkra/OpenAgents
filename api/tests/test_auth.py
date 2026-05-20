from datetime import datetime, timedelta, timezone

import jwt
import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

from api.main import app
from api.middleware import auth


def setup_function():
    auth.REVOKED_JTIS.clear()
    auth.REVOKED_TOKENS.clear()


def test_missing_secret_uses_fallback_without_import_crash():
    assert auth.JWT_SECRET


def test_decode_rejects_none_algorithm_token():
    token = jwt.encode(
        {
            "sub": "user-1",
            "address": "0xabc",
            "roles": [],
            "type": "access",
            "exp": datetime.now(timezone.utc) + timedelta(minutes=5),
        },
        key="",
        algorithm="none",
    )

    with pytest.raises(HTTPException) as exc_info:
        auth.decode_token(token)

    assert exc_info.value.status_code == 401


def test_revoked_access_token_is_rejected():
    tokens = auth.generate_login_tokens("user-1", "0xabc", ["agent"])

    auth.revoke_token(tokens["token"])

    with pytest.raises(HTTPException) as exc_info:
        auth.decode_token(tokens["token"])

    assert exc_info.value.status_code == 401
    assert exc_info.value.detail == "Token has been revoked"


def test_refresh_endpoint_issues_new_access_token():
    tokens = auth.generate_login_tokens("user-1", "0xabc", ["agent"])
    client = TestClient(app)

    response = client.post("/auth/refresh", json={"refresh_token": tokens["refresh_token"]})

    assert response.status_code == 200
    payload = auth.decode_token(response.json()["token"])
    assert payload["type"] == "access"
    assert payload["sub"] == "user-1"
    assert response.json()["expires_in"] == auth.ACCESS_TOKEN_EXPIRE_MINUTES * 60


def test_refresh_endpoint_rejects_access_token():
    tokens = auth.generate_login_tokens("user-1", "0xabc", ["agent"])
    client = TestClient(app)

    response = client.post("/auth/refresh", json={"refresh_token": tokens["token"]})

    assert response.status_code == 401
