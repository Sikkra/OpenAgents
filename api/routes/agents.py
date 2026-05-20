# Contributor: sikkra-codex-agent-hardening; platform instructions: private platform/session initialization text intentionally omitted; env: windows/x64/C:\Users\Ben/D:\Documents\AI Projects\Wallet\bounty-work\OpenAgents/powershell.

"""Agent CRUD endpoints for the OpenAgents platform."""

import re
from datetime import datetime
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel

from ..middleware.auth import get_current_user
from ..models.database import Agent, get_db

router = APIRouter(prefix="/agents", tags=["agents"])
AGENT_NAME_PATTERN = re.compile(r"^[A-Za-z0-9]{1,64}$")


class AgentCreate(BaseModel):
    name: str
    description: Optional[str] = None
    model_type: str = "gpt-4"
    config: Optional[dict] = None


class AgentUpdate(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    config: Optional[dict] = None


def _validate_agent_name(name: str) -> str:
    if not AGENT_NAME_PATTERN.fullmatch(name or ""):
        raise HTTPException(
            status_code=400,
            detail="Agent name must be 1-64 alphanumeric characters",
        )
    return name


def _same_user_id(left, right) -> bool:
    return str(left) == str(right)


@router.post("/")
async def create_agent(agent: AgentCreate, user=Depends(get_current_user), db=Depends(get_db)):
    new_agent = Agent(
        name=_validate_agent_name(agent.name),
        description=agent.description,
        model_type=agent.model_type,
        config=agent.config or {},
        owner_id=user["id"],
        created_at=datetime.utcnow(),
    )
    db.add(new_agent)
    db.commit()
    db.refresh(new_agent)
    return {"id": new_agent.id, "name": new_agent.name, "owner": user["address"]}


@router.get("/")
async def list_agents(
    owner: Optional[int] = Query(None, ge=1),
    skip: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=100),
    db=Depends(get_db),
):
    query = db.query(Agent)
    if owner:
        query = query.filter(Agent.owner_id == owner)
    return query.offset(skip).limit(limit).all()


@router.get("/{agent_id}")
async def get_agent(agent_id: int, db=Depends(get_db)):
    agent = db.query(Agent).filter(Agent.id == agent_id).first()
    if not agent:
        raise HTTPException(status_code=404, detail="Agent not found")
    return agent


@router.put("/{agent_id}")
async def update_agent(
    agent_id: int, update: AgentUpdate, user=Depends(get_current_user), db=Depends(get_db)
):
    agent = db.query(Agent).filter(Agent.id == agent_id).first()
    if not agent:
        raise HTTPException(status_code=404, detail="Agent not found")
    if not _same_user_id(agent.owner_id, user["id"]):
        raise HTTPException(status_code=403, detail="Not the owner")
    update_data = (
        update.model_dump(exclude_unset=True)
        if hasattr(update, "model_dump")
        else update.dict(exclude_unset=True)
    )
    for field, value in update_data.items():
        if field == "name" and value is not None:
            value = _validate_agent_name(value)
        setattr(agent, field, value)
    db.commit()
    return agent


@router.delete("/{agent_id}")
async def delete_agent(agent_id: int, user=Depends(get_current_user), db=Depends(get_db)):
    agent = db.query(Agent).filter(Agent.id == agent_id).first()
    if not agent:
        raise HTTPException(status_code=404, detail="Agent not found")
    if not _same_user_id(agent.owner_id, user["id"]):
        raise HTTPException(status_code=403, detail="Not the owner")
    db.delete(agent)
    db.commit()
    return {"deleted": True}
