from fastapi.testclient import TestClient

from api.main import app


client = TestClient(app)


def openapi_schema():
    response = client.get("/openapi.json")
    assert response.status_code == 200
    return response.json()


def test_security_schemes_are_documented():
    schema = openapi_schema()

    security_schemes = schema["components"]["securitySchemes"]
    assert security_schemes["JWTBearer"]["type"] == "http"
    assert security_schemes["JWTBearer"]["scheme"] == "bearer"
    assert security_schemes["JWTBearer"]["bearerFormat"] == "JWT"
    assert security_schemes["ApiKeyAuth"]["type"] == "apiKey"
    assert security_schemes["ApiKeyAuth"]["in"] == "header"
    assert security_schemes["ApiKeyAuth"]["name"] == "X-API-Key"


def test_protected_endpoints_have_security_requirements():
    schema = openapi_schema()

    assert schema["paths"]["/agents"]["get"]["security"] == [
        {"JWTBearer": []},
        {"ApiKeyAuth": []},
    ]
    assert schema["paths"]["/tasks/{task_id}"]["get"]["security"] == [
        {"JWTBearer": []},
        {"ApiKeyAuth": []},
    ]
    assert "security" not in schema["paths"]["/health"]["get"]


def test_error_responses_are_documented_with_schema_refs():
    schema = openapi_schema()
    responses = schema["paths"]["/agents/{agent_id}"]["get"]["responses"]

    for status in ["400", "401", "403", "404", "429"]:
        content = responses[status]["content"]["application/json"]
        assert content["schema"]["$ref"] == "#/components/schemas/ErrorResponse"
        assert "code" in content["example"]


def test_models_include_examples():
    schema = openapi_schema()
    schemas = schema["components"]["schemas"]

    assert schemas["AgentResponse"]["example"]["agent_id"] == "agent-123"
    assert schemas["TaskResponse"]["example"]["task_id"] == 101
    assert schemas["LeaderboardEntry"]["example"]["success_rate"] == 0.95
    assert schemas["ErrorResponse"]["example"]["code"] == "NOT_FOUND"
