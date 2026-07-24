// ═══════════════════════════════════════════════
//  /wanted — Просмотр статуса розыска
//   • /wanted top  — топ разыскиваемых
//   • /wanted me   — свои звёзды + время до decay
// ═══════════════════════════════════════════════

import { SlashCommandBuilder, ChatInputCommandInteraction, MessageFlags } from 'discord.js';
import type { BublikClient } from '../../../bot';
import { BublikCommand, CommandScope } from '../../../types/Command';
import { i18n } from '../../../core/I18n';
import { getGuildLocale } from '../../../core/GuildConfig';
import { BublikEmbed } from '../../../core/EmbedBuilder';
import { getOrCreateProfile, getWantedTop } from '../database';
import { EMOJI, WANTED_DEFAULTS } from '../constants';
import { formatCooldown } from '../profile';
import { pickPhrase } from '../phrases';

function starsBar(stars: number): string {
  const max = WANTED_DEFAULTS.maxStarsDisplay;
  const filled = Math.min(stars, max);
  return '⭐'.repeat(filled) + (stars > max ? `+${stars - max}` : '');
}

const wantedCommand: BublikCommand = {
  data: new SlashCommandBuilder()
    .setName('wanted')
    .setDescription('Доска розыска')
    .addSubcommand((sub) =>
      sub.setName('top').setDescription('Топ разыскиваемых'),
    )
    .addSubcommand((sub) =>
      sub.setName('me').setDescription('Свой статус розыска'),
    ),

  scope: CommandScope.Guild,
  category: 'economy',
  descriptionKey: 'commands.wanted.description',

  async execute(interaction: ChatInputCommandInteraction, _client: BublikClient): Promise<void> {
    const locale = await getGuildLocale(interaction.guildId);
    const guildId = interaction.guildId!;
    const sub = interaction.options.getSubcommand();

    if (sub === 'top') {
      const top = await getWantedTop(guildId, 10);
      if (top.length === 0) {
        const embed = new BublikEmbed()
          .setColor(0x95a5a6)
          .setTitle(`${EMOJI.WANTED} ${i18n.t('economy.cmd.wanted.top_title', locale)}`)
          .setDescription(i18n.t('economy.cmd.wanted.top_empty', locale));
        await interaction.reply({ embeds: [embed] });
        return;
      }

      const lines = top.map((p, i) => {
        const rank = i + 1;
        return `**${rank}.** <@${p.userId}> — ${starsBar(p.wantedStars)}`;
      });

      const embed = new BublikEmbed()
        .setColor(0xe74c3c)
        .setTitle(`${EMOJI.WANTED} ${i18n.t('economy.cmd.wanted.top_title', locale)}`)
        .setDescription(
          `${pickPhrase('economy.cmd.wanted.phrase_top_intro', locale)}\n\n` + lines.join('\n'),
        );
      await interaction.reply({ embeds: [embed] });
      return;
    }

    // me
    const profile = await getOrCreateProfile(guildId, interaction.user.id);
    if (!profile.wantedStars || profile.wantedStars === 0) {
      const embed = new BublikEmbed()
        .setColor(0x2ecc71)
        .setAuthor({ name: interaction.user.displayName, iconURL: interaction.user.displayAvatarURL({ size: 64 }) })
        .setDescription(`${EMOJI.SUCCESS} ${pickPhrase('economy.cmd.wanted.phrase_clean', locale, { user: `<@${interaction.user.id}>` })}`);
      await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
      return;
    }

    const decayLeft = profile.wantedNextDecay
      ? Math.max(0, new Date(profile.wantedNextDecay).getTime() - Date.now())
      : 0;

    const embed = new BublikEmbed()
      .setColor(0xe74c3c)
      .setAuthor({ name: interaction.user.displayName, iconURL: interaction.user.displayAvatarURL({ size: 64 }) })
      .setDescription(
        `${EMOJI.WANTED} **${i18n.t('economy.cmd.wanted.me_stars', locale, { stars: profile.wantedStars })}**\n` +
        `${starsBar(profile.wantedStars)}\n\n` +
        (decayLeft > 0
          ? `${EMOJI.CLOCK} ${i18n.t('economy.cmd.wanted.me_next_decay', locale, { time: formatCooldown(decayLeft) })}`
          : `${EMOJI.CLOCK} ${i18n.t('economy.cmd.wanted.me_decay_due', locale)}`),
      );
    await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
  },
};

export default wantedCommand;
