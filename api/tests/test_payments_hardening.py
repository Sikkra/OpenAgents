import asyncio
import importlib
import os
from datetime import datetime

import pytest
from fastapi import HTTPException
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

os.environ.setdefault("JWT_SECRET", "test-secret")


def load_modules():
    import api.models.database as database
    import api.routes.payments as payments

    return importlib.reload(database), importlib.reload(payments)


def session_with_task(status="completed"):
    database, _ = load_modules()
    engine = create_engine("sqlite:///:memory:")
    database.Base.metadata.create_all(bind=engine)
    Session = sessionmaker(bind=engine)
    db = Session()
    user = database.User(id=1, address="0xcreator")
    task = database.Task(
        id=7,
        title="Audit payment route",
        description="Serialize escrow claims",
        reward_amount=10,
        status=status,
        creator_id=1,
        created_at=datetime.utcnow(),
    )
    db.add(user)
    db.add(task)
    db.commit()
    return database, db


def test_negative_escrow_deposit_rejected():
    _, payments = load_modules()

    with pytest.raises(HTTPException) as exc:
        payments._require_positive_amount(0)

    assert exc.value.status_code == 400


def test_deposit_idempotency_prevents_duplicate_rows():
    database, payments = load_modules()
    _, db = session_with_task()
    user = {"id": 1, "address": "0xcreator"}
    deposit = payments.EscrowDeposit(task_id=7, amount=10, idempotency_key="deposit-1")

    first = asyncio.run(payments.deposit_escrow(deposit, user=user, db=db))
    second = asyncio.run(payments.deposit_escrow(deposit, user=user, db=db))

    assert first["payment_id"] == second["payment_id"]
    assert second["idempotent"] is True
    assert db.query(database.Payment).count() == 1
    assert db.query(database.PaymentAuditLog).count() == 1


def test_claim_serializes_escrow_rows_and_writes_audit_log():
    database, payments = load_modules()
    _, db = session_with_task()
    db.add(
        database.Payment(
            task_id=7,
            from_address="0xcreator",
            amount=10,
            status="escrowed",
            created_at=datetime.utcnow(),
        )
    )
    db.commit()
    claim = payments.ClaimRequest(
        task_id=7,
        recipient_address="0xworker",
        idempotency_key="claim-1",
    )

    result = asyncio.run(payments.claim_payment(claim, user={"address": "0xworker"}, db=db))
    replay = asyncio.run(payments.claim_payment(claim, user={"address": "0xworker"}, db=db))
    row = db.query(database.Payment).one()

    assert result["claimed_amount"] == 10
    assert replay["idempotent"] is True
    assert row.status == "claimed"
    assert row.to_address == "0xworker"
    assert row.claim_idempotency_key == "claim-1"
    assert db.query(database.PaymentAuditLog).count() == 1


def test_claim_query_uses_for_update_lock():
    _, payments = load_modules()

    class Query:
        def __init__(self):
            self.locked = False

        def filter(self, *args):
            return self

        def with_for_update(self):
            self.locked = True
            return self

    class DB:
        def __init__(self):
            self.query_obj = Query()

        def query(self, model):
            return self.query_obj

    db = DB()
    query = payments._claimable_payments_query(db, 7)

    assert query.locked is True
