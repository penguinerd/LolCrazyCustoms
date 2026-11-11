from __future__ import annotations

import discord
from discord import app_commands
from discord.ext import commands

from ..app import ScrimBot


def _usage(cmd: app_commands.Command) -> str:
    params = " ".join(
        f"<{p.display_name}>" if p.required else f"[{p.display_name}]" for p in cmd.parameters
    )
    return f"/{cmd.qualified_name} {params}".strip()


class HelpCog(commands.Cog):
    """Builds /help from the live command tree, so new commands show up automatically."""

    def __init__(self, bot: ScrimBot) -> None:
        self.bot = bot

    @app_commands.command(name="help", description="Show all commands and what they do")
    async def show_help(self, interaction: discord.Interaction) -> None:
        sections: dict[str, list[str]] = {}
        for cmd in self.bot.tree.walk_commands():
            if isinstance(cmd, app_commands.Group):
                continue
            root = cmd.root_parent.name if cmd.root_parent else "general"
            sections.setdefault(root, []).append(f"`{_usage(cmd)}`\n{cmd.description}")

        embed = discord.Embed(
            title="Scrim voice rules",
            description="`<x>` is required, `[x]` is optional. Most commands need **Mute Members**.",
            color=discord.Color.blurple(),
        )
        for root in sorted(sections):
            embed.add_field(name=root.capitalize(), value="\n".join(sections[root])[:1024], inline=False)
        await interaction.response.send_message(embed=embed, ephemeral=True)


async def setup(bot: ScrimBot) -> None:
    await bot.add_cog(HelpCog(bot))
