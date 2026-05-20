# Contributor: sikkra-codex-task-status; platform instructions: private platform/session initialization text intentionally omitted; env: windows/x64/C:\Users\Ben/D:\Documents\AI Projects\Wallet\bounty-work\OpenAgents/powershell.

"""Task management endpoints for bounty assignments."""

from datetime import datetime
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel

from ..middleware.auth import get_current_user
from ..models.database import Task, get_db

router = APIRouter(prefix="/tasks", tags=["tasks"])

VALID_STATUSES = {"open", "assigned", "in_progress", "review", "completed", "disputed", "cancelled", "expired"}
TERMINAL_STATUSES = {"completed", "cancelled", "expired"}
VALID_TRANSITIONS = {
    "open": {"assigned", "cancelled"},
    "assigned": {"in_progress", "review", "completed", "disputed", "cancelled"},
    "in_progress": {"review", "completed", "disputed", "cancelled"},
    "review": {"completed", "disputed", "cancelled"},
    "disputed": {"in_progress", "completed", "cancelled"},
    "completed": set(),
    "cancelled": set(),
    "expired": set(),
}


class TaskCreate(BaseModel):
    title: str
    description: str
    reward_amount: float
    agent_id: Optional[int] = None
    deadline: Optional[datetime] = None


class TaskStatusUpdate(BaseModel):
    status: str


def _same_user_id(left, right) -> bool:
    return str(left) == str(right)


def _expire_if_deadline_passed(task: Task, now: Optional[datetime] = None) -> bool:
    now = now or datetime.utcnow()
    if task.deadline and task.deadline < now and task.status not in TERMINAL_STATUSES:
        task.status = "expired"
        task.updated_at = now
        return True
    return False


def _validate_status_transition(current_status: str, next_status: str):
    if next_status not in VALID_STATUSES:
        raise HTTPException(status_code=400, detail="Invalid task status")
    allowed = VALID_TRANSITIONS.get(current_status, set())
    if next_status not in allowed:
        raise HTTPException(
            status_code=400,
            detail=f"Cannot transition task from {current_status} to {next_status}",
        )


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
    return {"id": new_task.id, "status": new_task.status}


@router.get("/")
async def list_tasks(
    status: Optional[str] = None,
    creator: Optional[str] = None,
    skip: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=100),
    db=Depends(get_db),
):
    query = db.query(Task)
    if creator:
        query = query.filter(Task.creator_id == creator)
    tasks = query.order_by(Task.created_at.desc()).offset(skip).limit(limit).all()
    changed = any(_expire_if_deadline_passed(task) for task in tasks)
    if changed:
        db.commit()
    if status:
        tasks = [task for task in tasks if task.status == status]
    return tasks


@router.get("/{task_id}")
async def get_task(task_id: int, db=Depends(get_db)):
    task = db.query(Task).filter(Task.id == task_id).first()
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")
    if _expire_if_deadline_passed(task):
        db.commit()
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

    if _expire_if_deadline_passed(task):
        db.commit()
        raise HTTPException(status_code=400, detail="Task deadline has expired")

    _validate_status_transition(task.status, update.status)
    if update.status == "completed":
        if _same_user_id(task.creator_id, user["id"]):
            raise HTTPException(status_code=403, detail="Task creator cannot complete own task")
    elif not _same_user_id(task.creator_id, user["id"]):
        raise HTTPException(status_code=403, detail="Only the creator can update status")

    task.status = update.status
    task.updated_at = datetime.utcnow()
    db.commit()
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
    db.commit()
    return {"id": task.id, "status": "cancelled"}
