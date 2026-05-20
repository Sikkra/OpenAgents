import os

os.environ.setdefault("JWT_SECRET", "test-secret")

from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from api.models.database import Agent, Base, Task, User
from api.routes import tasks


def make_client(tmp_path, current_user):
    database_url = f"sqlite:///{tmp_path / 'test.db'}"
    engine = create_engine(database_url, connect_args={"check_same_thread": False})
    TestingSessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
    Base.metadata.create_all(bind=engine)

    def override_db():
        db = TestingSessionLocal()
        try:
            yield db
        finally:
            db.close()

    async def override_user():
        return current_user

    app = FastAPI()
    app.include_router(tasks.router)
    app.dependency_overrides[tasks.get_db] = override_db
    app.dependency_overrides[tasks.get_current_user] = override_user
    return TestClient(app), TestingSessionLocal


def seed_task(SessionLocal, status="review"):
    db = SessionLocal()
    try:
        creator = User(id=1, address="0x1111111111111111111111111111111111111111")
        worker = User(id=2, address="0x2222222222222222222222222222222222222222")
        agent = Agent(id=7, name="Worker", owner_id=worker.id)
        task = Task(
            id=42,
            title="Fix route",
            description="Patch task status authorization",
            reward_amount=100.0,
            creator_id=creator.id,
            agent_id=agent.id,
            status=status,
        )
        db.add_all([creator, worker, agent, task])
        db.commit()
    finally:
        db.close()


def test_creator_cannot_complete_own_task(tmp_path):
    client, SessionLocal = make_client(tmp_path, {"id": 1, "address": "0x1"})
    seed_task(SessionLocal)

    response = client.patch("/tasks/42/status", json={"status": "completed"})

    assert response.status_code == 403
    assert response.json()["detail"] == "Task creator cannot complete their own task"


def test_assigned_agent_owner_can_complete_review_task(tmp_path):
    client, SessionLocal = make_client(tmp_path, {"id": 2, "address": "0x2"})
    seed_task(SessionLocal)

    response = client.patch("/tasks/42/status", json={"status": "completed"})

    assert response.status_code == 200
    assert response.json() == {"id": 42, "status": "completed"}


def test_invalid_status_is_rejected(tmp_path):
    client, SessionLocal = make_client(tmp_path, {"id": 1, "address": "0x1"})
    seed_task(SessionLocal)

    response = client.patch("/tasks/42/status", json={"status": "paid"})

    assert response.status_code == 422


def test_invalid_transition_is_rejected(tmp_path):
    client, SessionLocal = make_client(tmp_path, {"id": 1, "address": "0x1"})
    seed_task(SessionLocal, status="open")

    response = client.patch("/tasks/42/status", json={"status": "review"})

    assert response.status_code == 400
    assert response.json()["detail"] == "Cannot transition task from open to review"


def test_list_limit_is_capped_at_100(tmp_path):
    client, SessionLocal = make_client(tmp_path, {"id": 1, "address": "0x1"})
    seed_task(SessionLocal)

    response = client.get("/tasks/?limit=101")

    assert response.status_code == 422
