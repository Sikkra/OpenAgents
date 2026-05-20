import asyncio
import os
from datetime import datetime

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from api.models.database import Agent, Base, User

os.environ.setdefault("JWT_SECRET", "test-secret")

from api.routes.agents import delete_agent, list_agents


def run(coro):
    return asyncio.run(coro)


def make_session():
    engine = create_engine("sqlite:///:memory:")
    TestingSession = sessionmaker(bind=engine)
    Base.metadata.create_all(bind=engine)
    return TestingSession()


def seed_agents(db):
    user = User(address="0x1111111111111111111111111111111111111111")
    db.add(user)
    db.commit()
    db.refresh(user)

    active = Agent(
        name="active",
        description="active agent",
        model_type="gpt-4",
        config={"platform_instructions": "must not leak"},
        owner_id=user.id,
        created_at=datetime.utcnow(),
    )
    deleted = Agent(
        name="deleted",
        description="deleted agent",
        model_type="gpt-4",
        config={"secret": "must not leak"},
        owner_id=user.id,
        created_at=datetime.utcnow(),
        deleted_at=datetime.utcnow(),
    )
    db.add_all([active, deleted])
    db.commit()
    return active, deleted


def test_default_list_filters_deleted_and_excludes_sensitive_config():
    db = make_session()
    active, _deleted = seed_agents(db)

    result = run(list_agents(include_inactive=False, skip=0, limit=50, db=db))

    assert [agent["id"] for agent in result] == [active.id]
    assert "config" not in result[0]
    assert "platform_instructions" not in result[0]


def test_include_inactive_returns_soft_deleted_agents():
    db = make_session()
    active, deleted = seed_agents(db)

    result = run(list_agents(include_inactive=True, skip=0, limit=50, db=db))

    assert [agent["id"] for agent in result] == [active.id, deleted.id]
    assert result[1]["deleted_at"] is not None


def test_delete_agent_sets_deleted_at_without_removing_row():
    db = make_session()
    active, _deleted = seed_agents(db)

    response = run(delete_agent(active.id, db=db))
    db.refresh(active)

    assert response["deleted"] is True
    assert active.deleted_at is not None
    assert db.query(Agent).filter(Agent.id == active.id).first() is not None
    assert run(list_agents(include_inactive=False, skip=0, limit=50, db=db)) == []
