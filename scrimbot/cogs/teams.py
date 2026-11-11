from __future__ import annotations

import discord
from discord import app_commands
from discord.ext import commands

from ..app import ScrimBot
from ..autocomplete import team_autocomplete
from ..config import MOD_PERMS
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
            await interaction.response.send_message("Give the team a name.", ephemeral=True)
        elif key in session.teams:
            await interaction.response.send_message(f"Team `{key}` already exists.", ephemeral=True)
        elif session.team_for_channel(channel.id):
            await interaction.response.send_message(
                f"{channel.mention} already belongs to a team.", ephemeral=True
            )
        else:
            session.teams[key] = TeamState(name=key, channel_id=channel.id)
            await interaction.response.send_message(f"Registered **{key}** -> {channel.mention}")

    @team.command(name="remove", description="Remove a team and unmute its members")
    @app_commands.autocomplete(name=team_autocomplete)
    async def remove(self, interaction: discord.Interaction, name: str) -> None:
        session = self.bot.sessions.get(interaction.guild_id)
        team = session.teams.pop(name.strip().lower(), None)
        if team is None:
            await interaction.response.send_message(f"No team named `{name}`.", ephemeral=True)
            return
        team.cancel_rotation()
        team.open()
        await interaction.response.defer()
        await self.bot.muter.apply_team(interaction.guild, team)
        await interaction.followup.send(f"Removed **{team.name}**.")

    @team.command(name="list", description="Show teams and their active rules")
    async def list_(self, interaction: discord.Interaction) -> None:
        session = self.bot.sessions.get(interaction.guild_id)
        if not session.teams:
            await interaction.response.send_message("No teams yet. Use `/team register`.", ephemeral=True)
            return
        lines = [
            f"**{t.name}** -> <#{t.channel_id}> | rule: `{t.mode.value}`"
            for t in session.teams.values()
        ]
        await interaction.response.send_message("\n".join(lines), ephemeral=True)


async def setup(bot: ScrimBot) -> None:
    await bot.add_cog(TeamsCog(bot))
