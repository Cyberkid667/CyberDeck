from types import SimpleNamespace as NS

import pytest
from fastapi.testclient import TestClient


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("GROCERY_BACKEND", "local")
    monkeypatch.setenv("ASSISTANT_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("ASSISTANT_TOKEN", "secret")
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test")
    from assistant import server

    with TestClient(server.app) as c:
        fake = NS(beta=NS(messages=NS(create=lambda **kw: NS(
            stop_reason="end_turn", content=[NS(type="text", text="Tu veux du beurre doux ?")]))))
        server.state["assistant"].client = fake
        yield c


def test_page_is_public(client):
    assert client.get("/").status_code == 200
    assert client.get("/app.js").status_code == 200


def test_api_requires_token(client):
    assert client.get("/api/list").status_code == 401
    assert client.get("/api/list", headers={"Authorization": "Bearer nope"}).status_code == 401
    r = client.get("/api/list", headers={"Authorization": "Bearer secret"})
    assert r.json() == {"title": "GROCERIES", "items": []}


def test_message(client):
    r = client.post("/api/message?token=secret", json={"text": "y'a plus de beurre"})
    body = r.json()
    assert body["reply"] == "Tu veux du beurre doux ?" and body["expects_answer"] is True
    r = client.post("/api/message?token=secret&format=text", json={"text": "oui", "conversation_id": "siri"})
    assert r.text == "Tu veux du beurre doux ?"
