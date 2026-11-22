from assistant import matching


def test_key_ignores_case_accents_articles_plural_and_numbers():
    assert matching.key("Beurre") == matching.key("du beurre")
    assert matching.key("Carottes") == matching.key("carotte")
    assert matching.key("2 Smoked tofu") == matching.key("smoked tofu")
    assert matching.key("Œufs") == matching.key("oeuf")
    assert matching.key("Pâtes") == matching.key("pates")


def test_similar_when_words_included():
    assert matching.is_similar("lait", "lait de coco pas de thaïlande")
    assert matching.is_similar("tofu", "2 Smoked tofu")
    assert matching.is_similar("carottes", "carottes snack")
    assert not matching.is_similar("beurre", "Beurre")  # identique, pas « proche »
    assert not matching.is_similar("beurre", "fromage")
