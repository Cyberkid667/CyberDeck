"""Comparaison tolérante des noms d'articles.

« Beurre », « du beurre » et « beurres » doivent être vus comme le même article,
et « lait » doit être reconnu comme proche de « lait de coco pas de thaïlande ».
"""

from __future__ import annotations

import re
import unicodedata

# Petits mots qui ne servent pas à distinguer deux articles.
STOP_WORDS = {
    "de", "du", "des", "d", "la", "le", "les", "l", "un", "une",
    "a", "au", "aux", "en", "et", "pour", "pas", "avec", "sans",
    "the", "of", "and",
}


def strip_accents(text: str) -> str:
    decomposed = unicodedata.normalize("NFKD", text)
    return "".join(c for c in decomposed if not unicodedata.combining(c))


def _singular(word: str) -> str:
    # Pluriel français naïf : carottes -> carotte, poireaux -> poireau.
    if len(word) > 3 and word[-1] in "sx":
        return word[:-1]
    return word


def words(text: str) -> tuple[str, ...]:
    """Mots significatifs, sans accents, sans chiffres, au singulier."""
    text = strip_accents(text.lower())
    text = text.replace("œ", "oe").replace("æ", "ae")
    tokens = re.findall(r"[a-z]+", text)
    return tuple(_singular(t) for t in tokens if t not in STOP_WORDS)


def key(text: str) -> str:
    """Clé de comparaison exacte : « 2 Smoked tofu » == « smoked tofu »."""
    return " ".join(words(text))


def is_similar(a: str, b: str) -> bool:
    """Vrai si tous les mots de l'un se retrouvent dans l'autre (sans être identiques)."""
    wa, wb = set(words(a)), set(words(b))
    if not wa or not wb or wa == wb:
        return False
    return wa <= wb or wb <= wa
