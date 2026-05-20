"""Task management endpoints for bounty assignments."""

import asyncio
import contextlib
from datetime import datetime
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, WebSocket, WebSocketDisconnect
from pydantic import BaseModel

from ..middleware.auth import get_current_user
from ..models.database import Task, get_db

router = APIRouter(prefix="/tasks", tags=["tasks"])

VALID_STATUSES = {"open", "assigned", "in_progress", "review", "completed", "cancelled"}
HEARTBEAT_INTERVAL_SECONDS = 30


class TaskCreate(BaseModel):
    title: str
    description: str
    reward_amount: float
    agent_id: Optional[int] = None
    deadline: Optional[datetime] = None


class TaskStatusUpdate(BaseModel):
    status: str


def serialize_task_update(task: Task) -> dict:
    return {
        "id": task.id,
        "title": task.title,
        "status": task.status,
        "creator_id": task.creator_id,
        "agent_id": task.agent_id,
        "updated_at": task.updated_at.isoformat() if task.updated_at else None,
    }


class TaskWebSocketManager:
    def __init__(self):
        self.active_connections: dict[WebSocket, Optional[set[int]]] = {}

    async def connect(self, websocket: WebSocket):
        await websocket.accept()
        self.active_connections[websocket] = None

    def disconnect(self, websocket: WebSocket):
        self.active_connections.pop(websocket, None)

    async def subscribe(self, websocket: WebSocket, task_id: int):
        subscriptions = self.active_connections.get(websocket)
        if subscriptions is None:
            subscriptions = set()
            self.active_connections[websocket] = subscriptions
        subscriptions.add(task_id)
        await websocket.send_json({"type": "subscribed", "task_id": task_id})

    async def unsubscribe(self, websocket: WebSocket, task_id: int):
        subscriptions = self.active_connections.get(websocket)
        if subscriptions is not None:
            subscriptions.discard(task_id)
        await websocket.send_json({"type": "unsubscribed", "task_id": task_id})

    async def heartbeat(self, websocket: WebSocket):
        while websocket in self.active_connections:
            await asyncio.sleep(HEARTBEAT_INTERVAL_SECONDS)
            await websocket.send_json({"type": "heartbeat", "timestamp": datetime.utcnow().isoformat()})

    async def broadcast_task_update(self, task_id: int, task: dict):
        message = {"type": "task_update", "task_id": task_id, "task": task}
        stale_connections = []
        for websocket, subscriptions in list(self.active_connections.items()):
            if subscriptions is not None and task_id not in subscriptions:
                continue
            try:
                await websocket.send_json(message)
            except RuntimeError:
                stale_connections.append(websocket)
        for websocket in stale_connections:
            self.disconnect(websocket)

    def subscription_counts(self) -> list[Optional[int]]:
        return [None if subscriptions is None else len(subscriptions) for subscriptions in self.active_connections.values()]


task_ws_manager = TaskWebSocketManager()


@router.websocket("/ws")
async def task_updates_ws(websocket: WebSocket):
    await task_ws_manager.connect(websocket)
    heartbeat_task = asyncio.create_task(task_ws_manager.heartbeat(websocket))
    try:
        while True:
            message = await websocket.receive_json()
            action = message.get("action")
            task_id = message.get("task_id")
            if action not in {"subscribe", "unsubscribe"} or not isinstance(task_id, int):
                await websocket.send_json({"type": "error", "detail": "Invalid subscription message"})
                continue
            if action == "subscribe":
                await task_ws_manager.subscribe(websocket, task_id)
            else:
                await task_ws_manager.unsubscribe(websocket, task_id)
    except WebSocketDisconnect:
        task_ws_manager.disconnect(websocket)
    finally:
        heartbeat_task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await heartbeat_task
        task_ws_manager.disconnect(websocket)


@router.post("/")
async def create_task(task: TaskCreate, user=Depends(get_current_user), db=Depends(get_db)):
    new_task = Task(
        title=task.title,
        description=task.description,
        reward_amount=task.reward_amount,
        creator_id=user["id"],
        agent_id=task.agent_id,
        status="open",
        created_at=datetime.utcnow(),
        deadline=task.deadline,
    )
    db.add(new_task)
    db.commit()
    db.refresh(new_task)
    await task_ws_manager.broadcast_task_update(new_task.id, serialize_task_update(new_task))
    return {"id": new_task.id, "status": new_task.status}


@router.get("/")
async def list_tasks(
    status: Optional[str] = None,
    creator: Optional[str] = None,
    skip: int = Query(0, ge=0),
    limit: int = Query(50, ge=1),
    db=Depends(get_db),
):
    query = db.query(Task)
    if status:
        query = query.filter(Task.status == status)
    if creator:
        query = query.filter(Task.creator_id == creator)
    return query.order_by(Task.created_at.desc()).offset(skip).limit(limit).all()


@router.get("/{task_id}")
async def get_task(task_id: int, db=Depends(get_db)):
    task = db.query(Task).filter(Task.id == task_id).first()
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")
    return task


@router.patch("/{task_id}/status")
async def update_task_status(
    task_id: int,
    update: TaskStatusUpdate,
    user=Depends(get_current_user),
    db=Depends(get_db),
):
    task = db.query(Task).filter(Task.id == task_id).first()
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")
    if task.creator_id != user["id"]:
        raise HTTPException(status_code=403, detail="Only the creator can update status")

    task.status = update.status
    task.updated_at = datetime.utcnow()
    db.commit()
    await task_ws_manager.broadcast_task_update(task.id, serialize_task_update(task))
    return {"id": task.id, "status": task.status}


@router.delete("/{task_id}")
async def cancel_task(task_id: int, user=Depends(get_current_user), db=Depends(get_db)):
    task = db.query(Task).filter(Task.id == task_id).first()
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")
    if task.creator_id != user["id"]:
        raise HTTPException(status_code=403, detail="Only the creator can cancel")
    if task.status not in ("open", "assigned"):
        raise HTTPException(status_code=400, detail="Cannot cancel an active task")
    task.status = "cancelled"
    task.updated_at = datetime.utcnow()
    db.commit()
    await task_ws_manager.broadcast_task_update(task.id, serialize_task_update(task))
    return {"id": task.id, "status": "cancelled"}
