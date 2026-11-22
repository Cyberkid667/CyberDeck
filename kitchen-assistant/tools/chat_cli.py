"""Parler à l'assistant au clavier, sans voix ni navigateur (pratique pour tester).

    python tools/chat_cli.py
"""

from __future__ import annotations

import logging
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from assistant import config  # noqa: E402
from assistant.agent import KitchenAssistant  # noqa: E402


def main() -> None:
    logging.basicConfig(level=logging.WARNING)
    settings = config.load()
    grocery = config.make_grocery_list(settings)
    bot = KitchenAssistant(settings, grocery)
    print(f"{settings.assistant_name} t'écoute (liste « {grocery.title} », backend {settings.backend}). "
          "Ctrl+C pour quitter.\n")
    conversation = None
    while True:
        try:
            text = input("toi > ")
        except (EOFError, KeyboardInterrupt):
            print()
            return
        reply = bot.handle(text, conversation)
        conversation = reply.conversation_id
        print(f"{settings.assistant_name.lower()} > {reply.text}   ({reply.seconds}s)\n")


if __name__ == "__main__":
    main()
