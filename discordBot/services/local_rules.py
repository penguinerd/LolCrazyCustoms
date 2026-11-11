"""Stand-in rule logic so the bot is playable before the FastAPI rules engine exists.

Once the engine exists, delete this and have the bot receive an allowed-speaker
set over the websocket, then call MuteManager.apply() with it.
"""
from __future__ import annotations

import random
from collections.abc import Sequence


def pick_next_speaker(
    candidates: Sequence[int],
    previous: int | None = None,
    rng: random.Random | None = None,
) -> int | None:
    """Random pick that avoids repeating the previous speaker when possible."""
    rng = rng or random
    pool = [c for c in candidates if c != previous] or list(candidates)
    return rng.choice(pool) if pool else None
