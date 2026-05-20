import os

os.environ.setdefault("JWT_SECRET", "test-secret")

from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from api.models.database import Base, Payment, Task, User
from api.routes import payments


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
    app.include_router(payments.router)
    app.dependency_overrides[payments.get_db] = override_db
    app.dependency_overrides[payments.get_current_user] = override_user
    return TestClient(app), TestingSessionLocal


def seed_task(SessionLocal, status="open"):
    db = SessionLocal()
    try:
        creator = User(id=1, address="0x1111111111111111111111111111111111111111")
        worker = User(id=2, address="0x2222222222222222222222222222222222222222")
        task = Task(
            id=50,
            title="Escrow fix",
            description="Patch claim safety",
            reward_amount=100.0,
            creator_id=creator.id,
            status=status,
        )
        db.add_all([creator, worker, task])
        db.commit()
    finally:
        db.close()


def test_deposit_rejects_non_positive_amount(tmp_path):
    client, SessionLocal = make_client(
        tmp_path,
        {"id": 1, "address": "0x1111111111111111111111111111111111111111"},
    )
    seed_task(SessionLocal)

    response = client.post("/payments/escrow/deposit", json={"task_id": 50, "amount": 0})

    assert response.status_code == 422


def test_deposit_idempotency_key_reuses_existing_payment(tmp_path):
    client, SessionLocal = make_client(
        tmp_path,
        {"id": 1, "address": "0x1111111111111111111111111111111111111111"},
    )
    seed_task(SessionLocal)
    payload = {"task_id": 50, "amount": 12.5, "idempotency_key": "deposit-50-a"}

    first = client.post("/payments/escrow/deposit", json=payload)
    second = client.post("/payments/escrow/deposit", json=payload)

    assert first.status_code == 200
    assert second.status_code == 200
    assert second.json()["idempotent"] is True
    assert second.json()["payment_id"] == first.json()["payment_id"]

    db = SessionLocal()
    try:
        assert db.query(Payment).count() == 1
    finally:
        db.close()


def test_claim_uses_positive_escrow_once(tmp_path):
    client, SessionLocal = make_client(
        tmp_path,
        {"id": 2, "address": "0x2222222222222222222222222222222222222222"},
    )
    seed_task(SessionLocal, status="completed")
    db = SessionLocal()
    try:
        db.add(
            Payment(
                task_id=50,
                from_address="0x1111111111111111111111111111111111111111",
                amount=8.0,
                status="escrowed",
            )
        )
        db.commit()
    finally:
        db.close()

    first = client.post(
        "/payments/claim",
        json={"task_id": 50, "recipient_address": "0x2222222222222222222222222222222222222222"},
    )
    second = client.post(
        "/payments/claim",
        json={"task_id": 50, "recipient_address": "0x2222222222222222222222222222222222222222"},
    )

    assert first.status_code == 200
    assert first.json()["claimed_amount"] == 8.0
    assert second.status_code == 400
    assert second.json()["detail"] == "No escrowed funds available"
