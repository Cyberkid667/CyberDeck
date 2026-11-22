# Cuistot : assistant vocal de cuisine

Tu dis « **y'a plus de beurre** », il l'ajoute à ta liste Google Keep **GROCERIES** et te répond « C'est noté ».
S'il a un doute, il te pose une question (« Du lait d'avoine ou du lait de coco ? ») et le micro se rouvre tout seul pour ta réponse.

Ce dossier contient le **prototype pour téléphone** : un petit serveur + une page web vocale. Le même serveur servira plus tard pour l'appareil fixé au mur (tablette Android ou Raspberry Pi).

```
 Téléphone (page web)                   Serveur (ton PC, plus tard un Raspberry Pi)
 ┌──────────────────────┐   texte   ┌───────────────────────────────────────────┐
 │ micro → reconnaissance│ ───────▶ │ Claude comprend la phrase                  │
 │ vocale du navigateur  │           │   └─ outils : ajouter / voir / retirer ──▶ Google Keep
 │ haut-parleur ◀── voix │ ◀─────── │ réponse courte en français                 │
 └──────────────────────┘  réponse  └───────────────────────────────────────────┘
```

## Ce qu'il sait faire

| Tu dis | Il fait |
|---|---|
| « Y'a plus de beurre » / « On n'a plus d'œufs ni de farine » | Ajoute les articles |
| « Y'a plus d'olive oil » (déjà acheté par le passé) | **Décoche** l'article existant au lieu de créer un doublon : tes 354 articles cochés servent d'historique |
| « Y'a plus de beurre » (déjà sur la liste) | « Le beurre est déjà sur la liste. » |
| « Y'a plus de lait » (tu as « lait de coco » et « lait d'avoine ») | Te demande lequel, puis ajoute le bon |
| « Qu'est-ce qu'il y a sur la liste ? » | Te la lit |
| « Enlève le fromage » / « Annule » / « Je l'ai acheté » | Coche l'article (ou le supprime s'il vient d'être ajouté par erreur) |
| « Combien de temps pour un œuf mollet ? » | Répond en une phrase |

La comparaison des noms ignore les majuscules, les accents, les déterminants, le pluriel et les quantités : « du beurre » = « Beurre », « smoked tofu » = « 2 Smoked tofu ».

## 1. Installer (10 minutes)

Il te faut **Python 3.10 ou plus récent** sur ton ordinateur, et une **clé API Claude** ([platform.claude.com](https://platform.claude.com/) › Settings › API keys).

```bash
cd kitchen-assistant
python -m venv .venv
# Windows :        .venv\Scripts\activate
# macOS / Linux :  source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env        # Windows : copy .env.example .env
```

Ouvre `.env` et colle ta clé dans `ANTHROPIC_API_KEY=`.

## 2. Essayer au clavier, sans toucher à Keep

Par défaut (`GROCERY_BACKEND=local`), la liste est un simple fichier `data/liste_locale.json`.

```bash
python tools/chat_cli.py
```

```
toi > y'a plus de beurre
cuistot > Beurre ajouté.   (1.8s)
```

## 3. Brancher ta vraie liste Google Keep

Google ne propose pas d'API Keep officielle pour les comptes Gmail perso. On passe par [gkeepapi](https://github.com/kiwiz/gkeepapi), une librairie **non officielle** qui a besoin d'un « jeton maître » Google :

1. Sur ton ordinateur, ouvre une **fenêtre de navigation privée** et va sur `https://accounts.google.com/EmbeddedSetup`.
2. Connecte-toi et accepte les conditions (la page peut ensuite tourner dans le vide, c'est normal).
3. Ouvre les outils de développement (**F12**) › **Application** (Chrome) ou **Stockage** (Firefox) › **Cookies** › `accounts.google.com`, et copie la valeur du cookie **`oauth_token`** (elle commence par `oauth2_4/`). Elle expire vite : enchaîne avec l'étape suivante.
4. Lance `python tools/get_master_token.py`, colle ton e-mail puis le cookie. Copie les lignes affichées dans `.env` (`KEEP_EMAIL`, `KEEP_MASTER_TOKEN`, `GROCERY_BACKEND=keep`).
5. Vérifie que `KEEP_LIST_TITLE=GROCERIES` correspond bien au titre de ta note, puis relance `python tools/chat_cli.py`.

> **Sécurité.** Le jeton maître donne un accès complet au compte Google : il ne quitte jamais ton fichier `.env`. Pour limiter le risque, tu peux créer un **compte Google dédié** à l'assistant, **partager** la note GROCERIES avec lui depuis Keep (Collaborateur), et utiliser le jeton de ce compte-là.

## 4. Utiliser le téléphone comme micro

Lance le serveur sur ton ordinateur :

```bash
python -m assistant.server
```

Le navigateur du téléphone n'autorise le micro que sur une adresse **https**. Deux façons simples :

**Tailscale (recommandé, privé, gratuit)**
1. Installe [Tailscale](https://tailscale.com/download) sur l'ordinateur et sur l'iPhone, avec le même compte.
2. Dans la console Tailscale, onglet **DNS**, active **HTTPS Certificates**.
3. Sur l'ordinateur : `tailscale serve --bg 8000`. La commande affiche une adresse du type `https://mon-pc.tailXXXX.ts.net`.
4. Ouvre cette adresse dans Safari sur l'iPhone.

**Tunnel Cloudflare (rapide, mais public)**
1. Mets un mot de passe dans `.env` : `ASSISTANT_TOKEN=une-longue-phrase-secrete`, et relance le serveur.
2. Installe [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/) puis lance `cloudflared tunnel --url http://localhost:8000`.
3. Ouvre `https://xxxx.trycloudflare.com/?token=une-longue-phrase-secrete` sur le téléphone (le jeton est mémorisé ensuite). L'adresse change à chaque lancement.

Ensuite, dans Safari : **Partager › Sur l'écran d'accueil**. Cuistot s'ouvre alors en plein écran comme une appli. Appuie sur le gros bouton, parle, il répond à voix haute. Sur iPhone, la dictée de Siri doit être activée (Réglages › Général › Clavier › Activer la dictée).

### Mains libres sur iPhone : « Dis Siri, Cuistot »

Sur iPhone, une page web ne peut pas écouter en arrière-plan ni écran verrouillé. Pour parler sans rien toucher, crée un raccourci Siri :

1. App **Raccourcis** › **+** › nomme-le **Cuistot**.
2. Action **Dicter du texte** (langue : Français).
3. Action **Obtenir le contenu de l'URL** :
   - URL : `https://TON-ADRESSE/api/message?format=text&token=TON_JETON` (sans `&token=…` si tu n'as pas mis de jeton)
   - Méthode : **POST**, Corps de la requête : **JSON**
   - Champ `text` = *Texte dicté* ; champ `conversation_id` = `siri`
4. Action **Énoncer le texte** avec *Contenu de l'URL*.
5. (Facultatif) Pour répondre à ses questions : **Si** *Contenu de l'URL* **contient** `?`, refais les étapes 2 à 4 dans le bloc.

Dis ensuite « **Dis Siri, Cuistot** », puis « y'a plus de beurre ».

## 5. Réglages utiles (`.env`)

| Variable | Rôle |
|---|---|
| `ASSISTANT_MODEL` | `claude-opus-5-5` par défaut (le plus capable). `claude-haiku-5-5` répond plus vite et coûte bien moins cher, à essayer. |
| `ASSISTANT_EFFORT` | `low` par défaut : réflexion courte, réponses rapides pour la voix. |
| `ASSISTANT_NAME` | Le nom de l'assistant, et le mot d'activation par défaut en mode mains libres. |
| `KEEP_NEW_ITEMS_ON_TOP` | `true` si, dans Keep, tes nouveaux articles s'ajoutent en haut. |
| `ASSISTANT_TOKEN` | Mot de passe de l'API, obligatoire si le serveur est joignable depuis internet. |

**Coût indicatif** : avec Claude Opus 5.5, compte de l'ordre de 1 à 3 centimes par demande (une demande = un ou deux échanges avec Claude). Avec Claude Haiku 5.5, une fraction de centime. Le suivi exact est dans la console Claude.

## 6. Ensuite : l'appareil au mur

Le serveur ne change pas ; seul le « micro + haut-parleur » change.

- **Vieille tablette Android** (le plus simple) : ouvre la même page dans Chrome, active **Mode mains libres** dans les réglages (roue dentée). Elle écoute en continu le mot « Cuistot » (« Cuistot, y'a plus de beurre ») et garde l'écran allumé. Une appli kiosque comme Fully Kiosk Browser la lance au démarrage. Limite connue : Chrome Android peut faire un petit bip à chaque relance de l'écoute.
- **Raspberry Pi 5** avec un micro-haut-parleur USB (type speakerphone de visio) : le Pi peut faire tourner ce serveur **et** un petit client vocal en Python, entièrement local pour la partie voix : détection du mot d'activation ([openWakeWord](https://github.com/dscripka/openWakeWord)), transcription ([faster-whisper](https://github.com/SYSTRAN/faster-whisper), modèle `small` en français), synthèse vocale ([Piper](https://github.com/rhasspy/piper), voix `fr_FR-siwis`). Ce client enverrait simplement le texte à `POST /api/message`, comme la page web.

## API

| Route | Rôle |
|---|---|
| `POST /api/message` | `{"text": "...", "conversation_id": "..."}` → `{"reply", "conversation_id", "expects_answer", "list_changed", "seconds"}`. `?format=text` renvoie juste la réponse (raccourci Siri). |
| `GET /api/list` | Articles restant à acheter. |
| `POST /api/reset?conversation_id=...` | Oublie une conversation. |

Si `ASSISTANT_TOKEN` est défini, chaque appel doit porter `Authorization: Bearer <jeton>` ou `?token=<jeton>`.

## Fichiers

```
assistant/
  agent.py      Claude : consignes, outils, boucle de conversation
  stores.py     Liste de courses : Google Keep ou fichier local, et la logique « déjà là / décocher / demander »
  matching.py   Comparaison tolérante des noms d'articles
  config.py     Lecture du .env
  server.py     Serveur web (page + API)
web/            La page vocale (reconnaissance et synthèse vocales du navigateur)
tools/
  chat_cli.py         Tester au clavier
  get_master_token.py Obtenir le jeton Google Keep
tests/          pip install -r requirements-dev.txt puis python -m pytest
```

## Limites à connaître

- **gkeepapi n'est pas officiel** : si Google change son fonctionnement interne, l'accès à Keep peut casser jusqu'à une mise à jour de la librairie (`pip install -U gkeepapi`). Les modifications arrivent dans l'appli Keep après sa synchronisation (quelques secondes).
- Sur iPhone, la page ne peut pas écouter écran verrouillé ou en arrière-plan : utilise le raccourci Siri pour le mains libres.
- La reconnaissance vocale de la page est celle du navigateur (Siri sur iPhone, Google sur Android) : elle passe par leurs serveurs.
