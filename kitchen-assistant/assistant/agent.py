"""Le cerveau : Claude comprend la phrase et agit sur la liste via des outils."""

from __future__ import annotations

import json
import logging
import re
import threading
import time
import uuid
from dataclasses import dataclass, field

import anthropic

from .config import Settings
from .stores import GroceryList

log = logging.getLogger(__name__)

MAX_TOOL_ROUNDS = 5

# Modèles qui acceptent le repli automatique côté serveur en cas de refus
# (`fallbacks: "default"`). Claude Haiku 5.5 ne l'accepte pas.
FALLBACK_MODELS = {
    "claude-opus-5-5", "claude-opus-5", "claude-sonnet-5-5",
    "claude-fable-5-2", "claude-fable-5-1",
}
FALLBACK_BETA = "server-side-fallback-2026-07-01"

SYSTEM_PROMPT = """\
Tu es {name}, l'assistant vocal de la cuisine. Tu tiens la liste de courses de la maison : une liste Google Keep nommée « {title} ».

Tes réponses sont lues à voix haute par une synthèse vocale :
- réponds en français, en une phrase courte (idéalement moins de 15 mots), en tutoyant ;
- pas de markdown, pas d'emoji, pas de listes à puces, pas de guillemets.

Ce que tu reçois vient d'une reconnaissance vocale : il peut y avoir des fautes (homophones, mots coupés, ponctuation absente). Retiens l'interprétation la plus plausible dans une cuisine. Si tu ne comprends vraiment pas, demande de répéter.

Ajouter à la liste :
- Dès que l'utilisateur dit qu'il manque quelque chose (« y'a plus de beurre », « on n'a plus d'œufs », « faut racheter du lait », « note les tomates », « rajoute du PQ »), appelle ajouter_articles tout de suite, sans demander confirmation.
- Écris chaque article sans déterminant, en minuscules, comme l'utilisateur le dit (« beurre », « œufs », « papier toilette »), en gardant les précisions utiles (« lait d'avoine », « 2 citrons »).
- Plusieurs articles dans la même phrase : un seul appel avec tous les articles.
- forcer vaut false, sauf quand l'utilisateur vient de confirmer qu'il veut un nouvel article, différent des articles proches qu'on lui a proposés.

Résultats de ajouter_articles :
- ajoute ou remis_sur_la_liste : confirme brièvement (« C'est noté. », « Beurre ajouté. », « J'ai mis le beurre et les œufs. »).
- deja_sur_la_liste : dis-le simplement (« Le beurre est déjà sur la liste. »).
- a_confirmer : rien n'a été ajouté, car la liste ou l'historique contient des articles proches (champ similaires). Pose une seule question courte qui propose au plus trois choix, par exemple « Du lait d'avoine ou du lait de coco ? ». Si un article proche est déjà sur la liste (sur_la_liste vrai), signale-le. Ensuite, selon la réponse :
  - il choisit un article proposé : rappelle ajouter_articles avec le texte exact de cet article ;
  - il veut autre chose (« non, du lait normal ») : rappelle ajouter_articles avec ce nom et forcer à true ;
  - il dit que c'est bon comme ça : ne fais rien de plus.
- Plusieurs articles : une seule réponse courte qui résume tout.

Autres demandes :
- « Qu'est-ce qu'il y a sur la liste ? » : appelle voir_liste. Cite les articles s'il y en a 8 ou moins, sinon donne leur nombre et les cinq premiers.
- « Je l'ai acheté », « enlève le beurre », « annule », « non, pas ça » : appelle retirer_articles.
- Une question de cuisine rapide (cuisson, conversion, remplacement d'un ingrédient) : réponds en une ou deux phrases.
- Autre chose : dis gentiment que pour l'instant tu t'occupes de la liste de courses.

Termine ta réponse par un point d'interrogation seulement quand tu attends vraiment une réponse : le micro se rouvre automatiquement après une question. Ne demande jamais « Autre chose ? ».
"""

TOOLS = [
    {
        "name": "ajouter_articles",
        "description": (
            "Ajoute un ou plusieurs articles à la liste de courses. Un article déjà présent n'est pas dupliqué ; "
            "un article déjà acheté par le passé (coché dans l'historique) est remis sur la liste. "
            "Si des articles proches mais différents existent, rien n'est ajouté et le résultat a le statut "
            "a_confirmer avec la liste des articles similaires : il faut alors demander à l'utilisateur."
        ),
        "strict": True,
        "input_schema": {
            "type": "object",
            "properties": {
                "articles": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "Noms des articles, sans déterminant, ex. [\"beurre\", \"œufs\"].",
                },
                "forcer": {
                    "type": "boolean",
                    "description": "true pour créer l'article même si des articles proches existent.",
                },
            },
            "required": ["articles", "forcer"],
            "additionalProperties": False,
        },
    },
    {
        "name": "voir_liste",
        "description": "Renvoie les articles qui restent à acheter sur la liste de courses.",
        "strict": True,
        "input_schema": {"type": "object", "properties": {}, "required": [], "additionalProperties": False},
    },
    {
        "name": "retirer_articles",
        "description": (
            "Retire des articles de la liste à acheter (achetés, ou ajoutés par erreur). "
            "Un article ajouté par erreur pendant cette conversation est supprimé ; les autres sont cochés."
        ),
        "strict": True,
        "input_schema": {
            "type": "object",
            "properties": {
                "articles": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "Noms des articles à retirer.",
                },
            },
            "required": ["articles"],
            "additionalProperties": False,
        },
    },
]


@dataclass
class Conversation:
    id: str
    messages: list = field(default_factory=list)
    created_ids: set[str] = field(default_factory=set)  # articles créés dans cette conversation
    last_used: float = field(default_factory=time.monotonic)
    lock: threading.Lock = field(default_factory=threading.Lock)


@dataclass
class Reply:
    text: str
    conversation_id: str
    expects_answer: bool
    list_changed: bool
    seconds: float


def _clean_for_speech(text: str) -> str:
    text = re.sub(r"[*_#`>]+", "", text)
    return re.sub(r"\s+", " ", text).strip()


class KitchenAssistant:
    def __init__(self, settings: Settings, grocery: GroceryList, client: anthropic.Anthropic | None = None):
        self.settings = settings
        self.grocery = grocery
        self.client = client or anthropic.Anthropic(timeout=45.0, max_retries=2)
        self.system = SYSTEM_PROMPT.format(name=settings.assistant_name, title=grocery.title)
        self._conversations: dict[str, Conversation] = {}
        self._lock = threading.Lock()

    # -- conversations --------------------------------------------------------

    def _conversation(self, conversation_id: str | None) -> Conversation:
        now = time.monotonic()
        timeout = self.settings.conversation_timeout
        with self._lock:
            for cid in [c for c, conv in self._conversations.items() if now - conv.last_used > timeout]:
                del self._conversations[cid]
            conv = self._conversations.get(conversation_id or "")
            if conv is None:
                conv = Conversation(id=conversation_id or uuid.uuid4().hex)
                self._conversations[conv.id] = conv
            conv.last_used = now
            return conv

    def reset(self, conversation_id: str) -> None:
        with self._lock:
            self._conversations.pop(conversation_id, None)

    # -- outils ---------------------------------------------------------------

    def _run_tool(self, conv: Conversation, name: str, args: dict) -> tuple[str, bool]:
        """Exécute un outil. Retourne (contenu JSON, liste modifiée ?)."""
        if name == "ajouter_articles":
            results = self.grocery.add(list(args.get("articles") or []), force=bool(args.get("forcer")))
            for r in results:
                if r["statut"] == "ajoute":
                    conv.created_ids.add(r["id"])
            changed = any(r["statut"] in {"ajoute", "remis_sur_la_liste"} for r in results)
        elif name == "voir_liste":
            items = self.grocery.unchecked()
            results = {"nombre": len(items), "articles": items}
            changed = False
        elif name == "retirer_articles":
            results = self.grocery.remove(list(args.get("articles") or []), delete_ids=conv.created_ids)
            changed = any(r["statut"] in {"coche", "supprime"} for r in results)
        else:
            raise ValueError(f"outil inconnu : {name}")
        if isinstance(results, list):  # l'identifiant interne n'intéresse pas le modèle
            results = [{k: v for k, v in r.items() if k != "id"} for r in results]
        return json.dumps(results, ensure_ascii=False), changed

    # -- boucle principale ----------------------------------------------------

    def _request_params(self) -> dict:
        params = dict(
            model=self.settings.model,
            max_tokens=8000,
            system=self.system,
            tools=TOOLS,
            output_config={"effort": self.settings.effort},
            cache_control={"type": "ephemeral"},
        )
        if self.settings.model in FALLBACK_MODELS:
            params["betas"] = [FALLBACK_BETA]
            params["fallbacks"] = "default"
        return params

    def handle(self, text: str, conversation_id: str | None = None) -> Reply:
        started = time.monotonic()
        conv = self._conversation(conversation_id)
        with conv.lock:
            reply, changed = self._handle_locked(conv, text.strip())
        seconds = time.monotonic() - started
        log.info("[%s] « %s » -> « %s » (%.1fs)", conv.id[:6], text, reply, seconds)
        return Reply(
            text=reply,
            conversation_id=conv.id,
            expects_answer=reply.rstrip().endswith("?"),
            list_changed=changed,
            seconds=round(seconds, 2),
        )

    def _handle_locked(self, conv: Conversation, text: str) -> tuple[str, bool]:
        if not text:
            return "Je n'ai rien entendu.", False

        checkpoint = len(conv.messages)
        conv.messages.append({"role": "user", "content": text})
        params = self._request_params()
        list_changed = False

        try:
            for _ in range(MAX_TOOL_ROUNDS):
                response = self.client.beta.messages.create(messages=conv.messages, **params)

                if response.stop_reason == "refusal":
                    del conv.messages[checkpoint:]
                    return "Désolé, je ne peux pas t'aider avec ça.", list_changed

                conv.messages.append({"role": "assistant", "content": response.content})

                if response.stop_reason == "pause_turn":
                    continue
                if response.stop_reason != "tool_use":
                    break

                results = []
                for block in response.content:
                    if block.type != "tool_use":
                        continue
                    try:
                        content, changed = self._run_tool(conv, block.name, block.input)
                        list_changed |= changed
                        results.append({"type": "tool_result", "tool_use_id": block.id, "content": content})
                    except Exception as exc:  # erreur Keep, réseau…
                        log.exception("Échec de l'outil %s", block.name)
                        results.append({
                            "type": "tool_result", "tool_use_id": block.id, "is_error": True,
                            "content": f"Erreur pendant l'accès à la liste : {exc}",
                        })
                conv.messages.append({"role": "user", "content": results})
            else:
                self.reset(conv.id)
                return "Je me suis un peu perdu, tu peux répéter ?", list_changed
        except anthropic.AuthenticationError:
            log.error("Clé API Anthropic invalide ou absente (ANTHROPIC_API_KEY)")
            del conv.messages[checkpoint:]
            return "Ma clé d'accès à Claude ne fonctionne pas, vérifie la configuration.", list_changed
        except anthropic.RateLimitError:
            del conv.messages[checkpoint:]
            return "Je suis un peu débordé, réessaie dans une minute.", list_changed
        except anthropic.APIStatusError as exc:
            log.error("Erreur API Claude %s : %s", exc.status_code, exc.message)
            self.reset(conv.id)
            return "J'ai eu un souci avec le serveur, tu peux répéter ?", list_changed
        except anthropic.APIConnectionError:
            log.error("Impossible de joindre l'API Claude")
            del conv.messages[checkpoint:]
            return "Je n'arrive pas à me connecter à internet.", list_changed

        text_out = " ".join(b.text for b in response.content if b.type == "text")
        if response.stop_reason == "max_tokens" and not text_out:
            return "Désolé, je n'ai pas réussi à répondre, tu peux répéter ?", list_changed
        return _clean_for_speech(text_out) or "C'est fait.", list_changed
