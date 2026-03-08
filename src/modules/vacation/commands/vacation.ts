// ═══════════════════════════════════════════════
//  /vacation — Админская команда управления отпусками
//
//  Субкоманды:
//  • setup     — первичная настройка (каналы, роль)
//  • panel     — развернуть панель в канале
//  • addrole   — добавить роль (remove/reviewer/ping)
//  • removerole— убрать роль
//  • force     — принудительный отпуск (обход прайм-тайма)
//  • return    — принудительный возврат
//  • primetime — настройка прайм-тайма
//  • config    — показать текущую конфигурацию
//  • list      — список активных/ожидающих отпусков
//  • antiabuse — настройка антиабьюза (кулдаун, лимиты)
// ═══════════════════════════════════════════════

import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  ChannelType,
  PermissionsBitField,
  TextChannel,
  GuildMember,
} from 'discord.js';
import type { BublikClient } from '../../../bot';
import { BublikCommand, CommandScope } from '../../../types/Command';
import { logger } from '../../../core/Logger';
import { successEmbed, errorEmbed } from '../../../core/EmbedBuilder';

import {
  getConfig,
  upsertConfig,
  createRequest,
  getActiveVacation,
  getGuildActiveVacations,
  updateRequest,
} from '../database';
import {
  parseDuration,
  formatDuration,
  formatDateMsk,
  formatTimeLeft,
  applyVacationRoles,
  restoreRoles,
} from '../utils';
import {
  buildPanelEmbed,
  buildPanelButtons,
  buildVacationStartLog,
  buildVacationEndLog,
} from '../embeds';
import { VacationStatus, VacationType } from '../constants';

const log = logger.child('Vacation:Command');

const vacationCommand: BublikCommand = {
  data: new SlashCommandBuilder()
    .setName('vacation')
    .setDescription('Управление системой отпусков')

    // ── setup ─────────────────────
    .addSubcommand((sub) =>
      sub
        .setName('setup')
        .setDescription('Настроить систему отпусков')
        .addChannelOption((opt) =>
          opt
            .setName('review')
            .setDescription('Канал для заявок на отпуск')
            .addChannelTypes(ChannelType.GuildText)
            .setRequired(true),
        )
        .addChannelOption((opt) =>
          opt
            .setName('log')
            .setDescription('Канал для логов (уход/возврат)')
            .addChannelTypes(ChannelType.GuildText)
            .setRequired(true),
        )
        .addRoleOption((opt) =>
          opt
            .setName('role')
            .setDescription('Роль, выдаваемая в отпуске')
            .setRequired(true),
        )
        .addIntegerOption((opt) =>
          opt
            .setName('max_days')
            .setDescription('Максимальная длительность отпуска (дни)')
            .setMinValue(1)
            .setMaxValue(365)
            .setRequired(false),
        )
        .addIntegerOption((opt) =>
          opt
            .setName('quick_hours')
            .setDescription('Длительность «Не смогу сегодня» (часы)')
            .setMinValue(1)
            .setMaxValue(72)
            .setRequired(false),
        ),
    )

    // ── panel ─────────────────────
    .addSubcommand((sub) =>
      sub
        .setName('panel')
        .setDescription('Развернуть панель отпусков в канале')
        .addChannelOption((opt) =>
          opt
            .setName('channel')
            .setDescription('Канал для панели')
            .addChannelTypes(ChannelType.GuildText)
            .setRequired(true),
        )
        .addStringOption((opt) =>
          opt
            .setName('image')
            .setDescription('URL картинки для панели')
            .setRequired(false),
        ),
    )

    // ── addrole ───────────────────
    .addSubcommand((sub) =>
      sub
        .setName('addrole')
        .setDescription('Добавить роль в конфигурацию')
        .addStringOption((opt) =>
          opt
            .setName('type')
            .setDescription('Тип роли')
            .setRequired(true)
            .addChoices(
              { name: '🔄 Снимаемая (remove)', value: 'remove' },
              { name: '👮 Проверяющая (reviewer)', value: 'reviewer' },
              { name: '🔔 Уведомляемая (ping)', value: 'ping' },
            ),
        )
        .addRoleOption((opt) =>
          opt.setName('role').setDescription('Роль').setRequired(true),
        ),
    )

    // ── removerole ────────────────
    .addSubcommand((sub) =>
      sub
        .setName('removerole')
        .setDescription('Убрать роль из конфигурации')
        .addStringOption((opt) =>
          opt
            .setName('type')
            .setDescription('Тип роли')
            .setRequired(true)
            .addChoices(
              { name: '🔄 Снимаемая (remove)', value: 'remove' },
              { name: '👮 Проверяющая (reviewer)', value: 'reviewer' },
              { name: '🔔 Уведомляемая (ping)', value: 'ping' },
            ),
        )
        .addRoleOption((opt) =>
          opt.setName('role').setDescription('Роль').setRequired(true),
        ),
    )

    // ── force ─────────────────────
    .addSubcommand((sub) =>
      sub
        .setName('force')
        .setDescription('Принудительный отпуск (обход прайм-тайма)')
        .addUserOption((opt) =>
          opt.setName('user').setDescription('Участник').setRequired(true),
        )
        .addStringOption((opt) =>
          opt
            .setName('duration')
            .setDescription('Длительность (3d, 2w, 1m)')
            .setRequired(true),
        )
        .addStringOption((opt) =>
          opt
            .setName('reason')
            .setDescription('Причина')
            .setRequired(false),
        ),
    )

    // ── return ────────────────────
    .addSubcommand((sub) =>
      sub
        .setName('return')
        .setDescription('Принудительный возврат из отпуска')
        .addUserOption((opt) =>
          opt.setName('user').setDescription('Участник').setRequired(true),
        ),
    )

    // ── primetime ─────────────────
    .addSubcommand((sub) =>
      sub
        .setName('primetime')
        .setDescription('Настроить прайм-тайм')
        .addIntegerOption((opt) =>
          opt
            .setName('start')
            .setDescription('Начало прайм-тайма (час МСК, 0-23)')
            .setMinValue(0)
            .setMaxValue(23)
            .setRequired(true),
        )
        .addIntegerOption((opt) =>
          opt
            .setName('end')
            .setDescription('Конец прайм-тайма (час МСК, 0-23)')
            .setMinValue(0)
            .setMaxValue(23)
            .setRequired(true),
        )
        .addIntegerOption((opt) =>
          opt
            .setName('buffer')
            .setDescription('Блокировка за N часов до прайм-тайма')
            .setMinValue(0)
            .setMaxValue(6)
            .setRequired(false),
        ),
    )

    // ── config ────────────────────
    .addSubcommand((sub) =>
      sub.setName('config').setDescription('Показать текущую конфигурацию'),
    )

    // ── list ──────────────────────
    .addSubcommand((sub) =>
      sub.setName('list').setDescription('Список активных и ожидающих отпусков'),
    )

    // ── antiabuse ─────────────────
    .addSubcommand((sub) =>
      sub
        .setName('antiabuse')
        .setDescription('Настроить антиабьюз (кулдаун, лимиты)')
        .addIntegerOption((opt) =>
          opt
            .setName('cooldown')
            .setDescription('Дней кулдауна после возврата из отпуска (0 = отключить)')
            .setMinValue(0)
            .setMaxValue(90)
            .setRequired(false),
        )
        .addIntegerOption((opt) =>
          opt
            .setName('max_per_month')
            .setDescription('Макс. отпусков за 30 дней (0 = без лимита)')
            .setMinValue(0)
            .setMaxValue(30)
            .setRequired(false),
        )
        .addIntegerOption((opt) =>
          opt
            .setName('max_quick_per_week')
            .setDescription('Макс. быстрых отпусков за 7 дней (0 = без лимита)')
            .setMinValue(0)
            .setMaxValue(14)
            .setRequired(false),
        ),
    ),

  scope: CommandScope.Guild,
  category: 'admin',
  descriptionKey: 'commands.vacation.description',
  cooldown: 3,

  async execute(interaction: ChatInputCommandInteraction, client: BublikClient): Promise<void> {
    const sub = interaction.options.getSubcommand();

    // Все команды требуют ManageGuild
    const perms = interaction.memberPermissions;
    if (!perms?.has(PermissionsBitField.Flags.ManageGuild)) {
      await interaction.reply({
        embeds: [errorEmbed('Эта команда доступна только администраторам.')],
        ephemeral: true,
      });
      return;
    }

    switch (sub) {
      case 'setup':      await handleSetup(interaction, client); break;
      case 'panel':      await handlePanel(interaction, client); break;
      case 'addrole':    await handleAddRole(interaction); break;
      case 'removerole': await handleRemoveRole(interaction); break;
      case 'force':      await handleForce(interaction, client); break;
      case 'return':     await handleReturn(interaction, client); break;
      case 'primetime':  await handlePrimeTime(interaction); break;
      case 'config':     await handleConfig(interaction); break;
      case 'list':       await handleList(interaction); break;
      case 'antiabuse':  await handleAntiAbuse(interaction); break;
    }
  },
};

// ═══════════════════════════════════════════════
//  /vacation setup
// ═══════════════════════════════════════════════

async function handleSetup(
  interaction: ChatInputCommandInteraction,
  client: BublikClient,
): Promise<void> {
  const reviewChannel = interaction.options.getChannel('review', true);
  const logChannel = interaction.options.getChannel('log', true);
  const role = interaction.options.getRole('role', true);
  const maxDays = interaction.options.getInteger('max_days') ?? 30;
  const quickHours = interaction.options.getInteger('quick_hours') ?? 12;

  await upsertConfig(interaction.guildId!, {
    reviewChannelId: reviewChannel.id,
    logChannelId: logChannel.id,
    vacationRoleId: role.id,
    maxDurationDays: maxDays,
    quickDurationH: quickHours,
  });

  await interaction.reply({
    embeds: [successEmbed(
      `🏖️ **Система отпусков настроена!**\n\n` +
      `> 📋 **Канал заявок:** <#${reviewChannel.id}>\n` +
      `> 📝 **Канал логов:** <#${logChannel.id}>\n` +
      `> 🏖️ **Роль отпуска:** <@&${role.id}>\n` +
      `> ⏳ **Макс. срок:** ${maxDays} дн.\n` +
      `> ⚡ **Быстрый отпуск:** ${quickHours}ч\n\n` +
      `Далее:\n` +
      `• \`/vacation addrole type:remove\` — роли для снятия\n` +
      `• \`/vacation addrole type:reviewer\` — проверяющие\n` +
      `• \`/vacation addrole type:ping\` — роли для пинга\n` +
      `• \`/vacation panel\` — развернуть панель`,
    )],
    ephemeral: true,
  });

  log.info(`Vacation setup: ${interaction.guild?.name}`);
}

// ═══════════════════════════════════════════════
//  /vacation panel
// ═══════════════════════════════════════════════

async function handlePanel(
  interaction: ChatInputCommandInteraction,
  client: BublikClient,
): Promise<void> {
  const channel = interaction.options.getChannel('channel', true) as TextChannel;
  const imageUrl = interaction.options.getString('image');

  const guildId = interaction.guildId!;
  let config = await getConfig(guildId);

  if (!config) {
    await interaction.reply({
      embeds: [errorEmbed('Сначала выполните `/vacation setup`.')],
      ephemeral: true,
    });
    return;
  }

  // Обновить imageUrl если указан
  if (imageUrl) {
    config = await upsertConfig(guildId, { imageUrl });
  }

  await interaction.deferReply({ ephemeral: true });

  // Если панель уже есть в этом канале — попробовать обновить
  if (config.panelMessageId && config.panelChannelId === channel.id) {
    try {
      const existing = await channel.messages.fetch(config.panelMessageId);
      await existing.edit({
        embeds: [buildPanelEmbed(config)],
        components: [buildPanelButtons()],
      });
      await interaction.editReply({
        embeds: [successEmbed('Панель обновлена.')],
      });
      return;
    } catch {
      // Сообщение удалено — отправим новое
    }
  }

  // Удалить старую панель если в другом канале
  if (config.panelMessageId && config.panelChannelId && config.panelChannelId !== channel.id) {
    try {
      const oldChannel = await client.channels.fetch(config.panelChannelId) as TextChannel;
      await oldChannel.messages.delete(config.panelMessageId).catch(() => null);
    } catch { /* skip */ }
  }

  // Отправить новую панель
  const msg = await channel.send({
    embeds: [buildPanelEmbed(config)],
    components: [buildPanelButtons()],
  });

  await upsertConfig(guildId, {
    panelChannelId: channel.id,
    panelMessageId: msg.id,
  });

  await interaction.editReply({
    embeds: [successEmbed(`Панель развёрнута в <#${channel.id}>.`)],
  });

  log.info(`Панель отпусков развёрнута: ${channel.name}`);
}

// ═══════════════════════════════════════════════
//  /vacation addrole
// ═══════════════════════════════════════════════

async function handleAddRole(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const type = interaction.options.getString('type', true);
  const role = interaction.options.getRole('role', true);
  const guildId = interaction.guildId!;

  const config = await getConfig(guildId);
  if (!config) {
    await interaction.reply({ embeds: [errorEmbed('Сначала выполните `/vacation setup`.')], ephemeral: true });
    return;
  }

  const fieldMap: Record<string, string> = {
    remove: 'removeRoleIds',
    reviewer: 'reviewerRoleIds',
    ping: 'pingRoleIds',
  };
  const field = fieldMap[type] as 'removeRoleIds' | 'reviewerRoleIds' | 'pingRoleIds';
  const current: string[] = config[field];

  if (current.includes(role.id)) {
    await interaction.reply({ embeds: [errorEmbed(`<@&${role.id}> уже в списке.`)], ephemeral: true });
    return;
  }

  const updated = [...current, role.id];
  await upsertConfig(guildId, { [field]: updated });

  const typeLabels: Record<string, string> = {
    remove: '🔄 Снимаемые',
    reviewer: '👮 Проверяющие',
    ping: '🔔 Уведомляемые',
  };

  const list = updated.map((id) => `<@&${id}>`).join(', ');
  await interaction.reply({
    embeds: [successEmbed(
      `<@&${role.id}> добавлена в **${typeLabels[type]}**.\n\n> **Текущий список:** ${list}`,
    )],
    ephemeral: true,
  });
}

// ═══════════════════════════════════════════════
//  /vacation removerole
// ═══════════════════════════════════════════════

async function handleRemoveRole(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const type = interaction.options.getString('type', true);
  const role = interaction.options.getRole('role', true);
  const guildId = interaction.guildId!;

  const config = await getConfig(guildId);
  if (!config) {
    await interaction.reply({ embeds: [errorEmbed('Сначала выполните `/vacation setup`.')], ephemeral: true });
    return;
  }

  const fieldMap: Record<string, string> = {
    remove: 'removeRoleIds',
    reviewer: 'reviewerRoleIds',
    ping: 'pingRoleIds',
  };
  const field = fieldMap[type] as 'removeRoleIds' | 'reviewerRoleIds' | 'pingRoleIds';
  const current: string[] = config[field];

  if (!current.includes(role.id)) {
    await interaction.reply({ embeds: [errorEmbed(`<@&${role.id}> не в списке.`)], ephemeral: true });
    return;
  }

  const updated = current.filter((id) => id !== role.id);
  await upsertConfig(guildId, { [field]: updated });

  const typeLabels: Record<string, string> = {
    remove: '🔄 Снимаемые',
    reviewer: '👮 Проверяющие',
    ping: '🔔 Уведомляемые',
  };

  const list = updated.length > 0 ? updated.map((id) => `<@&${id}>`).join(', ') : '*нет*';
  await interaction.reply({
    embeds: [successEmbed(
      `<@&${role.id}> убрана из **${typeLabels[type]}**.\n\n> **Текущий список:** ${list}`,
    )],
    ephemeral: true,
  });
}

// ═══════════════════════════════════════════════
//  /vacation force — принудительный отпуск
// ═══════════════════════════════════════════════

async function handleForce(
  interaction: ChatInputCommandInteraction,
  client: BublikClient,
): Promise<void> {
  const targetUser = interaction.options.getUser('user', true);
  const durationStr = interaction.options.getString('duration', true);
  const reason = interaction.options.getString('reason') ?? '👮 Принудительный отпуск';

  const guildId = interaction.guildId!;
  const config = await getConfig(guildId);
  if (!config) {
    await interaction.reply({ embeds: [errorEmbed('Система отпусков не настроена.')], ephemeral: true });
    return;
  }

  const durationMinutes = parseDuration(durationStr);
  if (!durationMinutes) {
    await interaction.reply({
      embeds: [errorEmbed('Неверный формат длительности. Примеры: `3d`, `2w`, `1m`')],
      ephemeral: true,
    });
    return;
  }

  // Проверить, не в отпуске ли уже
  const active = await getActiveVacation(guildId, targetUser.id);
  if (active) {
    await interaction.reply({
      embeds: [errorEmbed(`<@${targetUser.id}> уже в отпуске до ${formatDateMsk(active.endDate!)}.`)],
      ephemeral: true,
    });
    return;
  }

  await interaction.deferReply({ ephemeral: true });

  const guild = interaction.guild!;
  const member = await guild.members.fetch(targetUser.id).catch(() => null);
  if (!member) {
    await interaction.editReply({ embeds: [errorEmbed('Участник не найден на сервере.')] });
    return;
  }

  const now = new Date();
  const endDate = new Date(now.getTime() + durationMinutes * 60_000);

  // Снять роли
  const savedRoles = await applyVacationRoles(member, config);

  // Создать запись
  const request = await createRequest({
    guildId,
    userId: targetUser.id,
    type: VacationType.Admin,
    reason,
    durationMinutes,
    status: VacationStatus.Active,
    startDate: now,
    endDate,
    savedRoleIds: savedRoles,
    configId: config.id,
  });

  // Лог
  if (config.logChannelId) {
    try {
      const logChannel = await client.channels.fetch(config.logChannelId) as TextChannel;
      await logChannel.send({ embeds: [buildVacationStartLog(member, request, savedRoles)] });
    } catch { /* skip */ }
  }

  // DM
  await member.send({
    embeds: [successEmbed(
      `🏖️ Вам оформлен отпуск администратором.\n\n` +
      `**Причина:** ${reason}\n` +
      `**Срок:** ${formatDuration(durationMinutes)}\n` +
      `**До:** ${formatDateMsk(endDate)}`,
    )],
  }).catch(() => null);

  await interaction.editReply({
    embeds: [successEmbed(
      `🏖️ Отпуск оформлен для ${member.toString()}.\n\n` +
      `> **Причина:** ${reason}\n` +
      `> **Срок:** ${formatDuration(durationMinutes)}\n` +
      `> **До:** ${formatDateMsk(endDate)}`,
    )],
  });

  log.info(`Принудительный отпуск: ${member.user.tag} — ${formatDuration(durationMinutes)} (admin: ${interaction.user.tag})`);
}

// ═══════════════════════════════════════════════
//  /vacation return — принудительный возврат
// ═══════════════════════════════════════════════

async function handleReturn(
  interaction: ChatInputCommandInteraction,
  client: BublikClient,
): Promise<void> {
  const targetUser = interaction.options.getUser('user', true);
  const guildId = interaction.guildId!;

  const active = await getActiveVacation(guildId, targetUser.id);
  if (!active) {
    await interaction.reply({
      embeds: [errorEmbed(`<@${targetUser.id}> не находится в отпуске.`)],
      ephemeral: true,
    });
    return;
  }

  await interaction.deferReply({ ephemeral: true });

  const guild = interaction.guild!;
  const member = await guild.members.fetch(targetUser.id).catch(() => null);

  if (member) {
    await restoreRoles(member, active.savedRoleIds, active.config.vacationRoleId);
  }

  await updateRequest(active.id, { status: VacationStatus.Completed });

  // Лог
  if (active.config.logChannelId && member) {
    try {
      const logChannel = await client.channels.fetch(active.config.logChannelId) as TextChannel;
      await logChannel.send({ embeds: [buildVacationEndLog(member, active, true)] });
    } catch { /* skip */ }
  }

  await interaction.editReply({
    embeds: [successEmbed(`${targetUser.toString()} принудительно возвращён из отпуска. Роли восстановлены.`)],
  });

  log.info(`Принудительный возврат: ${targetUser.tag} (admin: ${interaction.user.tag})`);
}

// ═══════════════════════════════════════════════
//  /vacation primetime
// ═══════════════════════════════════════════════

async function handlePrimeTime(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const start = interaction.options.getInteger('start', true);
  const end = interaction.options.getInteger('end', true);
  const buffer = interaction.options.getInteger('buffer') ?? 1;

  await upsertConfig(interaction.guildId!, {
    primeTimeStart: start,
    primeTimeEnd: end,
    primeTimeBuffer: buffer,
  });

  const blockStart = (start - buffer + 24) % 24;
  await interaction.reply({
    embeds: [successEmbed(
      `⏰ **Прайм-тайм обновлён:**\n\n` +
      `> 🕐 **Прайм-тайм:** ${String(start).padStart(2, '0')}:00 — ${String(end).padStart(2, '0')}:00 МСК\n` +
      `> 🚫 **Блокировка с:** ${String(blockStart).padStart(2, '0')}:00 МСК (буфер ${buffer}ч)`,
    )],
    ephemeral: true,
  });
}

// ═══════════════════════════════════════════════
//  /vacation config
// ═══════════════════════════════════════════════

async function handleConfig(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const config = await getConfig(interaction.guildId!);
  if (!config) {
    await interaction.reply({
      embeds: [errorEmbed('Система отпусков не настроена. Используйте `/vacation setup`.')],
      ephemeral: true,
    });
    return;
  }

  const removeRoles = config.removeRoleIds.length > 0
    ? config.removeRoleIds.map((id: string) => `<@&${id}>`).join(', ')
    : '*не настроены*';
  const reviewerRoles = config.reviewerRoleIds.length > 0
    ? config.reviewerRoleIds.map((id: string) => `<@&${id}>`).join(', ')
    : '*не настроены*';
  const pingRoles = config.pingRoleIds.length > 0
    ? config.pingRoleIds.map((id: string) => `<@&${id}>`).join(', ')
    : '*не настроены*';

  const blockStart = (config.primeTimeStart - config.primeTimeBuffer + 24) % 24;

  await interaction.reply({
    embeds: [successEmbed(
      `⚙️ **Конфигурация системы отпусков:**\n\n` +
      `> 📋 **Канал заявок:** ${config.reviewChannelId ? `<#${config.reviewChannelId}>` : '*не настроен*'}\n` +
      `> 📝 **Канал логов:** ${config.logChannelId ? `<#${config.logChannelId}>` : '*не настроен*'}\n` +
      `> 🏖️ **Роль отпуска:** ${config.vacationRoleId ? `<@&${config.vacationRoleId}>` : '*не настроена*'}\n` +
      `> 🔄 **Снимаемые роли:** ${removeRoles}\n` +
      `> 👮 **Проверяющие:** ${reviewerRoles}\n` +
      `> 🔔 **Уведомляемые:** ${pingRoles}\n` +
      `> ⏳ **Макс. длительность:** ${config.maxDurationDays} дн.\n` +
      `> ⚡ **Быстрый отпуск:** ${config.quickDurationH}ч\n` +
      `> 🕐 **Прайм-тайм:** ${String(config.primeTimeStart).padStart(2, '0')}:00 — ` +
        `${String(config.primeTimeEnd).padStart(2, '0')}:00 МСК\n` +
      `> 🚫 **Блокировка с:** ${String(blockStart).padStart(2, '0')}:00 МСК\n\n` +
      `🛡️ **Антиабьюз:**\n` +
      `> ⏳ **Кулдаун:** ${config.cooldownDays} дн.\n` +
      `> 📊 **Макс. за 30 дн.:** ${config.maxPerMonth || '∞'}\n` +
      `> ⚡ **Макс. быстрых/7 дн.:** ${config.maxQuickPerWeek || '∞'}`,
    )],
    ephemeral: true,
  });
}

// ═══════════════════════════════════════════════
//  /vacation list
// ═══════════════════════════════════════════════

async function handleList(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const vacations = await getGuildActiveVacations(interaction.guildId!);

  if (vacations.length === 0) {
    await interaction.reply({
      embeds: [successEmbed('📋 Нет активных или ожидающих отпусков.')],
      ephemeral: true,
    });
    return;
  }

  const active = vacations.filter((v: any) => v.status === VacationStatus.Active);
  const pending = vacations.filter((v: any) => v.status === VacationStatus.Pending);

  const lines: string[] = [];

  if (active.length > 0) {
    lines.push('**🏖️ Активные отпуска:**\n');
    for (const v of active) {
      const left = formatTimeLeft(v.endDate!);
      const typeIcon = v.type === 'quick' ? '⚡' : v.type === 'admin' ? '👮' : '🏖️';
      lines.push(
        `${typeIcon} <@${v.userId}> — до **${formatDateMsk(v.endDate!)}** (${left})\n` +
        `> 📝 ${v.reason}`,
      );
    }
  }

  if (pending.length > 0) {
    if (active.length > 0) lines.push('');
    lines.push('**⏳ Ожидающие заявки:**\n');
    for (const v of pending) {
      lines.push(
        `📋 <@${v.userId}> — ${formatDuration(v.durationMinutes)}\n` +
        `> 📝 ${v.reason}`,
      );
    }
  }

  await interaction.reply({
    embeds: [successEmbed(`📋 **Отпуска** (${vacations.length})\n\n${lines.join('\n')}`)],
    ephemeral: true,
  });
}

// ═══════════════════════════════════════════════
//  /vacation antiabuse — настройка антиабьюза
// ═══════════════════════════════════════════════

async function handleAntiAbuse(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const guildId = interaction.guildId!;
  const config = await getConfig(guildId);
  if (!config) {
    await interaction.reply({
      embeds: [errorEmbed('Система отпусков не настроена. Используйте `/vacation setup`.')],
      ephemeral: true,
    });
    return;
  }

  const cooldown = interaction.options.getInteger('cooldown');
  const maxPerMonth = interaction.options.getInteger('max_per_month');
  const maxQuickPerWeek = interaction.options.getInteger('max_quick_per_week');

  // Если ничего не указано — показать текущие настройки
  if (cooldown === null && maxPerMonth === null && maxQuickPerWeek === null) {
    await interaction.reply({
      embeds: [successEmbed(
        `🛡️ **Настройки антиабьюза:**\n\n` +
        `> ⏳ **Кулдаун после отпуска:** ${config.cooldownDays} дн.\n` +
        `> 📊 **Макс. отпусков за 30 дн.:** ${config.maxPerMonth || '∞ (без лимита)'}\n` +
        `> ⚡ **Макс. быстрых за 7 дн.:** ${config.maxQuickPerWeek || '∞ (без лимита)'}\n\n` +
        `Укажите параметры для изменения:\n` +
        `\`/vacation antiabuse cooldown:7 max_per_month:3 max_quick_per_week:2\``,
      )],
      ephemeral: true,
    });
    return;
  }

  const updateData: Record<string, number> = {};
  if (cooldown !== null) updateData.cooldownDays = cooldown;
  if (maxPerMonth !== null) updateData.maxPerMonth = maxPerMonth;
  if (maxQuickPerWeek !== null) updateData.maxQuickPerWeek = maxQuickPerWeek;

  const updated = await upsertConfig(guildId, updateData);

  await interaction.reply({
    embeds: [successEmbed(
      `🛡️ **Антиабьюз обновлён:**\n\n` +
      `> ⏳ **Кулдаун:** ${updated.cooldownDays} дн.${cooldown !== null ? ' ✏️' : ''}\n` +
      `> 📊 **Макс. за 30 дн.:** ${updated.maxPerMonth || '∞'}${maxPerMonth !== null ? ' ✏️' : ''}\n` +
      `> ⚡ **Макс. быстрых/7 дн.:** ${updated.maxQuickPerWeek || '∞'}${maxQuickPerWeek !== null ? ' ✏️' : ''}`,
    )],
    ephemeral: true,
  });

  log.info(`Антиабьюз обновлён: cooldown=${updated.cooldownDays}, maxMonth=${updated.maxPerMonth}, maxQuick=${updated.maxQuickPerWeek}`);
}

export default vacationCommand;
