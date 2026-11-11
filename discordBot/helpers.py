from __future__ import annotations

import discord
from discord import app_commands

from .state import TeamState


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


async def resolve_team(interaction: discord.Interaction, name: str) -> TeamState | None:
    """Look up a team by name; replies with an error and returns None if missing."""
    session = interaction.client.sessions.get(interaction.guild_id)  # type: ignore[attr-defined]
    team = session.find(name)
    if team is None:
        await interaction.response.send_message(
            f"No team named `{name}`. Use `/team list`.", ephemeral=True
        )
    return team
