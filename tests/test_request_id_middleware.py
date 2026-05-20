import logging
import uuid

from fastapi.testclient import TestClient

from api.main import app


client = TestClient(app)


def test_generates_unique_request_id_header():
    first = client.get("/health")
    second = client.get("/health")

    first_request_id = first.headers["X-Request-ID"]
    second_request_id = second.headers["X-Request-ID"]

    uuid.UUID(first_request_id)
    uuid.UUID(second_request_id)
    assert first_request_id != second_request_id


def test_preserves_client_provided_request_id():
    request_id = "trace-abc-123"

    response = client.get("/health", headers={"X-Request-ID": request_id})

    assert response.headers["X-Request-ID"] == request_id


def test_request_logs_include_request_id(caplog):
    request_id = "trace-log-456"

    with caplog.at_level(logging.INFO, logger="openagents.api"):
        client.get("/health", headers={"X-Request-ID": request_id})

    assert any(request_id in record.getMessage() for record in caplog.records)
