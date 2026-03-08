// ═══════════════════════════════════════════════
//  Vacation — Шедулер (периодические проверки)
//
//  Один setInterval (60с) проверяет БД:
//  1. Pending > 3ч → автоотклонение
//  2. Active, endDate < now+24h, !reminderSent → DM напоминание
//  3. Active, endDate <= now → завершить, вернуть роли
//
//  Все данные в БД → таймеры не теряются при рестартах.
// ═══════════════════════════════════════════════

import { TextChannel } from 'discord.js';
import type { BublikClient } from '../../bot';
import { logger } from '../../core/Logger';
import { errorReporter } from '../../core/ErrorReporter';

import { VacationStatus, SCHEDULER_INTERVAL_MS } from './constants';
import {
  findPendingExpired,
  findActiveNeedingReminder,
  findActiveEnded,
  updateRequest,
} from './database';
import { restoreRoles } from './utils';
import {
  buildExpiredRequestEmbed,
  buildDmExpired,
  buildDmReminder,
  buildVacationEndLog,
} from './embeds';

const log = logger.child('Vacation:Scheduler');

let schedulerInterval: ReturnType<typeof setInterval> | null = null;

// ═══════════════════════════════════════════════
//  Start / Stop
// ═══════════════════════════════════════════════

export function startScheduler(client: BublikClient): void {
  if (schedulerInterval) return;

  // Первый запуск сразу (ловит всё, что произошло во время даунтайма)
  runChecks(client).catch((err) => {
    log.error('Ошибка при первом запуске шедулера', { error: String(err) });
  });

  schedulerInterval = setInterval(() => {
    runChecks(client).catch((err) => {
      log.error('Ошибка в шедулере', { error: String(err) });
      errorReporter.eventError(err, 'vacationScheduler', 'vacation');
    });
  }, SCHEDULER_INTERVAL_MS);

  log.info('Шедулер отпусков запущен (интервал 60с)');
}

export function stopScheduler(): void {
  if (schedulerInterval) {
    clearInterval(schedulerInterval);
    schedulerInterval = null;
    log.info('Шедулер отпусков остановлен');
  }
}

// ═══════════════════════════════════════════════
//  Основной цикл проверок
// ═══════════════════════════════════════════════

async function runChecks(client: BublikClient): Promise<void> {
  await checkPendingExpiry(client);
  await checkReminders(client);
  await checkVacationEnd(client);
}

// ═══════════════════════════════════════════════
//  1. Автоотклонение просроченных заявок (>3ч)
// ═══════════════════════════════════════════════

async function checkPendingExpiry(client: BublikClient): Promise<void> {
  const expired = await findPendingExpired();

  for (const request of expired) {
    try {
      await updateRequest(request.id, { status: VacationStatus.Expired });

      // Обновить сообщение в канале ревью
      if (request.reviewMessageId && request.config.reviewChannelId) {
        try {
          const reviewChannel = await client.channels.fetch(request.config.reviewChannelId) as TextChannel;
          const msg = await reviewChannel.messages.fetch(request.reviewMessageId);

          const guild = await client.guilds.fetch(request.guildId).catch(() => null);
          const member = guild ? await guild.members.fetch(request.userId).catch(() => null) : null;

          await msg.edit({
            embeds: [buildExpiredRequestEmbed(request, member)],
            components: [],
          });
        } catch { /* skip */ }
      }

      // DM пользователю
      try {
        const user = await client.users.fetch(request.userId);
        await user.send({ embeds: [buildDmExpired(request)] });
      } catch { /* DM закрыты или пользователь не найден */ }

      log.info(`Автоотклонение заявки: ${request.userId} (${request.guildId})`);
    } catch (err) {
      log.error(`Ошибка при автоотклонении заявки ${request.id}`, { error: String(err) });
    }
  }
}

// ═══════════════════════════════════════════════
//  2. Напоминание за 24ч до конца отпуска
// ═══════════════════════════════════════════════

async function checkReminders(client: BublikClient): Promise<void> {
  const needReminder = await findActiveNeedingReminder();

  for (const request of needReminder) {
    try {
      await updateRequest(request.id, { reminderSent: true });

      try {
        const user = await client.users.fetch(request.userId);
        await user.send({ embeds: [buildDmReminder(request)] });
      } catch { /* DM закрыты */ }

      log.info(`Напоминание отправлено: ${request.userId} — отпуск до ${request.endDate}`);
    } catch (err) {
      log.error(`Ошибка при отправке напоминания ${request.id}`, { error: String(err) });
    }
  }
}

// ═══════════════════════════════════════════════
//  3. Завершение отпусков, время которых истекло
// ═══════════════════════════════════════════════

async function checkVacationEnd(client: BublikClient): Promise<void> {
  const ended = await findActiveEnded();

  for (const request of ended) {
    try {
      const guild = await client.guilds.fetch(request.guildId).catch(() => null);
      if (!guild) {
        // Гильдия недоступна — просто завершаем запись
        await updateRequest(request.id, { status: VacationStatus.Completed });
        continue;
      }

      const member = await guild.members.fetch(request.userId).catch(() => null);

      if (member) {
        // Восстановить роли
        await restoreRoles(member, request.savedRoleIds, request.config.vacationRoleId);
      }

      await updateRequest(request.id, { status: VacationStatus.Completed });

      // Лог
      if (request.config.logChannelId && member) {
        try {
          const logChannel = await client.channels.fetch(request.config.logChannelId) as TextChannel;
          await logChannel.send({
            embeds: [buildVacationEndLog(member, request, false)],
          });
        } catch { /* skip */ }
      }

      log.info(`Отпуск завершён автоматически: ${request.userId} (${request.guildId})`);
    } catch (err) {
      log.error(`Ошибка при завершении отпуска ${request.id}`, { error: String(err) });
    }
  }
}
