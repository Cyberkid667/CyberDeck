"""Accès à la liste de courses : Google Keep, ou un fichier local pour tester.

Les deux backends exposent la même petite interface ; toute la logique
(« déjà sur la liste », « je le décoche au lieu de le recréer », etc.)
est dans `GroceryList`, qui ne dépend pas du backend.
"""

from __future__ import annotations

import json
import logging
import threading
import uuid
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Protocol

from . import matching

log = logging.getLogger(__name__)


@dataclass
class Item:
    id: str
    text: str
    checked: bool


class Backend(Protocol):
    title: str

    def refresh(self) -> list[Item]: ...
    def add(self, text: str) -> Item: ...
    def set_checked(self, item_id: str, checked: bool) -> None: ...
    def delete(self, item_id: str) -> None: ...
    def commit(self) -> None: ...


# --------------------------------------------------------------------------
# Backend local (fichier JSON) : pour tester la voix sans toucher à Keep.
# --------------------------------------------------------------------------


class LocalBackend:
    def __init__(self, path: Path, title: str = "Liste de courses") -> None:
        self.path = path
        self.title = title
        self._items: list[dict] = []
        if path.exists():
            self._items = json.loads(path.read_text(encoding="utf-8"))

    def refresh(self) -> list[Item]:
        return [Item(i["id"], i["text"], i["checked"]) for i in self._items]

    def add(self, text: str) -> Item:
        item = Item(uuid.uuid4().hex[:12], text, False)
        self._items.append(asdict(item))
        return item

    def _find(self, item_id: str) -> dict:
        return next(i for i in self._items if i["id"] == item_id)

    def set_checked(self, item_id: str, checked: bool) -> None:
        raw = self._find(item_id)
        raw["checked"] = checked
        if not checked:  # remis sur la liste : on le place en bas, comme un nouvel article
            self._items.remove(raw)
            self._items.append(raw)

    def delete(self, item_id: str) -> None:
        self._items.remove(self._find(item_id))

    def commit(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.path.write_text(json.dumps(self._items, ensure_ascii=False, indent=1), encoding="utf-8")


# --------------------------------------------------------------------------
# Backend Google Keep (API non officielle gkeepapi).
# --------------------------------------------------------------------------


class KeepBackend:
    """Une note-liste Google Keep, retrouvée par son titre (ex. « GROCERIES »)."""

    def __init__(
        self,
        email: str,
        master_token: str,
        list_title: str,
        state_path: Path,
        new_items_on_top: bool = False,
        list_id: str | None = None,
    ) -> None:
        import gkeepapi  # import tardif : inutile en mode local
        import gkeepapi.exception  # noqa: F401

        self._gkeepapi = gkeepapi
        self.keep = gkeepapi.Keep()
        self.state_path = state_path
        self.list_title = list_title
        self.list_id = list_id
        self.new_items_on_top = new_items_on_top

        state = None
        if state_path.exists():
            try:
                state = json.loads(state_path.read_text(encoding="utf-8"))
            except ValueError:
                state = None
        log.info("Connexion à Google Keep (%s)…", email)
        self.keep.authenticate(email, master_token, state=state, sync=True)
        self._save_state()
        self.note = self._find_list()
        self.title = self.note.title or list_title
        log.info("Liste Keep trouvée : « %s » (%d articles)", self.title, len(self.note.items))

    def _find_list(self):
        node = self._gkeepapi.node
        if self.list_id:
            note = self.keep.get(self.list_id)
            if isinstance(note, node.List):
                return note
            raise RuntimeError(f"KEEP_LIST_ID={self.list_id} ne correspond à aucune liste Keep.")

        wanted = self.list_title.strip().lower()
        candidates = [
            n for n in self.keep.all()
            if isinstance(n, node.List) and not n.trashed and (n.title or "").strip().lower() == wanted
        ]
        if not candidates:
            titles = sorted({n.title for n in self.keep.all() if isinstance(n, node.List) and n.title})
            raise RuntimeError(
                f"Aucune liste Keep nommée « {self.list_title} ». Listes trouvées : {', '.join(titles) or 'aucune'}"
            )
        # Plusieurs listes du même nom : on prend l'épinglée, puis la plus récente.
        candidates.sort(key=lambda n: (n.pinned, n.timestamps.updated), reverse=True)
        return candidates[0]

    def _save_state(self) -> None:
        try:
            self.state_path.parent.mkdir(parents=True, exist_ok=True)
            self.state_path.write_text(json.dumps(self.keep.dump()), encoding="utf-8")
        except Exception:  # le cache n'est qu'une optimisation
            log.warning("Impossible d'enregistrer le cache Keep", exc_info=True)

    def _sync(self) -> None:
        try:
            self.keep.sync()
        except self._gkeepapi.exception.ResyncRequiredException:
            self.keep.sync(resync=True)

    def refresh(self) -> list[Item]:
        self._sync()  # récupère ce qui a été modifié depuis l'appli Keep
        self.note = self.keep.get(self.note.id) or self._find_list()
        return [Item(i.id, i.text, i.checked) for i in self.note.items if not i.deleted]

    def _placement(self):
        p = self._gkeepapi.node.NewListItemPlacementValue
        return p.Top if self.new_items_on_top else p.Bottom

    def add(self, text: str) -> Item:
        li = self.note.add(text, False, self._placement())
        return Item(li.id, li.text, False)

    def set_checked(self, item_id: str, checked: bool) -> None:
        li = self.note.get(item_id)
        li.checked = checked
        if not checked:
            # Remis sur la liste : même place qu'un nouvel article.
            others = [int(i.sort) for i in self.note.items if i.id != item_id]
            if others:
                delta = self.note.SORT_DELTA
                li.sort = max(others) + delta if self.new_items_on_top else min(others) - delta

    def delete(self, item_id: str) -> None:
        self.note.get(item_id).delete()

    def commit(self) -> None:
        self._sync()
        self._save_state()


# --------------------------------------------------------------------------
# Logique métier commune.
# --------------------------------------------------------------------------

MAX_SIMILAR = 5


class GroceryList:
    def __init__(self, backend: Backend) -> None:
        self.backend = backend
        self.lock = threading.Lock()

    @property
    def title(self) -> str:
        return self.backend.title

    def unchecked(self) -> list[str]:
        with self.lock:
            return [i.text for i in self.backend.refresh() if not i.checked]

    @staticmethod
    def _similar(name: str, items: list[Item]) -> list[dict]:
        found = [i for i in items if matching.is_similar(name, i.text)]
        found.sort(key=lambda i: i.checked)  # ceux déjà sur la liste d'abord
        seen, out = set(), []
        for i in found:
            k = matching.key(i.text)
            if k in seen:
                continue
            seen.add(k)
            out.append({"texte": i.text, "sur_la_liste": not i.checked})
        return out[:MAX_SIMILAR]

    def add(self, names: list[str], force: bool = False) -> list[dict]:
        """Ajoute des articles. Retourne un résultat par article pour l'assistant.

        Statuts :
          - deja_sur_la_liste : un article identique est déjà à acheter
          - remis_sur_la_liste : il était coché (historique), on l'a décoché
          - a_confirmer : rien d'identique, mais des articles proches existent ;
            rien n'a été ajouté, il faut demander à l'utilisateur
          - ajoute : nouvel article créé
        """
        results: list[dict] = []
        with self.lock:
            items = self.backend.refresh()
            changed = False
            for raw in names:
                name = raw.strip()
                if not name:
                    continue
                k = matching.key(name)
                same = [i for i in items if matching.key(i.text) == k] if k else []
                unchecked = next((i for i in same if not i.checked), None)
                if unchecked:
                    results.append({"article": name, "statut": "deja_sur_la_liste", "texte": unchecked.text})
                    continue
                if same:
                    item = same[0]
                    self.backend.set_checked(item.id, False)
                    item.checked = False
                    changed = True
                    results.append({"article": name, "statut": "remis_sur_la_liste", "texte": item.text,
                                    "id": item.id})
                    continue
                similar = self._similar(name, items)
                if similar and not force:
                    results.append({"article": name, "statut": "a_confirmer", "similaires": similar})
                    continue
                item = self.backend.add(name)
                items.append(item)
                changed = True
                results.append({"article": name, "statut": "ajoute", "texte": item.text, "id": item.id})
            if changed:
                self.backend.commit()
        return results

    def remove(self, names: list[str], delete_ids: set[str] | None = None) -> list[dict]:
        """Retire des articles de la liste à acheter.

        Par défaut l'article est coché (il reste dans l'historique de Keep).
        S'il vient d'être créé dans la conversation en cours (`delete_ids`),
        on le supprime carrément : c'était sans doute une erreur.
        """
        delete_ids = delete_ids or set()
        results: list[dict] = []
        with self.lock:
            items = self.backend.refresh()
            changed = False
            for raw in names:
                name = raw.strip()
                k = matching.key(name)
                active = [i for i in items if not i.checked]
                target = next((i for i in active if matching.key(i.text) == k), None)
                if target is None:
                    close = [i for i in active if matching.is_similar(name, i.text)]
                    if len(close) == 1:
                        target = close[0]
                    elif close:
                        results.append({"article": name, "statut": "ambigu",
                                        "candidats": [i.text for i in close[:MAX_SIMILAR]]})
                        continue
                if target is None:
                    results.append({"article": name, "statut": "pas_sur_la_liste"})
                    continue
                if target.id in delete_ids:
                    self.backend.delete(target.id)
                    items.remove(target)
                    results.append({"article": name, "statut": "supprime", "texte": target.text})
                else:
                    self.backend.set_checked(target.id, True)
                    target.checked = True
                    results.append({"article": name, "statut": "coche", "texte": target.text})
                changed = True
            if changed:
                self.backend.commit()
        return results
