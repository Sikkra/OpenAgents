import importlib
import json
import os
from datetime import datetime
from types import SimpleNamespace

os.environ.setdefault("JWT_SECRET", "test-secret")


class FakeQuery:
    def __init__(self, rows):
        self.rows = rows

    def filter(self, *args):
        return self

    def all(self):
        return self.rows


class FakeDB:
    def __init__(self, subscriptions):
        self.subscriptions = subscriptions
        self.added = []
        self.commits = 0

    def query(self, model):
        return FakeQuery(self.subscriptions)

    def add(self, row):
        self.added.append(row)

    def commit(self):
        self.commits += 1


def load_webhooks():
    import api.routes.webhooks as webhooks

    return importlib.reload(webhooks)


def task(status="completed"):
    now = datetime(2026, 5, 20, 7, 20, 0)
    return SimpleNamespace(
        id=42,
        title="Ship webhook task events",
        status=status,
        creator_id=7,
        agent_id=11,
        reward_amount=5000.0,
        created_at=now,
        updated_at=now,
        deadline=None,
    )


def subscription(events):
    return SimpleNamespace(
        id=9,
        url="https://hooks.example.test/openagents",
        secret="super-secret-signing-key",
        events=events,
        active=True,
        created_at=datetime(2026, 5, 20, 7, 20, 0),
        updated_at=None,
    )


def test_hmac_signature_header_is_stable():
    webhooks = load_webhooks()
    body = b'{"event":"completed"}'

    signature = webhooks._sign_payload("super-secret-signing-key", body)

    assert signature == (
        "sha256=12d6998d37b5e41645e54fa8849112a3"
        "4333a6e5f1a1f2a377ab6425e05dc359"
    )


def test_delivery_retries_until_success_and_records_history():
    webhooks = load_webhooks()
    db = FakeDB([subscription(["completed"])])
    attempts = []

    def http_post(url, body, headers, timeout):
        attempts.append((url, body, headers, timeout))
        if len(attempts) < 3:
            return 503, "not yet"
        return 204, "ok"

    deliveries = webhooks.deliver_task_webhooks(
        db,
        task(),
        "completed",
        http_post=http_post,
        sleep=lambda seconds: None,
        backoff=(0, 0, 0, 0, 0),
    )

    assert len(deliveries) == 1
    assert len(attempts) == 3
    assert db.commits == 1
    delivery = db.added[0]
    assert delivery.status == "delivered"
    assert delivery.attempts == 3
    assert delivery.response_status == 204
    assert delivery.event_type == "completed"
    assert delivery.payload["task"]["id"] == 42
    assert delivery.signature.startswith("sha256=")
    sent_body = json.loads(attempts[0][1].decode("utf-8"))
    assert sent_body["event"] == "completed"
    assert attempts[0][2]["X-OpenAgents-Event"] == "completed"
    assert attempts[0][2]["X-OpenAgents-Task-Id"] == "42"


def test_delivery_skips_subscriptions_without_matching_event():
    webhooks = load_webhooks()
    db = FakeDB([subscription(["created"])])

    deliveries = webhooks.deliver_task_webhooks(
        db,
        task(),
        "completed",
        http_post=lambda *args: (_ for _ in ()).throw(AssertionError("unexpected post")),
        sleep=lambda seconds: None,
    )

    assert deliveries == []
    assert db.added == []
    assert db.commits == 0


def test_subscription_serialization_omits_secret():
    webhooks = load_webhooks()
    serialized = webhooks._serialize_subscription(subscription(["created", "completed"]))

    assert serialized["events"] == ["created", "completed"]
    assert "secret" not in serialized
