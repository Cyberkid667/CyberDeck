"""Obtenir le « jeton maître » Google nécessaire pour lire et écrire dans Keep.

Google n'offre pas d'API Keep officielle pour les comptes Gmail personnels :
on passe par gkeepapi (non officielle), qui s'authentifie avec ce jeton.

Étapes :
  1. Sur un ordinateur, ouvre une fenêtre de navigation privée et va sur
     https://accounts.google.com/EmbeddedSetup
  2. Connecte-toi avec ton compte Google, accepte les conditions
     (la page peut ensuite tourner dans le vide : c'est normal).
  3. Ouvre les outils de développement (F12) > Application (ou Stockage) > Cookies
     > https://accounts.google.com, et copie la valeur du cookie « oauth_token »
     (elle commence par « oauth2_4/ »). Elle n'est valable que quelques minutes.
  4. Lance :  python tools/get_master_token.py
     et colle ton adresse e-mail puis la valeur du cookie.

Le jeton maître (« aas_et/… ») donne un accès complet à ton compte Google :
garde-le uniquement dans le fichier .env, sur ta machine.
"""

from __future__ import annotations

import getpass
import secrets
import sys

import gpsoauth


def main() -> int:
    email = input("Adresse e-mail Google : ").strip()
    oauth_token = getpass.getpass("Valeur du cookie oauth_token (masquée) : ").strip()
    android_id = secrets.token_hex(8)

    result = gpsoauth.exchange_token(email, oauth_token, android_id)
    master = result.get("Token")
    if not master:
        print("\nÉchec : Google n'a pas renvoyé de jeton.", file=sys.stderr)
        print(f"Réponse : {result.get('Error') or result}", file=sys.stderr)
        print("Le cookie expire vite : recommence l'étape 1 et colle-le tout de suite.", file=sys.stderr)
        return 1

    print("\nC'est bon ! Ajoute ces lignes dans ton fichier .env :\n")
    print(f"KEEP_EMAIL={email}")
    print(f"KEEP_MASTER_TOKEN={master}")
    print("GROCERY_BACKEND=keep")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
