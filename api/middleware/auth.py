"""JWT and API key authentication middleware for the OpenAgents API."""

import hashlib
import os
import secrets
from datetime import datetime, timedelta, timezone
from typing import Optional
from uuid import uuid4

import jwt
from fastapi import Depends, HTTPException, Request
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy.orm import Session

from api.models.database import APIKey, get_db

JWT_SECRET = os.environ.get("JWT_SECRET", "openagents-development-secret-please-change")
JWT_ALGORITHM = "HS256"
ACCESS_TOKEN_EXPIRE_MINUTES = 60
REFRESH_TOKEN_EXPIRE_DAYS = 30
API_KEY_PREFIX = "oa_"

security = HTTPBearer(auto_error=False)


def create_access_token(data: dict, expires_delta: Optional[timedelta] = None) -> str:
    to_encode = data.copy()
    now = datetime.now(timezone.utc)
    expire = now + (expires_delta or timedelta(minutes=ACCESS_TOKEN_EXPIRE_MINUTES))
    to_encode.update({"exp": expire, "iat": now, "type": "access"})
    return jwt.encode(to_encode, JWT_SECRET, algorithm=JWT_ALGORITHM)


def create_refresh_token(data: dict) -> str:
    to_encode = data.copy()
    now = datetime.now(timezone.utc)
    expire = now + timedelta(days=REFRESH_TOKEN_EXPIRE_DAYS)
    to_encode.update({"exp": expire, "iat": now, "type": "refresh"})
    return jwt.encode(to_encode, JWT_SECRET, algorithm=JWT_ALGORITHM)


def decode_token(token: str) -> dict:
    try:
        return jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALGORITHM])
    except jwt.ExpiredSignatureError:
        raise HTTPException(status_code=401, detail="Token has expired")
    except jwt.InvalidTokenError:
        raise HTTPException(status_code=401, detail="Invalid token")


def hash_api_key(api_key: str) -> str:
    return hashlib.sha256(api_key.encode("utf-8")).hexdigest()


def create_api_key(
    db: Session,
    user: dict,
    name: Optional[str] = None,
) -> dict:
    raw_key = API_KEY_PREFIX + secrets.token_urlsafe(32)
    key = APIKey(
        id=str(uuid4()),
        user_id=str(user["id"]),
        address=user.get("address"),
        name=name,
        key_hash=hash_api_key(raw_key),
        roles=user.get("roles", []),
        revoked=False,
    )
    db.add(key)
    db.commit()
    db.refresh(key)
    return {
        "id": key.id,
        "key": raw_key,
        "name": key.name,
        "created_at": key.created_at,
    }


def revoke_api_key(db: Session, key_id: str, user: dict) -> bool:
    key = db.query(APIKey).filter(APIKey.id == key_id).first()
    if not key or key.user_id != str(user["id"]):
        raise HTTPException(status_code=404, detail="API key not found")
    key.revoked = True
    key.revoked_at = datetime.now(timezone.utc)
    db.commit()
    return True


def authenticate_api_key(db: Session, api_key: str) -> dict:
    key_hash = hash_api_key(api_key)
    key = db.query(APIKey).filter(APIKey.key_hash == key_hash).first()
    if not key or key.revoked:
        raise HTTPException(status_code=401, detail="Invalid API key")
    return {
        "id": key.user_id,
        "address": key.address,
        "roles": key.roles or [],
        "auth_type": "api_key",
        "api_key_id": key.id,
        "rate_limit_tier": "api_key",
    }


async def get_current_user(
    request: Request,
    credentials: Optional[HTTPAuthorizationCredentials] = Depends(security),
    db: Session = Depends(get_db),
) -> dict:
    api_key = request.headers.get("X-API-Key")
    if api_key:
        return authenticate_api_key(db, api_key)

    if credentials is None:
        raise HTTPException(status_code=401, detail="Missing credentials")

    payload = decode_token(credentials.credentials)

    if payload.get("type") != "access":
        raise HTTPException(status_code=401, detail="Invalid token type")

    user_data = {
        "id": payload.get("sub"),
        "address": payload.get("address"),
        "roles": payload.get("roles", []),
        "auth_type": "jwt",
        "rate_limit_tier": "jwt",
    }

    if not user_data["id"]:
        raise HTTPException(status_code=401, detail="Invalid token payload")

    return user_data


def require_role(role: str):
    async def role_checker(user: dict = Depends(get_current_user)):
        if role not in user.get("roles", []):
            raise HTTPException(status_code=403, detail=f"Role '{role}' required")
        return user

    return role_checker


def generate_login_tokens(user_id: str, address: str, roles: list = None) -> dict:
    data = {"sub": user_id, "address": address, "roles": roles or []}
    return {
        "token": create_access_token(data),
        "refresh_token": create_refresh_token(data),
        "expires_in": ACCESS_TOKEN_EXPIRE_MINUTES * 60,
    }
