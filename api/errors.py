"""Structured API error responses.

Error codes:
- VALIDATION_ERROR: Invalid request input or malformed parameters.
- NOT_FOUND: The requested resource or route does not exist.
- AUTH_FAILED: Authentication failed or the caller lacks required access.
- RATE_LIMITED: The caller exceeded the configured request limit.
- INTERNAL_ERROR: An unexpected server-side failure occurred.
"""

from enum import Enum
from typing import Any

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
from starlette.exceptions import HTTPException as StarletteHTTPException


class ErrorCode(str, Enum):
    VALIDATION_ERROR = "VALIDATION_ERROR"
    NOT_FOUND = "NOT_FOUND"
    AUTH_FAILED = "AUTH_FAILED"
    RATE_LIMITED = "RATE_LIMITED"
    INTERNAL_ERROR = "INTERNAL_ERROR"


ERROR_CODE_DESCRIPTIONS = {
    ErrorCode.VALIDATION_ERROR: "Invalid request input or malformed parameters.",
    ErrorCode.NOT_FOUND: "The requested resource or route does not exist.",
    ErrorCode.AUTH_FAILED: "Authentication failed or the caller lacks required access.",
    ErrorCode.RATE_LIMITED: "The caller exceeded the configured request limit.",
    ErrorCode.INTERNAL_ERROR: "An unexpected server-side failure occurred.",
}


class ErrorResponse(BaseModel):
    code: ErrorCode
    message: str
    details: dict[str, Any] = Field(default_factory=dict)
    request_id: str


def get_request_id(request: Request) -> str:
    return getattr(request.state, "request_id", None) or request.headers.get(
        "X-Request-ID", "unknown"
    )


def error_response(
    request: Request,
    code: ErrorCode,
    message: str,
    status_code: int,
    details: dict[str, Any] | None = None,
    headers: dict[str, str] | None = None,
) -> JSONResponse:
    request_id = get_request_id(request)
    content = ErrorResponse(
        code=code,
        message=message,
        details=details or {},
        request_id=request_id,
    ).model_dump(mode="json")
    response_headers = {"X-Request-ID": request_id}
    if headers:
        response_headers.update(headers)
    return JSONResponse(status_code=status_code, content=content, headers=response_headers)


def status_to_error_code(status_code: int) -> ErrorCode:
    if status_code in {401, 403}:
        return ErrorCode.AUTH_FAILED
    if status_code == 404:
        return ErrorCode.NOT_FOUND
    if status_code == 429:
        return ErrorCode.RATE_LIMITED
    if 400 <= status_code < 500:
        return ErrorCode.VALIDATION_ERROR
    return ErrorCode.INTERNAL_ERROR


def normalize_http_detail(detail: Any, fallback_message: str) -> tuple[str, dict[str, Any]]:
    if isinstance(detail, dict):
        message = str(detail.get("message") or detail.get("error") or fallback_message)
        details = detail.get("details")
        if isinstance(details, dict):
            return message, details
        return message, {k: v for k, v in detail.items() if k not in {"message", "error"}}
    if detail:
        return str(detail), {}
    return fallback_message, {}


def validation_error_details(exc: RequestValidationError) -> dict[str, Any]:
    errors = []
    for error in exc.errors():
        loc = ".".join(str(part) for part in error.get("loc", []))
        errors.append(
            {
                "field": loc,
                "message": error.get("msg", "Invalid value"),
                "type": error.get("type", "value_error"),
            }
        )
    return {"errors": errors}


async def validation_exception_handler(
    request: Request, exc: RequestValidationError
) -> JSONResponse:
    return error_response(
        request=request,
        code=ErrorCode.VALIDATION_ERROR,
        message="Request validation failed",
        status_code=422,
        details=validation_error_details(exc),
    )


async def http_exception_handler(
    request: Request, exc: StarletteHTTPException
) -> JSONResponse:
    code = status_to_error_code(exc.status_code)
    message, details = normalize_http_detail(exc.detail, exc.__class__.__name__)
    return error_response(
        request=request,
        code=code,
        message=message,
        status_code=exc.status_code,
        details=details,
        headers=getattr(exc, "headers", None),
    )


async def internal_exception_handler(request: Request, _exc: Exception) -> JSONResponse:
    return error_response(
        request=request,
        code=ErrorCode.INTERNAL_ERROR,
        message="Internal server error",
        status_code=500,
        details={},
    )


def register_exception_handlers(app: FastAPI) -> None:
    app.add_exception_handler(RequestValidationError, validation_exception_handler)
    app.add_exception_handler(StarletteHTTPException, http_exception_handler)
    app.add_exception_handler(Exception, internal_exception_handler)
