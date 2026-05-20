import importlib

from fastapi.testclient import TestClient


def load_app(monkeypatch, origins, environment="production"):
    monkeypatch.setenv("ALLOWED_ORIGINS", origins)
    monkeypatch.setenv("ENVIRONMENT", environment)
    import api.main

    return importlib.reload(api.main).app


def test_cors_preflight_allows_configured_origin(monkeypatch):
    app = load_app(monkeypatch, "https://frontend.example")
    client = TestClient(app)

    response = client.options(
        "/health",
        headers={
            "Origin": "https://frontend.example",
            "Access-Control-Request-Method": "GET",
        },
    )

    assert response.status_code == 200
    assert response.headers["access-control-allow-origin"] == "https://frontend.example"
    assert response.headers["access-control-allow-credentials"] == "true"
    assert "GET" in response.headers["access-control-allow-methods"]


def test_cors_get_allows_configured_origin(monkeypatch):
    app = load_app(monkeypatch, "https://frontend.example")
    client = TestClient(app)

    response = client.get("/health", headers={"Origin": "https://frontend.example"})

    assert response.status_code == 200
    assert response.headers["access-control-allow-origin"] == "https://frontend.example"
    assert response.headers["access-control-allow-credentials"] == "true"


def test_wildcard_only_allowed_in_development(monkeypatch):
    prod_app = load_app(monkeypatch, "*", "production")
    prod_client = TestClient(prod_app)
    prod_response = prod_client.get("/health", headers={"Origin": "https://frontend.example"})
    assert "access-control-allow-origin" not in prod_response.headers

    dev_app = load_app(monkeypatch, "*", "development")
    dev_client = TestClient(dev_app)
    dev_response = dev_client.get("/health", headers={"Origin": "https://frontend.example"})
    assert dev_response.headers["access-control-allow-origin"] == "https://frontend.example"
