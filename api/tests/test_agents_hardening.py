import asyncio
import importlib
import inspect
import os
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

os.environ.setdefault("JWT_SECRET", "test-secret")


class FakeQuery:
    def __init__(self, rows):
        self.rows = rows
        self.offset_value = None
        self.limit_value = None

    def filter(self, *args):
        return self

    def first(self):
        return self.rows[0] if self.rows else None

    def offset(self, value):
        self.offset_value = value
        return self

    def limit(self, value):
        self.limit_value = value
        return self

    def all(self):
        return self.rows


class FakeDB:
    def __init__(self, rows=None):
        self.query_obj = FakeQuery(rows or [])
        self.deleted = []
        self.commits = 0

    def query(self, model):
        return self.query_obj

    def delete(self, row):
        self.deleted.append(row)

    def commit(self):
        self.commits += 1


def load_agents():
    import api.routes.agents as agents

    return importlib.reload(agents)


def test_agent_name_validation_rejects_special_characters():
    agents = load_agents()

    assert agents._validate_agent_name("Agent007") == "Agent007"
    with pytest.raises(HTTPException) as exc:
        agents._validate_agent_name("Agent<script>")

    assert exc.value.status_code == 400


def test_list_agents_caps_pagination_at_100():
    agents = load_agents()
    limit_param = inspect.signature(agents.list_agents).parameters["limit"].default

    assert any(getattr(metadata, "le", None) == 100 for metadata in limit_param.metadata)


def test_delete_agent_requires_owner():
    agents = load_agents()
    db = FakeDB([SimpleNamespace(id=1, owner_id=10)])

    with pytest.raises(HTTPException) as exc:
        asyncio.run(agents.delete_agent(1, user={"id": 11}, db=db))

    assert exc.value.status_code == 403
    assert db.deleted == []


def test_delete_agent_deletes_for_owner():
    agents = load_agents()
    agent = SimpleNamespace(id=1, owner_id=10)
    db = FakeDB([agent])

    result = asyncio.run(agents.delete_agent(1, user={"id": "10"}, db=db))

    assert result == {"deleted": True}
    assert db.deleted == [agent]
    assert db.commits == 1


def test_update_agent_revalidates_name():
    agents = load_agents()
    db = FakeDB([SimpleNamespace(id=1, owner_id=10, name="AgentOne")])

    with pytest.raises(HTTPException) as exc:
        asyncio.run(
            agents.update_agent(
                1,
                agents.AgentUpdate(name="bad name"),
                user={"id": 10},
                db=db,
            )
        )

    assert exc.value.status_code == 400
