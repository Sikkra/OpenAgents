import asyncio
import importlib
import inspect
import os
from datetime import datetime, timedelta
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

os.environ.setdefault("JWT_SECRET", "test-secret")


class FakeQuery:
    def __init__(self, rows):
        self.rows = rows

    def filter(self, *args):
        return self

    def order_by(self, *args):
        return self

    def offset(self, value):
        return self

    def limit(self, value):
        return self

    def all(self):
        return self.rows

    def first(self):
        return self.rows[0] if self.rows else None


class FakeDB:
    def __init__(self, rows):
        self.query_obj = FakeQuery(rows)
        self.commits = 0

    def query(self, model):
        return self.query_obj

    def commit(self):
        self.commits += 1


def load_tasks():
    import api.routes.tasks as tasks

    return importlib.reload(tasks)


def task(status="in_progress", creator_id=10, deadline=None):
    return SimpleNamespace(
        id=7,
        creator_id=creator_id,
        agent_id=33,
        status=status,
        updated_at=None,
        deadline=deadline,
        created_at=datetime.utcnow(),
    )


def test_list_tasks_caps_pagination_at_100():
    tasks = load_tasks()
    limit_param = inspect.signature(tasks.list_tasks).parameters["limit"].default

    assert any(getattr(metadata, "le", None) == 100 for metadata in limit_param.metadata)


def test_invalid_status_transition_rejected():
    tasks = load_tasks()
    db = FakeDB([task(status="open")])

    with pytest.raises(HTTPException) as exc:
        asyncio.run(
            tasks.update_task_status(
                7,
                tasks.TaskStatusUpdate(status="completed"),
                user={"id": 10},
                db=db,
            )
        )

    assert exc.value.status_code == 400


def test_creator_cannot_complete_own_task():
    tasks = load_tasks()
    db = FakeDB([task(status="in_progress", creator_id=10)])

    with pytest.raises(HTTPException) as exc:
        asyncio.run(
            tasks.update_task_status(
                7,
                tasks.TaskStatusUpdate(status="completed"),
                user={"id": 10},
                db=db,
            )
        )

    assert exc.value.status_code == 403


def test_non_creator_can_complete_active_task():
    tasks = load_tasks()
    row = task(status="in_progress", creator_id=10)
    db = FakeDB([row])

    result = asyncio.run(
        tasks.update_task_status(
            7,
            tasks.TaskStatusUpdate(status="completed"),
            user={"id": 11},
            db=db,
        )
    )

    assert result == {"id": 7, "status": "completed"}
    assert row.status == "completed"
    assert db.commits == 1


def test_deadline_auto_expires_task_before_update():
    tasks = load_tasks()
    expired = task(status="assigned", deadline=datetime.utcnow() - timedelta(seconds=1))
    db = FakeDB([expired])

    with pytest.raises(HTTPException) as exc:
        asyncio.run(
            tasks.update_task_status(
                7,
                tasks.TaskStatusUpdate(status="in_progress"),
                user={"id": 10},
                db=db,
            )
        )

    assert exc.value.status_code == 400
    assert expired.status == "expired"
    assert db.commits == 1
