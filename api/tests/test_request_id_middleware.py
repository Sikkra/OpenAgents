import logging
import unittest
from uuid import UUID

from fastapi.testclient import TestClient

from api.main import REQUEST_ID_HEADER, app, logger


class _ListHandler(logging.Handler):
    def __init__(self):
        super().__init__()
        self.records = []

    def emit(self, record):
        self.records.append(record)


class RequestIdMiddlewareTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(app)

    def test_response_has_unique_generated_request_ids(self):
        first = self.client.get("/health")
        second = self.client.get("/health")

        self.assertEqual(first.status_code, 200)
        self.assertEqual(second.status_code, 200)

        first_id = first.headers[REQUEST_ID_HEADER]
        second_id = second.headers[REQUEST_ID_HEADER]

        UUID(first_id)
        UUID(second_id)
        self.assertNotEqual(first_id, second_id)

    def test_client_request_id_is_preserved(self):
        response = self.client.get(
            "/health",
            headers={REQUEST_ID_HEADER: "trace-client-123"},
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.headers[REQUEST_ID_HEADER], "trace-client-123")

    def test_request_id_is_written_to_api_logs(self):
        handler = _ListHandler()
        old_level = logger.level
        logger.addHandler(handler)
        logger.setLevel(logging.INFO)
        try:
            response = self.client.get(
                "/health",
                headers={REQUEST_ID_HEADER: "trace-log-456"},
            )
        finally:
            logger.removeHandler(handler)
            logger.setLevel(old_level)

        self.assertEqual(response.status_code, 200)
        self.assertTrue(
            any("trace-log-456" in record.getMessage() for record in handler.records)
        )
        self.assertTrue(
            all(
                getattr(record, "request_id", None) == "trace-log-456"
                for record in handler.records
            )
        )


if __name__ == "__main__":
    unittest.main()
