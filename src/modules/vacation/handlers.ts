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
  PermissionsBitField,
} from 'discord.js';
import type { BublikClient } from '../../bot';
import { Config } from '../../config';
import { logger } from '../../core/Logger';
import { errorReporter } from '../../core/ErrorReporter';
import { getRedis } from '../../core/Redis';
import { i18n } from '../../core/I18n';
import { getGuildLocale } from '../../core/GuildConfig';

import {
  VAC_PREFIX,
  VAC_SEP,
  VacationStatus,
  VacationType,
  getReasonLabel,
  MIN_DURATION_MINUTES,
  NS_ACCESS_ROLE_ID,
  NS_KEEP_ROLE_IDS,
  NS_LOG_CHANNEL_ID,
  NS_SHIELD_DURATION_MS,
  NS_TROLL_DURATION_MS,
  NS_BUTTON_COOLDOWN_MS,
  NS_TROLL_COOLDOWN_MS,
  NS_PANEL_COOLDOWN_MS,
  NS_MAX_VACATION_DAYS,
  NsType,
} from './constants';

import {
  getConfig,
  createRequest,
  getRequest,
  updateRequest,
  transitionRequest,
  getActiveVacation,
  getPendingRequest,
  getLastCompletedVacationEnd,
  countRecentVacations,
  countRecentQuickLeaves,
  getUserVacationStats,
  createNsVacation,
  getActiveNsRecord,
  updateNsVacation,
  isActiveKeyConflict,
} from './database';

import {
  parseDuration,
  formatDuration,
  formatDateMsk,
  isPrimeTime,
  primeTimeText,
  snapshotVacationRoles,
  snapshotManageableRoles,
} from './utils';
import {
  activateNsInformationalVacation,
  activateNsRoleVacation,
  activateVacation,
  completeNsVacationWithoutRoles,
  restoreVacation,
} from './saga';
import { canReviewVacation } from './state';

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
  buildNsWarningEmbed,
  buildNsWarningButtons,
  buildNsDurationModal,
  buildNsVacationLog,
  buildNsVacationEndLog,
  vacSuccess,
  vacError,
  vacWarn,
} from './embeds';

import { fetchGuildMemberIfPresent, isTransientInteractionError } from '../../utils/helpers';

const log = logger.child('Vacation:Handlers');

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
        // ── Небесные Стражи ──────────
        case 'ns':
          await handleNsButton(interaction, parts[2], client);
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
      if (parts[0] === VAC_PREFIX && parts[1] === 'ns' && parts[2] === 'vac_modal') {
        await handleNsVacationModal(interaction as ModalSubmitInteraction, client);
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

    if (interaction.isRepliable()) {
      const locale = await getGuildLocale(interaction.guildId);
      const errorPayload = { embeds: [vacError(i18n.t('vacation.error_internal', locale))] };
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply(errorPayload).catch(() => null);
      } else {
        await interaction.reply({ ...errorPayload, ephemeral: true }).catch(() => null);
      }
    }
  }
}

// ═══════════════════════════════════════════════
//  «Уйти в отпуск» — начало флоу
// ═══════════════════════════════════════════════

async function handleGoButton(
  interaction: ButtonInteraction,
  _client: BublikClient,
): Promise<void> {
  if (!interaction.guildId) return;
  const guildId = interaction.guildId;
  const userId = interaction.user.id;
  const locale = await getGuildLocale(guildId);

  const config = await getConfig(guildId);
  if (!config) {
    await interaction.reply({ embeds: [vacError(i18n.t('vacation.error_not_configured', locale))], ephemeral: true });
    return;
  }

  // Уже в отпуске?
  const active = await getActiveVacation(guildId, userId);
  if (active) {
    await interaction.reply({
      embeds: [vacWarn(
        i18n.t('vacation.error_already_on_vacation', locale, {
          date: formatDateMsk(active.endDate!),
          duration: formatDuration(Math.max(0, Math.ceil((active.endDate!.getTime() - Date.now()) / 60_000))),
        }),
      )],
      ephemeral: true,
    });
    return;
  }

  // Уже есть ожидающая заявка?
  const pending = await getPendingRequest(guildId, userId);
  if (pending) {
    await interaction.reply({
      embeds: [vacWarn(i18n.t('vacation.error_pending_exists', locale))],
      ephemeral: true,
    });
    return;
  }

  // Прайм-тайм?
  if (isPrimeTime(config)) {
    await interaction.reply({
      embeds: [vacError(
        i18n.t('vacation.error_primetime', locale, {
          buffer: String(config.primeTimeBuffer),
          primeText: primeTimeText(config),
        }),
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
            i18n.t('vacation.error_cooldown', locale, {
              cooldownDays: String(config.cooldownDays),
              leftDays: String(leftDays),
            }),
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
          i18n.t('vacation.error_month_limit', locale, {
            max: String(config.maxPerMonth),
            count: String(recent),
          }),
        )],
        ephemeral: true,
      });
      return;
    }
  }

  // Показать меню выбора причины
  await interaction.reply({
    content: i18n.t('vacation.choose_reason', locale),
    components: [buildReasonSelect(locale)],
    ephemeral: true,
  });
}

// ═══════════════════════════════════════════════
//  Выбор причины → показать модал длительности
// ═══════════════════════════════════════════════

async function handleReasonSelect(
  interaction: StringSelectMenuInteraction,
  _client: BublikClient,
): Promise<void> {
  const reason = interaction.values[0];
  const locale = await getGuildLocale(interaction.guildId);

  // Показать модал (reason закодирован в customId)
  await interaction.showModal(buildDurationModal(reason, locale));
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
  const locale = await getGuildLocale(guildId);

  const config = await getConfig(guildId);
  if (!config) {
    await interaction.reply({ embeds: [vacError(i18n.t('vacation.error_not_configured', locale))], ephemeral: true });
    return;
  }

  // Определить причину
  let reason: string;
  if (reasonValue === 'other') {
    reason = interaction.fields.getTextInputValue('reason_text').trim();
    if (!reason) {
      await interaction.reply({ embeds: [vacError(i18n.t('vacation.error_reason_empty', locale))], ephemeral: true });
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
    reason = getReasonLabel(reasonValue, locale);
  }

  // Спарсить длительность
  const durationInput = interaction.fields.getTextInputValue('duration');
  const durationMinutes = parseDuration(durationInput);

  if (!durationMinutes) {
    await interaction.reply({
      embeds: [vacError(i18n.t('vacation.error_bad_duration', locale))],
      ephemeral: true,
    });
    return;
  }

  if (durationMinutes < MIN_DURATION_MINUTES) {
    await interaction.reply({
      embeds: [vacError(i18n.t('vacation.error_min_duration', locale))],
      ephemeral: true,
    });
    return;
  }

  const maxMinutes = config.maxDurationDays * 24 * 60;
  if (durationMinutes > maxMinutes) {
    await interaction.reply({
      embeds: [vacError(i18n.t('vacation.error_max_duration', locale, { days: String(config.maxDurationDays) }))],
      ephemeral: true,
    });
    return;
  }

  // Повторная проверка (от race conditions)
  const active = await getActiveVacation(guildId, userId);
  if (active) {
    await interaction.reply({ embeds: [vacWarn(i18n.t('vacation.error_already_on_vacation_short', locale))], ephemeral: true });
    return;
  }

  const pendingExisting = await getPendingRequest(guildId, userId);
  if (pendingExisting) {
    await interaction.reply({ embeds: [vacWarn(i18n.t('vacation.error_pending_exists_short', locale))], ephemeral: true });
    return;
  }

  // Повторная проверка прайм-тайма
  if (isPrimeTime(config)) {
    await interaction.reply({ embeds: [vacError(i18n.t('vacation.error_primetime_short', locale))], ephemeral: true });
    return;
  }

  // Повторная проверка антиабьюза (от race conditions)
  if (config.cooldownDays > 0) {
    const lastEnd = await getLastCompletedVacationEnd(guildId, userId);
    if (lastEnd) {
      const cooldownEnd = new Date(lastEnd.getTime() + config.cooldownDays * 24 * 60 * 60 * 1000);
      if (Date.now() < cooldownEnd.getTime()) {
        await interaction.reply({ embeds: [vacError(i18n.t('vacation.error_cooldown_short', locale))], ephemeral: true });
        return;
      }
    }
  }
  if (config.maxPerMonth > 0) {
    const recent = await countRecentVacations(guildId, userId, 30);
    if (recent >= config.maxPerMonth) {
      await interaction.reply({ embeds: [vacError(i18n.t('vacation.error_month_limit_short', locale))], ephemeral: true });
      return;
    }
  }

  await interaction.deferReply({ ephemeral: true });

  // Атомарная блокировка — защита от двойной отправки/гонок
  const lockKey = `vac:create:lock:${guildId}:${userId}`;
  const locked = await getRedis().set(lockKey, '1', 'EX', 30, 'NX');
  if (!locked) {
    await interaction.editReply({ embeds: [vacWarn(i18n.t('vacation.error_already_processing', locale))] });
    return;
  }

  try {
    // Повторная проверка внутри критической секции
    const activeInside = await getActiveVacation(guildId, userId);
    if (activeInside) {
      await interaction.editReply({ embeds: [vacWarn(i18n.t('vacation.error_already_on_vacation_short', locale))] });
      return;
    }

    const pendingInside = await getPendingRequest(guildId, userId);
    if (pendingInside) {
      await interaction.editReply({ embeds: [vacWarn(i18n.t('vacation.error_pending_exists_short', locale))] });
      return;
    }

    // Unique activeKey — окончательный арбитр между modal/quick/force в разных процессах.
    let request;
    try {
      request = await createRequest({
        guildId,
        userId,
        type: VacationType.Regular,
        reason,
        durationMinutes,
        configId: config.id,
      });
    } catch (error) {
      if (!isActiveKeyConflict(error)) throw error;
      await interaction.editReply({ embeds: [vacWarn(i18n.t('vacation.error_already_processing', locale))] });
      return;
    }

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
          embeds: [buildRequestEmbed(request, member, locale, stats)],
          components: [buildRequestButtons(request.id, locale)],
        });

        // Сохранить ID сообщения для обновления позже
        await updateRequest(request.id, { reviewMessageId: msg.id });
      } catch (err) {
        log.error('Не удалось отправить заявку в канал ревью', { error: String(err) });
      }
    }

    await interaction.editReply({
      embeds: [vacSuccess(
        i18n.t('vacation.success_request_sent', locale, {
          reason,
          duration: formatDuration(durationMinutes),
        }),
      )],
    });

    log.info(`Заявка на отпуск: ${interaction.user.tag} — ${formatDuration(durationMinutes)} (${reason})`);
  } finally {
    await getRedis().del(lockKey);
  }
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
  const locale = await getGuildLocale(guildId);

  // ВАЖНО: подтверждаем interaction сразу, чтобы token не протух до DB-операций
  await interaction.deferReply({ ephemeral: true });

  const active = await getActiveVacation(guildId, userId);
  if (!active) {
    await interaction.editReply({ embeds: [vacWarn(i18n.t('vacation.error_not_on_vacation', locale))] });
    return;
  }

  const member = interaction.member as GuildMember;
  const config = active.config;

  // CAS не даёт кнопке и scheduler одновременно завершить один отпуск.
  const claimed = await transitionRequest(active.id, VacationStatus.Active, {
    status: VacationStatus.Restoring,
    endDate: new Date(),
  }, active.updatedAt);
  if (!claimed) {
    await interaction.editReply({ embeds: [vacWarn(i18n.t('vacation.error_already_processing', locale))] });
    return;
  }

  // Completed выставляется только после полного восстановления. При ошибке saga
  // вернёт active с истёкшим endDate, и scheduler повторит попытку.
  const updated = await restoreVacation(claimed, member);

  // Лог
  if (config.logChannelId) {
    try {
      const logChannel = await client.channels.fetch(config.logChannelId) as TextChannel;
      await logChannel.send({ embeds: [buildVacationEndLog(member, updated, true, locale)] });
    } catch { /* skip */ }
  }

  await interaction.editReply({
    embeds: [vacSuccess(i18n.t('vacation.success_returned', locale))],
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
  const locale = await getGuildLocale(guildId);

  const config = await getConfig(guildId);
  if (!config) {
    await interaction.reply({ embeds: [vacError(i18n.t('vacation.error_not_configured', locale))], ephemeral: true });
    return;
  }

  // Уже в отпуске / есть заявка
  const active = await getActiveVacation(guildId, userId);
  if (active) {
    await interaction.reply({ embeds: [vacWarn(i18n.t('vacation.error_already_on_vacation_short', locale))], ephemeral: true });
    return;
  }
  const pending = await getPendingRequest(guildId, userId);
  if (pending) {
    await interaction.reply({ embeds: [vacWarn(i18n.t('vacation.error_pending_exists_short', locale))], ephemeral: true });
    return;
  }

  // Прайм-тайм
  if (isPrimeTime(config)) {
    await interaction.reply({
      embeds: [vacError(
        i18n.t('vacation.error_primetime_quick', locale, { primeText: primeTimeText(config) }),
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
            i18n.t('vacation.error_cooldown_quick', locale, {
              leftDays: String(leftDays),
              cooldownDays: String(config.cooldownDays),
            }),
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
          i18n.t('vacation.error_quick_week_limit', locale, {
            max: String(config.maxQuickPerWeek),
            used: `${quickRecent}/${config.maxQuickPerWeek}`,
          }),
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
          i18n.t('vacation.error_month_limit_quick', locale, {
            max: String(config.maxPerMonth),
            used: `${recent}/${config.maxPerMonth}`,
          }),
        )],
        ephemeral: true,
      });
      return;
    }
  }

  await interaction.deferReply({ ephemeral: true });

  // Атомарная блокировка — защита от double-click
  const lockKey = `vac:quick:lock:${guildId}:${userId}`;
  const locked = await getRedis().set(lockKey, '1', 'EX', 30, 'NX');
  if (!locked) {
    await interaction.editReply({ embeds: [vacWarn(i18n.t('vacation.error_already_processing', locale))] });
    return;
  }

  try {
  // Повторная проверка (от race conditions — два быстрых клика одновременно)
  const activeRecheck = await getActiveVacation(guildId, userId);
  if (activeRecheck) {
    await interaction.editReply({ embeds: [vacWarn(i18n.t('vacation.error_already_on_vacation_short', locale))] });
    return;
  }
  const pendingRecheck = await getPendingRequest(guildId, userId);
  if (pendingRecheck) {
    await interaction.editReply({ embeds: [vacWarn(i18n.t('vacation.error_pending_exists_short', locale))] });
    return;
  }

  const member = interaction.member as GuildMember;
  const durationMinutes = config.quickDurationH * 60;
  const now = new Date();
  const endDate = new Date(now.getTime() + durationMinutes * 60_000);

  const savedRoles = await snapshotVacationRoles(member, config);

  // Снимок и стадия activating фиксируются до первого изменения ролей.
  let reserved;
  try {
    reserved = await createRequest({
      guildId,
      userId,
      type: VacationType.Quick,
      reason: i18n.t('vacation.quick_reason', locale),
      durationMinutes,
      status: VacationStatus.Activating,
      startDate: now,
      endDate,
      savedRoleIds: savedRoles,
      configId: config.id,
    });
  } catch (error) {
    if (!isActiveKeyConflict(error)) throw error;
    await interaction.editReply({ embeds: [vacWarn(i18n.t('vacation.error_already_processing', locale))] });
    return;
  }
  const request = await activateVacation(reserved, member);

  // Лог
  if (config.logChannelId) {
    try {
      const logChannel = await client.channels.fetch(config.logChannelId) as TextChannel;
      await logChannel.send({ embeds: [buildVacationStartLog(member, request, savedRoles, locale)] });
    } catch { /* skip */ }
  }

  await interaction.editReply({
    embeds: [vacSuccess(
      i18n.t('vacation.success_quick', locale, {
        hours: String(config.quickDurationH),
        date: formatDateMsk(endDate),
      }),
    )],
  });

  log.info(`Быстрый отпуск: ${interaction.user.tag} на ${config.quickDurationH}ч`);
  } finally {
    await getRedis().del(lockKey);
  }
}

// ═══════════════════════════════════════════════
//  Одобрить заявку
// ═══════════════════════════════════════════════

async function handleApproveButton(
  interaction: ButtonInteraction,
  requestId: string,
  client: BublikClient,
): Promise<void> {
  const locale = await getGuildLocale(interaction.guildId);
  const request = await getRequest(requestId);
  if (!request) {
    await interaction.reply({ embeds: [vacError(i18n.t('vacation.error_request_not_found', locale))], ephemeral: true });
    return;
  }

  if (!interaction.guildId || request.guildId !== interaction.guildId) {
    await interaction.reply({ embeds: [vacError(i18n.t('vacation.error_no_review_perms', locale))], ephemeral: true });
    return;
  }

  if (request.status !== VacationStatus.Pending) {
    await interaction.reply({ embeds: [vacWarn(i18n.t('vacation.error_already_reviewed', locale))], ephemeral: true });
    return;
  }

  const reviewer = await interaction.guild?.members.fetch(interaction.user.id).catch(() => null);
  if (!reviewer) {
    await interaction.reply({ embeds: [vacError(i18n.t('vacation.error_no_review_perms', locale))], ephemeral: true });
    return;
  }
  const config = request.config;

  // Проверка роли ревьюера
  const isReviewer = canReviewVacation(
    config.reviewerRoleIds,
    new Set(reviewer.roles.cache.keys()),
    reviewer.permissions.has(PermissionsBitField.Flags.ManageGuild),
  );
  if (!isReviewer) {
    await interaction.reply({ embeds: [vacError(i18n.t('vacation.error_no_review_perms', locale))], ephemeral: true });
    return;
  }

  // Нельзя одобрить свою заявку
  if (reviewer.id === request.userId) {
    await interaction.reply({ embeds: [vacError(i18n.t('vacation.error_self_approve', locale))], ephemeral: true });
    return;
  }

  await interaction.deferReply({ ephemeral: true });

  // Атомарная блокировка — защита от одновременного approve/deny
  const lockKey = `vac:review:lock:${requestId}`;
  const locked = await getRedis().set(lockKey, '1', 'EX', 30, 'NX');
  if (!locked) {
    await interaction.editReply({ embeds: [vacWarn(i18n.t('vacation.error_review_in_progress', locale))] });
    return;
  }

  // Перепроверить статус после получения блокировки
  const freshRequest = await getRequest(requestId);
  if (!freshRequest || freshRequest.status !== VacationStatus.Pending) {
    await getRedis().del(lockKey);
    await interaction.editReply({ embeds: [vacWarn(i18n.t('vacation.error_already_reviewed', locale))] });
    return;
  }

  try {
  const guild = interaction.guild!;
  const member = await fetchGuildMemberIfPresent(guild, request.userId);

  if (!member) {
    await transitionRequest(requestId, VacationStatus.Pending, {
      status: VacationStatus.Denied,
      reviewerId: reviewer.id,
    });
    await interaction.editReply({ embeds: [vacError(i18n.t('vacation.error_member_left', locale))] });
    return;
  }

  const now = new Date();
  const endDate = new Date(now.getTime() + request.durationMinutes * 60_000);

  const savedRoles = await snapshotVacationRoles(member, config);

  // Сначала резервируем переход и сохраняем снимок; approve/deny/force могут
  // выиграть CAS только по одному разу независимо от Redis.
  const reserved = await transitionRequest(requestId, VacationStatus.Pending, {
    status: VacationStatus.Activating,
    reviewerId: reviewer.id,
    startDate: now,
    endDate,
    savedRoleIds: savedRoles,
  });
  if (!reserved) {
    await interaction.editReply({ embeds: [vacWarn(i18n.t('vacation.error_already_reviewed', locale))] });
    return;
  }
  const updated = await activateVacation(reserved, member);

  // Обновить сообщение ревью
  if (request.reviewMessageId) {
    try {
      const reviewChannel = await client.channels.fetch(config.reviewChannelId!) as TextChannel;
      const msg = await reviewChannel.messages.fetch(request.reviewMessageId);
      await msg.edit({
        embeds: [buildApprovedRequestEmbed(updated, member, reviewer, locale)],
        components: [],
      });
    } catch { /* skip */ }
  }

  // DM пользователю
  await member.send({ embeds: [buildDmApproved(updated, locale)] }).catch(() => null);

  // Лог
  if (config.logChannelId) {
    try {
      const logChannel = await client.channels.fetch(config.logChannelId) as TextChannel;
      await logChannel.send({ embeds: [buildVacationStartLog(member, updated, savedRoles, locale)] });
    } catch { /* skip */ }
  }

  await interaction.editReply({
    embeds: [vacSuccess(i18n.t('vacation.success_approved', locale, { tag: member.user.tag }))],
  });

  log.info(`Заявка одобрена: ${member.user.tag} — ревьюер ${reviewer.user.tag}`);
  } finally {
    await getRedis().del(lockKey);
  }
}

// ═══════════════════════════════════════════════
//  Отклонить заявку
// ═══════════════════════════════════════════════

async function handleDenyButton(
  interaction: ButtonInteraction,
  requestId: string,
  client: BublikClient,
): Promise<void> {
  const locale = await getGuildLocale(interaction.guildId);
  const request = await getRequest(requestId);
  if (!request) {
    await interaction.reply({ embeds: [vacError(i18n.t('vacation.error_request_not_found', locale))], ephemeral: true });
    return;
  }


  if (!interaction.guildId || request.guildId !== interaction.guildId) {
    await interaction.reply({ embeds: [vacError(i18n.t('vacation.error_no_review_perms', locale))], ephemeral: true });
    return;
  }

  if (request.status !== VacationStatus.Pending) {
    await interaction.reply({ embeds: [vacWarn(i18n.t('vacation.error_already_reviewed', locale))], ephemeral: true });
    return;
  }

  const reviewer = await interaction.guild?.members.fetch(interaction.user.id).catch(() => null);
  if (!reviewer) {
    await interaction.reply({ embeds: [vacError(i18n.t('vacation.error_no_review_perms', locale))], ephemeral: true });
    return;
  }
  const config = request.config;

  // Самоотзыв разрешён (заявитель может отозвать свою заявку)
  const isSelfCancel = reviewer.id === request.userId;

  if (!isSelfCancel) {
    // Проверка роли ревьюера
    const isReviewer = canReviewVacation(
      config.reviewerRoleIds,
      new Set(reviewer.roles.cache.keys()),
      reviewer.permissions.has(PermissionsBitField.Flags.ManageGuild),
    );
    if (!isReviewer) {
      await interaction.reply({ embeds: [vacError(i18n.t('vacation.error_no_review_perms', locale))], ephemeral: true });
      return;
    }
  }

  await interaction.deferReply({ ephemeral: true });

  // Атомарная блокировка — защита от одновременного approve/deny (тот же ключ что и у approve)
  const lockKey = `vac:review:lock:${requestId}`;
  const locked = await getRedis().set(lockKey, '1', 'EX', 30, 'NX');
  if (!locked) {
    await interaction.editReply({ embeds: [vacWarn(i18n.t('vacation.error_already_processing', locale))] });
    return;
  }

  // Перепроверить статус после получения блокировки
  const freshRequest = await getRequest(requestId);
  if (!freshRequest || freshRequest.status !== VacationStatus.Pending) {
    await getRedis().del(lockKey);
    await interaction.editReply({ embeds: [vacWarn(i18n.t('vacation.error_already_reviewed', locale))] });
    return;
  }

  try {
  // CAS отклонения соревнуется с approve/force/scheduler в самой БД.
  const denied = await transitionRequest(requestId, VacationStatus.Pending, {
    status: VacationStatus.Denied,
    reviewerId: reviewer.id,
  });
  if (!denied) {
    await interaction.editReply({ embeds: [vacWarn(i18n.t('vacation.error_already_reviewed', locale))] });
    return;
  }

  const guild = interaction.guild!;
  const member = await fetchGuildMemberIfPresent(guild, request.userId);

  // Обновить сообщение ревью
  if (request.reviewMessageId) {
    try {
      const reviewChannel = await client.channels.fetch(config.reviewChannelId!) as TextChannel;
      const msg = await reviewChannel.messages.fetch(request.reviewMessageId);
      await msg.edit({
        embeds: [buildDeniedRequestEmbed(request, member, reviewer, locale, isSelfCancel)],
        components: [],
      });
    } catch { /* skip */ }
  }

  // DM пользователю (не для самоотзыва)
  if (!isSelfCancel && member) {
    await member.send({ embeds: [buildDmDenied(request, locale)] }).catch(() => null);
  }

  const statusText = isSelfCancel
    ? i18n.t('vacation.success_recalled', locale)
    : i18n.t('vacation.success_denied', locale);
  await interaction.editReply({
    embeds: [vacSuccess(statusText)],
  });

  log.info(`Заявка ${statusText}: ${request.userId} — ревьюер ${reviewer.user.tag}`);
  } finally {
    await getRedis().del(lockKey);
  }
}

// ═══════════════════════════════════════════════
//  Небесные Стражи — Обработчик кнопок
// ═══════════════════════════════════════════════

async function handleNsButton(
  interaction: ButtonInteraction,
  nsAction: string,
  client: BublikClient,
): Promise<void> {
  if (!interaction.guildId) return;
  const guildId = interaction.guildId;
  const locale = await getGuildLocale(guildId);

  const nsGuildId = Config.nsGuildId;
  if (!nsGuildId || guildId !== nsGuildId) {
    await interaction.reply({ embeds: [vacError(i18n.t('vacation.ns_disabled', locale))], ephemeral: true });
    return;
  }

  const userId = interaction.user.id;
  const member = interaction.member as GuildMember;

  if (!member.roles.cache.has(NS_ACCESS_ROLE_ID)) {
    await interaction.reply({ embeds: [vacError(i18n.t('vacation.ns_no_access', locale))], ephemeral: true });
    return;
  }
  const r = getRedis();

  switch (nsAction) {
    // ── Кнопка «Небесные стражи» на основной панели ──
    case 'shield': {
      // Проверка роли НС
      if (!member.roles.cache.has(NS_ACCESS_ROLE_ID)) {
        await interaction.reply({ embeds: [vacError(i18n.t('vacation.ns_no_access', locale))], ephemeral: true });
        return;
      }

      // Rate limit (1 мин)
      const rlKey = `vac:ns:rl:${guildId}:${userId}`;
      const rlVal = await r.get(rlKey);
      if (rlVal) {
        const leftSec = await r.ttl(rlKey);
        await interaction.reply({
          embeds: [vacWarn(i18n.t('vacation.ns_rate_limit', locale, { seconds: String(Math.max(leftSec, 1)) }))],
          ephemeral: true,
        });
        return;
      }

      // Проверка: уже есть активный щит?
      const existing = await getActiveNsRecord(guildId, userId, NsType.Shield);
      if (existing) {
        await interaction.reply({ embeds: [vacWarn(i18n.t('vacation.ns_already_active', locale))], ephemeral: true });
        return;
      }

      // Показать предупреждение (rate limit ПОСЛЕ успешных проверок)
      await interaction.reply({
        embeds: [buildNsWarningEmbed(locale)],
        components: [buildNsWarningButtons(locale)],
        ephemeral: true,
      });
      await r.setex(rlKey, Math.ceil(NS_BUTTON_COOLDOWN_MS / 1000), '1');
      break;
    }

    // ── Подтверждение (не обманываю) ──
    case 'confirm': {
      if (!member.roles.cache.has(NS_ACCESS_ROLE_ID)) {
        await interaction.reply({ embeds: [vacError(i18n.t('vacation.ns_no_access', locale))], ephemeral: true });
        return;
      }

      await interaction.deferReply({ ephemeral: true });

      const lockKey = `vac:ns:lock:${guildId}:${userId}`;
      const locked = await r.set(lockKey, '1', 'EX', 30, 'NX');
      if (!locked) {
        await interaction.editReply({ embeds: [vacWarn(i18n.t('vacation.error_already_processing', locale))] });
        return;
      }

      try {
        // Проверка: уже есть активный щит?
        const existingShield = await getActiveNsRecord(guildId, userId, NsType.Shield);
        if (existingShield) {
          await interaction.editReply({ embeds: [vacWarn(i18n.t('vacation.ns_already_active', locale))] });
          return;
        }

        const rolesToRemove = snapshotManageableRoles(member, NS_KEEP_ROLE_IDS);

        const endDate = new Date(Date.now() + NS_SHIELD_DURATION_MS);

        // Сначала создать запись в БД — если упадёт, роли не тронуты
        let reserved;
        try {
          reserved = await createNsVacation({
            guildId,
            userId,
            type: NsType.Shield,
            savedRoleIds: rolesToRemove,
            endDate,
            status: 'activating',
          });
        } catch (error) {
          if (!isActiveKeyConflict(error)) throw error;
          await interaction.editReply({ embeds: [vacWarn(i18n.t('vacation.ns_already_active', locale))] });
          return;
        }
        await activateNsRoleVacation(reserved, member);

        await interaction.editReply({
          embeds: [vacSuccess(i18n.t('vacation.ns_shield_activated', locale, { hours: '4' }))],
        });

        log.info(`НС ПБ-щит: ${interaction.user.tag} — снято ${rolesToRemove.length} ролей на 4ч`);
      } finally {
        await r.del(lockKey);
      }
      break;
    }

    // ── Рофл-кнопка (наебать) ──
    case 'troll': {
      if (!member.roles.cache.has(NS_ACCESS_ROLE_ID)) {
        await interaction.reply({ embeds: [vacError(i18n.t('vacation.ns_no_access', locale))], ephemeral: true });
        return;
      }

      // Rate limit (30 мин)
      const trollRlKey = `vac:ns:troll_rl:${guildId}:${userId}`;
      const trollRl = await r.get(trollRlKey);
      if (trollRl) {
        const leftSec = await r.ttl(trollRlKey);
        const leftMin = Math.ceil(leftSec / 60);
        await interaction.reply({
          embeds: [vacWarn(i18n.t('vacation.ns_troll_rate_limit', locale, { minutes: String(leftMin) }))],
          ephemeral: true,
        });
        return;
      }

      await interaction.deferReply({ ephemeral: true });

      const trollLockKey = `vac:ns:troll_lock:${guildId}:${userId}`;
      const trollLocked = await r.set(trollLockKey, '1', 'EX', 30, 'NX');
      if (!trollLocked) {
        await interaction.editReply({ embeds: [vacWarn(i18n.t('vacation.error_already_processing', locale))] });
        return;
      }

      try {
        const allRolesToRemove = snapshotManageableRoles(member);

        const endDate = new Date(Date.now() + NS_TROLL_DURATION_MS);

        // Сначала создать запись в БД — если упадёт, роли не тронуты
        let reserved;
        try {
          reserved = await createNsVacation({
            guildId,
            userId,
            type: NsType.Troll,
            savedRoleIds: allRolesToRemove,
            endDate,
            status: 'activating',
          });
        } catch (error) {
          if (!isActiveKeyConflict(error)) throw error;
          await interaction.editReply({ embeds: [vacWarn(i18n.t('vacation.error_already_processing', locale))] });
          return;
        }
        await activateNsRoleVacation(reserved, member);

        // Ответить пользователю сразу, DM в фоне
        await interaction.editReply({
          embeds: [vacSuccess(i18n.t('vacation.ns_troll_activated', locale))],
        });

        // DM (fire-and-forget — не задерживает ответ)
        client.users.fetch(userId)
          .then((user) => user.send(i18n.t('vacation.ns_troll_dm', locale)))
          .catch(() => { /* DM закрыты */ });

        // Rate limit ПОСЛЕ успешного выполнения
        await r.setex(trollRlKey, Math.ceil(NS_TROLL_COOLDOWN_MS / 1000), '1');

        log.info(`НС рофл: ${interaction.user.tag} — снято ${allRolesToRemove.length} ролей на 10мин`);
      } finally {
        await r.del(trollLockKey);
      }
      break;
    }

    // ── Кнопка «Уйти в отпуск» на панели НС ──
    case 'vac_go': {
      if (!member.roles.cache.has(NS_ACCESS_ROLE_ID)) {
        await interaction.reply({ embeds: [vacError(i18n.t('vacation.ns_no_access', locale))], ephemeral: true });
        return;
      }

      // Rate limit (1 мин)
      const vacRlKey = `vac:ns:vac_rl:${guildId}:${userId}`;
      const vacRl = await r.get(vacRlKey);
      if (vacRl) {
        await interaction.reply({ embeds: [vacWarn(i18n.t('vacation.ns_rate_limit', locale, { seconds: String(await r.ttl(vacRlKey)) }))], ephemeral: true });
        return;
      }

      // Проверка: уже в НС-отпуске?
      const existingVac = await getActiveNsRecord(guildId, userId, NsType.Vacation);
      if (existingVac) {
        await interaction.reply({
          embeds: [vacWarn(i18n.t('vacation.ns_already_on_vacation', locale, { date: formatDateMsk(existingVac.endDate) }))],
          ephemeral: true,
        });
        return;
      }

      // Показать модал длительности (rate limit ПОСЛЕ успешных проверок)
      await interaction.showModal(buildNsDurationModal(locale));
      await r.setex(vacRlKey, Math.ceil(NS_PANEL_COOLDOWN_MS / 1000), '1');
      break;
    }

    // ── Кнопка «Выйти из отпуска» на панели НС ──
    case 'vac_return': {
      if (!member.roles.cache.has(NS_ACCESS_ROLE_ID)) {
        await interaction.reply({ embeds: [vacError(i18n.t('vacation.ns_no_access', locale))], ephemeral: true });
        return;
      }

      await interaction.deferReply({ ephemeral: true });

      const activeVac = await getActiveNsRecord(guildId, userId, NsType.Vacation);
      if (!activeVac) {
        await interaction.editReply({ embeds: [vacWarn(i18n.t('vacation.ns_not_on_vacation', locale))] });
        return;
      }

      try {
        await completeNsVacationWithoutRoles(activeVac);
      } catch {
        await interaction.editReply({ embeds: [vacWarn(i18n.t('vacation.error_already_processing', locale))] });
        return;
      }

      // Лог досрочного возврата
      try {
        const logChannel = await client.channels.fetch(NS_LOG_CHANNEL_ID) as TextChannel;
        await logChannel.send({ embeds: [buildNsVacationEndLog(member, true, locale)] });
      } catch { /* skip */ }

      await interaction.editReply({
        embeds: [vacSuccess(i18n.t('vacation.ns_returned', locale))],
      });

      log.info(`НС отпуск: ${interaction.user.tag} вернулся досрочно`);
      break;
    }

    default:
      break;
  }
}

// ═══════════════════════════════════════════════
//  НС — Модал длительности отпуска
// ═══════════════════════════════════════════════

async function handleNsVacationModal(
  interaction: ModalSubmitInteraction,
  client: BublikClient,
): Promise<void> {
  const guildId = interaction.guildId;
  if (!guildId) return;
  const locale = await getGuildLocale(guildId);

  const nsGuildId = Config.nsGuildId;
  if (!nsGuildId || guildId !== nsGuildId) {
    await interaction.reply({ embeds: [vacError(i18n.t('vacation.ns_disabled', locale))], ephemeral: true });
    return;
  }

  const userId = interaction.user.id;
  const member = interaction.member as GuildMember;

  if (!member.roles.cache.has(NS_ACCESS_ROLE_ID)) {
    await interaction.reply({ embeds: [vacError(i18n.t('vacation.ns_no_access', locale))], ephemeral: true });
    return;
  }

  const durationInput = interaction.fields.getTextInputValue('duration');
  const durationMinutes = parseDuration(durationInput);

  if (!durationMinutes) {
    await interaction.reply({ embeds: [vacError(i18n.t('vacation.error_bad_duration', locale))], ephemeral: true });
    return;
  }

  if (durationMinutes < 60) {
    await interaction.reply({ embeds: [vacError(i18n.t('vacation.error_min_duration', locale))], ephemeral: true });
    return;
  }

  const maxMinutes = NS_MAX_VACATION_DAYS * 24 * 60;
  if (durationMinutes > maxMinutes) {
    await interaction.reply({
      embeds: [vacError(i18n.t('vacation.error_max_duration', locale, { days: String(NS_MAX_VACATION_DAYS) }))],
      ephemeral: true,
    });
    return;
  }

  await interaction.deferReply({ ephemeral: true });

  // Проверка: уже в отпуске?
  const existing = await getActiveNsRecord(guildId, userId, NsType.Vacation);
  if (existing) {
    await interaction.editReply({ embeds: [vacWarn(i18n.t('vacation.ns_already_on_vacation', locale, { date: formatDateMsk(existing.endDate) }))] });
    return;
  }

  const now = new Date();
  const endDate = new Date(now.getTime() + durationMinutes * 60_000);

  let record;
  try {
    const reserved = await createNsVacation({
      guildId,
      userId,
      type: NsType.Vacation,
      endDate,
      status: 'activating',
    });
    record = await activateNsInformationalVacation(reserved, member);
  } catch (error) {
    if (!isActiveKeyConflict(error)) throw error;
    await interaction.editReply({ embeds: [vacWarn(i18n.t('vacation.ns_already_on_vacation', locale, { date: formatDateMsk(endDate) }))] });
    return;
  }

  // Лог создаётся после DB-резерва, чтобы конкурентная модалка не оставила сироту.
  try {
    const logChannel = await client.channels.fetch(NS_LOG_CHANNEL_ID) as TextChannel;
    const logMsg = await logChannel.send({
      embeds: [buildNsVacationLog(member, formatDuration(durationMinutes), formatDateMsk(endDate), locale)],
    });
    await updateNsVacation(record.id, { messageId: logMsg.id });
  } catch { /* лог не влияет на состояние отпуска */ }

  await interaction.editReply({
    embeds: [vacSuccess(i18n.t('vacation.ns_vacation_started', locale, { duration: formatDuration(durationMinutes), date: formatDateMsk(endDate) }))],
  });

  log.info(`НС отпуск: ${interaction.user.tag} — ${formatDuration(durationMinutes)}`);
}
