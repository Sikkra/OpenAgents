from datetime import datetime, timedelta, timezone

from fastapi.testclient import TestClient

from api.main import agents_cache, app


client = TestClient(app)


def utcnow():
    return datetime.now(timezone.utc).replace(tzinfo=None)


def setup_function():
    agents_cache.clear()


def seed_agent(agent_id: str, name: str = "Agent", reputation: int = 500):
    agents_cache[agent_id] = {
        "agent_id": agent_id,
        "name": name,
        "owner": "0xowner",
        "endpoint": "https://example.com/agent",
        "reputation": reputation,
        "tasks_completed": 0,
        "registered_at": utcnow(),
        "active": True,
    }
    return agents_cache[agent_id]


def test_completion_increases_reputation():
    seed_agent("agent-1")

    response = client.post(
        "/agents/agent-1/reputation",
        json={"outcome": "completion", "completion_seconds": 1800},
    )

    assert response.status_code == 200
    body = response.json()
    assert body["reputation"] > 500
    assert body["tasks_completed"] == 1


def test_dispute_decreases_reputation_after_success():
    seed_agent("agent-1")

    first = client.post(
        "/agents/agent-1/reputation",
        json={"outcome": "completion", "completion_seconds": 1800},
    )
    second = client.post("/agents/agent-1/reputation", json={"outcome": "dispute"})

    assert first.status_code == 200
    assert second.status_code == 200
    assert second.json()["reputation"] < first.json()["reputation"]


def test_weekly_decay_applies_to_inactive_agents():
    agent = seed_agent("agent-1")
    agent["reputation_metrics"] = {
        "successful_tasks": 10,
        "disputed_tasks": 0,
        "average_completion_seconds": 1800,
        "last_activity_at": utcnow() - timedelta(days=14),
    }

    response = client.get("/leaderboard")

    assert response.status_code == 200
    assert response.json()[0]["reputation"] == 980


def test_leaderboard_sorts_by_reputation_and_success_rate():
    slower = seed_agent("agent-low", name="Slow")
    slower["reputation_metrics"] = {
        "successful_tasks": 2,
        "disputed_tasks": 2,
        "average_completion_seconds": 7200,
        "last_activity_at": utcnow(),
    }
    faster = seed_agent("agent-high", name="Fast")
    faster["reputation_metrics"] = {
        "successful_tasks": 3,
        "disputed_tasks": 0,
        "average_completion_seconds": 1800,
        "last_activity_at": utcnow(),
    }

    response = client.get("/leaderboard")

    assert response.status_code == 200
    body = response.json()
    assert body[0]["agent_id"] == "agent-high"
    assert body[0]["success_rate"] == 1.0
    assert 0 <= body[0]["reputation"] <= 1000


def test_unknown_agent_reputation_event_returns_404():
    response = client.post("/agents/missing/reputation", json={"outcome": "completion"})

    assert response.status_code == 404
