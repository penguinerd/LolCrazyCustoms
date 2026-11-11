from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from enum import Enum


class RuleMode(str, Enum):
    OPEN = "open"              # everyone on the team can talk
    PHONE_LINE = "phone_line"  # exactly two holders can talk
    SHOTCALLER = "shotcaller"  # one fixed speaker
    ROTATING = "rotating"      # one speaker, re-picked on a timer


@dataclass
class TeamState:
    """A team is just a name bound to a voice channel; members are whoever is in it."""

    name: str
    channel_id: int
    mode: RuleMode = RuleMode.OPEN
    allowed: set[int] = field(default_factory=set)  # Discord user IDs who may speak
    rotation_task: asyncio.Task | None = None

    @property
    def muting_active(self) -> bool:
        return self.mode is not RuleMode.OPEN

    def open(self) -> None:
        self.mode = RuleMode.OPEN
        self.allowed = set()

    def cancel_rotation(self) -> None:
        if self.rotation_task and not self.rotation_task.done():
            self.rotation_task.cancel()
        self.rotation_task = None


@dataclass
class GuildSession:
    teams: dict[str, TeamState] = field(default_factory=dict)

    def team_for_channel(self, channel_id: int) -> TeamState | None:
        return next((t for t in self.teams.values() if t.channel_id == channel_id), None)


class SessionStore:
    """In-memory only for now. Swap for the FastAPI server's room state later."""

    def __init__(self) -> None:
        self._guilds: dict[int, GuildSession] = {}

    def get(self, guild_id: int) -> GuildSession:
        return self._guilds.setdefault(guild_id, GuildSession())
