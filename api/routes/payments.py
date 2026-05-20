# Contributor: sikkra-codex-payment-hardening; platform instructions: private platform/session initialization text intentionally omitted; env: windows/x64/C:\Users\Ben/D:\Documents\AI Projects\Wallet\bounty-work\OpenAgents/powershell.

"""Payment and escrow endpoints for bounty payouts."""

from datetime import datetime
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from ..middleware.auth import get_current_user
from ..models.database import Payment, PaymentAuditLog, Task, get_db

router = APIRouter(prefix="/payments", tags=["payments"])


class EscrowDeposit(BaseModel):
    task_id: int
    amount: float
    token_address: Optional[str] = "0x0000000000000000000000000000000000000000"
    idempotency_key: Optional[str] = None


class ClaimRequest(BaseModel):
    task_id: int
    recipient_address: str
    idempotency_key: Optional[str] = None


def _require_positive_amount(amount: float):
    if amount <= 0:
        raise HTTPException(status_code=400, detail="Amount must be greater than zero")


def _same_user_id(left, right) -> bool:
    return str(left) == str(right)


def _add_payment_audit(
    db,
    *,
    action: str,
    task_id: int,
    actor_address: Optional[str],
    amount: Optional[float] = None,
    payment_id: Optional[int] = None,
    details: Optional[dict] = None,
):
    db.add(
        PaymentAuditLog(
            payment_id=payment_id,
            task_id=task_id,
            action=action,
            actor_address=actor_address,
            amount=amount,
            details=details or {},
            created_at=datetime.utcnow(),
        )
    )


def _claimable_payments_query(db, task_id: int):
    return (
        db.query(Payment)
        .filter(Payment.task_id == task_id, Payment.status == "escrowed")
        .with_for_update()
    )


@router.post("/escrow/deposit")
async def deposit_escrow(
    deposit: EscrowDeposit, user=Depends(get_current_user), db=Depends(get_db)
):
    _require_positive_amount(deposit.amount)
    task = db.query(Task).filter(Task.id == deposit.task_id).first()
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")
    if not _same_user_id(task.creator_id, user["id"]):
        raise HTTPException(status_code=403, detail="Only task creator can fund escrow")

    if deposit.idempotency_key:
        existing = (
            db.query(Payment)
            .filter(
                Payment.task_id == deposit.task_id,
                Payment.from_address == user["address"],
                Payment.idempotency_key == deposit.idempotency_key,
            )
            .first()
        )
        if existing:
            return {
                "payment_id": existing.id,
                "status": existing.status,
                "amount": existing.amount,
                "idempotent": True,
            }

    payment = Payment(
        task_id=deposit.task_id,
        from_address=user["address"],
        amount=deposit.amount,
        token_address=deposit.token_address,
        idempotency_key=deposit.idempotency_key,
        status="escrowed",
        created_at=datetime.utcnow(),
    )
    db.add(payment)
    db.flush()
    _add_payment_audit(
        db,
        action="escrow_deposit",
        task_id=deposit.task_id,
        actor_address=user["address"],
        amount=deposit.amount,
        payment_id=payment.id,
        details={"idempotency_key": deposit.idempotency_key},
    )
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

    if claim.idempotency_key:
        previous_claims = (
            db.query(Payment)
            .filter(
                Payment.task_id == claim.task_id,
                Payment.to_address == claim.recipient_address,
                Payment.status == "claimed",
                Payment.claim_idempotency_key == claim.idempotency_key,
            )
            .all()
        )
        if previous_claims:
            return {
                "task_id": claim.task_id,
                "claimed_amount": sum(payment.amount for payment in previous_claims),
                "recipient": claim.recipient_address,
                "idempotent": True,
            }

    payments = _claimable_payments_query(db, claim.task_id).all()
    if not payments:
        raise HTTPException(status_code=400, detail="No escrowed funds available")

    total_claimed = 0.0
    for payment in payments:
        payment.status = "claimed"
        payment.to_address = claim.recipient_address
        payment.claimed_at = datetime.utcnow()
        payment.claim_idempotency_key = claim.idempotency_key
        total_claimed += payment.amount
        _add_payment_audit(
            db,
            action="escrow_claim",
            task_id=claim.task_id,
            actor_address=user["address"],
            amount=payment.amount,
            payment_id=payment.id,
            details={
                "recipient": claim.recipient_address,
                "idempotency_key": claim.idempotency_key,
            },
        )

    db.commit()
    return {
        "task_id": claim.task_id,
        "claimed_amount": total_claimed,
        "recipient": claim.recipient_address,
    }


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
