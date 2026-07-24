import { TextChannel } from 'discord.js';
import type { BublikClient } from '../../bot';
import { logger } from '../../core/Logger';
import { getGuildLocale } from '../../core/GuildConfig';
import { isGuildAllowed } from '../../core/Whitelist';
import { fetchGuildIfPresent, fetchGuildMemberIfPresent } from '../../utils/helpers';
import { scheduleTask, unscheduleTask } from '../../core/SchedulerManager';
import { VacationStatus, SCHEDULER_INTERVAL_MS, NS_LOG_CHANNEL_ID, NsType } from './constants';
import { isNsInformationalVacation } from './state';
import {
  claimReminder,
  findActiveEnded,
  findActiveNeedingReminder,
  findLiveRoleVacations,
  findNsActiveEnded,
  findPendingExpired,
  findStaleActivating,
  findStaleNsActivating,
  transitionNsVacation,
  transitionRequest,
} from './database';
import {
  activateNsInformationalVacation,
  activateNsRoleVacation,
  activateVacation,
  completeNsVacationWithoutRoles,
  restoreNsRoleVacation,
  restoreVacation,
  reconcileActiveVacationRoles,
} from './saga';
import {
  buildDmExpired,
  buildDmReminder,
  buildExpiredRequestEmbed,
  buildNsVacationEndLog,
  buildVacationEndLog,
} from './embeds';

const log = logger.child('Vacation:Scheduler');

export function startScheduler(client: BublikClient): void {
  scheduleTask('vacation:scheduler', SCHEDULER_INTERVAL_MS, () => runChecks(client), {
    exclusive: true,
    immediate: true,
  });
  log.info('Шедулер отпусков запущен (интервал 60с)');
}

export function stopScheduler(): void {
  unscheduleTask('vacation:scheduler');
  log.info('Шедулер отпусков остановлен');
}

async function runChecks(client: BublikClient): Promise<void> {
  await checkLiveVacationRoles(client);
  await checkStaleActivations(client);
  await checkPendingExpiry(client);
  await checkReminders(client);
  await checkVacationEnd(client);
  await checkStaleNsActivations(client);
  await checkNsExpiry(client);
}

/**
 * Backfill the current PB ping role into legacy snapshots before removing it,
 * and continuously converge live vacations after uncertain Discord replies.
 */
async function checkLiveVacationRoles(client: BublikClient): Promise<void> {
  for (const request of await findLiveRoleVacations()) {
    if (!isGuildAllowed(request.guildId)) continue;
    try {
      const guild = await client.guilds.fetch(request.guildId).catch(() => null);
      if (!guild) continue;
      const member = await fetchGuildMemberIfPresent(guild, request.userId);
      if (!member) continue;
      await reconcileActiveVacationRoles(request, member);
    } catch (error) {
      log.warn(`Vacation role reconciliation ${request.id} retained for retry`, { error: String(error) });
    }
  }
}

async function checkStaleActivations(client: BublikClient): Promise<void> {
  for (const request of await findStaleActivating()) {
    if (!isGuildAllowed(request.guildId)) continue;
    try {
      const claimed = await transitionRequest(
        request.id,
        VacationStatus.Activating,
        { status: VacationStatus.Activating },
        request.updatedAt,
      );
      if (!claimed) continue;

      const guild = await client.guilds.fetch(claimed.guildId).catch(() => null);
      if (!guild) continue; // activating остаётся и будет повторно захвачен по lease

      const member = await fetchGuildMemberIfPresent(guild, claimed.userId);
      if (!member) {
        await transitionRequest(claimed.id, VacationStatus.Activating, {
          status: VacationStatus.Denied,
          endDate: new Date(),
        });
        continue;
      }

      await activateVacation(claimed, member);
      log.info(`Восстановлена незавершённая активация отпуска ${claimed.id}`);
    } catch (error) {
      log.error(`Ошибка восстановления активации отпуска ${request.id}`, { error: String(error) });
    }
  }
}

async function checkPendingExpiry(client: BublikClient): Promise<void> {
  for (const request of await findPendingExpired()) {
    if (!isGuildAllowed(request.guildId)) continue;
    const autoDenyMs = request.config.autoDenyHours * 60 * 60 * 1000;
    if (Date.now() - request.createdAt.getTime() < autoDenyMs) continue;

    try {
      const expired = await transitionRequest(request.id, VacationStatus.Pending, {
        status: VacationStatus.Expired,
      });
      if (!expired) continue;
      const locale = await getGuildLocale(request.guildId);

      if (request.reviewMessageId && request.config.reviewChannelId) {
        try {
          const reviewChannel = await client.channels.fetch(request.config.reviewChannelId) as TextChannel;
          const message = await reviewChannel.messages.fetch(request.reviewMessageId);
          const guild = await client.guilds.fetch(request.guildId).catch(() => null);
          const member = guild ? await fetchGuildMemberIfPresent(guild, request.userId) : null;
          await message.edit({
            embeds: [buildExpiredRequestEmbed(expired, member, locale)],
            components: [],
          });
        } catch (error) {
          log.warn(`Не удалось обновить просроченную заявку ${request.id}`, { error: String(error) });
        }
      }

      try {
        const user = await client.users.fetch(request.userId);
        await user.send({ embeds: [buildDmExpired(expired, locale)] });
      } catch (error) {
        log.warn(`Не удалось отправить DM о просроченной заявке ${request.id}`, { error: String(error) });
      }
      log.info(`Автоотклонение заявки: ${request.userId} (${request.guildId})`);
    } catch (error) {
      log.error(`Ошибка автоотклонения заявки ${request.id}`, { error: String(error) });
    }
  }
}

async function checkReminders(client: BublikClient): Promise<void> {
  for (const request of await findActiveNeedingReminder()) {
    if (!isGuildAllowed(request.guildId)) continue;
    try {
      if (!await claimReminder(request.id)) continue;
      const locale = await getGuildLocale(request.guildId);
      try {
        const user = await client.users.fetch(request.userId);
        await user.send({ embeds: [buildDmReminder(request, locale)] });
        log.info(`Напоминание отправлено: ${request.userId} — отпуск до ${request.endDate}`);
      } catch (error) {
        // Закрытые DM не должны создавать бесконечную очередь повторов.
        log.warn(`Не удалось отправить напоминание ${request.id}`, { error: String(error) });
      }
    } catch (error) {
      log.error(`Ошибка обработки напоминания ${request.id}`, { error: String(error) });
    }
  }
}

async function checkVacationEnd(client: BublikClient): Promise<void> {
  for (const request of await findActiveEnded()) {
    if (!isGuildAllowed(request.guildId)) continue;
    try {
      const claimed = await transitionRequest(
        request.id,
        request.status,
        { status: VacationStatus.Restoring },
        request.updatedAt,
      );
      if (!claimed) continue;

      const guild = await client.guilds.fetch(claimed.guildId).catch(() => null);
      if (!guild) {
        // Keep the durable desired state. A transient Discord/guild lookup is
        // not proof that restoration did not happen.
        continue;
      }

      const member = await fetchGuildMemberIfPresent(guild, claimed.userId);
      const completed = member
        ? await restoreVacation(claimed, member)
        : await transitionRequest(claimed.id, VacationStatus.Restoring, {
          status: VacationStatus.Completed,
        });
      if (!completed) continue;

      if (claimed.config.logChannelId && member) {
        try {
          const locale = await getGuildLocale(claimed.guildId);
          const channel = await client.channels.fetch(claimed.config.logChannelId) as TextChannel;
          await channel.send({ embeds: [buildVacationEndLog(member, completed, false, locale)] });
        } catch (error) {
          log.warn(`Не удалось записать завершение отпуска ${claimed.id}`, { error: String(error) });
        }
      }
      log.info(`Отпуск завершён автоматически: ${claimed.userId} (${claimed.guildId})`);
    } catch (error) {
      log.error(`Ошибка завершения отпуска ${request.id}`, { error: String(error) });
    }
  }
}

async function checkStaleNsActivations(client: BublikClient): Promise<void> {
  for (const record of await findStaleNsActivating()) {
    if (!isGuildAllowed(record.guildId)) continue;
    try {
      const claimed = await transitionNsVacation(
        record.id,
        'activating',
        { status: 'activating' },
        record.updatedAt,
      );
      if (!claimed) continue;
      const guild = await fetchGuildIfPresent(() => client.guilds.fetch(claimed.guildId));
      const member = guild ? await fetchGuildMemberIfPresent(guild, claimed.userId) : null;
      if (isNsInformationalVacation(claimed.type)) {
        await activateNsInformationalVacation(claimed, member);
      } else {
        if (!guild) {
          await transitionNsVacation(claimed.id, 'activating', { status: 'completed' });
          continue;
        }
        if (!member) {
          await transitionNsVacation(claimed.id, 'activating', { status: 'completed' });
          continue;
        }
        await activateNsRoleVacation(claimed, member);
      }
      log.info(`Восстановлена незавершённая НС-активация ${claimed.id}`);
    } catch (error) {
      log.error(`Ошибка восстановления НС-активации ${record.id}`, { error: String(error) });
    }
  }
}

async function checkNsExpiry(client: BublikClient): Promise<void> {
  for (const record of await findNsActiveEnded()) {
    if (!isGuildAllowed(record.guildId)) continue;
    try {
      const claimed = await transitionNsVacation(
        record.id,
        record.status,
        { status: 'restoring' },
        record.updatedAt,
      );
      if (!claimed) continue;

      const isRoleVacation = claimed.type === NsType.Shield || claimed.type === NsType.Troll;
      const guild = await client.guilds.fetch(claimed.guildId).catch(() => null);
      if (!guild && isRoleVacation) {
        // Keep RESTORING until an authoritative retry can converge roles.
        continue;
      }

      const member = guild ? await fetchGuildMemberIfPresent(guild, claimed.userId) : null;
      const completed = isRoleVacation && member
        ? await restoreNsRoleVacation(claimed, member)
        : await completeNsVacationWithoutRoles(claimed);
      if (!completed) continue;

      if (claimed.type === NsType.Vacation && member) {
        try {
          const locale = await getGuildLocale(claimed.guildId);
          const channel = await client.channels.fetch(NS_LOG_CHANNEL_ID) as TextChannel;
          await channel.send({ embeds: [buildNsVacationEndLog(member, false, locale)] });
        } catch (error) {
          log.warn(`Не удалось записать завершение НС-отпуска ${claimed.id}`, { error: String(error) });
        }
      }
      log.info(`НС запись завершена: ${claimed.userId} (${claimed.type}, ${claimed.guildId})`);
    } catch (error) {
      log.error(`Ошибка завершения НС-записи ${record.id}`, { error: String(error) });
    }
  }
}
