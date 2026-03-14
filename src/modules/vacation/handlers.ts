// ═══════════════════════════════════════════════
//  Vacation — Обработчики интеракций
// ═══════════════════════════════════════════════

import {
  Interaction,
  ButtonInteraction,
  StringSelectMenuInteraction,
  ModalSubmitInteraction,
  GuildMember,
  TextChannel,
} from 'discord.js';
import type { BublikClient } from '../../bot';
import { logger } from '../../core/Logger';
import { errorReporter } from '../../core/ErrorReporter';

import {
  VAC_PREFIX,
  VAC_SEP,
  VacationStatus,
  VacationType,
  REASONS,
  getReasonLabel,
  MIN_DURATION_MINUTES,
} from './constants';

import {
  getConfig,
  createRequest,
  getRequest,
  updateRequest,
  getActiveVacation,
  getPendingRequest,
  getLastCompletedVacationEnd,
  countRecentVacations,
  countRecentQuickLeaves,
  getUserVacationStats,
} from './database';

import {
  parseDuration,
  formatDuration,
  formatDateMsk,
  isPrimeTime,
  primeTimeText,
  applyVacationRoles,
  restoreRoles,
} from './utils';

import {
  buildReasonSelect,
  buildDurationModal,
  buildRequestEmbed,
  buildRequestButtons,
  buildApprovedRequestEmbed,
  buildDeniedRequestEmbed,
  buildVacationStartLog,
  buildVacationEndLog,
  buildDmApproved,
  buildDmDenied,
  vacSuccess,
  vacError,
  vacWarn,
} from './embeds';

const log = logger.child('Vacation:Handlers');

function isTransientInteractionError(err: unknown): boolean {
  const anyErr = err as any;
  const message = String(anyErr?.message ?? anyErr ?? '');

  return (
    anyErr?.code === 10062 ||
    message.includes('Unknown interaction') ||
    message.includes('EAI_AGAIN') ||
    message.includes('getaddrinfo EAI_AGAIN')
  );
}

// ═══════════════════════════════════════════════
//  Роутер интеракций
// ═══════════════════════════════════════════════

export async function handleVacationInteraction(
  interaction: Interaction,
  client: BublikClient,
): Promise<void> {
  try {
    // ── Кнопки ──────────────────────
    if (interaction.isButton()) {
      const parts = interaction.customId.split(VAC_SEP);
      if (parts[0] !== VAC_PREFIX) return;

      const action = parts[1];

      switch (action) {
        case 'go':
          await handleGoButton(interaction, client);
          break;
        case 'return':
          await handleReturnButton(interaction, client);
          break;
        case 'quick':
          await handleQuickButton(interaction, client);
          break;
        case 'approve':
          await handleApproveButton(interaction, parts[2], client);
          break;
        case 'deny':
          await handleDenyButton(interaction, parts[2], client);
          break;
      }
      return;
    }

    // ── StringSelectMenu ────────────
    if (interaction.isStringSelectMenu()) {
      if (interaction.customId === `${VAC_PREFIX}${VAC_SEP}sel${VAC_SEP}reason`) {
        await handleReasonSelect(interaction as StringSelectMenuInteraction, client);
      }
      return;
    }

    // ── Модальные окна ──────────────
    if (interaction.isModalSubmit()) {
      const parts = interaction.customId.split(VAC_SEP);
      if (parts[0] === VAC_PREFIX && parts[1] === 'modal' && parts[2] === 'duration') {
        await handleDurationModal(interaction as ModalSubmitInteraction, parts[3], client);
      }
      return;
    }
  } catch (err) {
    if (isTransientInteractionError(err)) {
      log.warn('Транзиентная ошибка в vacation interaction (пропускаем репорт)', { error: String(err) });
      return;
    }

    log.error('Ошибка в обработчике vacation', { error: String(err) });
    errorReporter.eventError(err, 'interactionCreate', 'vacation');

    if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
      await interaction.reply({
        embeds: [vacError('Произошла внутренняя ошибка.')],
        ephemeral: true,
      }).catch(() => null);
    }
  }
}

// ═══════════════════════════════════════════════
//  «Уйти в отпуск» — начало флоу
// ═══════════════════════════════════════════════

async function handleGoButton(
  interaction: ButtonInteraction,
  client: BublikClient,
): Promise<void> {
  if (!interaction.guildId) return;
  const guildId = interaction.guildId;
  const userId = interaction.user.id;

  const config = await getConfig(guildId);
  if (!config) {
    await interaction.reply({ embeds: [vacError('Система отпусков не настроена.')], ephemeral: true });
    return;
  }

  // Уже в отпуске?
  const active = await getActiveVacation(guildId, userId);
  if (active) {
    await interaction.reply({
      embeds: [vacWarn(
        `Вы уже в отпуске до **${formatDateMsk(active.endDate!)}** ` +
        `(осталось ${formatDuration(Math.max(0, Math.ceil((active.endDate!.getTime() - Date.now()) / 60_000)))})\n\n` +
        `Используйте **«Вернуться из отпуска»** для досрочного возвращения.`,
      )],
      ephemeral: true,
    });
    return;
  }

  // Уже есть ожидающая заявка?
  const pending = await getPendingRequest(guildId, userId);
  if (pending) {
    await interaction.reply({
      embeds: [vacWarn('У вас уже есть ожидающая заявка. Дождитесь решения или она автоматически истечёт через 3 часа.')],
      ephemeral: true,
    });
    return;
  }

  // Прайм-тайм?
  if (isPrimeTime(config)) {
    await interaction.reply({
      embeds: [vacError(
        `Нельзя уйти в отпуск во время прайм-тайма или за ${config.primeTimeBuffer}ч до него.\n` +
        `Заблокировано: **${primeTimeText(config)}**`,
      )],
      ephemeral: true,
    });
    return;
  }

  // Антиабьюз: кулдаун после последнего отпуска
  if (config.cooldownDays > 0) {
    const lastEnd = await getLastCompletedVacationEnd(guildId, userId);
    if (lastEnd) {
      const cooldownEnd = new Date(lastEnd.getTime() + config.cooldownDays * 24 * 60 * 60 * 1000);
      if (Date.now() < cooldownEnd.getTime()) {
        const leftMs = cooldownEnd.getTime() - Date.now();
        const leftDays = Math.ceil(leftMs / (24 * 60 * 60 * 1000));
        await interaction.reply({
          embeds: [vacError(
            `После возврата из отпуска должно пройти минимум **${config.cooldownDays} дн.** перед новым отпуском.\n` +
            `Кулдаун истекает через **${leftDays} дн.**`,
          )],
          ephemeral: true,
        });
        return;
      }
    }
  }

  // Антиабьюз: лимит отпусков за 30 дней
  if (config.maxPerMonth > 0) {
    const recent = await countRecentVacations(guildId, userId, 30);
    if (recent >= config.maxPerMonth) {
      await interaction.reply({
        embeds: [vacError(
          `Вы достигли лимита отпусков: **${config.maxPerMonth}** за последние 30 дней.\n` +
          `У вас уже было **${recent}** отпусков за этот период.`,
        )],
        ephemeral: true,
      });
      return;
    }
  }

  // Показать меню выбора причины
  await interaction.reply({
    content: '📝 **Выберите причину отпуска:**',
    components: [buildReasonSelect()],
    ephemeral: true,
  });
}

// ═══════════════════════════════════════════════
//  Выбор причины → показать модал длительности
// ═══════════════════════════════════════════════

async function handleReasonSelect(
  interaction: StringSelectMenuInteraction,
  client: BublikClient,
): Promise<void> {
  const reason = interaction.values[0];

  // Показать модал (reason закодирован в customId)
  await interaction.showModal(buildDurationModal(reason));
}

// ═══════════════════════════════════════════════
//  Модал длительности → создать заявку
// ═══════════════════════════════════════════════

async function handleDurationModal(
  interaction: ModalSubmitInteraction,
  reasonValue: string,
  client: BublikClient,
): Promise<void> {
  const guildId = interaction.guildId;
  if (!guildId) return;
  const userId = interaction.user.id;

  const config = await getConfig(guildId);
  if (!config) {
    await interaction.reply({ embeds: [vacError('Система отпусков не настроена.')], ephemeral: true });
    return;
  }

  // Определить причину
  let reason: string;
  if (reasonValue === 'other') {
    reason = interaction.fields.getTextInputValue('reason_text').trim();
    if (!reason) {
      await interaction.reply({ embeds: [vacError('Укажите причину отпуска.')], ephemeral: true });
      return;
    }
    // Эскейпинг markdown для защиты от подделки сообщений (social engineering)
    reason = reason
      .replace(/\\/g, '\\\\')
      .replace(/\*/g, '\\*')
      .replace(/_/g, '\\_')
      .replace(/~/g, '\\~')
      .replace(/`/g, '\\`')
      .replace(/\|/g, '\\|')
      .replace(/>/g, '\\>')
      .replace(/\[/g, '\\[');
  } else {
    reason = getReasonLabel(reasonValue);
  }

  // Спарсить длительность
  const durationInput = interaction.fields.getTextInputValue('duration');
  const durationMinutes = parseDuration(durationInput);

  if (!durationMinutes) {
    await interaction.reply({
      embeds: [vacError('Неверный формат длительности.\nПримеры: `3d`, `2w`, `1m`, `12h`, `3д 5ч`')],
      ephemeral: true,
    });
    return;
  }

  if (durationMinutes < MIN_DURATION_MINUTES) {
    await interaction.reply({
      embeds: [vacError('Минимальная длительность отпуска — **1 час**.')],
      ephemeral: true,
    });
    return;
  }

  const maxMinutes = config.maxDurationDays * 24 * 60;
  if (durationMinutes > maxMinutes) {
    await interaction.reply({
      embeds: [vacError(`Максимальная длительность — **${config.maxDurationDays} дней**.`)],
      ephemeral: true,
    });
    return;
  }

  // Повторная проверка (от race conditions)
  const active = await getActiveVacation(guildId, userId);
  if (active) {
    await interaction.reply({ embeds: [vacWarn('Вы уже в отпуске.')], ephemeral: true });
    return;
  }

  const pendingExisting = await getPendingRequest(guildId, userId);
  if (pendingExisting) {
    await interaction.reply({ embeds: [vacWarn('У вас уже есть ожидающая заявка.')], ephemeral: true });
    return;
  }

  // Повторная проверка прайм-тайма
  if (isPrimeTime(config)) {
    await interaction.reply({ embeds: [vacError('Сейчас прайм-тайм. Отпуск недоступен.')], ephemeral: true });
    return;
  }

  // Повторная проверка антиабьюза (от race conditions)
  if (config.cooldownDays > 0) {
    const lastEnd = await getLastCompletedVacationEnd(guildId, userId);
    if (lastEnd) {
      const cooldownEnd = new Date(lastEnd.getTime() + config.cooldownDays * 24 * 60 * 60 * 1000);
      if (Date.now() < cooldownEnd.getTime()) {
        await interaction.reply({ embeds: [vacError('Кулдаун после отпуска ещё не истёк.')], ephemeral: true });
        return;
      }
    }
  }
  if (config.maxPerMonth > 0) {
    const recent = await countRecentVacations(guildId, userId, 30);
    if (recent >= config.maxPerMonth) {
      await interaction.reply({ embeds: [vacError('Лимит отпусков за 30 дней исчерпан.')], ephemeral: true });
      return;
    }
  }

  await interaction.deferReply({ ephemeral: true });

  // Создать заявку
  const request = await createRequest({
    guildId,
    userId,
    type: VacationType.Regular,
    reason,
    durationMinutes,
    configId: config.id,
  });

  // Получить статистику для ревьюеров
  const stats = await getUserVacationStats(guildId, userId);

  // Отправить в канал ревью
  if (config.reviewChannelId) {
    try {
      const reviewChannel = await client.channels.fetch(config.reviewChannelId) as TextChannel;
      const member = interaction.member as GuildMember;

      const pingText = config.pingRoleIds.length > 0
        ? config.pingRoleIds.map((id: string) => `<@&${id}>`).join(' ')
        : undefined;

      const msg = await reviewChannel.send({
        content: pingText,
        embeds: [buildRequestEmbed(request, member, stats)],
        components: [buildRequestButtons(request.id)],
      });

      // Сохранить ID сообщения для обновления позже
      await updateRequest(request.id, { reviewMessageId: msg.id });
    } catch (err) {
      log.error('Не удалось отправить заявку в канал ревью', { error: String(err) });
    }
  }

  await interaction.editReply({
    embeds: [vacSuccess(
      `Заявка на отпуск отправлена!\n\n` +
      `**Причина:** ${reason}\n` +
      `**Срок:** ${formatDuration(durationMinutes)}\n\n` +
      `Ожидайте решения командования (авто-отклонение через 3 часа).`,
    )],
  });

  log.info(`Заявка на отпуск: ${interaction.user.tag} — ${formatDuration(durationMinutes)} (${reason})`);
}

// ═══════════════════════════════════════════════
//  «Вернуться из отпуска»
// ═══════════════════════════════════════════════

async function handleReturnButton(
  interaction: ButtonInteraction,
  client: BublikClient,
): Promise<void> {
  if (!interaction.guildId) return;
  const guildId = interaction.guildId;
  const userId = interaction.user.id;

  // ВАЖНО: подтверждаем interaction сразу, чтобы token не протух до DB-операций
  await interaction.deferReply({ ephemeral: true });

  const active = await getActiveVacation(guildId, userId);
  if (!active) {
    await interaction.editReply({ embeds: [vacWarn('Вы не находитесь в отпуске.')] });
    return;
  }

  const member = interaction.member as GuildMember;
  const config = active.config;

  // Восстановить роли
  await restoreRoles(member, active.savedRoleIds, config.vacationRoleId);

  // Обновить статус + зафиксировать реальную дату окончания (для корректного кулдауна)
  const updated = await updateRequest(active.id, {
    status: VacationStatus.Completed,
    endDate: new Date(),
  });

  // Лог
  if (config.logChannelId) {
    try {
      const logChannel = await client.channels.fetch(config.logChannelId) as TextChannel;
      await logChannel.send({ embeds: [buildVacationEndLog(member, updated, true)] });
    } catch { /* skip */ }
  }

  await interaction.editReply({
    embeds: [vacSuccess('С возвращением! Ваши роли восстановлены.')],
  });

  log.info(`Досрочный возврат из отпуска: ${interaction.user.tag}`);
}

// ═══════════════════════════════════════════════
//  «Не смогу сегодня» — быстрый отпуск
// ═══════════════════════════════════════════════

async function handleQuickButton(
  interaction: ButtonInteraction,
  client: BublikClient,
): Promise<void> {
  if (!interaction.guildId) return;
  const guildId = interaction.guildId;
  const userId = interaction.user.id;

  const config = await getConfig(guildId);
  if (!config) {
    await interaction.reply({ embeds: [vacError('Система отпусков не настроена.')], ephemeral: true });
    return;
  }

  // Уже в отпуске / есть заявка
  const active = await getActiveVacation(guildId, userId);
  if (active) {
    await interaction.reply({ embeds: [vacWarn('Вы уже в отпуске.')], ephemeral: true });
    return;
  }
  const pending = await getPendingRequest(guildId, userId);
  if (pending) {
    await interaction.reply({ embeds: [vacWarn('У вас уже есть ожидающая заявка.')], ephemeral: true });
    return;
  }

  // Прайм-тайм
  if (isPrimeTime(config)) {
    await interaction.reply({
      embeds: [vacError(
        `Нельзя взять отпуск во время прайм-тайма.\nЗаблокировано: **${primeTimeText(config)}**`,
      )],
      ephemeral: true,
    });
    return;
  }

  // Антиабьюз: кулдаун после последнего отпуска
  if (config.cooldownDays > 0) {
    const lastEnd = await getLastCompletedVacationEnd(guildId, userId);
    if (lastEnd) {
      const cooldownEnd = new Date(lastEnd.getTime() + config.cooldownDays * 24 * 60 * 60 * 1000);
      if (Date.now() < cooldownEnd.getTime()) {
        const leftMs = cooldownEnd.getTime() - Date.now();
        const leftDays = Math.ceil(leftMs / (24 * 60 * 60 * 1000));
        await interaction.reply({
          embeds: [vacError(
            `Кулдаун после отпуска: осталось **${leftDays} дн.**\n` +
            `Минимальный перерыв между отпусками: **${config.cooldownDays} дн.**`,
          )],
          ephemeral: true,
        });
        return;
      }
    }
  }

  // Антиабьюз: лимит быстрых отпусков за неделю
  if (config.maxQuickPerWeek > 0) {
    const quickRecent = await countRecentQuickLeaves(guildId, userId, 7);
    if (quickRecent >= config.maxQuickPerWeek) {
      await interaction.reply({
        embeds: [vacError(
          `Вы достигли лимита быстрых отпусков: **${config.maxQuickPerWeek}** за 7 дней.\n` +
          `Использовано: **${quickRecent}/${config.maxQuickPerWeek}**`,
        )],
        ephemeral: true,
      });
      return;
    }
  }

  // Антиабьюз: лимит отпусков за 30 дней
  if (config.maxPerMonth > 0) {
    const recent = await countRecentVacations(guildId, userId, 30);
    if (recent >= config.maxPerMonth) {
      await interaction.reply({
        embeds: [vacError(
          `Лимит отпусков за 30 дней: **${config.maxPerMonth}**.\n` +
          `Использовано: **${recent}/${config.maxPerMonth}**`,
        )],
        ephemeral: true,
      });
      return;
    }
  }

  await interaction.deferReply({ ephemeral: true });

  // Повторная проверка (от race conditions — два быстрых клика одновременно)
  const activeRecheck = await getActiveVacation(guildId, userId);
  if (activeRecheck) {
    await interaction.editReply({ embeds: [vacWarn('Вы уже в отпуске.')] });
    return;
  }
  const pendingRecheck = await getPendingRequest(guildId, userId);
  if (pendingRecheck) {
    await interaction.editReply({ embeds: [vacWarn('У вас уже есть ожидающая заявка.')] });
    return;
  }

  const member = interaction.member as GuildMember;
  const durationMinutes = config.quickDurationH * 60;
  const now = new Date();
  const endDate = new Date(now.getTime() + durationMinutes * 60_000);

  // Снять роли
  const savedRoles = await applyVacationRoles(member, config);

  // Создать запись (сразу active)
  const request = await createRequest({
    guildId,
    userId,
    type: VacationType.Quick,
    reason: '👋 Не смогу сегодня',
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

  await interaction.editReply({
    embeds: [vacSuccess(
      `Быстрый отпуск оформлен на **${config.quickDurationH} часов**.\n` +
      `Вы вернётесь автоматически **${formatDateMsk(endDate)}**.\n\n` +
      `Нажмите **«Вернуться из отпуска»** для досрочного возвращения.`,
    )],
  });

  log.info(`Быстрый отпуск: ${interaction.user.tag} на ${config.quickDurationH}ч`);
}

// ═══════════════════════════════════════════════
//  Одобрить заявку
// ═══════════════════════════════════════════════

async function handleApproveButton(
  interaction: ButtonInteraction,
  requestId: string,
  client: BublikClient,
): Promise<void> {
  const request = await getRequest(requestId);
  if (!request) {
    await interaction.reply({ embeds: [vacError('Заявка не найдена.')], ephemeral: true });
    return;
  }

  if (request.status !== VacationStatus.Pending) {
    await interaction.reply({ embeds: [vacWarn('Эта заявка уже рассмотрена.')], ephemeral: true });
    return;
  }

  const reviewer = interaction.member as GuildMember;
  const config = request.config;

  // Проверка роли ревьюера
  const isReviewer = config.reviewerRoleIds.some((id: string) => reviewer.roles.cache.has(id));
  if (!isReviewer) {
    await interaction.reply({ embeds: [vacError('У вас нет прав на рассмотрение заявок.')], ephemeral: true });
    return;
  }

  // Нельзя одобрить свою заявку
  if (reviewer.id === request.userId) {
    await interaction.reply({ embeds: [vacError('Нельзя одобрить свою собственную заявку.')], ephemeral: true });
    return;
  }

  await interaction.deferReply({ ephemeral: true });

  const guild = interaction.guild!;
  const member = await guild.members.fetch(request.userId).catch(() => null);

  if (!member) {
    await updateRequest(requestId, { status: VacationStatus.Denied, reviewerId: reviewer.id });
    await interaction.editReply({ embeds: [vacError('Участник покинул сервер. Заявка отклонена.')] });
    return;
  }

  // Проверка: нет ли уже активного отпуска у этого пользователя (race condition с force/quick)
  const existingActive = await getActiveVacation(request.guildId, request.userId);
  if (existingActive) {
    await updateRequest(requestId, { status: VacationStatus.Denied, reviewerId: reviewer.id });

    // Обновить сообщение ревью
    if (request.reviewMessageId) {
      try {
        const reviewChannel = await client.channels.fetch(config.reviewChannelId!) as TextChannel;
        const msg = await reviewChannel.messages.fetch(request.reviewMessageId);
        await msg.edit({
          embeds: [buildDeniedRequestEmbed(request, member, reviewer, false)],
          components: [],
        });
      } catch { /* skip */ }
    }

    await interaction.editReply({
      embeds: [vacError(`У ${member.toString()} уже есть активный отпуск. Заявка автоматически отклонена.`)],
    });
    return;
  }

  const now = new Date();
  const endDate = new Date(now.getTime() + request.durationMinutes * 60_000);

  // Снять роли
  const savedRoles = await applyVacationRoles(member, config);

  // Обновить заявку
  const updated = await updateRequest(requestId, {
    status: VacationStatus.Active,
    reviewerId: reviewer.id,
    startDate: now,
    endDate,
    savedRoleIds: savedRoles,
  });

  // Обновить сообщение ревью
  if (request.reviewMessageId) {
    try {
      const reviewChannel = await client.channels.fetch(config.reviewChannelId!) as TextChannel;
      const msg = await reviewChannel.messages.fetch(request.reviewMessageId);
      await msg.edit({
        embeds: [buildApprovedRequestEmbed(updated, member, reviewer)],
        components: [],
      });
    } catch { /* skip */ }
  }

  // DM пользователю
  await member.send({ embeds: [buildDmApproved(updated)] }).catch(() => null);

  // Лог
  if (config.logChannelId) {
    try {
      const logChannel = await client.channels.fetch(config.logChannelId) as TextChannel;
      await logChannel.send({ embeds: [buildVacationStartLog(member, updated, savedRoles)] });
    } catch { /* skip */ }
  }

  await interaction.editReply({
    embeds: [vacSuccess(`Заявка ${member.user.tag} **одобрена**. Роли сняты, отпуск начат.`)],
  });

  log.info(`Заявка одобрена: ${member.user.tag} — ревьюер ${reviewer.user.tag}`);
}

// ═══════════════════════════════════════════════
//  Отклонить заявку
// ═══════════════════════════════════════════════

async function handleDenyButton(
  interaction: ButtonInteraction,
  requestId: string,
  client: BublikClient,
): Promise<void> {
  const request = await getRequest(requestId);
  if (!request) {
    await interaction.reply({ embeds: [vacError('Заявка не найдена.')], ephemeral: true });
    return;
  }

  if (request.status !== VacationStatus.Pending) {
    await interaction.reply({ embeds: [vacWarn('Эта заявка уже рассмотрена.')], ephemeral: true });
    return;
  }

  const reviewer = interaction.member as GuildMember;
  const config = request.config;

  // Самоотзыв разрешён (заявитель может отозвать свою заявку)
  const isSelfCancel = reviewer.id === request.userId;

  if (!isSelfCancel) {
    // Проверка роли ревьюера
    const isReviewer = config.reviewerRoleIds.some((id: string) => reviewer.roles.cache.has(id));
    if (!isReviewer) {
      await interaction.reply({ embeds: [vacError('У вас нет прав на рассмотрение заявок.')], ephemeral: true });
      return;
    }
  }

  await interaction.deferReply({ ephemeral: true });

  // Обновить заявку
  await updateRequest(requestId, {
    status: VacationStatus.Denied,
    reviewerId: reviewer.id,
  });

  const guild = interaction.guild!;
  const member = await guild.members.fetch(request.userId).catch(() => null);

  // Обновить сообщение ревью
  if (request.reviewMessageId) {
    try {
      const reviewChannel = await client.channels.fetch(config.reviewChannelId!) as TextChannel;
      const msg = await reviewChannel.messages.fetch(request.reviewMessageId);
      await msg.edit({
        embeds: [buildDeniedRequestEmbed(request, member, reviewer, isSelfCancel)],
        components: [],
      });
    } catch { /* skip */ }
  }

  // DM пользователю (не для самоотзыва)
  if (!isSelfCancel && member) {
    await member.send({ embeds: [buildDmDenied(request)] }).catch(() => null);
  }

  const statusText = isSelfCancel ? 'отозвана' : 'отклонена';
  await interaction.editReply({
    embeds: [vacSuccess(`Заявка **${statusText}**.`)],
  });

  log.info(`Заявка ${statusText}: ${request.userId} — ревьюер ${reviewer.user.tag}`);
}
