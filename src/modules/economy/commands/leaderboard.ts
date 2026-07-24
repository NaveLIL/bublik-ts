// ═══════════════════════════════════════════════
//  /leaderboard — Лидерборд экономики
// ═══════════════════════════════════════════════

import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
} from 'discord.js';
import type { BublikClient } from '../../../bot';
import { BublikCommand, CommandScope } from '../../../types/Command';
import { getLeaderboard, getEcoConfig } from '../database';
import { buildLeaderboardEmbed, ecoError } from '../embeds';
import { i18n } from '../../../core/I18n';
import { getGuildLocale } from '../../../core/GuildConfig';

const leaderboardCommand: BublikCommand = {
  data: new SlashCommandBuilder()
    .setName('leaderboard')
    .setDescription('Топ богатейших участников сервера')
    .addIntegerOption((opt) =>
      opt
        .setName('page')
        .setDescription('Страница (по 10 человек)')
        .setMinValue(1)
        .setRequired(false),
    ),

  scope: CommandScope.Guild,
  category: 'economy',
  descriptionKey: 'commands.leaderboard.description',

  async execute(interaction: ChatInputCommandInteraction, _client: BublikClient): Promise<void> {
    const guildId = interaction.guildId!;
    const locale = await getGuildLocale(interaction.guildId);

    const config = await getEcoConfig(guildId);
    if (!config?.enabled) {
      await interaction.reply({
        embeds: [ecoError(i18n.t('economy.common.error_economy_disabled', locale))],
        ephemeral: true,
      });
      return;
    }

    const page = (interaction.options.getInteger('page') || 1) - 1;
    const pageSize = 10;

    // Получаем все профили для подсчёта страниц
    const allProfiles = await getLeaderboard(guildId, 100);
    const totalPages = Math.max(1, Math.ceil(allProfiles.length / pageSize));
    const safePage = Math.min(page, totalPages - 1);

    const entries = allProfiles.slice(safePage * pageSize, (safePage + 1) * pageSize);

    await interaction.reply({
      embeds: [
        buildLeaderboardEmbed(
          interaction.guild!.name,
          entries,
          safePage,
          totalPages,
          locale,
        ),
      ],
    });
  },
};

export default leaderboardCommand;
