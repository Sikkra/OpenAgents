"""Payment and escrow endpoints for bounty payouts."""

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from typing import Optional
from datetime import datetime, timedelta, timezone

from ..models.database import get_db, Payment, PaymentRefundLog, Task
from ..middleware.auth import get_current_user

router = APIRouter(prefix="/payments", tags=["payments"])
AUTO_REFUND_GRACE_PERIOD = timedelta(days=30)


def utc_now() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def escrow_expired_at(payment: Payment, task: Optional[Task] = None) -> datetime:
    release_time = payment.release_time or (task.deadline if task else None) or payment.created_at
    return payment.expired_at or (release_time + AUTO_REFUND_GRACE_PERIOD)


class EscrowDeposit(BaseModel):
    task_id: int
    # BUG: Amount is not validated as positive - negative or zero deposits
    # could corrupt escrow balances or drain funds
    amount: float
    token_address: Optional[str] = "0x0000000000000000000000000000000000000000"


class ClaimRequest(BaseModel):
    task_id: int
    recipient_address: str


@router.post("/escrow/deposit")
async def deposit_escrow(
    deposit: EscrowDeposit, user=Depends(get_current_user), db=Depends(get_db)
):
    task = db.query(Task).filter(Task.id == deposit.task_id).first()
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")
    if task.creator_id != user["id"]:
        raise HTTPException(status_code=403, detail="Only task creator can fund escrow")

    # BUG: No idempotency key - retried requests create duplicate escrow entries,
    # locking more funds than intended
    now = utc_now()
    release_time = task.deadline or now
    payment = Payment(
        task_id=deposit.task_id,
        from_address=user["address"],
        amount=deposit.amount,
        token_address=deposit.token_address,
        status="escrowed",
        created_at=now,
        release_time=release_time,
        expired_at=release_time + AUTO_REFUND_GRACE_PERIOD,
    )
    db.add(payment)
    db.commit()
    db.refresh(payment)
    return {"payment_id": payment.id, "status": "escrowed", "amount": payment.amount}


@router.get("/escrow/{task_id}")
async def get_escrow_balance(task_id: int, db=Depends(get_db)):
    payments = db.query(Payment).filter(
        Payment.task_id == task_id, Payment.status == "escrowed"
    ).all()
    total = sum(p.amount for p in payments)
    return {"task_id": task_id, "escrowed_total": total, "deposits": len(payments)}


@router.post("/claim")
async def claim_payment(
    claim: ClaimRequest, user=Depends(get_current_user), db=Depends(get_db)
):
    task = db.query(Task).filter(Task.id == claim.task_id).first()
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")
    if task.status != "completed":
        raise HTTPException(status_code=400, detail="Task not yet completed")

    # BUG: Race condition - two concurrent claims can both read status="escrowed"
    # before either updates it, causing a double-payout
    payments = db.query(Payment).filter(
        Payment.task_id == claim.task_id, Payment.status == "escrowed"
    ).all()

    if not payments:
        raise HTTPException(status_code=400, detail="No escrowed funds available")

    total_claimed = 0.0
    for payment in payments:
        payment.status = "claimed"
        payment.to_address = claim.recipient_address
        payment.claimed_at = utc_now()
        total_claimed += payment.amount

    db.commit()
    return {
        "task_id": claim.task_id,
        "claimed_amount": total_claimed,
        "recipient": claim.recipient_address,
    }


@router.post("/process-expired")
async def process_expired_escrows(user=Depends(get_current_user), db=Depends(get_db)):
    now = utc_now()
    payments = db.query(Payment).filter(Payment.status == "escrowed").all()
    refunded = []

    for payment in payments:
        task = db.query(Task).filter(Task.id == payment.task_id).first()
        expired_at = escrow_expired_at(payment, task)
        if expired_at > now:
            continue

        payment.status = "refunded"
        payment.to_address = payment.from_address
        payment.refunded_at = now
        payment.expired_at = expired_at

        log = PaymentRefundLog(
            payment_id=payment.id,
            task_id=payment.task_id,
            amount=payment.amount,
            refunded_to=payment.from_address,
            reason="expired",
            created_at=now,
        )
        db.add(log)
        refunded.append({
            "payment_id": payment.id,
            "task_id": payment.task_id,
            "amount": payment.amount,
            "refunded_to": payment.from_address,
            "refunded_at": now.isoformat(),
            "expired_at": expired_at.isoformat(),
        })

    db.commit()
    return {"processed": len(payments), "refunded": len(refunded), "refunds": refunded}


@router.get("/history")
async def payment_history(
    user=Depends(get_current_user),
    db=Depends(get_db),
):
    sent = db.query(Payment).filter(Payment.from_address == user["address"]).all()
    received = db.query(Payment).filter(Payment.to_address == user["address"]).all()
    return {
        "sent": [{"id": p.id, "amount": p.amount, "status": p.status} for p in sent],
        "received": [{"id": p.id, "amount": p.amount, "status": p.status} for p in received],
    }
