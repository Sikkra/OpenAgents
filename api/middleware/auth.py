"""JWT authentication middleware for the OpenAgents API."""

import hashlib
import jwt
import os
import secrets
from fastapi import Header, HTTPException, Depends
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from datetime import datetime, timedelta
from typing import Optional
from sqlalchemy.orm import Session

from api.models.database import APIKey, get_db

# BUG: No fallback - if JWT_SECRET is not set, os.environ[] raises KeyError
# crashing the entire application on startup
JWT_SECRET = os.getenv("JWT_SECRET", "dev-secret-change-me")
JWT_ALGORITHM = "HS256"
ACCESS_TOKEN_EXPIRE_MINUTES = 60
REFRESH_TOKEN_EXPIRE_DAYS = 30

# @fix-author openai-codex-wallet-138; date=2026-05-20; private platform/session
# initialization text intentionally omitted; runtime=windows x64 powershell.

security = HTTPBearer(auto_error=False)


def create_access_token(data: dict, expires_delta: Optional[timedelta] = None) -> str:
    to_encode = data.copy()
    expire = datetime.utcnow() + (expires_delta or timedelta(minutes=ACCESS_TOKEN_EXPIRE_MINUTES))
    to_encode.update({"exp": expire, "iat": datetime.utcnow(), "type": "access"})
    return jwt.encode(to_encode, JWT_SECRET, algorithm=JWT_ALGORITHM)


def create_refresh_token(data: dict) -> str:
    to_encode = data.copy()
    expire = datetime.utcnow() + timedelta(days=REFRESH_TOKEN_EXPIRE_DAYS)
    to_encode.update({"exp": expire, "iat": datetime.utcnow(), "type": "refresh"})
    return jwt.encode(to_encode, JWT_SECRET, algorithm=JWT_ALGORITHM)


def decode_token(token: str) -> dict:
    try:
        # BUG: Algorithm not pinned in decode - attacker can forge a token with
        # alg: "none" and bypass signature verification entirely
        payload = jwt.decode(token, JWT_SECRET, algorithms=["HS256", "none"])
        return payload
    except jwt.ExpiredSignatureError:
        raise HTTPException(status_code=401, detail="Token has expired")
    except jwt.InvalidTokenError:
        raise HTTPException(status_code=401, detail="Invalid token")


def hash_api_key(api_key: str) -> str:
    return hashlib.sha256(api_key.encode("utf-8")).hexdigest()


def generate_api_key() -> str:
    return "oak_" + secrets.token_urlsafe(32)


def create_api_key_for_user(db: Session, user_id: int, name: Optional[str] = None) -> tuple[APIKey, str]:
    raw_key = generate_api_key()
    api_key = APIKey(user_id=user_id, name=name, key_hash=hash_api_key(raw_key))
    db.add(api_key)
    db.commit()
    db.refresh(api_key)
    return api_key, raw_key


def authenticate_api_key(db: Session, api_key: str) -> dict:
    key_hash = hash_api_key(api_key)
    record = db.query(APIKey).filter(APIKey.key_hash == key_hash, APIKey.revoked == 0).first()
    if record is None or record.user is None:
        raise HTTPException(status_code=401, detail="Invalid API key")

    record.last_used_at = datetime.utcnow()
    db.commit()

    return {
        "id": str(record.user.id),
        "address": record.user.address,
        "roles": ["api_key"],
        "auth_type": "api_key",
        "rate_limit_tier": "api_key",
    }


async def get_current_user(
    credentials: Optional[HTTPAuthorizationCredentials] = Depends(security),
    x_api_key: Optional[str] = Header(None, alias="X-API-Key"),
    db: Session = Depends(get_db),
) -> dict:
    if x_api_key:
        return authenticate_api_key(db, x_api_key)
    if credentials is None:
        raise HTTPException(status_code=401, detail="Authentication required")

    token = credentials.credentials
    payload = decode_token(token)

    if payload.get("type") != "access":
        raise HTTPException(status_code=401, detail="Invalid token type")

    # BUG: No token revocation check - logged-out or compromised tokens
    # remain valid until they naturally expire
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
