// ═══════════════════════════════════════════════
//  /heist — Коллективный налёт на банк
// ═══════════════════════════════════════════════

import { SlashCommandBuilder, ChatInputCommandInteraction, TextChannel, MessageFlags, GuildMember } from 'discord.js';
import type { BublikClient } from '../../../bot';
import { BublikCommand, CommandScope } from '../../../types/Command';
import { i18n } from '../../../core/I18n';
import { getGuildLocale } from '../../../core/GuildConfig';
import { ecoError, buildCooldownEmbed } from '../embeds';
import { createHeistSession, postHeistPanelAndStore } from '../heist-engine';
import { getEcoConfig } from '../database';

const heistCommand: BublikCommand = {
  data: new SlashCommandBuilder()
    .setName('heist')
    .setDescription('Собрать команду и ограбить банк игрока')
    .addUserOption((opt) =>
      opt.setName('user').setDescription('Жертва').setRequired(true),
    ),

  scope: CommandScope.Guild,
  category: 'economy',
  descriptionKey: 'commands.heist.description',

  async execute(interaction: ChatInputCommandInteraction, _client: BublikClient): Promise<void> {
    const locale = await getGuildLocale(interaction.guildId);
    const guildId = interaction.guildId!;
    const initiatorId = interaction.user.id;
    const target = interaction.options.getUser('user', true);

    const config = await getEcoConfig(guildId);
    if (config?.policeRoleId) {
      const member = interaction.member as GuildMember;
      if (member.roles.cache.has(config.policeRoleId)) {
        await interaction.reply({
          embeds: [ecoError('👮 **Полицейский не может организовывать ограбления банков!**\nВы при исполнении обязанностей.')],
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
    }

    if (target.bot) {
      await interaction.reply({ embeds: [ecoError(i18n.t('economy.cmd.heist.error_bot', locale))], flags: MessageFlags.Ephemeral });
      return;
    }
    if (!(interaction.channel instanceof TextChannel)) {
      await interaction.reply({ embeds: [ecoError(i18n.t('economy.cmd.heist.error_channel', locale))], flags: MessageFlags.Ephemeral });
      return;
    }

    const result = await createHeistSession(guildId, initiatorId, target.id, interaction.channelId);
    if (!result.ok) {
      if (result.errorKey === '__cooldown__' && result.cooldownRemaining) {
        await interaction.reply({
          embeds: [buildCooldownEmbed(i18n.t('economy.cmd.heist.cooldown_init', locale), result.cooldownRemaining, locale)],
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      await interaction.reply({
        embeds: [ecoError(i18n.t(result.errorKey || 'economy.cmd.heist.error_generic', locale, result.errorVars))],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    await interaction.reply({
      content: i18n.t('economy.cmd.heist.posting', locale),
      flags: MessageFlags.Ephemeral,
    });

    await postHeistPanelAndStore(interaction.client, interaction.channel, result.heistId!, locale);
  },
};

export default heistCommand;
