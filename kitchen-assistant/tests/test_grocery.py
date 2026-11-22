import json

from assistant.stores import GroceryList, LocalBackend


def make_list(tmp_path, items):
    path = tmp_path / "liste.json"
    path.write_text(json.dumps([
        {"id": f"i{n}", "text": text, "checked": checked} for n, (text, checked) in enumerate(items)
    ]))
    return GroceryList(LocalBackend(path, "GROCERIES")), path


def saved(path):
    return [(i["text"], i["checked"]) for i in json.loads(path.read_text())]


def test_add_new_item(tmp_path):
    g, path = make_list(tmp_path, [("Fromage", False)])
    [r] = g.add(["beurre"])
    assert r["statut"] == "ajoute"
    assert ("beurre", False) in saved(path)


def test_already_on_list(tmp_path):
    g, path = make_list(tmp_path, [("Beurre", False)])
    [r] = g.add(["du beurre"])
    assert r == {"article": "du beurre", "statut": "deja_sur_la_liste", "texte": "Beurre"}
    assert len(saved(path)) == 1


def test_checked_item_is_unchecked_instead_of_duplicated(tmp_path):
    g, path = make_list(tmp_path, [("Olive oil", True), ("Fromage", False)])
    [r] = g.add(["olive oil"])
    assert r["statut"] == "remis_sur_la_liste"
    assert saved(path) == [("Fromage", False), ("Olive oil", False)]  # remis en bas


def test_similar_items_need_confirmation(tmp_path):
    g, path = make_list(tmp_path, [("lait de coco pas de thaïlande", False), ("Lait d'avoine", True)])
    [r] = g.add(["lait"])
    assert r["statut"] == "a_confirmer"
    assert r["similaires"] == [
        {"texte": "lait de coco pas de thaïlande", "sur_la_liste": True},
        {"texte": "Lait d'avoine", "sur_la_liste": False},
    ]
    assert len(saved(path)) == 2  # rien d'ajouté

    [r] = g.add(["Lait d'avoine"])  # l'utilisateur choisit une variante
    assert r["statut"] == "remis_sur_la_liste"

    [r] = g.add(["lait"], force=True)  # ou veut vraiment du « lait »
    assert r["statut"] == "ajoute"


def test_remove_checks_existing_and_deletes_fresh_mistakes(tmp_path):
    g, path = make_list(tmp_path, [("Beurre", False)])
    [added] = g.add(["piri piri"])
    results = g.remove(["beurre", "piri piri"], delete_ids={added["id"]})
    assert [r["statut"] for r in results] == ["coche", "supprime"]
    assert saved(path) == [("Beurre", True)]
    assert g.remove(["chocolat"])[0]["statut"] == "pas_sur_la_liste"


def test_unchecked(tmp_path):
    g, _ = make_list(tmp_path, [("A", False), ("B", True), ("C", False)])
    assert g.unchecked() == ["A", "C"]
