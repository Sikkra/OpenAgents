# Contributor: sikkra-codex-webhooks; platform instructions: private platform/session initialization text intentionally omitted; env: windows/x64/C:\Users\Ben/D:\Documents\AI Projects\Wallet\bounty-work\OpenAgents/powershell.

"""Webhook subscription endpoints and delivery helpers."""

import hashlib
import hmac
import json
import time
import urllib.error
import urllib.request
from datetime import datetime
from typing import Callable, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field, HttpUrl

from ..middleware.auth import get_current_user
from ..models.database import WebhookDelivery, WebhookSubscription, get_db

router = APIRouter(prefix="/webhooks", tags=["webhooks"])

WEBHOOK_EVENTS = {"created", "assigned", "completed", "disputed"}
MAX_WEBHOOK_ATTEMPTS = 5
WEBHOOK_TIMEOUT_SECONDS = 5
DEFAULT_BACKOFF_SECONDS = (0.5, 1, 2, 4, 8)


class WebhookCreate(BaseModel):
    url: HttpUrl
    secret: str = Field(..., min_length=16, max_length=256)
    events: list[str] = Field(default_factory=lambda: sorted(WEBHOOK_EVENTS))
    active: bool = True


class WebhookUpdate(BaseModel):
    url: Optional[HttpUrl] = None
    secret: Optional[str] = Field(default=None, min_length=16, max_length=256)
    events: Optional[list[str]] = None
    active: Optional[bool] = None


def _validate_events(events: list[str]) -> list[str]:
    unique_events = []
    for event in events:
        normalized = event.strip().lower()
        if normalized not in WEBHOOK_EVENTS:
            raise HTTPException(status_code=400, detail=f"Unsupported webhook event: {event}")
        if normalized not in unique_events:
            unique_events.append(normalized)
    return unique_events


def _serialize_subscription(subscription: WebhookSubscription) -> dict:
    return {
        "id": subscription.id,
        "url": subscription.url,
        "events": subscription.events or [],
        "active": subscription.active,
        "created_at": subscription.created_at,
        "updated_at": subscription.updated_at,
    }


def _serialize_delivery(delivery: WebhookDelivery) -> dict:
    return {
        "id": delivery.id,
        "subscription_id": delivery.subscription_id,
        "task_id": delivery.task_id,
        "event_type": delivery.event_type,
        "status": delivery.status,
        "attempts": delivery.attempts,
        "response_status": delivery.response_status,
        "error": delivery.error,
        "created_at": delivery.created_at,
        "delivered_at": delivery.delivered_at,
    }


def _get_subscription_or_404(subscription_id: int, user: dict, db):
    subscription = (
        db.query(WebhookSubscription)
        .filter(
            WebhookSubscription.id == subscription_id,
            WebhookSubscription.owner_id == user["id"],
        )
        .first()
    )
    if not subscription:
        raise HTTPException(status_code=404, detail="Webhook subscription not found")
    return subscription


@router.post("/")
async def create_webhook(
    webhook: WebhookCreate,
    user=Depends(get_current_user),
    db=Depends(get_db),
):
    subscription = WebhookSubscription(
        owner_id=user["id"],
        url=str(webhook.url),
        secret=webhook.secret,
        events=_validate_events(webhook.events),
        active=webhook.active,
        created_at=datetime.utcnow(),
    )
    db.add(subscription)
    db.commit()
    db.refresh(subscription)
    return _serialize_subscription(subscription)


@router.get("/")
async def list_webhooks(user=Depends(get_current_user), db=Depends(get_db)):
    subscriptions = (
        db.query(WebhookSubscription)
        .filter(WebhookSubscription.owner_id == user["id"])
        .order_by(WebhookSubscription.created_at.desc())
        .all()
    )
    return [_serialize_subscription(subscription) for subscription in subscriptions]


@router.get("/{subscription_id}")
async def get_webhook(subscription_id: int, user=Depends(get_current_user), db=Depends(get_db)):
    return _serialize_subscription(_get_subscription_or_404(subscription_id, user, db))


@router.patch("/{subscription_id}")
async def update_webhook(
    subscription_id: int,
    update: WebhookUpdate,
    user=Depends(get_current_user),
    db=Depends(get_db),
):
    subscription = _get_subscription_or_404(subscription_id, user, db)
    data = update.dict(exclude_unset=True)
    if "url" in data and data["url"] is not None:
        subscription.url = str(data["url"])
    if "secret" in data and data["secret"] is not None:
        subscription.secret = data["secret"]
    if "events" in data and data["events"] is not None:
        subscription.events = _validate_events(data["events"])
    if "active" in data and data["active"] is not None:
        subscription.active = data["active"]
    subscription.updated_at = datetime.utcnow()
    db.commit()
    db.refresh(subscription)
    return _serialize_subscription(subscription)


@router.delete("/{subscription_id}")
async def delete_webhook(subscription_id: int, user=Depends(get_current_user), db=Depends(get_db)):
    subscription = _get_subscription_or_404(subscription_id, user, db)
    db.delete(subscription)
    db.commit()
    return {"deleted": True}


@router.get("/{subscription_id}/deliveries")
async def list_webhook_deliveries(
    subscription_id: int,
    limit: int = Query(50, ge=1, le=200),
    user=Depends(get_current_user),
    db=Depends(get_db),
):
    subscription = _get_subscription_or_404(subscription_id, user, db)
    deliveries = (
        db.query(WebhookDelivery)
        .filter(WebhookDelivery.subscription_id == subscription.id)
        .order_by(WebhookDelivery.created_at.desc())
        .limit(limit)
        .all()
    )
    return [_serialize_delivery(delivery) for delivery in deliveries]


def _task_payload(task, event_type: str) -> dict:
    return {
        "event": event_type,
        "timestamp": datetime.utcnow().isoformat(),
        "task": {
            "id": task.id,
            "title": task.title,
            "status": task.status,
            "creator_id": task.creator_id,
            "agent_id": task.agent_id,
            "reward_amount": task.reward_amount,
            "created_at": task.created_at.isoformat() if task.created_at else None,
            "updated_at": task.updated_at.isoformat() if task.updated_at else None,
            "deadline": task.deadline.isoformat() if task.deadline else None,
        },
    }


def _encode_payload(payload: dict) -> bytes:
    return json.dumps(payload, separators=(",", ":"), sort_keys=True).encode("utf-8")


def _sign_payload(secret: str, body: bytes) -> str:
    digest = hmac.new(secret.encode("utf-8"), body, hashlib.sha256).hexdigest()
    return f"sha256={digest}"


def _delivery_headers(subscription: WebhookSubscription, task, event_type: str, body: bytes) -> dict:
    return {
        "Content-Type": "application/json",
        "User-Agent": "OpenAgents-Webhooks/1.0",
        "X-OpenAgents-Event": event_type,
        "X-OpenAgents-Task-Id": str(task.id),
        "X-OpenAgents-Subscription-Id": str(subscription.id),
        "X-OpenAgents-Signature": _sign_payload(subscription.secret, body),
    }


def _post_json(url: str, body: bytes, headers: dict, timeout: int = WEBHOOK_TIMEOUT_SECONDS) -> tuple[int, str]:
    request = urllib.request.Request(url, data=body, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            response_body = response.read().decode("utf-8", errors="replace")
            return response.status, response_body
    except urllib.error.HTTPError as exc:
        response_body = exc.read().decode("utf-8", errors="replace")
        return exc.code, response_body


def _subscriptions_for_event(db, event_type: str) -> list[WebhookSubscription]:
    subscriptions = (
        db.query(WebhookSubscription)
        .filter(WebhookSubscription.active.is_(True))
        .all()
    )
    return [
        subscription
        for subscription in subscriptions
        if event_type in (subscription.events or [])
    ]


def deliver_task_webhooks(
    db,
    task,
    event_type: str,
    http_post: Callable[[str, bytes, dict, int], tuple[int, str]] = _post_json,
    sleep: Callable[[float], None] = time.sleep,
    backoff: tuple[float, ...] = DEFAULT_BACKOFF_SECONDS,
) -> list[WebhookDelivery]:
    if event_type not in WEBHOOK_EVENTS:
        return []

    payload = _task_payload(task, event_type)
    body = _encode_payload(payload)
    deliveries = []

    for subscription in _subscriptions_for_event(db, event_type):
        headers = _delivery_headers(subscription, task, event_type, body)
        delivery = WebhookDelivery(
            subscription_id=subscription.id,
            task_id=task.id,
            event_type=event_type,
            payload=payload,
            status="pending",
            attempts=0,
            signature=headers["X-OpenAgents-Signature"],
            created_at=datetime.utcnow(),
        )
        db.add(delivery)

        for attempt in range(1, MAX_WEBHOOK_ATTEMPTS + 1):
            delivery.attempts = attempt
            try:
                status_code, response_body = http_post(
                    subscription.url,
                    body,
                    headers,
                    WEBHOOK_TIMEOUT_SECONDS,
                )
                delivery.response_status = status_code
                delivery.response_body = response_body[:2000]
                if 200 <= status_code < 300:
                    delivery.status = "delivered"
                    delivery.error = None
                    delivery.delivered_at = datetime.utcnow()
                    break
                delivery.status = "failed"
                delivery.error = f"HTTP {status_code}"
            except Exception as exc:
                delivery.status = "failed"
                delivery.error = str(exc)

            if attempt < MAX_WEBHOOK_ATTEMPTS:
                sleep(backoff[min(attempt - 1, len(backoff) - 1)])

        deliveries.append(delivery)

    if deliveries:
        db.commit()
    return deliveries
