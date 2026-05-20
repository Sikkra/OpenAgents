import importlib
import os
from pathlib import Path
import sys
import unittest
from datetime import UTC, datetime, timedelta

import jwt
from fastapi import HTTPException

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))


def load_auth_module(secret=None):
    if secret is None:
        os.environ.pop("JWT_SECRET", None)
    else:
        os.environ["JWT_SECRET"] = secret

    sys.modules.pop("api.middleware.auth", None)
    return importlib.import_module("api.middleware.auth")


class JwtAuthMiddlewareTests(unittest.TestCase):
    def test_missing_secret_uses_graceful_fallback(self):
        auth = load_auth_module(secret=None)
        self.assertEqual(auth.JWT_SECRET, auth.DEFAULT_JWT_SECRET)

        token = auth.create_access_token({"sub": "u1", "address": "0xabc"})
        payload = auth.decode_token(token)
        self.assertEqual(payload["sub"], "u1")

    def test_algorithm_none_token_is_rejected(self):
        auth = load_auth_module(secret="test-secret-that-is-long-enough-for-hs256")
        payload = {
            "sub": "attacker",
            "address": "0xbad",
            "type": "access",
            "iat": datetime.now(UTC),
            "exp": datetime.now(UTC) + timedelta(minutes=5),
        }
        token = jwt.encode(payload, key=None, algorithm="none")

        with self.assertRaises(HTTPException) as raised:
            auth.decode_token(token)

        self.assertEqual(raised.exception.status_code, 401)
        self.assertEqual(raised.exception.detail, "Invalid token")

    def test_created_tokens_are_pinned_to_hs256(self):
        auth = load_auth_module(secret="test-secret-that-is-long-enough-for-hs256")
        token = auth.create_access_token({"sub": "u1", "address": "0xabc"})
        header = jwt.get_unverified_header(token)

        self.assertEqual(header["alg"], "HS256")
        self.assertEqual(auth.decode_token(token)["type"], "access")

    def test_revoked_token_is_rejected(self):
        auth = load_auth_module(secret="test-secret-that-is-long-enough-for-hs256")
        token = auth.create_access_token({"sub": "u1", "address": "0xabc"})

        auth.revoke_token(token)

        with self.assertRaises(HTTPException) as raised:
            auth.decode_token(token)

        self.assertEqual(raised.exception.status_code, 401)
        self.assertEqual(raised.exception.detail, "Token has been revoked")

    def test_refresh_token_is_not_accepted_as_current_user_token(self):
        auth = load_auth_module(secret="test-secret-that-is-long-enough-for-hs256")
        token = auth.create_refresh_token({"sub": "u1", "address": "0xabc"})
        payload = auth.decode_token(token)

        self.assertEqual(payload["type"], "refresh")


if __name__ == "__main__":
    unittest.main()
