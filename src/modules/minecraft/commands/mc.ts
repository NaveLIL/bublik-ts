import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  PermissionFlagsBits,
  MessageFlags,
  ChannelType,
} from 'discord.js';
import type { BublikClient } from '../../../bot';
import { BublikCommand, CommandScope } from '../../../types';
import { refreshGuildMinecraftStatus } from '../services/status-tracker';
import { buildMinecraftStatusEmbed } from '../embeds';
import { updateMinecraftConfig, getOrCreateMinecraftConfig } from '../database';

const mcCommand: BublikCommand = {
  data: new SlashCommandBuilder()
    .setName('mc')
    .setDescription('🎮 Команды модуля Minecraft (EREZCRAFT)')
    .setDescriptionLocalizations({
      ru: '🎮 Команды модуля Minecraft (EREZCRAFT)',
    })
    .addSubcommand((sub) =>
      sub
        .setName('status')
        .setDescription('Проверить текущее состояние Minecraft-сервера')
        .setDescriptionLocalizations({ ru: 'Проверить текущее состояние Minecraft-сервера' })
    )
    .addSubcommand((sub) =>
      sub
        .setName('setup')
        .setDescription('Указать канал для автоматической Live статус-панели')
        .setDescriptionLocalizations({ ru: 'Указать канал для автоматической Live статус-панели' })
        .addChannelOption((opt) =>
          opt
            .setName('channel')
            .setDescription('Канал для вывода постоянного статуса')
            .addChannelTypes(ChannelType.GuildText)
            .setRequired(true)
        )
    ),

  scope: CommandScope.Guild,
  category: 'general',
  descriptionKey: 'commands.mc.description',

  async execute(interaction: ChatInputCommandInteraction, client: BublikClient): Promise<void> {
    const subcommand = interaction.options.getSubcommand();
    const guildId = interaction.guildId!;

    if (subcommand === 'status') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const metrics = await refreshGuildMinecraftStatus(client, guildId);
      const embed = buildMinecraftStatusEmbed(metrics);
      await interaction.editReply({ embeds: [embed] });
      return;
    }

    if (subcommand === 'setup') {
      // Permission check: ManageGuild
      if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
        await interaction.reply({
          content: '⛔ Только администраторы сервера могут настраивать канал статус-панели.',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const targetChannel = interaction.options.getChannel('channel', true);

      await updateMinecraftConfig(guildId, {
        statusChannelId: targetChannel.id,
        statusMessageId: null, // Force creation of new status message in target channel
      });

      const metrics = await refreshGuildMinecraftStatus(client, guildId);

      await interaction.editReply({
        content: `✅ Автоматическая Live статус-панель настроена в канале <#${targetChannel.id}>!`,
      });
      return;
    }
  },
};

export default mcCommand;
