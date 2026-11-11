from __future__ import annotations

import discord
from discord.ext import commands

from ..app import ScrimBot


class VoiceCog(commands.Cog):
    """Keeps the mask correct as people move around.

    Server-mute persists after disconnecting, so joiners must be re-evaluated
    and anyone who leaves a team channel must be released.
    """

    def __init__(self, bot: ScrimBot) -> None:
        self.bot = bot

    @commands.Cog.listener()
    async def on_voice_state_update(
        self, member: discord.Member, before: discord.VoiceState, after: discord.VoiceState
    ) -> None:
        # Ignore mute/deafen changes (including our own edits) to avoid feedback loops.
        if member.bot or before.channel == after.channel or after.channel is None:
            return
        session = self.bot.sessions.get(member.guild.id)
        team = session.team_for_channel(after.channel.id)
        if team is None:
            await self.bot.muter.release_member(member)  # left team channels: unmute if ours
        else:
            await self.bot.muter.apply_team(member.guild, team)  # joiner gets current mask


async def setup(bot: ScrimBot) -> None:
    await bot.add_cog(VoiceCog(bot))
