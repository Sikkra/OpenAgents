from fastapi import FastAPI, HTTPException, Query
from pydantic import BaseModel, Field
from typing import Literal, Optional
from datetime import datetime, timedelta, timezone

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


class ReputationEvent(BaseModel):
    outcome: Literal["completion", "dispute"]
    completion_seconds: Optional[int] = Field(None, ge=0)


# In-memory store (placeholder for DB)
agents_cache: dict = {}
tasks_cache: dict = {}

MAX_REPUTATION = 1000
BASE_REPUTATION = 500
TARGET_COMPLETION_SECONDS = 3600
WEEKLY_DECAY = 0.01


def _utcnow() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _clamp_reputation(score: float) -> int:
    return max(0, min(MAX_REPUTATION, round(score)))


def _coerce_datetime(value) -> datetime:
    if isinstance(value, datetime):
        return value
    if isinstance(value, str):
        return datetime.fromisoformat(value.replace("Z", "+00:00")).replace(tzinfo=None)
    return _utcnow()


def _metrics_for(agent: dict) -> dict:
    metrics = agent.setdefault("reputation_metrics", {})
    metrics.setdefault("successful_tasks", int(agent.get("tasks_completed", 0)))
    metrics.setdefault("disputed_tasks", int(agent.get("disputed_tasks", 0)))
    metrics.setdefault("average_completion_seconds", agent.get("average_completion_seconds"))
    metrics.setdefault("last_activity_at", agent.get("registered_at", _utcnow()))
    return metrics


def _score_agent(agent: dict, now: Optional[datetime] = None) -> int:
    now = now or _utcnow()
    metrics = _metrics_for(agent)
    successful = int(metrics.get("successful_tasks", 0))
    disputed = int(metrics.get("disputed_tasks", 0))
    total = successful + disputed

    completion_rate = successful / total if total else 0.0
    dispute_rate = disputed / total if total else 0.0
    avg_seconds = metrics.get("average_completion_seconds")
    speed_score = 0.0
    if avg_seconds:
        speed_score = min(1.0, TARGET_COMPLETION_SECONDS / max(float(avg_seconds), 1.0))

    raw_score = (
        BASE_REPUTATION
        + completion_rate * 350
        + speed_score * 150
        - dispute_rate * 400
    )

    last_activity = _coerce_datetime(metrics.get("last_activity_at"))
    inactive_weeks = max(0, (now - last_activity).days // 7)
    decayed_score = raw_score * ((1 - WEEKLY_DECAY) ** inactive_weeks)
    return _clamp_reputation(decayed_score)


def _refresh_reputation(agent: dict, now: Optional[datetime] = None) -> dict:
    metrics = _metrics_for(agent)
    agent["tasks_completed"] = int(metrics.get("successful_tasks", 0))
    agent["reputation"] = _score_agent(agent, now=now)
    return agent


def _success_rate(agent: dict) -> float:
    metrics = _metrics_for(agent)
    successful = int(metrics.get("successful_tasks", 0))
    disputed = int(metrics.get("disputed_tasks", 0))
    total = successful + disputed
    return successful / total if total else 0.0


@app.get("/agents", response_model=list[AgentResponse])
async def list_agents(
    active_only: bool = Query(True),
    min_reputation: int = Query(0),
    limit: int = Query(50, le=100),
    offset: int = Query(0),
):
    for agent in agents_cache.values():
        _refresh_reputation(agent)
    results = list(agents_cache.values())
    if active_only:
        results = [a for a in results if a.get("active")]
    results = [a for a in results if a.get("reputation", 0) >= min_reputation]
    return results[offset : offset + limit]


@app.get("/agents/{agent_id}", response_model=AgentResponse)
async def get_agent(agent_id: str):
    if agent_id not in agents_cache:
        raise HTTPException(status_code=404, detail="Agent not found")
    return _refresh_reputation(agents_cache[agent_id])


@app.post("/agents/{agent_id}/reputation", response_model=AgentResponse)
async def record_reputation_event(agent_id: str, event: ReputationEvent):
    if agent_id not in agents_cache:
        raise HTTPException(status_code=404, detail="Agent not found")

    agent = agents_cache[agent_id]
    metrics = _metrics_for(agent)
    now = _utcnow()

    if event.outcome == "completion":
        successful = int(metrics.get("successful_tasks", 0)) + 1
        previous_avg = metrics.get("average_completion_seconds")
        if event.completion_seconds is not None:
            if previous_avg is None:
                metrics["average_completion_seconds"] = event.completion_seconds
            else:
                metrics["average_completion_seconds"] = (
                    float(previous_avg) * (successful - 1) + event.completion_seconds
                ) / successful
        metrics["successful_tasks"] = successful
    else:
        metrics["disputed_tasks"] = int(metrics.get("disputed_tasks", 0)) + 1

    metrics["last_activity_at"] = now
    return _refresh_reputation(agent, now=now)


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
        _refresh_reputation(agent)
        completed = agent.get("tasks_completed", 0)
        entries.append(
            {
                "agent_id": agent["agent_id"],
                "name": agent["name"],
                "reputation": agent.get("reputation", 0),
                "tasks_completed": completed,
                "success_rate": _success_rate(agent),
            }
        )
    entries.sort(key=lambda x: (x["reputation"], x["tasks_completed"], x["name"]), reverse=True)
    return entries[:limit]


@app.get("/health")
async def health():
    return {
        "status": "ok",
        "agents_indexed": len(agents_cache),
        "tasks_indexed": len(tasks_cache),
        "timestamp": _utcnow().isoformat(),
    }
