from __future__ import annotations

import asyncio
import logging

import discord
from discord import app_commands
from discord.ext import commands

from ..app import ScrimBot
from ..autocomplete import team_autocomplete
from ..config import MOD_PERMS
from ..services.local_rules import pick_next_speaker
from ..state import RuleMode, TeamState

log = logging.getLogger(__name__)


def _group(name: str, description: str) -> app_commands.Group:
    return app_commands.Group(
            name=name, description=description, guild_only=True, default_permissions=MOD_PERMS
            )


class RulesCog(commands.Cog):
    phone = _group("phone", "One phone line: only two people can talk")
    shotcaller = _group("shotcaller", "Only one person can talk")
    rules = _group("rules", "Inspect or reset voice rules")

    def __init__(self, bot: ScrimBot) -> None:
        self.bot = bot

    async def cog_unload(self) -> None:
        for session in self.bot.sessions._guilds.values():
            for team in session.teams.values():
                team.cancel_rotation()

    # ---- helpers -------------------------------------------------------

    async def _resolve(self, interaction: discord.Interaction, name: str) -> TeamState | None:
        team = self.bot.sessions.get(interaction.guild_id).teams.get(name.strip().lower())
        if team is None:
            await interaction.response.send_message(
                    f"No team named `{name}`. Use `/team list`.", ephemeral=True
                    )
        return team

    async def _activate(
            self,
            interaction: discord.Interaction,
            team: TeamState,
            mode: RuleMode,
            allowed: set[int],
            message: str,
            ) -> None:
        team.cancel_rotation()
        team.mode = mode
        team.allowed = set(allowed)
        await interaction.response.defer()
        await self.bot.muter.apply_team(interaction.guild, team)
        await interaction.followup.send(message)

    async def _rotate(self, guild: discord.Guild, team: TeamState, interval: int) -> None:
        previous: int | None = None
        while True:
            try:
                channel = guild.get_channel(team.channel_id)
                candidates = [m.id for m in getattr(channel, "members", []) if not m.bot]
                speaker = pick_next_speaker(candidates, previous)
                team.allowed = {speaker} if speaker else set()
                previous = speaker
                await self.bot.muter.apply_team(guild, team)
            except Exception:
                log.exception("Rotation tick failed for team %s", team.name)
            await asyncio.sleep(interval)

    # ---- /phone --------------------------------------------------------

    @phone.command(name="start", description="Give a team's phone line to two players")
    @app_commands.autocomplete(team=team_autocomplete)
    async def phone_start(
            self, interaction: discord.Interaction, team: str, a: discord.Member, b: discord.Member
            ) -> None:
        if a.id == b.id:
            await interaction.response.send_message("Pick two different players.", ephemeral=True)
            return
        if (t := await self._resolve(interaction, team)) is None:
            return
        await self._activate(
                interaction, t, RuleMode.PHONE_LINE, {a.id, b.id},
                f"Phone line for **{t.name}**: {a.mention} <-> {b.mention}. Everyone else is muted.",
                )

    @phone.command(name="swap", description="Hand one end of the phone line to someone else")
    @app_commands.autocomplete(team=team_autocomplete)
    async def phone_swap(
            self,
            interaction: discord.Interaction,
            team: str,
            leaving: discord.Member,
            joining: discord.Member,
            ) -> None:
        if (t := await self._resolve(interaction, team)) is None:
            return
        if t.mode is not RuleMode.PHONE_LINE or leaving.id not in t.allowed:
            await interaction.response.send_message(
                    f"{leaving.display_name} isn't on {t.name}'s phone line.", ephemeral=True
                    )
            return
        await self._activate(
                interaction, t, RuleMode.PHONE_LINE, (t.allowed - {leaving.id}) | {joining.id},
                f"{joining.mention} picked up the line from {leaving.mention}.",
                )

    # ---- /shotcaller ---------------------------------------------------

    @shotcaller.command(name="set", description="Only this player can talk")
    @app_commands.autocomplete(team=team_autocomplete)
    async def shotcaller_set(
            self, interaction: discord.Interaction, team: str, member: discord.Member
            ) -> None:
        if (t := await self._resolve(interaction, team)) is None:
            return
        await self._activate(
                interaction, t, RuleMode.SHOTCALLER, {member.id},
                f"{member.mention} is the shotcaller for **{t.name}**.",
                )

    @shotcaller.command(name="rotate", description="Randomly rotate who can talk on a timer")
    @app_commands.autocomplete(team=team_autocomplete)
    async def shotcaller_rotate(
            self,
            interaction: discord.Interaction,
            team: str,
            interval_seconds: app_commands.Range[int, 5, 600] = 30,
            ) -> None:
        if (t := await self._resolve(interaction, team)) is None:
            return
        t.cancel_rotation()
        t.mode = RuleMode.ROTATING
        t.allowed = set()
        await interaction.response.defer()
        t.rotation_task = asyncio.create_task(self._rotate(interaction.guild, t, interval_seconds))
        await interaction.followup.send(
                f"Rotating speaker on **{t.name}** every {interval_seconds}s."
                )

    # ---- /rules --------------------------------------------------------

    @rules.command(name="clear", description="Let a team talk freely again")
    @app_commands.autocomplete(team=team_autocomplete)
    async def rules_clear(self, interaction: discord.Interaction, team: str) -> None:
        if (t := await self._resolve(interaction, team)) is None:
            return
        await self._activate(
                interaction, t, RuleMode.OPEN, set(), f"**{t.name}** is back to open voice."
                )

    @rules.command(name="reset", description="Panic button: clear every rule and unmute everyone")
    async def rules_reset(self, interaction: discord.Interaction) -> None:
        await interaction.response.defer()
        for t in self.bot.sessions.get(interaction.guild_id).teams.values():
            t.cancel_rotation()
            t.open()
        count = await self.bot.muter.release_all(interaction.guild)
        await interaction.followup.send(f"All rules cleared. Released {count} player(s).")

    @rules.command(name="status", description="Show active rules and who can talk")
    async def rules_status(self, interaction: discord.Interaction) -> None:
        session = self.bot.sessions.get(interaction.guild_id)
        lines = []
        for t in session.teams.values():
            who = ", ".join(f"<@{i}>" for i in t.allowed) or "everyone"
            lines.append(f"**{t.name}**: `{t.mode.value}` | speakers: {who}")
        await interaction.response.send_message(
                "\n".join(lines) or "No teams registered.", ephemeral=True
                )


async def setup(bot: ScrimBot) -> None:
    await bot.add_cog(RulesCog(bot))
