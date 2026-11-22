"""Réglages, lus depuis les variables d'environnement (ou le fichier .env)."""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent.parent
load_dotenv(ROOT / ".env")


def _bool(name: str, default: bool) -> bool:
    value = os.getenv(name)
    if value is None or value.strip() == "":
        return default
    return value.strip().lower() in {"1", "true", "yes", "oui", "on"}


@dataclass(frozen=True)
class Settings:
    assistant_name: str
    model: str
    effort: str
    backend: str
    keep_email: str
    keep_master_token: str
    keep_list_title: str
    keep_list_id: str
    keep_new_items_on_top: bool
    access_token: str
    conversation_timeout: int
    data_dir: Path


def load() -> Settings:
    return Settings(
        assistant_name=os.getenv("ASSISTANT_NAME", "Cuistot"),
        model=os.getenv("ASSISTANT_MODEL", "claude-opus-5-5"),
        effort=os.getenv("ASSISTANT_EFFORT", "low"),
        backend=os.getenv("GROCERY_BACKEND", "local").strip().lower(),
        keep_email=os.getenv("KEEP_EMAIL", ""),
        keep_master_token=os.getenv("KEEP_MASTER_TOKEN", ""),
        keep_list_title=os.getenv("KEEP_LIST_TITLE", "GROCERIES"),
        keep_list_id=os.getenv("KEEP_LIST_ID", ""),
        keep_new_items_on_top=_bool("KEEP_NEW_ITEMS_ON_TOP", False),
        access_token=os.getenv("ASSISTANT_TOKEN", ""),
        conversation_timeout=int(os.getenv("ASSISTANT_CONVERSATION_TIMEOUT", "120")),
        data_dir=Path(os.getenv("ASSISTANT_DATA_DIR", str(ROOT / "data"))),
    )


def make_grocery_list(settings: Settings):
    from .stores import GroceryList, KeepBackend, LocalBackend

    if settings.backend == "keep":
        if not settings.keep_email or not settings.keep_master_token:
            raise SystemExit(
                "GROCERY_BACKEND=keep demande KEEP_EMAIL et KEEP_MASTER_TOKEN dans .env "
                "(voir tools/get_master_token.py)."
            )
        backend = KeepBackend(
            email=settings.keep_email,
            master_token=settings.keep_master_token,
            list_title=settings.keep_list_title,
            list_id=settings.keep_list_id or None,
            state_path=settings.data_dir / "keep_state.json",
            new_items_on_top=settings.keep_new_items_on_top,
        )
    elif settings.backend == "local":
        backend = LocalBackend(settings.data_dir / "liste_locale.json", title=settings.keep_list_title)
    else:
        raise SystemExit(f"GROCERY_BACKEND inconnu : {settings.backend!r} (attendu : keep ou local)")
    return GroceryList(backend)
