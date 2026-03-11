// ═══════════════════════════════════════════════
//  /economy — Админская команда настройки экономики
//
//  Субкоманды:
//  • setup   — каналы (новости, логи)
//  • toggle  — вкл/выкл экономики
//  • config  — текущая конфигурация
//  • reset   — сброс профиля пользователя
// ═══════════════════════════════════════════════

import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  ChannelType,
  PermissionsBitField,
} from 'discord.js';
import type { BublikClient } from '../../../bot';
import { BublikCommand, CommandScope } from '../../../types/Command';
import { logger } from '../../../core/Logger';
import { getDatabase } from '../../../core/Database';
import { upsertEcoConfig, getEcoConfig, deleteEcoConfig, invalidateProfileCache } from '../database';
import { buildSetupEmbed, ecoError, ecoSuccess } from '../embeds';

const log = logger.child('Economy:Command');

const economyCommand: BublikCommand = {
  data: new SlashCommandBuilder()
    .setName('economy')
    .setDescription('Управление системой экономики')
    .setDefaultMemberPermissions(PermissionsBitField.Flags.Administrator)

    // ── setup ─────────────────────
    .addSubcommand((sub) =>
      sub
        .setName('setup')
        .setDescription('Настроить каналы экономики')
        .addChannelOption((opt) =>
          opt
            .setName('news')
            .setDescription('Канал новостей экономики')
            .addChannelTypes(ChannelType.GuildText)
            .setRequired(false),
        )
        .addChannelOption((opt) =>
          opt
            .setName('log')
            .setDescription('Канал логов экономики (для админов)')
            .addChannelTypes(ChannelType.GuildText)
            .setRequired(false),
        ),
    )

    // ── toggle ────────────────────
    .addSubcommand((sub) =>
      sub
        .setName('toggle')
        .setDescription('Включить/выключить экономику'),
    )

    // ── config ────────────────────
    .addSubcommand((sub) =>
      sub
        .setName('config')
        .setDescription('Показать текущую конфигурацию экономики'),
    )

    // ── reset ─────────────────────
    .addSubcommand((sub) =>
      sub
        .setName('reset')
        .setDescription('Сбросить профиль экономики пользователя')
        .addUserOption((opt) =>
          opt
            .setName('user')
            .setDescription('Пользователь для сброса')
            .setRequired(true),
        ),
    ),

  scope: CommandScope.Guild,
  category: 'admin',
  descriptionKey: 'commands.economy.description',

  async execute(interaction: ChatInputCommandInteraction, client: BublikClient): Promise<void> {
    const sub = interaction.options.getSubcommand();
    const guildId = interaction.guildId!;

    switch (sub) {
      case 'setup':
        await handleSetup(interaction, guildId);
        break;
      case 'toggle':
        await handleToggle(interaction, guildId);
        break;
      case 'config':
        await handleConfig(interaction, guildId);
        break;
      case 'reset':
        await handleReset(interaction, guildId);
        break;
      default:
        await interaction.reply({ embeds: [ecoError('Неизвестная субкоманда.')], ephemeral: true });
    }
  },
};

// ── setup ─────────────────────────────────────

async function handleSetup(
  interaction: ChatInputCommandInteraction,
  guildId: string,
): Promise<void> {
  const newsChannel = interaction.options.getChannel('news');
  const logChannel = interaction.options.getChannel('log');

  if (!newsChannel && !logChannel) {
    await interaction.reply({
      embeds: [ecoError('Укажите хотя бы один канал для настройки.')],
      ephemeral: true,
    });
    return;
  }

  const data: Record<string, any> = {};
  if (newsChannel) data.newsChannelId = newsChannel.id;
  if (logChannel) data.logChannelId = logChannel.id;

  await upsertEcoConfig(guildId, data);

  const config = await getEcoConfig(guildId);

  await interaction.reply({
    embeds: [
      buildSetupEmbed(
        interaction.guild!.name,
        config?.enabled ?? true,
        config?.newsChannelId ?? null,
        config?.logChannelId ?? null,
      ),
    ],
    ephemeral: true,
  });

  log.info(`[${guildId}] Экономика настроена: news=${newsChannel?.id}, log=${logChannel?.id}`);
}

// ── toggle ────────────────────────────────────

async function handleToggle(
  interaction: ChatInputCommandInteraction,
  guildId: string,
): Promise<void> {
  const config = await getEcoConfig(guildId);
  const currentState = config?.enabled ?? true;
  const newState = !currentState;

  await upsertEcoConfig(guildId, { enabled: newState });

  await interaction.reply({
    embeds: [
      ecoSuccess(
        newState
          ? 'Экономика **включена** ✅'
          : 'Экономика **выключена** ❌',
      ),
    ],
    ephemeral: true,
  });

  log.info(`[${guildId}] Экономика ${newState ? 'включена' : 'выключена'}`);
}

// ── config ────────────────────────────────────

async function handleConfig(
  interaction: ChatInputCommandInteraction,
  guildId: string,
): Promise<void> {
  const config = await getEcoConfig(guildId);

  if (!config) {
    await interaction.reply({
      embeds: [ecoError('Экономика не настроена. Используйте `/economy setup`.')],
      ephemeral: true,
    });
    return;
  }

  await interaction.reply({
    embeds: [
      buildSetupEmbed(
        interaction.guild!.name,
        config.enabled,
        config.newsChannelId,
        config.logChannelId,
      ),
    ],
    ephemeral: true,
  });
}

// ── reset ─────────────────────────────────────

async function handleReset(
  interaction: ChatInputCommandInteraction,
  guildId: string,
): Promise<void> {
  const target = interaction.options.getUser('user', true);

  try {
    const db = getDatabase();

    // Удаляем все транзакции и профиль
    await db.economyTransaction.deleteMany({
      where: { guildId, userId: target.id },
    });
    await db.economyProfile.deleteMany({
      where: { guildId, userId: target.id },
    });

    // Инвалидируем кэш
    await invalidateProfileCache(guildId, target.id);

    await interaction.reply({
      embeds: [ecoSuccess(`Профиль экономики <@${target.id}> сброшен.`)],
      ephemeral: true,
    });

    log.info(`[${guildId}] Профиль ${target.id} сброшен администратором ${interaction.user.id}`);
  } catch (err) {
    log.error(`Ошибка сброса профиля ${target.id}`, err);
    await interaction.reply({
      embeds: [ecoError('Не удалось сбросить профиль.')],
      ephemeral: true,
    });
  }
}

export default economyCommand;
