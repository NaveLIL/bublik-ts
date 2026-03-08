import { SlashCommandBuilder, ChatInputCommandInteraction } from 'discord.js';
import { BublikCommand, CommandScope } from '../../../types';
import { BublikEmbed } from '../../../core/EmbedBuilder';
import { i18n } from '../../../core/I18n';
import type { BublikClient } from '../../../bot';

const command: BublikCommand = {
  data: new SlashCommandBuilder()
    .setName('ping')
    .setDescription('Check bot latency')
    .setDescriptionLocalizations({
      ru: 'Проверить задержку бота',
    }),

  scope: CommandScope.Guild,
  category: 'general',
  descriptionKey: 'commands.ping.description',
  cooldown: 3,

  async execute(interaction: ChatInputCommandInteraction, client: BublikClient): Promise<void> {
    const locale = interaction.locale.startsWith('ru') ? 'ru' : 'en'; // TODO: из GuildSettings
    const sent = await interaction.deferReply({ fetchReply: true });

    const roundtrip = sent.createdTimestamp - interaction.createdTimestamp;
    const wsLatency = client.ws.ping;

    const embed = new BublikEmbed()
      .setTitle(`🏓 ${i18n.t('commands.ping.title', locale)}`)
      .addFields(
        {
          name: `📡 ${i18n.t('commands.ping.roundtrip', locale)}`,
          value: `\`${roundtrip}ms\``,
          inline: true,
        },
        {
          name: `💓 ${i18n.t('commands.ping.websocket', locale)}`,
          value: `\`${wsLatency}ms\``,
          inline: true,
        },
      )
      .success();

    await interaction.editReply({ embeds: [embed] });
  },
};

export default command;
