"""Shotcaller announcer: says "<name> is the shotcaller now." in the team's voice channel.

Fully automatic. The rules cog dispatches these events:
    shotcaller_changed(guild_id, team_name, display_name)  -> announce
    shotcaller_roster(names)                                -> pre-render names (slow on CPU)
The phone line never triggers it.

Needs: ffmpeg + libopus, PyNaCl, and View Channel / Connect / Speak in the team channels.

Timing (one bot = one voice channel per server, so announcements run one at a time):
    render (if wav missing) -> hop to team channel -> JOIN_SETTLE -> random stinger ->
    STINGER_GAP -> name clip -> TAIL_PAD -> HOP_GAP -> next
If a team rotates again before its clip plays, only the newest name is spoken.
"""
from __future__ import annotations

import asyncio
import logging
import os
import random
import re
import wave
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import discord
from discord import app_commands
from discord.ext import commands

from ..app import ScrimBot
from ..config import MOD_PERMS
from ..state import RuleMode

log = logging.getLogger(__name__)

REFERENCE_WAV = Path("champ_audio/training/reference.wav")
ANNOUNCE_DIR = Path("announcements")
TEMPLATE = "{name} is the shotcaller now."
MODEL = "tts_models/multilingual/multi-dataset/xtts_v2"

STINGER_DIR = Path("champ_audio/stingers")  # Kled_Original_R_0.ogg ... _7.ogg
STINGER_GLOB = "Kled_Original_R_*.ogg"

# Timing (seconds): tweak if clips get cut off or feel laggy.
JOIN_SETTLE = 0.7       # after joining/moving, so the start isn't clipped
STINGER_GAP = 0.25      # between stinger and name clip
TAIL_PAD = 0.6          # after the clip ends, so the last syllable finishes
HOP_GAP = 0.4           # between two announcements
PLAY_TIMEOUT_PAD = 5.0  # safety margin added to clip length before giving up


def safe_filename(name: str) -> str:
    return re.sub(r"[^\w\-]", "_", name)


def wav_duration(path: Path) -> float:
    try:
        with wave.open(str(path), "rb") as w:
            return w.getnframes() / float(w.getframerate())
    except Exception:
        return 10.0


async def play_file(vc: discord.VoiceClient, path: Path) -> None:
    """Play one file and wait until it finishes (or a safety timeout hits)."""
    if vc.is_playing():
        vc.stop()
    done = asyncio.Event()
    loop = asyncio.get_running_loop()

    def after(err: Exception | None) -> None:
        if err:
            log.error("Playback error: %s", err)
        loop.call_soon_threadsafe(done.set)  # 'after' runs in another thread

    vc.play(discord.FFmpegPCMAudio(str(path)), after=after)
    length = wav_duration(path) if path.suffix.lower() == ".wav" else 25.0
    try:
        await asyncio.wait_for(done.wait(), timeout=length + PLAY_TIMEOUT_PAD)
    except asyncio.TimeoutError:
        vc.stop()


class TTSEngine:
    """Loads XTTS-v2 once, renders in a background thread so the bot never blocks."""

    def __init__(self) -> None:
        self._tts = None
        self._pool = ThreadPoolExecutor(max_workers=1)  # renders run one at a time
        self.pronunciations: dict[str, str] = {}

    def path_for(self, name: str) -> Path:
        return ANNOUNCE_DIR / f"{safe_filename(name)}.wav"

    def _load(self):
        if self._tts is None:
            os.environ.setdefault("COQUI_TOS_AGREED", "1")  # XTTS non-commercial license
            import torch
            from TTS.api import TTS

            device = "cuda" if torch.cuda.is_available() else "cpu"
            log.info("Loading XTTS-v2 on %s...", device)
            self._tts = TTS(MODEL).to(device)
        return self._tts

    def _render(self, name: str) -> Path:
        path = self.path_for(name)
        if path.exists():
            return path
        ANNOUNCE_DIR.mkdir(exist_ok=True)
        spoken = self.pronunciations.get(name.lower(), name)
        tmp = path.with_suffix(".tmp.wav")  # never leave a half-written file to be played
        self._load().tts_to_file(
            text=TEMPLATE.format(name=spoken),
            speaker_wav=str(REFERENCE_WAV),
            language="en",
            file_path=str(tmp),
        )
        tmp.replace(path)
        return path

    async def get(self, name: str) -> Path:
        """Return the wav for this name, rendering it first if needed."""
        path = self.path_for(name)
        if path.exists():
            return path
        return await asyncio.get_running_loop().run_in_executor(self._pool, self._render, name)


class VoiceAnnouncer(commands.Cog):
    def __init__(self, bot: ScrimBot) -> None:
        self.bot = bot
        self.tts = TTSEngine()
        self._pending: dict[tuple[int, str], str] = {}  # (guild, team) -> newest name
        self._locks: dict[int, asyncio.Lock] = defaultdict(asyncio.Lock)  # one voice client per guild
        self._tasks: set[asyncio.Task] = set()
        self._last_stinger: Path | None = None

    async def cog_unload(self) -> None:
        for task in list(self._tasks):
            task.cancel()
        for vc in list(self.bot.voice_clients):
            await vc.disconnect(force=True)

    # ---- events from the rules cog -------------------------------------

    @commands.Cog.listener()
    async def on_shotcaller_roster(self, names: list[str]) -> None:
        for name in names:
            try:
                await self.tts.get(name)
            except Exception:
                log.exception("Pre-render failed for %s", name)

    @commands.Cog.listener()
    async def on_shotcaller_changed(self, guild_id: int, team: str, name: str) -> None:
        key = (guild_id, team)
        queued = key in self._pending
        self._pending[key] = name  # overwrite: only the newest shotcaller matters
        if not queued:
            task = asyncio.create_task(self._announce(key))
            self._tasks.add(task)
            task.add_done_callback(self._tasks.discard)

    # ---- playback ------------------------------------------------------

    async def _announce(self, key: tuple[int, str]) -> None:
        async with self._locks[key[0]]:
            name = self._pending.pop(key, None)
            if name is None:
                return
            try:
                await self._play(*key, name)
            except Exception:
                log.exception("Announcement failed for %s / %s", key, name)
            await asyncio.sleep(HOP_GAP)

    async def _play(self, guild_id: int, team_name: str, name: str) -> None:
        guild = self.bot.get_guild(guild_id)
        team = self.bot.sessions.get(guild_id).find(team_name)
        channel = guild.get_channel(team.channel_id) if guild and team else None
        if not isinstance(channel, (discord.VoiceChannel, discord.StageChannel)):
            log.warning("No usable voice channel for team %s", team_name)
            return

        path = await self.tts.get(name)  # render BEFORE hopping into the channel
        if team.mode not in (RuleMode.SHOTCALLER, RuleMode.ROTATING):
            return  # rule was cleared while we were rendering

        vc = await self._join(channel)
        if vc is None:
            return
        if (stinger := self._pick_stinger()) is not None:
            await play_file(vc, stinger)
            await asyncio.sleep(STINGER_GAP)
        await play_file(vc, path)
        await asyncio.sleep(TAIL_PAD)

    async def _join(self, channel: discord.VoiceChannel | discord.StageChannel) -> discord.VoiceClient | None:
        vc = channel.guild.voice_client
        if vc is not None and not isinstance(vc, discord.VoiceClient):
            log.warning("Unexpected voice client type: %r", type(vc))
            return None
        if vc is not None and not vc.is_connected():
            await vc.disconnect(force=True)
            vc = None
        if vc is None:
            vc = await channel.connect(timeout=15, reconnect=True, cls=discord.VoiceClient)
        elif vc.channel.id != channel.id:
            await vc.move_to(channel)
        else:
            return vc  # already there, no need to settle
        await asyncio.sleep(JOIN_SETTLE)
        return vc

    def _pick_stinger(self) -> Path | None:
        options = sorted(STINGER_DIR.glob(STINGER_GLOB))
        if not options:
            log.warning("No stinger files found in %s (%s)", STINGER_DIR, STINGER_GLOB)
            return None
        if len(options) > 1 and self._last_stinger in options:
            options.remove(self._last_stinger)  # don't repeat the same line twice in a row
        self._last_stinger = random.choice(options)
        return self._last_stinger

    # ---- the only command ----------------------------------------------

    @app_commands.command(name="pronounce", description="Set how a name is spoken, e.g. xXSlayerXx -> Slayer")
    @app_commands.guild_only()
    @app_commands.default_permissions(MOD_PERMS)
    async def pronounce(self, interaction: discord.Interaction, name: str, spoken: str) -> None:
        self.tts.pronunciations[name.lower()] = spoken
        self.tts.path_for(name).unlink(missing_ok=True)  # re-render next time it's needed
        await interaction.response.send_message(f"'{name}' will be spoken as '{spoken}'.", ephemeral=True)

    @app_commands.command(name="prerender", description="Render announcements ahead of time (slow on CPU)")
    @app_commands.describe(names="Comma-separated player names")
    @app_commands.guild_only()
    @app_commands.default_permissions(MOD_PERMS)
    async def prerender(self, interaction: discord.Interaction, names: str) -> None:
        await interaction.response.defer(ephemeral=True)
        todo = [n.strip() for n in names.split(",") if n.strip()]
        for i, name in enumerate(todo, start=1):
            await self.tts.get(name)
            await interaction.followup.send(f"[{i}/{len(todo)}] {name} ready", ephemeral=True)
        await interaction.followup.send("All done.", ephemeral=True)

async def setup(bot: ScrimBot) -> None:
    await bot.add_cog(VoiceAnnouncer(bot))
