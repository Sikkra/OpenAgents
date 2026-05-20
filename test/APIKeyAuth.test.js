const assert = require("assert");
const fs = require("fs");
const { execFileSync } = require("child_process");

const auth = fs.readFileSync("api/middleware/auth.py", "utf8");
const models = fs.readFileSync("api/models/database.py", "utf8");
const routes = fs.readFileSync("api/routes/auth.py", "utf8");
const main = fs.readFileSync("api/main.py", "utf8");
const requirements = fs.readFileSync("api/requirements.txt", "utf8");

execFileSync("python", [
  "-B",
  "-m",
  "py_compile",
  "api/middleware/auth.py",
  "api/models/database.py",
  "api/routes/auth.py",
  "api/main.py",
]);

assert(models.includes("class APIKey(Base):"), "APIKey model should be stored in the database");
assert(models.includes("key_hash = Column(String(64)"), "API keys should be stored as SHA-256 hashes");
assert(models.includes("revoked = Column(Integer"), "API key revocation state should be persisted");

assert(auth.includes("Header(None, alias=\"X-API-Key\")"), "X-API-Key header should be accepted");
assert(auth.includes("hashlib.sha256"), "API key hashing should use SHA-256");
assert(auth.includes("secrets.token_urlsafe"), "raw API keys should be generated from secure randomness");
assert(auth.includes("authenticate_api_key(db, x_api_key)"), "API key auth should be an alternative to bearer JWT");
assert(auth.includes("\"auth_type\": \"api_key\""), "API-key users should be marked for downstream rate limiting");
assert(auth.includes("\"rate_limit_tier\": \"api_key\""), "API-key auth should expose a distinct rate-limit tier");
assert(auth.includes("\"auth_type\": \"jwt\""), "JWT auth should continue to work");

assert(routes.includes("@router.post(\"/api-keys\""), "API key creation endpoint should exist");
assert(routes.includes("@router.delete(\"/api-keys/{key_id}\""), "API key revocation endpoint should exist");
assert(routes.includes("api_key.revoked = 1"), "revocation should immediately disable the key");
assert(routes.includes("api_key=raw_key"), "the unhashed API key should be returned once on creation");
assert(main.includes("app.include_router(auth_router)"), "auth routes should be registered with the API app");
assert(requirements.includes("PyJWT"), "PyJWT should be declared for JWT auth imports");
assert(requirements.includes("SQLAlchemy"), "SQLAlchemy should be declared for API-key storage");

console.log("API key auth checks passed");
