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
import { PB_TIERS } from '../constants';

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
    )

    // ── roles ─────────────────────
    .addSubcommand((sub) =>
      sub
        .setName('roles')
        .setDescription('Настроить PB-роли (до 10 тиров, от низшего к высшему)')
        .addRoleOption((o) => o.setName('tier1').setDescription('Тир 1: Шалом, полковые! (50ч, x1.0)').setRequired(false))
        .addRoleOption((o) => o.setName('tier2').setDescription('Тир 2: Кошерный Воин (100ч, x1.1)').setRequired(false))
        .addRoleOption((o) => o.setName('tier3').setDescription('Тир 3: Моше Даян Войса (200ч, x1.2)').setRequired(false))
        .addRoleOption((o) => o.setName('tier4').setDescription('Тир 4: Маца и Меркава (400ч, x1.3)').setRequired(false))
        .addRoleOption((o) => o.setName('tier5').setDescription('Тир 5: Шаббатний Ветеран (600ч, x1.4)').setRequired(false)),
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
      case 'roles':
        await handleRoles(interaction, guildId);
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

// ── roles ───────────────────────────────────────

async function handleRoles(
  interaction: ChatInputCommandInteraction,
  guildId: string,
): Promise<void> {
  // Собираем роли из опций (tier1..tier5)
  // Discord ограничивает 25 опций на субкоманду, поэтому тиры 6-10 можно добавить вторым вызовом
  const config = await getEcoConfig(guildId);
  const existing: string[] = config?.pbRoleIds ?? [];

  const roleIds: string[] = [...existing];
  // Заполняем до 10 элементов
  while (roleIds.length < 10) roleIds.push('');

  let updated = false;
  for (let i = 0; i < 5; i++) {
    const role = interaction.options.getRole(`tier${i + 1}`);
    if (role) {
      roleIds[i] = role.id;
      updated = true;
    }
  }

  if (!updated) {
    // Показываем текущие настройки
    const lines = PB_TIERS.map((t, i) => {
      const rId = existing[i];
      const roleStr = rId ? `<@&${rId}>` : '*не задана*';
      return `**${i + 1}.** ${t.name} (${t.hours}ч, x${t.multiplier}, банк: ${t.bankLimit === Infinity ? '∞' : t.bankLimit.toLocaleString('ru-RU')}) — ${roleStr}`;
    });

    await interaction.reply({
      embeds: [
        ecoSuccess(
          `**PB-роли экономики:**\n\n${lines.join('\n')}\n\n` +
          `Укажите роли в опциях tier1-tier5 для настройки.`,
        ),
      ],
      ephemeral: true,
    });
    return;
  }

  // Сохраняем обновлённый массив (убираем trailing empty)
  const trimmed = roleIds.slice();
  while (trimmed.length > 0 && !trimmed[trimmed.length - 1]) trimmed.pop();

  await upsertEcoConfig(guildId, { pbRoleIds: trimmed });

  const lines = PB_TIERS.slice(0, Math.max(trimmed.length, 5)).map((t, i) => {
    const rId = trimmed[i];
    const roleStr = rId ? `<@&${rId}>` : '*не задана*';
    return `**${i + 1}.** ${t.name} — ${roleStr}`;
  });

  await interaction.reply({
    embeds: [
      ecoSuccess(`**PB-роли обновлены!**\n\n${lines.join('\n')}`),
    ],
    ephemeral: true,
  });

  log.info(`[${guildId}] PB-роли обновлены: [${trimmed.join(', ')}]`);
}

export default economyCommand;
