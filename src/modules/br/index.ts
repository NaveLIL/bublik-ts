// ═══════════════════════════════════════════════
//  Модуль: BR — Справочник техники War Thunder
//
//  Функционал:
//  • Панель с навигацией по БР (◀ ▶) и фильтром категорий
//  • Поиск техники по названию (across all BRs)
//  • Админ: добавление, удаление, bulk-edit для каждой
//    категории + приоритета
//  • ANSI-раскраска приоритетов в Discord
//  • Redis cache + автоинвалидация
// ═══════════════════════════════════════════════

import { Interaction } from 'discord.js';
import type { BublikClient } from '../../bot';
import { BublikModule } from '../../types';
import { logger } from '../../core/Logger';
import {
  drainScheduledTasksByPrefix,
  scheduleTask,
  unscheduleTask,
} from '../../core/SchedulerManager';
import { getGuildLocale } from '../../core/GuildConfig';
import { getRedis } from '../../core/Redis';
import { isGuildAllowed } from '../../core/Whitelist';
import { getAllPanels, getAvailableBrs, upsertPanel } from './database';
import {
  getGuildRotation,
  getRotationDisplayBr,
  getRotationSnapshot,
  getTomorrowIso,
  wasRotationNotificationSent,
  markRotationNotificationSent,
  shouldSendNotificationsNow,
  getNotifyRoleMention,
} from './rotation';
import { buildPanelHubEmbed, buildRotationNotifyEmbed } from './embeds';
import { buildPanelButtons, buildRotationNotifyButton } from './components';

import { handleBrInteraction } from './handlers';
import { BR_PREFIX, BR_SEP } from './constants';
import brCommand from './commands/br';

const log = logger.child('Module:br');
const BR_TASK_PREFIX = 'br:';
const ROTATION_TASK = 'br:rotation:notify';
const ROTATION_NOTIFY_CLEANUP_ZSET = 'br:rotation:notify:cleanup';
const ROTATION_NOTIFY_DELETE_AFTER_MS = 24 * 60 * 60 * 1000;
const ROTATION_NOTIFY_CLEANUP_BATCH = 50;

function cleanupMember(channelId: string, messageId: string): string {
  return `${channelId}:${messageId}`;
}

function parseCleanupMember(value: string): { channelId: string; messageId: string } | null {
  const sep = value.indexOf(':');
  if (sep <= 0 || sep >= value.length - 1) return null;
  return {
    channelId: value.slice(0, sep),
    messageId: value.slice(sep + 1),
  };
}

function isSafeToForgetDeleteError(err: unknown): boolean {
  if (!err || typeof err !== 'object' || !('code' in err)) return false;
  const code = Number((err as { code?: unknown }).code);
  return code === 10003 || code === 10008 || code === 50001 || code === 50013;
}

async function enqueueRotationNotificationCleanup(channelId: string, messageId: string): Promise<void> {
  const redis = getRedis();
  const deleteAt = Date.now() + ROTATION_NOTIFY_DELETE_AFTER_MS;
  await redis.zadd(ROTATION_NOTIFY_CLEANUP_ZSET, deleteAt, cleanupMember(channelId, messageId));
}

async function cleanupExpiredRotationNotifications(client: BublikClient): Promise<void> {
  const redis = getRedis();
  const now = Date.now();
  const due = await redis.zrangebyscore(
    ROTATION_NOTIFY_CLEANUP_ZSET,
    0,
    now,
    'LIMIT',
    0,
    ROTATION_NOTIFY_CLEANUP_BATCH,
  );

  for (const member of due) {
    const parsed = parseCleanupMember(member);
    if (!parsed) {
      await redis.zrem(ROTATION_NOTIFY_CLEANUP_ZSET, member);
      continue;
    }

    try {
      const channel = await client.channels.fetch(parsed.channelId).catch(() => null);
      if (!channel?.isTextBased() || !('messages' in channel)) {
        await redis.zrem(ROTATION_NOTIFY_CLEANUP_ZSET, member);
        continue;
      }
      if ('guildId' in channel && typeof channel.guildId === 'string' && !isGuildAllowed(channel.guildId)) {
        // Access was revoked. Forget the maintenance item without touching the
        // former guild; re-authorisation must not replay an old delete.
        await redis.zrem(ROTATION_NOTIFY_CLEANUP_ZSET, member);
        continue;
      }

      const msg = await channel.messages.fetch(parsed.messageId).catch(() => null);
      if (msg) {
        await msg.delete();
      }

      await redis.zrem(ROTATION_NOTIFY_CLEANUP_ZSET, member);
    } catch (err) {
      if (isSafeToForgetDeleteError(err)) {
        await redis.zrem(ROTATION_NOTIFY_CLEANUP_ZSET, member);
      } else {
        log.warn(`Failed to cleanup BR notification message channel=${parsed.channelId} message=${parsed.messageId}`, {
          error: String(err),
        });
      }
    }
  }
}

async function processRotationNotifications(client: BublikClient): Promise<void> {
  await cleanupExpiredRotationNotifications(client);

  const shouldNotify = shouldSendNotificationsNow();

  const panels = await getAllPanels();
  if (panels.length === 0) return;

  for (const panel of panels) {
    if (!isGuildAllowed(panel.guildId)) continue;
    try {
      const livePanel = await refreshHubPanel(client, panel);

      const guildId = panel.guildId;
      const periods = await getGuildRotation(guildId);
      if (!shouldNotify || periods.length === 0) continue;

      const locale = await getGuildLocale(guildId);
      const snapshot = getRotationSnapshot(periods);
      const tomorrowIso = getTomorrowIso();

      const notifyChannelId = process.env.BR_ROTATION_NOTIFY_CHANNEL_ID || livePanel.panelChannelId;
      if (!notifyChannelId) continue;

      const channel = await client.channels.fetch(notifyChannelId).catch(() => null);
      if (!channel || !('send' in channel)) continue;

      const roleMention = getNotifyRoleMention(process.env.BR_ROTATION_NOTIFY_ROLE_ID || null);

      const tomorrowPeriod = periods.find((p) => p.start === tomorrowIso) ?? null;
      if (tomorrowPeriod) {
        const alreadySent = await wasRotationNotificationSent(guildId, tomorrowPeriod.start, 'warning');
        if (!alreadySent) {
          const nextAfterTomorrow = periods.find((p) => p.start > tomorrowPeriod.start) ?? null;
          await channel.send({
            content: roleMention || undefined,
            embeds: [buildRotationNotifyEmbed(locale, 'warning', tomorrowPeriod.rating, tomorrowPeriod.start, tomorrowPeriod.end, nextAfterTomorrow)],
            components: [buildRotationNotifyButton(locale, tomorrowPeriod.rating)],
          }).then(async (sent) => {
            await enqueueRotationNotificationCleanup(notifyChannelId, sent.id);
          });
          await markRotationNotificationSent(guildId, tomorrowPeriod.start, 'warning');
        }
      }

      // Если расписание обновили с задержкой, отправим финал текущего периода один раз.
      if (snapshot.current) {
        const alreadySent = await wasRotationNotificationSent(guildId, snapshot.current.start, 'final');
        if (!alreadySent) {
          await channel.send({
            content: roleMention || undefined,
            embeds: [
              buildRotationNotifyEmbed(
                locale,
                'final',
                snapshot.current.rating,
                snapshot.current.start,
                snapshot.current.end,
                snapshot.next,
              ),
            ],
            components: [buildRotationNotifyButton(locale, snapshot.current.rating)],
          }).then(async (sent) => {
            await enqueueRotationNotificationCleanup(notifyChannelId, sent.id);
          });
          await markRotationNotificationSent(guildId, snapshot.current.start, 'final');
        }
      }
    } catch (err) {
      log.error(`BR rotation cycle failed for guild=${panel.guildId}`, { error: String(err) });
    }
  }
}

async function refreshHubPanel(client: BublikClient, panel: {
  guildId: string;
  panelChannelId: string | null;
  panelMessageId: string | null;
  defaultBr: string | null;
}): Promise<{
  guildId: string;
  panelChannelId: string | null;
  panelMessageId: string | null;
  defaultBr: string | null;
}> {
  if (!panel.panelChannelId) return panel;

  const channel = await client.channels.fetch(panel.panelChannelId).catch(() => null);
  if (!channel?.isTextBased() || !('send' in channel)) return panel;

  const locale = await getGuildLocale(panel.guildId);
  const periods = await getGuildRotation(panel.guildId);
  const snapshot = getRotationSnapshot(periods);
  const brs = await getAvailableBrs(panel.guildId);
  const fallbackBr = panel.defaultBr && brs.includes(panel.defaultBr)
    ? panel.defaultBr
    : (getRotationDisplayBr(snapshot, periods) ?? brs[0] ?? null);

  let msg = null;
  if (panel.panelMessageId && 'messages' in channel) {
    msg = await channel.messages.fetch(panel.panelMessageId).catch(() => null);
  }

  if (!msg) {
    const created = await channel.send({
      embeds: [buildPanelHubEmbed(locale, snapshot, periods, fallbackBr)],
      components: buildPanelButtons(locale),
    });
    const saved = await upsertPanel(panel.guildId, {
      panelChannelId: panel.panelChannelId,
      panelMessageId: created.id,
      defaultBr: fallbackBr,
    });
    log.info(`BR hub panel re-published: guild=${panel.guildId} channel=${panel.panelChannelId}`);
    return {
      guildId: saved.guildId,
      panelChannelId: saved.panelChannelId,
      panelMessageId: saved.panelMessageId,
      defaultBr: saved.defaultBr,
    };
  }

  await msg.edit({
    embeds: [buildPanelHubEmbed(locale, snapshot, periods, fallbackBr)],
    components: buildPanelButtons(locale),
  });

  if (fallbackBr !== panel.defaultBr) {
    const saved = await upsertPanel(panel.guildId, { defaultBr: fallbackBr });
    return {
      guildId: saved.guildId,
      panelChannelId: saved.panelChannelId,
      panelMessageId: saved.panelMessageId,
      defaultBr: saved.defaultBr,
    };
  }

  return panel;
}

const brModule: BublikModule = {
  name: 'br',
  descriptionKey: 'modules.br.description',
  version: '1.0.0',
  author: 'NaveLIL',

  commands: [brCommand],

  events: [
    {
      event: 'interactionCreate',
      async execute(interaction: Interaction) {
        const customId =
          (interaction.isButton() && interaction.customId) ||
          (interaction.isStringSelectMenu() && interaction.customId) ||
          (interaction.isModalSubmit() && interaction.customId) ||
          '';

        if (!customId.startsWith(BR_PREFIX + BR_SEP)) return;

        await handleBrInteraction(interaction);
      },
    },
  ],

  async onLoad(_client: BublikClient): Promise<void> {
    scheduleTask(
      ROTATION_TASK,
      15 * 60 * 1000,
      async () => {
        await processRotationNotifications(_client);
      },
      { exclusive: true, immediate: true },
    );
    log.info('Модуль War Thunder BR загружен ✓');
  },

  async onUnload(_client: BublikClient): Promise<void> {
    unscheduleTask(ROTATION_TASK);
    // ModuleLoader applies the external timeout and quarantines this legacy
    // generation while an already-started BR cycle is still settling.
    await drainScheduledTasksByPrefix(BR_TASK_PREFIX);
    log.info('Модуль War Thunder BR выгружен');
  },
};

export default brModule;
