import asyncio
import os

import httpx
import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

os.environ.setdefault("JWT_SECRET", "test-secret")

from api.models.database import Agent, Base, get_db
from api.routes import agents


class FakeResponse:
    status_code = 204


class FakeAsyncClient:
    def __init__(self, *args, **kwargs):
        self.timeout = kwargs.get("timeout")

    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc, tb):
        return False

    async def head(self, url):
        assert self.timeout == agents.ENDPOINT_TIMEOUT_SECONDS
        return FakeResponse()


def public_dns(*args, **kwargs):
    return [(None, None, None, "", ("93.184.216.34", 443))]


def test_valid_url_is_normalized_after_head_check(monkeypatch):
    monkeypatch.setattr(agents.socket, "getaddrinfo", public_dns)
    monkeypatch.setattr(agents.httpx, "AsyncClient", FakeAsyncClient)

    validated = asyncio.run(agents.validate_endpoint_url("https://agent.example/callback#fragment"))

    assert validated == "https://agent.example/callback"


def test_invalid_url_format_is_rejected():
    with pytest.raises(HTTPException) as exc_info:
        asyncio.run(agents.validate_endpoint_url("not-a-url"))

    assert exc_info.value.status_code == 400
    assert "valid http or https URL" in exc_info.value.detail


def test_private_ip_is_rejected_before_head_request():
    with pytest.raises(HTTPException) as exc_info:
        asyncio.run(agents.validate_endpoint_url("http://127.0.0.1:8000/agent"))

    assert exc_info.value.status_code == 400
    assert "private or internal" in exc_info.value.detail


def test_timeout_is_rejected(monkeypatch):
    class TimeoutClient(FakeAsyncClient):
        async def head(self, url):
            raise httpx.TimeoutException("slow")

    monkeypatch.setattr(agents.socket, "getaddrinfo", public_dns)
    monkeypatch.setattr(agents.httpx, "AsyncClient", TimeoutClient)

    with pytest.raises(HTTPException) as exc_info:
        asyncio.run(agents.validate_endpoint_url("https://agent.example/"))

    assert exc_info.value.status_code == 400
    assert "timed out" in exc_info.value.detail


def test_create_agent_stores_validated_url(monkeypatch):
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    TestingSessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
    Base.metadata.create_all(bind=engine)

    async def fake_validate_endpoint_url(endpoint):
        assert endpoint == "https://agent.example/raw"
        return "https://agent.example/raw/"

    def override_get_db():
        db = TestingSessionLocal()
        try:
            yield db
        finally:
            db.close()

    test_app = FastAPI()
    test_app.include_router(agents.router)
    test_app.dependency_overrides[get_db] = override_get_db
    test_app.dependency_overrides[agents.get_current_user] = lambda: {
        "id": 1,
        "address": "0x0000000000000000000000000000000000000001",
    }
    monkeypatch.setattr(agents, "validate_endpoint_url", fake_validate_endpoint_url)

    response = TestClient(test_app).post(
        "/agents/",
        json={"name": "agent", "endpoint": "https://agent.example/raw"},
    )

    assert response.status_code == 200
    assert response.json()["endpoint"] == "https://agent.example/raw/"
    db = TestingSessionLocal()
    stored = db.query(Agent).one()
    assert stored.endpoint == "https://agent.example/raw/"
    db.close()
