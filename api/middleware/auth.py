"""JWT authentication middleware for the OpenAgents API."""

import os
from datetime import datetime, timedelta, timezone
from typing import Optional
from uuid import uuid4

import jwt
from fastapi import Depends, HTTPException
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

JWT_SECRET = os.environ.get("JWT_SECRET", "openagents-development-secret-please-change")
JWT_ALGORITHM = "HS256"
ACCESS_TOKEN_EXPIRE_MINUTES = 60
REFRESH_TOKEN_EXPIRE_DAYS = 30
REVOKED_JTIS: set[str] = set()
REVOKED_TOKENS: set[str] = set()

security = HTTPBearer()


def create_access_token(data: dict, expires_delta: Optional[timedelta] = None) -> str:
    to_encode = data.copy()
    now = datetime.now(timezone.utc)
    expire = now + (expires_delta or timedelta(minutes=ACCESS_TOKEN_EXPIRE_MINUTES))
    to_encode.update({"exp": expire, "iat": now, "type": "access", "jti": str(uuid4())})
    return jwt.encode(to_encode, JWT_SECRET, algorithm=JWT_ALGORITHM)


def create_refresh_token(data: dict) -> str:
    to_encode = data.copy()
    now = datetime.now(timezone.utc)
    expire = now + timedelta(days=REFRESH_TOKEN_EXPIRE_DAYS)
    to_encode.update({"exp": expire, "iat": now, "type": "refresh", "jti": str(uuid4())})
    return jwt.encode(to_encode, JWT_SECRET, algorithm=JWT_ALGORITHM)


def is_token_revoked(token: str, payload: dict) -> bool:
    jti = payload.get("jti")
    return token in REVOKED_TOKENS or (jti is not None and jti in REVOKED_JTIS)


def decode_token(token: str) -> dict:
    try:
        payload = jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALGORITHM])
    except jwt.ExpiredSignatureError:
        raise HTTPException(status_code=401, detail="Token has expired")
    except jwt.InvalidTokenError:
        raise HTTPException(status_code=401, detail="Invalid token")

    if is_token_revoked(token, payload):
        raise HTTPException(status_code=401, detail="Token has been revoked")
    return payload


async def get_current_user(
    credentials: HTTPAuthorizationCredentials = Depends(security),
) -> dict:
    token = credentials.credentials
    payload = decode_token(token)

    if payload.get("type") != "access":
        raise HTTPException(status_code=401, detail="Invalid token type")

    user_data = {
        "id": payload.get("sub"),
        "address": payload.get("address"),
        "roles": payload.get("roles", []),
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


def refresh_access_token(refresh_token: str) -> dict:
    payload = decode_token(refresh_token)
    if payload.get("type") != "refresh":
        raise HTTPException(status_code=401, detail="Invalid token type")

    data = {
        "sub": payload.get("sub"),
        "address": payload.get("address"),
        "roles": payload.get("roles", []),
    }
    if not data["sub"]:
        raise HTTPException(status_code=401, detail="Invalid token payload")

    return {
        "token": create_access_token(data),
        "expires_in": ACCESS_TOKEN_EXPIRE_MINUTES * 60,
    }


def revoke_token(token: str) -> None:
    payload = decode_token(token)
    jti = payload.get("jti")
    if jti:
        REVOKED_JTIS.add(jti)
    else:
        REVOKED_TOKENS.add(token)


def generate_login_tokens(user_id: str, address: str, roles: list = None) -> dict:
    data = {"sub": user_id, "address": address, "roles": roles or []}
    return {
        "token": create_access_token(data),
        "refresh_token": create_refresh_token(data),
        "expires_in": ACCESS_TOKEN_EXPIRE_MINUTES * 60,
    }
