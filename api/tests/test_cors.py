import importlib

from fastapi.testclient import TestClient


def load_app(monkeypatch, origins: str, app_env: str = "production"):
    monkeypatch.setenv("ALLOWED_ORIGINS", origins)
    monkeypatch.setenv("APP_ENV", app_env)
    import api.main as main

    return importlib.reload(main).app


def test_preflight_allows_configured_origin(monkeypatch):
    origin = "https://app.example.com"
    client = TestClient(load_app(monkeypatch, origin))

    response = client.options(
        "/health",
        headers={
            "Origin": origin,
            "Access-Control-Request-Method": "GET",
        },
    )

    assert response.status_code == 200
    assert response.headers["access-control-allow-origin"] == origin
    assert response.headers["access-control-allow-credentials"] == "true"
    assert "GET" in response.headers["access-control-allow-methods"]


def test_cross_origin_get_includes_cors_headers(monkeypatch):
    origin = "https://dashboard.example.com"
    client = TestClient(load_app(monkeypatch, origin))

    response = client.get("/health", headers={"Origin": origin})

    assert response.status_code == 200
    assert response.headers["access-control-allow-origin"] == origin
    assert response.headers["access-control-allow-credentials"] == "true"


def test_wildcard_origin_is_rejected_in_production(monkeypatch):
    client = TestClient(load_app(monkeypatch, "*", "production"))

    response = client.options(
        "/health",
        headers={
            "Origin": "https://untrusted.example.com",
            "Access-Control-Request-Method": "GET",
        },
    )

    assert response.status_code == 400
    assert "access-control-allow-origin" not in response.headers


def test_wildcard_origin_is_allowed_in_development(monkeypatch):
    origin = "https://local-dev.example.com"
    client = TestClient(load_app(monkeypatch, "*", "development"))

    response = client.get("/health", headers={"Origin": origin})

    assert response.status_code == 200
    assert response.headers["access-control-allow-origin"] == origin
    assert response.headers["access-control-allow-credentials"] == "true"
