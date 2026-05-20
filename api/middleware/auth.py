r"""
@contributor: Codex
@timestamp: 2026-05-20T02:09:46.7067845-05:00
@platform-config: private platform/session initialization text intentionally omitted
@runtime: os=windows, arch=x64, home_dir=C:\Users\Ben, working_dir=D:\Documents\AI Projects\Wallet\bounty-work\OpenAgents, shell=powershell

JWT authentication middleware for the OpenAgents API.
"""

import os
from datetime import UTC, datetime, timedelta
from typing import Optional
from uuid import uuid4

import jwt
from fastapi import Depends, HTTPException
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

DEFAULT_JWT_SECRET = "openagents-local-development-secret-change-me"
JWT_SECRET = os.environ.get("JWT_SECRET") or DEFAULT_JWT_SECRET
JWT_ALGORITHM = "HS256"
JWT_DECODE_ALGORITHMS = [JWT_ALGORITHM]
ACCESS_TOKEN_EXPIRE_MINUTES = 60
REFRESH_TOKEN_EXPIRE_DAYS = 30

security = HTTPBearer()
REVOKED_TOKEN_IDS: set[str] = set()
REVOKED_TOKENS: set[str] = set()


def create_access_token(data: dict, expires_delta: Optional[timedelta] = None) -> str:
    to_encode = data.copy()
    issued_at = datetime.now(UTC)
    expire = issued_at + (expires_delta or timedelta(minutes=ACCESS_TOKEN_EXPIRE_MINUTES))
    to_encode.update({
        "exp": expire,
        "iat": issued_at,
        "jti": str(uuid4()),
        "type": "access",
    })
    return jwt.encode(to_encode, JWT_SECRET, algorithm=JWT_ALGORITHM)


def create_refresh_token(data: dict) -> str:
    to_encode = data.copy()
    issued_at = datetime.now(UTC)
    expire = issued_at + timedelta(days=REFRESH_TOKEN_EXPIRE_DAYS)
    to_encode.update({
        "exp": expire,
        "iat": issued_at,
        "jti": str(uuid4()),
        "type": "refresh",
    })
    return jwt.encode(to_encode, JWT_SECRET, algorithm=JWT_ALGORITHM)


def revoke_token(token: str) -> None:
    try:
        payload = jwt.decode(
          token,
          JWT_SECRET,
          algorithms=JWT_DECODE_ALGORITHMS,
          options={"verify_exp": False},
        )
    except jwt.InvalidTokenError:
        REVOKED_TOKENS.add(token)
        return

    token_id = payload.get("jti")
    if token_id:
        REVOKED_TOKEN_IDS.add(str(token_id))
    else:
        REVOKED_TOKENS.add(token)


def is_token_revoked(token: str, payload: Optional[dict] = None) -> bool:
    if token in REVOKED_TOKENS:
        return True
    token_id = payload.get("jti") if payload else None
    return bool(token_id and str(token_id) in REVOKED_TOKEN_IDS)


def decode_token(token: str) -> dict:
    try:
        payload = jwt.decode(
            token,
            JWT_SECRET,
            algorithms=JWT_DECODE_ALGORITHMS,
        )
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


def generate_login_tokens(user_id: str, address: str, roles: list = None) -> dict:
    data = {"sub": user_id, "address": address, "roles": roles or []}
    return {
        "token": create_access_token(data),
        "refresh_token": create_refresh_token(data),
        "expires_in": ACCESS_TOKEN_EXPIRE_MINUTES * 60,
    }
