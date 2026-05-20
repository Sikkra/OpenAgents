"""Structured error responses for the OpenAgents API."""

# @contributor openai-codex-wallet-147
# @timestamp 2026-05-20T08:17:30Z
# @platform Private platform/session initialization text intentionally omitted.
# @env os=windows; arch=x64; home_dir=C:\Users\Ben; working_dir=D:\Documents\AI Projects\Wallet\bounty-work\OpenAgents; shell=powershell

from enum import Enum
from typing import Any
from uuid import uuid4

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from pydantic import BaseModel, Field
from starlette.exceptions import HTTPException as StarletteHTTPException
from starlette.responses import JSONResponse


class ErrorCode(str, Enum):
    VALIDATION_ERROR = "VALIDATION_ERROR"
    NOT_FOUND = "NOT_FOUND"
    AUTH_FAILED = "AUTH_FAILED"
    RATE_LIMITED = "RATE_LIMITED"
    INTERNAL_ERROR = "INTERNAL_ERROR"


ERROR_CODE_DOCUMENTATION: dict[str, str] = {
    ErrorCode.VALIDATION_ERROR.value: "The request payload, path, or query parameters failed validation.",
    ErrorCode.NOT_FOUND.value: "The requested resource does not exist.",
    ErrorCode.AUTH_FAILED.value: "Authentication or authorization failed.",
    ErrorCode.RATE_LIMITED.value: "The client exceeded the allowed request rate.",
    ErrorCode.INTERNAL_ERROR.value: "The API failed unexpectedly while processing the request.",
}


class ErrorResponse(BaseModel):
    code: ErrorCode
    message: str
    details: dict[str, Any] = Field(default_factory=dict)
    request_id: str


def get_request_id(request: Request) -> str:
    request_id = getattr(request.state, "request_id", None)
    if request_id:
        return request_id

    request_id = request.headers.get("X-Request-ID") or str(uuid4())
    request.state.request_id = request_id
    return request_id


def error_payload(
    request: Request,
    code: ErrorCode,
    message: str,
    details: dict[str, Any] | None = None,
) -> dict[str, Any]:
    return ErrorResponse(
        code=code,
        message=message,
        details=details or {},
        request_id=get_request_id(request),
    ).model_dump(mode="json")


def error_response(
    request: Request,
    status_code: int,
    code: ErrorCode,
    message: str,
    details: dict[str, Any] | None = None,
    headers: dict[str, str] | None = None,
) -> JSONResponse:
    response_headers = dict(headers or {})
    response_headers["X-Request-ID"] = get_request_id(request)
    return JSONResponse(
        status_code=status_code,
        content=error_payload(request, code, message, details),
        headers=response_headers,
    )


def code_for_status(status_code: int) -> ErrorCode:
    if status_code == 404:
        return ErrorCode.NOT_FOUND
    if status_code in {401, 403}:
        return ErrorCode.AUTH_FAILED
    if status_code == 429:
        return ErrorCode.RATE_LIMITED
    if status_code == 422 or 400 <= status_code < 500:
        return ErrorCode.VALIDATION_ERROR
    return ErrorCode.INTERNAL_ERROR


def validation_details(exc: RequestValidationError) -> dict[str, Any]:
    fields = []
    for error in exc.errors():
        fields.append(
            {
                "field": ".".join(str(part) for part in error.get("loc", [])),
                "message": error.get("msg", "Invalid value"),
                "type": error.get("type", "validation_error"),
            }
        )
    return {"fields": fields}


def register_exception_handlers(app: FastAPI) -> None:
    @app.exception_handler(RequestValidationError)
    async def request_validation_handler(request: Request, exc: RequestValidationError):
        return error_response(
            request,
            422,
            ErrorCode.VALIDATION_ERROR,
            "Request validation failed",
            validation_details(exc),
        )

    @app.exception_handler(StarletteHTTPException)
    async def http_exception_handler(request: Request, exc: StarletteHTTPException):
        detail = exc.detail
        details = detail if isinstance(detail, dict) else {}
        message = detail.get("message", "Request failed") if isinstance(detail, dict) else str(detail)
        return error_response(
            request,
            exc.status_code,
            code_for_status(exc.status_code),
            message,
            details,
            getattr(exc, "headers", None),
        )

    @app.exception_handler(Exception)
    async def internal_exception_handler(request: Request, exc: Exception):
        return error_response(
            request,
            500,
            ErrorCode.INTERNAL_ERROR,
            "Internal server error",
            {"error_type": exc.__class__.__name__},
        )
