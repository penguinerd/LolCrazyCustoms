from __future__ import annotations

import discord
from discord import app_commands
from discord.ext import commands

from ..app import ScrimBot
from ..config import MOD_PERMS
from ..helpers import resolve_team, team_autocomplete
from ..state import TeamState


class TeamsCog(commands.Cog):
    team = app_commands.Group(
        name="team",
        description="Manage scrim teams",
        guild_only=True,
        default_permissions=MOD_PERMS,
    )

    def __init__(self, bot: ScrimBot) -> None:
        self.bot = bot

    @team.command(name="register", description="Bind a team name to a voice channel")
    async def register(
        self, interaction: discord.Interaction, name: str, channel: discord.VoiceChannel
    ) -> None:
        session = self.bot.sessions.get(interaction.guild_id)
        key = name.strip().lower()
        if not key:
            error = "Give the team a name."
        elif key in session.teams:
            error = f"Team `{key}` already exists."
        elif session.team_for_channel(channel.id):
            error = f"{channel.mention} already belongs to a team."
        else:
            session.teams[key] = TeamState(name=key, channel_id=channel.id)
            await interaction.response.send_message(f"Registered **{key}** -> {channel.mention}")
            return
        await interaction.response.send_message(error, ephemeral=True)

    @team.command(name="remove", description="Remove a team and unmute its members")
    @app_commands.autocomplete(name=team_autocomplete)
    async def remove(self, interaction: discord.Interaction, name: str) -> None:
        if (team := await resolve_team(interaction, name)) is None:
            return
        del self.bot.sessions.get(interaction.guild_id).teams[team.name]
        team.open()
        await interaction.response.defer()
        await self.bot.muter.apply_team(interaction.guild, team)
        await interaction.followup.send(f"Removed **{team.name}**.")

    @team.command(name="list", description="Show teams, active rules, and who can talk")
    async def list_(self, interaction: discord.Interaction) -> None:
        teams = self.bot.sessions.get(interaction.guild_id).teams.values()
        if not teams:
            await interaction.response.send_message("No teams yet. Use `/team register`.", ephemeral=True)
            return
        lines = [
            f"**{t.name}** -> <#{t.channel_id}> | `{t.mode.value}` | speakers: "
            + (", ".join(f"<@{i}>" for i in t.allowed) or "everyone")
            for t in teams
        ]
        await interaction.response.send_message("\n".join(lines), ephemeral=True)


async def setup(bot: ScrimBot) -> None:
    await bot.add_cog(TeamsCog(bot))
