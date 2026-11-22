"""Serveur HTTP : l'interface vocale (page web) et une petite API JSON.

Lancer :  python -m assistant.server
"""

from __future__ import annotations

import argparse
import hmac
import logging
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, PlainTextResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from . import config
from .agent import KitchenAssistant

log = logging.getLogger("assistant")
WEB_DIR = Path(__file__).resolve().parent.parent / "web"

state: dict = {}


@asynccontextmanager
async def lifespan(app: FastAPI):
    settings = config.load()
    grocery = config.make_grocery_list(settings)
    state["settings"] = settings
    state["grocery"] = grocery
    state["assistant"] = KitchenAssistant(settings, grocery)
    log.info("Assistant « %s » prêt (modèle %s, liste « %s », backend %s)",
             settings.assistant_name, settings.model, grocery.title, settings.backend)
    if not settings.access_token:
        log.warning("ASSISTANT_TOKEN n'est pas défini : n'expose pas ce serveur sur internet.")
    yield
    state.clear()


app = FastAPI(title="Assistant cuisine", lifespan=lifespan)


def check_token(request: Request) -> None:
    expected = state["settings"].access_token
    if not expected:
        return
    given = request.headers.get("authorization", "").removeprefix("Bearer ").strip()
    given = given or request.query_params.get("token", "")
    if not hmac.compare_digest(given.encode(), expected.encode()):
        raise HTTPException(status_code=401, detail="Jeton d'accès manquant ou invalide")


class MessageIn(BaseModel):
    text: str = Field(..., max_length=1000)
    conversation_id: str | None = Field(default=None, max_length=100)


class MessageOut(BaseModel):
    reply: str
    conversation_id: str
    expects_answer: bool
    list_changed: bool
    seconds: float


# Les routes sont synchrones : FastAPI les exécute dans un pool de threads,
# ce qui convient aux appels bloquants (Claude, Google Keep).


@app.post("/api/message", response_model=MessageOut, dependencies=[Depends(check_token)])
def post_message(msg: MessageIn, format: str = "json"):
    reply = state["assistant"].handle(msg.text, msg.conversation_id)
    if format == "text":  # pratique pour un raccourci Siri
        return PlainTextResponse(reply.text)
    return MessageOut(
        reply=reply.text,
        conversation_id=reply.conversation_id,
        expects_answer=reply.expects_answer,
        list_changed=reply.list_changed,
        seconds=reply.seconds,
    )


@app.post("/api/reset", dependencies=[Depends(check_token)])
def post_reset(conversation_id: str):
    state["assistant"].reset(conversation_id)
    return {"ok": True}


@app.get("/api/list", dependencies=[Depends(check_token)])
def get_list():
    grocery = state["grocery"]
    return {"title": grocery.title, "items": grocery.unchecked()}


@app.get("/api/config", dependencies=[Depends(check_token)])
def get_config():
    s = state["settings"]
    return {"assistant_name": s.assistant_name, "list_title": state["grocery"].title}


@app.get("/")
def index():
    return FileResponse(WEB_DIR / "index.html", headers={"Cache-Control": "no-cache"})


app.mount("/", StaticFiles(directory=WEB_DIR), name="web")


def main() -> None:
    import uvicorn

    parser = argparse.ArgumentParser(description="Assistant vocal de cuisine")
    parser.add_argument("--host", default="0.0.0.0", help="0.0.0.0 = accessible depuis le réseau local")
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--ssl-certfile", help="certificat HTTPS (le micro du navigateur exige HTTPS)")
    parser.add_argument("--ssl-keyfile")
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    uvicorn.run(app, host=args.host, port=args.port,
                ssl_certfile=args.ssl_certfile, ssl_keyfile=args.ssl_keyfile)


if __name__ == "__main__":
    main()
