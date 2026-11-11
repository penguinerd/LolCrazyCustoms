"""
Voice announcer cog: plays "<name> is the shotcaller now." in the right team's
voice channel whenever the shotcaller rotates.

Install:
    pip install "discord.py[voice]"      (pulls in PyNaCl)
    system packages: ffmpeg, libopus     (Arch: sudo pacman -S ffmpeg libopus)

Load it from your bot (e.g. in setup_hook):
    await bot.load_extension("cogs.voice_announcer")
    await bot.tree.sync()

The bot needs View Channel, Connect and Speak in both team channels.

Trigger it from your rules engine / anywhere that has the bot:
    bot.dispatch("shotcaller_changed", guild_id, team, player_name)
    # team is 1 or 2

Test without the rules engine:
    /announcer_setup team1:#Team-1 team2:#Team-2
    /prerender names:Dave, Mike, Sarah, Tom, Alex
    /announce_test team:1 name:Dave

How the timing works
--------------------
One bot can only sit in one voice channel per server, so announcements go
through a single worker that handles them one at a time:

    render (if the wav is missing)  ->  hop to the team's channel  ->
    JOIN_SETTLE (let the voice connection stabilise)  ->  random Kled stinger  ->
    STINGER_GAP  ->  the name announcement  ->  TAIL_PAD (let the last syllable
    finish)  ->  HOP_GAP  ->  next announcement

If a team rotates again before its announcement is played, only the latest
name is spoken (the stale one is dropped).
"""
import asyncio
import logging
import os
import random
import re
import wave
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import discord
from discord import app_commands
from discord.ext import commands

log = logging.getLogger(__name__)

# ---- paths / model (keep in sync with announcements.py) ----
REFERENCE_WAV = Path("champ_audio/training/reference.wav")
ANNOUNCE_DIR = Path("announcements")
TEMPLATE = "{name} is the shotcaller now."
MODEL = "tts_models/multilingual/multi-dataset/xtts_v2"

# ---- timing (seconds): tweak these if clips get cut off or feel laggy ----
JOIN_SETTLE = 0.7      # wait after joining/moving before playing, so the start isn't clipped
TAIL_PAD = 0.6         # wait after the clip ends before the bot may leave
HOP_GAP = 0.4          # extra breathing room between two announcements
PLAY_TIMEOUT_PAD = 5.0  # safety margin added to the clip length before giving up

# ---- stinger: a random Kled line played right before the name announcement ----
STINGER_DIR = Path("champ_audio/stingers")  # folder with Kled_Original_R_0.ogg ... _7.ogg
STINGER_GLOB = "Kled_Original_R_*.ogg"
STINGER_GAP = 0.25     # pause between the stinger and the name announcement


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

    def after(err):
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

    def __init__(self):
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
        loop = asyncio.get_running_loop()
        return await loop.run_in_executor(self._pool, self._render, name)


class GuildAnnouncer:
    """Per-server state: team channels, pending announcements, and the worker."""

    def __init__(self, bot: commands.Bot, tts: TTSEngine, guild_id: int):
        self.bot = bot
        self.tts = tts
        self.guild_id = guild_id
        self.channel_ids: dict[int, int] = {}  # team number -> voice channel id
        self.pending: dict[int, str] = {}      # team -> latest name still to announce
        self.queue: asyncio.Queue[int] = asyncio.Queue()
        self.task: asyncio.Task | None = None
        self.last_stinger: Path | None = None

    def _pick_stinger(self) -> Path | None:
        options = sorted(STINGER_DIR.glob(STINGER_GLOB))
        if not options:
            log.warning("No stinger files found in %s (%s)", STINGER_DIR, STINGER_GLOB)
            return None
        if len(options) > 1 and self.last_stinger in options:
            options.remove(self.last_stinger)  # don't repeat the same line twice in a row
        self.last_stinger = random.choice(options)
        return self.last_stinger

    def submit(self, team: int, name: str):
        if team not in self.pending:
            self.queue.put_nowait(team)
        self.pending[team] = name  # overwrite: only the newest shotcaller matters
        if self.task is None or self.task.done():
            self.task = asyncio.create_task(self._worker())

    async def _worker(self):
        while True:
            team = await self.queue.get()
            name = self.pending.pop(team, None)
            if name is None:
                continue
            try:
                await self._announce(team, name)
            except Exception:
                log.exception("Announcement failed for team %s / %s", team, name)
            await asyncio.sleep(HOP_GAP)

    async def _announce(self, team: int, name: str):
        guild = self.bot.get_guild(self.guild_id)
        channel = guild.get_channel(self.channel_ids.get(team, 0)) if guild else None
        if guild is None or not isinstance(channel, (discord.VoiceChannel, discord.StageChannel)):
            log.warning("No usable voice channel configured for team %s", team)
            return

        # Render BEFORE hopping so the bot isn't sitting in a channel waiting on the model.
        path = await self.tts.get(name)

        vc = guild.voice_client
        if vc is not None and not isinstance(vc, discord.VoiceClient):
            log.warning("Unexpected voice client type: %r", type(vc))
            return
        hopped = False
        if vc is not None and not vc.is_connected():
            await vc.disconnect(force=True)
            vc = None
        if vc is None:
            vc = await channel.connect(timeout=15, reconnect=True, cls=discord.VoiceClient)
            hopped = True
        elif vc.channel.id != channel.id:
            await vc.move_to(channel)
            hopped = True
        if hopped:
            await asyncio.sleep(JOIN_SETTLE)

        stinger = self._pick_stinger()
        if stinger is not None:
            await play_file(vc, stinger)
            await asyncio.sleep(STINGER_GAP)
        await play_file(vc, path)
        await asyncio.sleep(TAIL_PAD)


class VoiceAnnouncer(commands.Cog):
    def __init__(self, bot: commands.Bot):
        self.bot = bot
        self.tts = TTSEngine()
        self.guilds: dict[int, GuildAnnouncer] = {}

    @staticmethod
    def _gid(interaction: discord.Interaction) -> int:
        assert interaction.guild_id is not None  # all commands using this are guild_only
        return interaction.guild_id

    def _get(self, guild_id: int) -> GuildAnnouncer:
        if guild_id not in self.guilds:
            self.guilds[guild_id] = GuildAnnouncer(self.bot, self.tts, guild_id)
        return self.guilds[guild_id]

    async def cog_unload(self):
        for ann in self.guilds.values():
            if ann.task:
                ann.task.cancel()
        for vc in list(self.bot.voice_clients):
            await vc.disconnect(force=True)

    # ---- the hook your rules engine calls ----
    @commands.Cog.listener()
    async def on_shotcaller_changed(self, guild_id: int, team: int, name: str):
        ann = self.guilds.get(guild_id)
        if ann is None or team not in ann.channel_ids:
            log.warning("shotcaller_changed for unconfigured guild/team (%s, %s)", guild_id, team)
            return
        ann.submit(team, name)

    # ---- slash commands ----
    @app_commands.command(name="announcer_setup", description="Set the voice channel for each team")
    @app_commands.guild_only()
    async def announcer_setup(
        self,
        interaction: discord.Interaction,
        team1: discord.VoiceChannel,
        team2: discord.VoiceChannel,
    ):
        ann = self._get(self._gid(interaction))
        ann.channel_ids = {1: team1.id, 2: team2.id}
        await interaction.response.send_message(
            f"Team 1 -> {team1.mention}, Team 2 -> {team2.mention}", ephemeral=True
        )

    @app_commands.command(name="announce_test", description="Test: announce a shotcaller change")
    @app_commands.guild_only()
    async def announce_test(
        self, interaction: discord.Interaction, team: app_commands.Range[int, 1, 2], name: str
    ):
        ann = self._get(self._gid(interaction))
        if team not in ann.channel_ids:
            await interaction.response.send_message("Run /announcer_setup first.", ephemeral=True)
            return
        ann.submit(team, name)
        await interaction.response.send_message(f"Queued: {name} (team {team})", ephemeral=True)

    @app_commands.command(name="announce_beep", description="Diagnostic: join your channel and play a test tone")
    @app_commands.guild_only()
    async def announce_beep(self, interaction: discord.Interaction):
        """No files, no queue, no TTS: just join you and play a generated 440 Hz tone."""
        member = interaction.user
        if not isinstance(member, discord.Member) or member.voice is None or member.voice.channel is None:
            await interaction.response.send_message("Join a voice channel first.", ephemeral=True)
            return
        channel = member.voice.channel
        await interaction.response.send_message(f"Joining {channel.mention} for a 3s tone...", ephemeral=True)

        vc = channel.guild.voice_client
        if vc is not None and not isinstance(vc, discord.VoiceClient):
            return
        if vc is not None and not vc.is_connected():
            await vc.disconnect(force=True)
            vc = None
        if vc is None:
            vc = await channel.connect(timeout=15, reconnect=True, cls=discord.VoiceClient)
        elif vc.channel.id != channel.id:
            await vc.move_to(channel)
        await asyncio.sleep(JOIN_SETTLE + 1.0)

        log.info(
            "beep: connected=%s channel=%s mode=%s endpoint=%s",
            vc.is_connected(), vc.channel, getattr(vc, "mode", "?"), getattr(vc, "endpoint", "?"),
        )

        done = asyncio.Event()
        loop = asyncio.get_running_loop()

        def after(err):
            if err:
                log.error("Beep playback error: %s", err)
            loop.call_soon_threadsafe(done.set)

        vc.play(
            discord.FFmpegPCMAudio("sine=frequency=440:duration=3", before_options="-f lavfi"),
            after=after,
        )
        try:
            await asyncio.wait_for(done.wait(), timeout=10)
        except asyncio.TimeoutError:
            vc.stop()
        await interaction.followup.send("Tone finished. Did you hear it?", ephemeral=True)

    @app_commands.command(name="prerender", description="Render announcements ahead of time (slow on CPU)")
    @app_commands.describe(names="Comma-separated player names")
    async def prerender(self, interaction: discord.Interaction, names: str):
        await interaction.response.defer(ephemeral=True)
        todo = [n.strip() for n in names.split(",") if n.strip()]
        for i, name in enumerate(todo, start=1):
            await self.tts.get(name)
            await interaction.followup.send(f"[{i}/{len(todo)}] {name} ready", ephemeral=True)
        await interaction.followup.send("All done.", ephemeral=True)

    @app_commands.command(name="pronounce", description="Set how a name is spoken, e.g. xXSlayerXx -> Slayer")
    async def pronounce(self, interaction: discord.Interaction, name: str, spoken: str):
        self.tts.pronunciations[name.lower()] = spoken
        self.tts.path_for(name).unlink(missing_ok=True)  # force a re-render next time
        await interaction.response.send_message(
            f"'{name}' will be spoken as '{spoken}'. Run /prerender {name} to render it now.",
            ephemeral=True,
        )


async def setup(bot: commands.Bot):
    await bot.add_cog(VoiceAnnouncer(bot))
