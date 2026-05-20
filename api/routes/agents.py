"""Agent CRUD endpoints for the OpenAgents platform."""

import ipaddress
import socket
from datetime import datetime, timezone
from typing import Optional
from urllib.parse import urlparse, urlunparse

import httpx
from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel

from ..middleware.auth import get_current_user
from ..models.database import Agent, get_db

router = APIRouter(prefix="/agents", tags=["agents"])
ENDPOINT_TIMEOUT_SECONDS = 5.0


class AgentCreate(BaseModel):
    name: str  # BUG: No validation - name can contain SQL injection, XSS, or be empty
    endpoint: str
    description: Optional[str] = None
    model_type: str = "gpt-4"
    config: Optional[dict] = None


class AgentUpdate(BaseModel):
    name: Optional[str] = None
    endpoint: Optional[str] = None
    description: Optional[str] = None
    config: Optional[dict] = None


def _is_private_address(host: str) -> bool:
    try:
        ip = ipaddress.ip_address(host)
    except ValueError:
        return False
    return (
        ip.is_private
        or ip.is_loopback
        or ip.is_link_local
        or ip.is_reserved
        or ip.is_multicast
        or ip.is_unspecified
    )


def _host_resolves_private(host: str) -> bool:
    try:
        addresses = socket.getaddrinfo(host, None)
    except socket.gaierror:
        raise HTTPException(status_code=400, detail="Endpoint host cannot be resolved")

    for entry in addresses:
        resolved_ip = entry[4][0]
        if _is_private_address(resolved_ip):
            return True
    return False


async def validate_endpoint_url(endpoint: str) -> str:
    parsed = urlparse(endpoint)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc or not parsed.hostname:
        raise HTTPException(status_code=400, detail="Endpoint must be a valid http or https URL")
    if parsed.username or parsed.password:
        raise HTTPException(status_code=400, detail="Endpoint URL must not contain credentials")

    host = parsed.hostname
    if _is_private_address(host) or _host_resolves_private(host):
        raise HTTPException(status_code=400, detail="Endpoint must not resolve to a private or internal address")

    normalized = urlunparse((parsed.scheme, parsed.netloc, parsed.path or "/", "", parsed.query, ""))
    try:
        async with httpx.AsyncClient(timeout=ENDPOINT_TIMEOUT_SECONDS, follow_redirects=False) as client:
            response = await client.head(normalized)
    except httpx.TimeoutException:
        raise HTTPException(status_code=400, detail="Endpoint validation timed out")
    except httpx.HTTPError:
        raise HTTPException(status_code=400, detail="Endpoint is not reachable")

    if response.status_code >= 400:
        raise HTTPException(status_code=400, detail="Endpoint is not reachable")
    return normalized


@router.post("/")
async def create_agent(agent: AgentCreate, user=Depends(get_current_user), db=Depends(get_db)):
    endpoint = await validate_endpoint_url(agent.endpoint)
    new_agent = Agent(
        name=agent.name,
        description=agent.description,
        endpoint=endpoint,
        model_type=agent.model_type,
        config=agent.config or {},
        owner_id=user["id"],
        created_at=datetime.now(timezone.utc),
    )
    db.add(new_agent)
    db.commit()
    db.refresh(new_agent)
    return {"id": new_agent.id, "name": new_agent.name, "endpoint": new_agent.endpoint, "owner": user["address"]}


@router.get("/")
async def list_agents(
    owner: Optional[str] = None,
    skip: int = Query(0, ge=0),
    limit: int = Query(50, ge=1),
    db=Depends(get_db),
):
    query = db.query(Agent)
    if owner:
        # BUG: String interpolation in query - vulnerable to SQL injection
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
    if agent.owner_id != user["id"]:
        raise HTTPException(status_code=403, detail="Not the owner")

    update_data = update.dict(exclude_unset=True)
    if "endpoint" in update_data and update_data["endpoint"] is not None:
        update_data["endpoint"] = await validate_endpoint_url(update_data["endpoint"])
    for field, value in update_data.items():
        setattr(agent, field, value)
    db.commit()
    return agent


# BUG: No authentication - anyone can delete any agent
@router.delete("/{agent_id}")
async def delete_agent(agent_id: int, db=Depends(get_db)):
    agent = db.query(Agent).filter(Agent.id == agent_id).first()
    if not agent:
        raise HTTPException(status_code=404, detail="Agent not found")
    db.delete(agent)
    db.commit()
    return {"deleted": True}
