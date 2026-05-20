import json
import os
import shutil
import time
import tracemalloc
import urllib.error
import urllib.request

from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from typing import Optional
from datetime import datetime, timezone

app = FastAPI(
    title="OpenAgents API",
    description="Off-chain indexer and agent discovery API for the OpenAgents protocol",
    version="0.1.0",
)


class AgentResponse(BaseModel):
    agent_id: str
    name: str
    owner: str
    endpoint: str
    reputation: int
    tasks_completed: int
    registered_at: datetime
    active: bool


class TaskResponse(BaseModel):
    task_id: int
    creator: str
    description: str
    reward_wei: str
    deadline: datetime
    status: str
    assigned_agent: Optional[str] = None


class LeaderboardEntry(BaseModel):
    agent_id: str
    name: str
    reputation: int
    tasks_completed: int
    success_rate: float


# In-memory store (placeholder for DB)
agents_cache: dict = {}
tasks_cache: dict = {}
_health_cache: dict = {"expires_at": 0.0, "payload": None, "status_code": 200}
HEALTH_CACHE_SECONDS = 10
MIN_FREE_DISK_BYTES = 100 * 1024 * 1024
MAX_MEMORY_BYTES = int(os.getenv("HEALTH_MAX_MEMORY_BYTES", str(1024 * 1024 * 1024)))


def _utcnow() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _component(name: str, check):
    started = time.perf_counter()
    try:
        result = check()
    except Exception as exc:
        result = {"status": "unhealthy", "details": {"error": str(exc)}}
    latency_ms = round((time.perf_counter() - started) * 1000, 3)
    result.setdefault("details", {})
    result["latency_ms"] = latency_ms
    return name, result


def _check_db() -> dict:
    return {
        "status": "healthy",
        "details": {
            "backend": "in-memory",
            "agents_indexed": len(agents_cache),
            "tasks_indexed": len(tasks_cache),
        },
    }


def _check_rpc() -> dict:
    rpc_url = os.getenv("RPC_URL") or os.getenv("WEB3_PROVIDER_URI")
    if not rpc_url:
        return {"status": "healthy", "details": {"configured": False}}

    payload = json.dumps({"jsonrpc": "2.0", "id": 1, "method": "eth_blockNumber", "params": []}).encode()
    request = urllib.request.Request(
        rpc_url,
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=2) as response:
            body = json.loads(response.read().decode())
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as exc:
        return {"status": "unhealthy", "details": {"configured": True, "error": str(exc)}}

    if "result" not in body:
        return {"status": "unhealthy", "details": {"configured": True, "response": body}}
    return {"status": "healthy", "details": {"configured": True, "block_number": body["result"]}}


def _check_disk() -> dict:
    usage = shutil.disk_usage(os.getcwd())
    status = "healthy" if usage.free >= MIN_FREE_DISK_BYTES else "unhealthy"
    return {
        "status": status,
        "details": {
            "path": os.getcwd(),
            "free_bytes": usage.free,
            "total_bytes": usage.total,
            "min_free_bytes": MIN_FREE_DISK_BYTES,
        },
    }


def _check_memory() -> dict:
    if not tracemalloc.is_tracing():
        tracemalloc.start()
    current, peak = tracemalloc.get_traced_memory()
    status = "healthy" if current <= MAX_MEMORY_BYTES else "unhealthy"
    return {
        "status": status,
        "details": {
            "current_bytes": current,
            "peak_bytes": peak,
            "max_bytes": MAX_MEMORY_BYTES,
        },
    }


def _build_health_payload(cached: bool = False) -> tuple[dict, int]:
    components = dict(
        _component(name, check)
        for name, check in (
            ("db", _check_db),
            ("rpc", _check_rpc),
            ("disk", _check_disk),
            ("memory", _check_memory),
        )
    )
    unhealthy = [name for name, result in components.items() if result["status"] == "unhealthy"]
    overall = "unhealthy" if unhealthy else "healthy"
    payload = {
        "status": overall,
        "cached": cached,
        "components": components,
        "timestamp": _utcnow().isoformat(),
    }
    return payload, 503 if unhealthy else 200


def _health_response() -> JSONResponse:
    now = time.monotonic()
    headers = {"Cache-Control": f"public, max-age={HEALTH_CACHE_SECONDS}"}
    cached_payload = _health_cache.get("payload")
    if cached_payload is not None and now < _health_cache["expires_at"]:
        payload = {**cached_payload, "cached": True}
        return JSONResponse(payload, status_code=_health_cache["status_code"], headers=headers)

    payload, status_code = _build_health_payload()
    _health_cache.update(
        {
            "expires_at": now + HEALTH_CACHE_SECONDS,
            "payload": payload,
            "status_code": status_code,
        }
    )
    return JSONResponse(payload, status_code=status_code, headers=headers)


@app.get("/agents", response_model=list[AgentResponse])
async def list_agents(
    active_only: bool = Query(True),
    min_reputation: int = Query(0),
    limit: int = Query(50, le=100),
    offset: int = Query(0),
):
    results = list(agents_cache.values())
    if active_only:
        results = [a for a in results if a.get("active")]
    results = [a for a in results if a.get("reputation", 0) >= min_reputation]
    return results[offset : offset + limit]


@app.get("/agents/{agent_id}", response_model=AgentResponse)
async def get_agent(agent_id: str):
    if agent_id not in agents_cache:
        raise HTTPException(status_code=404, detail="Agent not found")
    return agents_cache[agent_id]


@app.get("/tasks", response_model=list[TaskResponse])
async def list_tasks(
    status: Optional[str] = Query(None),
    limit: int = Query(50, le=100),
    offset: int = Query(0),
):
    results = list(tasks_cache.values())
    if status:
        results = [t for t in results if t.get("status") == status]
    return results[offset : offset + limit]


@app.get("/tasks/{task_id}", response_model=TaskResponse)
async def get_task(task_id: int):
    if task_id not in tasks_cache:
        raise HTTPException(status_code=404, detail="Task not found")
    return tasks_cache[task_id]


@app.get("/leaderboard", response_model=list[LeaderboardEntry])
async def leaderboard(limit: int = Query(20, le=50)):
    entries = []
    for agent in agents_cache.values():
        completed = agent.get("tasks_completed", 0)
        entries.append(
            {
                "agent_id": agent["agent_id"],
                "name": agent["name"],
                "reputation": agent.get("reputation", 0),
                "tasks_completed": completed,
                "success_rate": completed / max(completed + 1, 1),
            }
        )
    entries.sort(key=lambda x: x["reputation"], reverse=True)
    return entries[:limit]


@app.get("/health")
async def health():
    return _health_response()
