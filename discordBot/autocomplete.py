from __future__ import annotations

import discord
from discord import app_commands


async def team_autocomplete(
    interaction: discord.Interaction, current: str
) -> list[app_commands.Choice[str]]:
    if interaction.guild_id is None:
        return []
    session = interaction.client.sessions.get(interaction.guild_id)  # type: ignore[attr-defined]
    return [
        app_commands.Choice(name=name, value=name)
        for name in session.teams
        if current.lower() in name
    ][:25]
