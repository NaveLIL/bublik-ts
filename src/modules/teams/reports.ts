// ═══════════════════════════════════════════════
//  Teams — Отчёты после ПБ-сессий
// ═══════════════════════════════════════════════

import {
  ButtonInteraction,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
  ModalSubmitInteraction,
} from 'discord.js';
import type { BublikClient } from '../../bot';
import { logger } from '../../core/Logger';
import { isGuildAllowed } from '../../core/Whitelist';
import { scheduleTask, unscheduleTask } from '../../core/SchedulerManager';

import { TM_SEP, getCurrentSeason, REPORT_TIMEOUT_H } from './constants';
import * as db from './database';
import {
  tmSuccess,
  tmError,
  tmWarn,
  buildReportRequestEmbed,
  buildReportButton,
  REPORT_MODAL_ID,
  buildReportChannelEmbed,
} from './embeds';

const log = logger.child('Teams:Reports');

async function getReportTimeoutMs(guildId: string): Promise<number> {
  const config = await db.getConfig(guildId);
  return (config?.reportTimeoutH ?? REPORT_TIMEOUT_H) * 60 * 60 * 1000;
}

// ═══════════════════════════════════════════════
//  Отправка запроса на отчёт (DM лидеру)
// ═══════════════════════════════════════════════

export async function sendReportRequest(
  client: BublikClient,
  sessionId: string,
  userId: string,
  teamName: string,
  squadNumber: number | null,
): Promise<void> {
  try {
    const user = await client.users.fetch(userId).catch(() => null);
    if (!user) return;

    const embed = buildReportRequestEmbed(teamName, squadNumber);
    const row = buildReportButton(sessionId);

    await user.send({ embeds: [embed], components: [row] });
    log.info(`Отчёт запрошен: ${user.tag}, сессия ${sessionId}`);
  } catch (err) {
    log.error('Ошибка отправки запроса отчёта', { error: String(err) });
  }
}

// ═══════════════════════════════════════════════
//  Кнопка «Заполнить отчёт» → Modal
// ═══════════════════════════════════════════════

export async function handleReportButton(
  interaction: ButtonInteraction,
  sessionId: string,
  _client: BublikClient,
): Promise<void> {
  const session = await db.getSession(sessionId);
  if (!session) {
    await interaction.reply({ embeds: [tmError('Сессия не найдена.')], ephemeral: true });
    return;
  }
  if (!isGuildAllowed(session.team.guildId)) {
    await interaction.reply({ embeds: [tmError('Сервер этой сессии больше не авторизован.')], ephemeral: true });
    return;
  }

  if (session.team.leaderId !== interaction.user.id) {
    await interaction.reply({ embeds: [tmError('Заполнить отчёт может только текущий лидер команды.')], ephemeral: true });
    return;
  }

  if (!session.endedAt) {
    await interaction.reply({ embeds: [tmWarn('Сессия ещё не завершена.')], ephemeral: true });
    return;
  }
  const timeoutMs = await getReportTimeoutMs(session.team.guildId);
  const deadline = new Date(session.endedAt.getTime() + timeoutMs);
  if (new Date() > deadline) {
    await interaction.reply({ embeds: [tmWarn('Время на заполнение отчёта истекло.')], ephemeral: true });
    return;
  }

  // Уже заполнен?
  if (session.reportedAt) {
    await interaction.reply({ embeds: [tmWarn('Отчёт уже заполнен.')], ephemeral: true });
    return;
  }

  const modal = new ModalBuilder()
    .setCustomId(`${REPORT_MODAL_ID}${TM_SEP}${sessionId}`)
    .setTitle('Отчёт о ПБ-сессии')
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId('report_pr')
          .setLabel('Полковой рейтинг (PR)')
          .setStyle(TextInputStyle.Short)
          .setPlaceholder('Например: 2500')
          .setRequired(true)
          .setMaxLength(10),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId('report_place')
          .setLabel('Место полка')
          .setStyle(TextInputStyle.Short)
          .setPlaceholder('Например: 42')
          .setRequired(true)
          .setMaxLength(5),
      ),
    );

  await interaction.showModal(modal);
}

// ═══════════════════════════════════════════════
//  Modal submit → сохранение отчёта
// ═══════════════════════════════════════════════

export async function handleReportModal(
  interaction: ModalSubmitInteraction,
  client: BublikClient,
): Promise<void> {
  const parts = interaction.customId.split(TM_SEP);
  const sessionId = parts[parts.length - 1];

  await interaction.deferReply({ ephemeral: true });

  const session = await db.getSession(sessionId);
  if (!session) {
    await interaction.editReply({ embeds: [tmError('Сессия не найдена.')] });
    return;
  }
  if (!isGuildAllowed(session.team.guildId)) {
    await interaction.editReply({ embeds: [tmError('Сервер этой сессии больше не авторизован.')] });
    return;
  }

  // Revalidate at modal submit; leadership may have changed while it was open.
  if (session.team.leaderId !== interaction.user.id) {
    await interaction.editReply({ embeds: [tmError('Вы больше не являетесь лидером этой команды.')] });
    return;
  }

  if (session.reportedAt) {
    await interaction.editReply({ embeds: [tmWarn('Отчёт уже заполнен.')] });
    return;
  }

  const timeoutMs = await getReportTimeoutMs(session.team.guildId);
  if (!session.endedAt || Date.now() > session.endedAt.getTime() + timeoutMs) {
    await interaction.editReply({ embeds: [tmWarn('Время на заполнение отчёта истекло.')] });
    return;
  }

  // Парсинг и валидация
  const prRaw = interaction.fields.getTextInputValue('report_pr').trim();
  const placeRaw = interaction.fields.getTextInputValue('report_place').trim();

  const pr = parseInt(prRaw, 10);
  const place = parseInt(placeRaw, 10);

  if (isNaN(pr) || pr < 0 || pr > 999_999) {
    await interaction.editReply({ embeds: [tmError('Полковой рейтинг должен быть числом от 0 до 999 999.')] });
    return;
  }

  if (isNaN(place) || place < 1 || place > 300) {
    await interaction.editReply({ embeds: [tmError('Место полка должно быть числом от 1 до 300.')] });
    return;
  }

  try {
    const { season, year } = getCurrentSeason(session.endedAt);
    const committed = await db.submitReportOnce({
      sessionId,
      reporterId: interaction.user.id,
      reportedPR: pr,
      reportedPlace: place,
      season,
      year,
      now: new Date(),
      timeoutMs,
    });
    if (!committed) {
      await interaction.editReply({ embeds: [tmWarn('Отчёт уже обработан, просрочен или право лидера изменилось.')] });
      return;
    }

    await interaction.editReply({ embeds: [tmSuccess(`Отчёт сохранён! ПР: **${pr.toLocaleString('ru')}**, место: **#${place}**`)] });

    // Опубликовать в канал отчётов
    const team = committed.team;
    const config = await db.getConfig(team.guildId);
    if (config?.reportChannelId) {
      await postReportToChannel(client, config.reportChannelId, team, committed, interaction.user.tag, pr, place);
    }

    log.info(`Отчёт заполнен: сессия ${sessionId}, ПР=${pr}, место=${place}`);
  } catch (err) {
    log.error('Ошибка сохранения отчёта', { error: String(err) });
    await interaction.editReply({ embeds: [tmError('Ошибка при сохранении отчёта.')] });
  }
}

// ═══════════════════════════════════════════════
//  Публикация в канал отчётов
// ═══════════════════════════════════════════════

async function postReportToChannel(
  client: BublikClient,
  channelId: string,
  team: { name: string; guildId: string },
  session: { startedAt: Date; endedAt: Date | null },
  reporterTag: string,
  pr: number,
  place: number,
): Promise<void> {
  try {
    const guild = client.guilds.cache.get(team.guildId);
    if (!guild) return;

    const channel = guild.channels.cache.get(channelId);
    if (!channel?.isTextBased()) return;

    // Длительность
    const durationMs = session.endedAt
      ? session.endedAt.getTime() - session.startedAt.getTime()
      : 0;
    const durationStr = formatDuration(durationMs);

    const embed = buildReportChannelEmbed(team.name, reporterTag, pr, place, durationStr);
    await channel.send({ embeds: [embed] });
  } catch (err) {
    log.error('Ошибка публикации отчёта в канал', { error: String(err) });
  }
}

// ═══════════════════════════════════════════════
//  Напоминание о незаполненных отчётах
// ═══════════════════════════════════════════════

const REPORT_REMINDER_TASK = 'teams:reportReminder';

export function startReportReminderChecker(client: BublikClient): void {
  unscheduleTask(REPORT_REMINDER_TASK);
  scheduleTask(REPORT_REMINDER_TASK, 30 * 60_000, async () => {
    await checkUnreportedSessions(client);
  }, { exclusive: true, immediate: true });
}

export function stopReportReminderChecker(): void {
  unscheduleTask(REPORT_REMINDER_TASK);
}

async function checkUnreportedSessions(client: BublikClient): Promise<void> {
  // Проверяем по каждой гильдии
  for (const [guildId] of client.guilds.cache) {
    if (!isGuildAllowed(guildId)) continue;
    const unreported = await db.getUnreportedSessions(guildId, 0);
    await processUnreportedSessions(client, unreported);
  }
}

async function processUnreportedSessions(
  client: BublikClient,
  unreported: Awaited<ReturnType<typeof db.getUnreportedSessions>>,
): Promise<void> {

  for (const session of unreported) {
    if (!session.endedAt) continue;

    const elapsed = Date.now() - session.endedAt.getTime();
    const team = await db.getTeam(session.teamId);
    if (!team) continue;
    const timeoutMs = (team.config.reportTimeoutH ?? REPORT_TIMEOUT_H) * 60 * 60 * 1000;

    // Если прошло больше таймаута — закрыть без отчёта
    if (elapsed > timeoutMs) {
      log.info(`Отчёт просрочен: сессия ${session.id}`);
      continue;
    }

    // Напомнить за 30 минут до дедлайна (если ещё не напоминали)
    const reminderAt = timeoutMs - 30 * 60_000;
    if (elapsed >= reminderAt && elapsed < reminderAt + 30 * 60_000) {
      if (!await db.claimReportReminder(session.id)) continue;

      try {
        const user = await client.users.fetch(team.leaderId);

        await user.send({
          embeds: [
            tmWarn(
              `Осталось **30 минут** для заполнения отчёта по сессии команды **${team.name}**.\n` +
              'Если не заполните — сессия не будет учтена в статистике.',
            ),
          ],
          components: [buildReportButton(session.id)],
        });
      } catch (err) {
        await db.releaseReportReminder(session.id).catch(() => null);
        log.error('Не удалось отправить напоминание об отчёте', { error: String(err), sessionId: session.id });
      }
    }
  }
}

// ═══════════════════════════════════════════════
//  Утилиты
// ═══════════════════════════════════════════════

function formatDuration(ms: number): string {
  const totalMin = Math.floor(ms / 60_000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;

  if (h > 0) return `${h}ч ${m}м`;
  return `${m}м`;
}
