import importlib
import time

from fastapi.testclient import TestClient


def load_main(monkeypatch):
    monkeypatch.delenv("OPENAGENTS_RPC_URL", raising=False)
    monkeypatch.delenv("RPC_URL", raising=False)
    monkeypatch.delenv("WEB3_PROVIDER_URI", raising=False)

    import api.main as main

    module = importlib.reload(main)
    module._health_cache.update({"expires_at": 0.0, "payload": None, "status_code": 200})
    return module


def install_healthy_checks(monkeypatch, main):
    calls = {"db": 0, "rpc": 0, "disk": 0, "memory": 0}

    def check(name):
        def inner():
            calls[name] += 1
            return {"status": "healthy", "details": {"component": name}}

        return inner

    monkeypatch.setattr(main, "_check_db", check("db"))
    monkeypatch.setattr(main, "_check_rpc", check("rpc"))
    monkeypatch.setattr(main, "_check_disk", check("disk"))
    monkeypatch.setattr(main, "_check_memory", check("memory"))
    return calls


def test_health_reports_component_status_and_latency(monkeypatch):
    main = load_main(monkeypatch)
    install_healthy_checks(monkeypatch, main)
    client = TestClient(main.app)

    started = time.perf_counter()
    response = client.get("/health")
    elapsed = time.perf_counter() - started

    assert response.status_code == 200
    assert response.headers["cache-control"] == "public, max-age=10"
    assert elapsed < 5
    body = response.json()
    assert body["status"] == "healthy"
    assert body["cached"] is False
    assert set(body["components"]) == {"db", "rpc", "disk", "memory"}
    for component in body["components"].values():
        assert component["status"] == "healthy"
        assert isinstance(component["latency_ms"], (int, float))
        assert component["latency_ms"] >= 0


def test_health_response_is_cached_for_ten_seconds(monkeypatch):
    main = load_main(monkeypatch)
    calls = install_healthy_checks(monkeypatch, main)
    client = TestClient(main.app)

    first = client.get("/health")
    second = client.get("/health")

    assert first.status_code == 200
    assert second.status_code == 200
    assert first.json()["cached"] is False
    assert second.json()["cached"] is True
    assert first.json()["timestamp"] == second.json()["timestamp"]
    assert calls == {"db": 1, "rpc": 1, "disk": 1, "memory": 1}


def test_unhealthy_component_returns_503(monkeypatch):
    main = load_main(monkeypatch)
    install_healthy_checks(monkeypatch, main)

    def unhealthy_disk():
        return {"status": "unhealthy", "details": {"free_bytes": 0}}

    monkeypatch.setattr(main, "_check_disk", unhealthy_disk)
    client = TestClient(main.app)

    response = client.get("/health")

    assert response.status_code == 503
    body = response.json()
    assert body["status"] == "unhealthy"
    assert body["components"]["disk"]["status"] == "unhealthy"


def test_rpc_component_is_present_when_not_configured(monkeypatch):
    main = load_main(monkeypatch)
    monkeypatch.setattr(main, "_check_db", lambda: {"status": "healthy", "details": {}})
    monkeypatch.setattr(main, "_check_disk", lambda: {"status": "healthy", "details": {}})
    monkeypatch.setattr(main, "_check_memory", lambda: {"status": "healthy", "details": {}})

    response = TestClient(main.app).get("/health")

    assert response.json()["components"]["rpc"]["details"]["configured"] is False
