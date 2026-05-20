from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool
from fastapi.testclient import TestClient

from api.main import app
from api.middleware.auth import generate_login_tokens, hash_api_key
from api.models.database import APIKey, Base, get_db


def build_client():
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    TestingSessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
    Base.metadata.create_all(bind=engine)

    def override_get_db():
        db = TestingSessionLocal()
        try:
            yield db
        finally:
            db.close()

    app.dependency_overrides[get_db] = override_get_db
    return TestClient(app), TestingSessionLocal


def auth_header():
    token = generate_login_tokens("user-1", "0x0000000000000000000000000000000000000001", ["agent"])["token"]
    return {"Authorization": f"Bearer {token}"}


def test_jwt_auth_still_works():
    client, _ = build_client()

    response = client.get("/auth/me", headers=auth_header())

    assert response.status_code == 200
    assert response.json()["id"] == "user-1"
    assert response.json()["auth_type"] == "jwt"
    app.dependency_overrides.clear()


def test_api_key_generation_stores_hash_and_authenticates():
    client, SessionLocal = build_client()

    created = client.post("/auth/api-keys", json={"name": "ci-key"}, headers=auth_header())
    assert created.status_code == 200
    api_key = created.json()["key"]
    key_id = created.json()["id"]
    assert api_key.startswith("oa_")

    db = SessionLocal()
    stored = db.query(APIKey).filter(APIKey.id == key_id).one()
    assert stored.key_hash == hash_api_key(api_key)
    assert stored.key_hash != api_key
    db.close()

    me = client.get("/auth/me", headers={"X-API-Key": api_key})
    assert me.status_code == 200
    assert me.json()["auth_type"] == "api_key"
    assert me.json()["api_key_id"] == key_id
    assert me.json()["rate_limit_tier"] == "api_key"
    app.dependency_overrides.clear()


def test_revoked_api_key_fails_immediately():
    client, _ = build_client()

    created = client.post("/auth/api-keys", json={"name": "revoke-me"}, headers=auth_header())
    api_key = created.json()["key"]
    key_id = created.json()["id"]

    revoked = client.delete(f"/auth/api-keys/{key_id}", headers=auth_header())
    assert revoked.status_code == 200
    assert revoked.json()["revoked"] is True

    response = client.get("/auth/me", headers={"X-API-Key": api_key})
    assert response.status_code == 401
    app.dependency_overrides.clear()
