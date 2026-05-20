"""Authentication routes for API-key management."""

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session
from typing import Optional

from api.middleware.auth import create_api_key_for_user, get_current_user
from api.models.database import APIKey, get_db

router = APIRouter(prefix="/auth", tags=["auth"])


class CreateAPIKeyRequest(BaseModel):
    name: Optional[str] = None


class CreateAPIKeyResponse(BaseModel):
    id: int
    api_key: str
    name: Optional[str] = None


def _current_user_id(user: dict) -> int:
    try:
        return int(user["id"])
    except (KeyError, TypeError, ValueError):
        raise HTTPException(status_code=401, detail="Invalid authenticated user")


@router.post("/api-keys", response_model=CreateAPIKeyResponse)
def create_api_key(
    request: CreateAPIKeyRequest,
    user: dict = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    api_key, raw_key = create_api_key_for_user(db, _current_user_id(user), request.name)
    return CreateAPIKeyResponse(id=api_key.id, api_key=raw_key, name=api_key.name)


@router.delete("/api-keys/{key_id}")
def revoke_api_key(
    key_id: int,
    user: dict = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    api_key = (
        db.query(APIKey)
        .filter(APIKey.id == key_id, APIKey.user_id == _current_user_id(user), APIKey.revoked == 0)
        .first()
    )
    if api_key is None:
        raise HTTPException(status_code=404, detail="API key not found")

    api_key.revoked = 1
    db.commit()
    return {"revoked": True, "id": key_id}
