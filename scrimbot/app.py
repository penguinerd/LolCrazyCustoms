from __future__ import annotations

import logging
import pkgutil

import discord
from discord.ext import commands

from . import cogs
from .config import Settings
from .services.mute import MuteManager
from .state import SessionStore

log = logging.getLogger(__name__)


class ScrimBot(commands.Bot):
    def __init__(self, settings: Settings) -> None:
        intents = discord.Intents.default()
        intents.members = True       # privileged: enable "Server Members Intent" in the dev portal
        intents.voice_states = True  # needed to see who is in which voice channel
        super().__init__(command_prefix=commands.when_mentioned, intents=intents)
        self.settings = settings
        self.sessions = SessionStore()
        self.muter = MuteManager()

    async def setup_hook(self) -> None:
        # Auto-load every module in bot/cogs/ that defines setup().
        for mod in pkgutil.iter_modules(cogs.__path__):
            await self.load_extension(f"{cogs.__name__}.{mod.name}")
            log.info("Loaded cog %s", mod.name)

        if self.settings.dev_guild_id:
            guild = discord.Object(id=self.settings.dev_guild_id)
            self.tree.copy_global_to(guild=guild)
            await self.tree.sync(guild=guild)
        else:
            await self.tree.sync()

    async def on_ready(self) -> None:
        log.info("Logged in as %s (%s guilds)", self.user, len(self.guilds))
