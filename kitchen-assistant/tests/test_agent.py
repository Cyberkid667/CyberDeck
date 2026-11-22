"""La boucle Claude, avec un faux client qui rejoue des réponses écrites à l'avance."""

import json
from types import SimpleNamespace as NS

from assistant.agent import TOOLS, KitchenAssistant
from assistant.config import Settings
from assistant.stores import GroceryList, LocalBackend


def text(t):
    return NS(type="text", text=t)


def tool(name, args, id="tu_1"):
    return NS(type="tool_use", id=id, name=name, input=args)


class FakeClient:
    def __init__(self, responses):
        self.responses = list(responses)
        self.calls = []
        self.beta = NS(messages=NS(create=self._create))

    def _create(self, **kwargs):
        self.calls.append({**kwargs, "messages": list(kwargs["messages"])})
        return self.responses.pop(0)


def settings(tmp_path, model="claude-opus-5-5"):
    return Settings(
        assistant_name="Cuistot", model=model, effort="low", backend="local",
        keep_email="", keep_master_token="", keep_list_title="GROCERIES", keep_list_id="",
        keep_new_items_on_top=False, access_token="", conversation_timeout=120, data_dir=tmp_path,
    )


def make(tmp_path, responses, model="claude-opus-5-5"):
    grocery = GroceryList(LocalBackend(tmp_path / "l.json", "GROCERIES"))
    client = FakeClient(responses)
    return KitchenAssistant(settings(tmp_path, model), grocery, client=client), client, grocery


def test_add_flow(tmp_path):
    bot, client, grocery = make(tmp_path, [
        NS(stop_reason="tool_use", content=[tool("ajouter_articles", {"articles": ["beurre"], "forcer": False})]),
        NS(stop_reason="end_turn", content=[text("C'est noté, **beurre** ajouté.")]),
    ])
    reply = bot.handle("y'a plus de beurre")
    assert reply.text == "C'est noté, beurre ajouté."
    assert reply.list_changed and not reply.expects_answer
    assert grocery.unchecked() == ["beurre"]

    first, second = client.calls
    assert first["model"] == "claude-opus-5-5"
    assert first["output_config"] == {"effort": "low"}
    assert first["fallbacks"] == "default" and first["betas"] == ["server-side-fallback-2026-07-01"]
    assert "thinking" not in first and "tool_choice" not in first
    assert all(t["strict"] for t in first["tools"]) and first["tools"] == TOOLS
    assert "GROCERIES" in first["system"]
    # Le résultat de l'outil est renvoyé à Claude, sans l'identifiant interne
    result = second["messages"][-1]["content"][0]
    assert result["type"] == "tool_result" and result["tool_use_id"] == "tu_1"
    assert json.loads(result["content"]) == [{"article": "beurre", "statut": "ajoute", "texte": "beurre"}]


def test_question_keeps_conversation_and_reopens_mic(tmp_path):
    bot, client, grocery = make(tmp_path, [
        NS(stop_reason="end_turn", content=[text("Du lait d'avoine ou du lait de coco ?")]),
        NS(stop_reason="end_turn", content=[text("D'accord.")]),
    ])
    r1 = bot.handle("y'a plus de lait")
    assert r1.expects_answer
    r2 = bot.handle("d'avoine", r1.conversation_id)
    assert r2.conversation_id == r1.conversation_id
    # Historique en ajout seul : user, assistant, user
    roles = [m["role"] for m in client.calls[1]["messages"]]
    assert roles == ["user", "assistant", "user"]


def test_haiku_has_no_fallbacks(tmp_path):
    bot, client, _ = make(tmp_path, [NS(stop_reason="end_turn", content=[text("Ok.")])], model="claude-haiku-5-5")
    bot.handle("salut")
    assert "fallbacks" not in client.calls[0] and "betas" not in client.calls[0]


def test_refusal_is_handled(tmp_path):
    bot, client, _ = make(tmp_path, [NS(stop_reason="refusal", content=[])])
    reply = bot.handle("???")
    assert "Désolé" in reply.text


def test_tool_error_is_reported_to_claude(tmp_path):
    bot, client, grocery = make(tmp_path, [
        NS(stop_reason="tool_use", content=[tool("voir_liste", {})]),
        NS(stop_reason="end_turn", content=[text("Je n'arrive pas à lire la liste.")]),
    ])
    grocery.unchecked = lambda: (_ for _ in ()).throw(RuntimeError("Keep injoignable"))
    reply = bot.handle("qu'est-ce qu'il y a sur la liste")
    result = client.calls[1]["messages"][-1]["content"][0]
    assert result["is_error"] is True and "Keep injoignable" in result["content"]
    assert reply.text == "Je n'arrive pas à lire la liste."
