from __future__ import annotations

import asyncio
import logging
from collections import defaultdict

import discord

from ..state import TeamState

log = logging.getLogger(__name__)


class MuteManager:
    """Turns a speaker mask into Discord server-mutes.

    This is the only place that talks to Discord about muting, so it is the
    seam where the rules engine plugs in: give it a channel and the set of
    allowed speaker IDs (or None for "everyone").

    Two rules it enforces:
        * It only ever unmutes people *it* muted, so it never undoes a
        moderator's manual server-mute.
      * Server-mute survives disconnecting, so we remember who we muted and
        release them when they rejoin or on reset.
    """

    def __init__(self) -> None:
        self._ours: dict[int, set[int]] = defaultdict(set)  # guild -> member IDs
        self._locks: dict[int, asyncio.Lock] = defaultdict(asyncio.Lock)

    async def apply_team(self, guild: discord.Guild, team: TeamState) -> None:
        channel = guild.get_channel(team.channel_id)
        if not isinstance(channel, (discord.VoiceChannel, discord.StageChannel)):
            log.warning("Team %s channel %s not found", team.name, team.channel_id)
            return
        await self.apply(channel, team.allowed if team.muting_active else None)

    async def apply(
            self,
            channel: discord.VoiceChannel | discord.StageChannel,
            allowed: set[int] | None,
            ) -> None:
        async with self._locks[channel.guild.id]:
            members = [m for m in channel.members if not m.bot]
            await asyncio.gather(
                    *(self._sync(m, allowed is not None and m.id not in allowed) for m in members)
                    )

    async def release_member(self, member: discord.Member) -> None:
        async with self._locks[member.guild.id]:
            await self._sync(member, False)

    async def release_all(self, guild: discord.Guild) -> int:
        async with self._locks[guild.id]:
            members = [guild.get_member(i) for i in list(self._ours[guild.id])]
            members = [m for m in members if m is not None]
            await asyncio.gather(*(self._sync(m, False) for m in members))
            return len(members)

    async def _sync(self, member: discord.Member, mute: bool) -> None:
        voice = member.voice
        if voice is None:  # not in voice; can't edit. Handled on rejoin.
            return
        ours = self._ours[member.guild.id]
        if mute:
            if voice.mute:  # already muted (by us or a mod); don't claim it
                return
            if await self._edit(member, True):
                ours.add(member.id)
        elif member.id in ours:
            if not voice.mute or await self._edit(member, False):
                ours.discard(member.id)

    @staticmethod
    async def _edit(member: discord.Member, mute: bool) -> bool:
        try:
            await member.edit(mute=mute, reason="Scrim voice rules")
            return True
        except discord.Forbidden:
            log.warning("Missing Mute Members permission for %s", member)
        except discord.HTTPException as exc:
            log.warning("Failed to set mute=%s for %s: %s", mute, member, exc)
        return False
