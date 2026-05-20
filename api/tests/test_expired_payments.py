import os
from datetime import timedelta

from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

os.environ.setdefault("JWT_SECRET", "test-secret")

from api.models.database import Base, Payment, PaymentRefundLog, Task, get_db
from api.routes import payments


def build_client():
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    TestingSessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
    Base.metadata.create_all(bind=engine)

    def override_get_db():
        db = TestingSessionLocal()
        try:
            yield db
        finally:
            db.close()

    app = FastAPI()
    app.include_router(payments.router)
    app.dependency_overrides[get_db] = override_get_db
    app.dependency_overrides[payments.get_current_user] = lambda: {
        "id": 1,
        "address": "0x0000000000000000000000000000000000000001",
    }
    return TestClient(app), TestingSessionLocal


def seed_task_and_payment(SessionLocal, *, release_delta_days: int, status: str = "escrowed"):
    now = payments.utc_now()
    db = SessionLocal()
    task = Task(
        title="task",
        reward_amount=10.0,
        status="open",
        creator_id=1,
        created_at=now,
        deadline=now + timedelta(days=release_delta_days),
    )
    db.add(task)
    db.commit()
    db.refresh(task)

    release_time = now + timedelta(days=release_delta_days)
    payment = Payment(
        task_id=task.id,
        from_address="0xpayer",
        amount=10.0,
        token_address="0xtoken",
        status=status,
        created_at=now,
        release_time=release_time,
        expired_at=release_time + payments.AUTO_REFUND_GRACE_PERIOD,
    )
    db.add(payment)
    db.commit()
    db.refresh(payment)
    payment_id = payment.id
    db.close()
    return payment_id


def test_fresh_escrow_not_refunded():
    client, SessionLocal = build_client()
    payment_id = seed_task_and_payment(SessionLocal, release_delta_days=1)

    response = client.post("/payments/process-expired")

    assert response.status_code == 200
    assert response.json()["refunded"] == 0
    db = SessionLocal()
    payment = db.query(Payment).filter(Payment.id == payment_id).one()
    assert payment.status == "escrowed"
    assert db.query(PaymentRefundLog).count() == 0
    db.close()


def test_expired_escrow_refunded_and_logged():
    client, SessionLocal = build_client()
    payment_id = seed_task_and_payment(SessionLocal, release_delta_days=-31)

    response = client.post("/payments/process-expired")

    assert response.status_code == 200
    assert response.json()["processed"] == 1
    assert response.json()["refunded"] == 1
    assert response.json()["refunds"][0]["payment_id"] == payment_id

    db = SessionLocal()
    payment = db.query(Payment).filter(Payment.id == payment_id).one()
    assert payment.status == "refunded"
    assert payment.to_address == payment.from_address
    assert payment.refunded_at is not None

    log = db.query(PaymentRefundLog).one()
    assert log.payment_id == payment_id
    assert log.refunded_to == payment.from_address
    assert log.reason == "expired"
    db.close()
