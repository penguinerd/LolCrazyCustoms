from __future__ import annotations

import os
from dataclasses import dataclass

import discord
from dotenv import load_dotenv

# Default permission gate for every slash command. Server admins can still
# override this per-command in Server Settings -> Integrations.
MOD_PERMS = discord.Permissions(mute_members=True)


@dataclass(frozen=True)
class Settings:
    token: str
    dev_guild_id: int | None
    log_level: str


def load_settings() -> Settings:
    load_dotenv()
    token = os.environ.get("DISCORD_TOKEN")
    if not token:
        raise SystemExit("DISCORD_TOKEN is not set (see .env.example)")
    dev_guild = os.environ.get("DEV_GUILD_ID", "").strip()
    return Settings(
        token=token,
        dev_guild_id=int(dev_guild) if dev_guild else None,
        log_level=os.environ.get("LOG_LEVEL", "INFO").upper(),
    )
