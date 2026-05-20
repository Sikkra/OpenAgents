import os

os.environ.setdefault("JWT_SECRET", "test-secret")

from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.routes import tasks as task_routes


def build_test_client():
    task_routes.task_ws_manager.active_connections.clear()
    app = FastAPI()
    app.include_router(task_routes.router)

    @app.post("/emit/{task_id}")
    async def emit(task_id: int):
        await task_routes.task_ws_manager.broadcast_task_update(
            task_id,
            {"id": task_id, "status": "completed"},
        )
        return {"ok": True}

    @app.get("/subscription-counts")
    async def subscription_counts():
        return task_routes.task_ws_manager.subscription_counts()

    return TestClient(app)


def test_websocket_subscribe_and_receive_task_update():
    client = build_test_client()

    with client.websocket_connect("/tasks/ws") as websocket:
        websocket.send_json({"action": "subscribe", "task_id": 7})
        assert websocket.receive_json() == {"type": "subscribed", "task_id": 7}

        response = client.post("/emit/7")
        assert response.status_code == 200

        message = websocket.receive_json()
        assert message["type"] == "task_update"
        assert message["task_id"] == 7
        assert message["task"]["status"] == "completed"


def test_websocket_unsubscribe_removes_task_subscription():
    client = build_test_client()

    with client.websocket_connect("/tasks/ws") as websocket:
        websocket.send_json({"action": "subscribe", "task_id": 7})
        assert websocket.receive_json()["type"] == "subscribed"
        assert client.get("/subscription-counts").json() == [1]

        websocket.send_json({"action": "unsubscribe", "task_id": 7})
        assert websocket.receive_json() == {"type": "unsubscribed", "task_id": 7}
        assert client.get("/subscription-counts").json() == [0]


def test_websocket_sends_heartbeat_and_cleans_up_disconnects():
    client = build_test_client()
    previous_interval = task_routes.HEARTBEAT_INTERVAL_SECONDS
    task_routes.HEARTBEAT_INTERVAL_SECONDS = 0.01
    try:
        with client.websocket_connect("/tasks/ws") as websocket:
            message = websocket.receive_json()
            assert message["type"] == "heartbeat"
            assert client.get("/subscription-counts").json() == [None]
    finally:
        task_routes.HEARTBEAT_INTERVAL_SECONDS = previous_interval

    assert task_routes.task_ws_manager.subscription_counts() == []
