import {
  Client,
  TextChannel,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  UserSelectMenuBuilder,
  MessageFlags,
  Message,
} from 'discord.js';
import { getDatabase } from '../../core/Database';
import { getRedis } from '../../core/Redis';
import { logger } from '../../core/Logger';
import { i18n } from '../../core/I18n';
import { getGuildLocale } from '../../core/GuildConfig';
import { scheduleTask, unscheduleTask } from '../../core/SchedulerManager';
import { isGuildAllowed } from '../../core/Whitelist';
import { BublikEmbed, successEmbed, errorEmbed } from '../../core/EmbedBuilder';
import { getCompleteGuildMembers } from '../../core/GuildMemberSnapshot';
import {
  drainAbandonedBalances,
  getOrCreatePendingRaid,
  getActiveRaid,
  getRaidById,
  updateRaid,
  addRaidDamage,
  resolveRaidPayouts,
  getEcoConfig,
  invalidateProfileCache,
  RAID_BOOST_CHARGE_SCOPE,
} from './database';
import { secureRandomInt } from './random';
import { applyWalletDeltaInTransaction, claimOperationInTransaction } from './profile';

const log = logger.child('Economy:Raid');

const COMBOS_KEY = (guildId: string, userId: string) => `economy:raid:combo:${guildId}:${userId}`;
const BUTTON_COOLDOWN_KEY = (guildId: string, userId: string) => `economy:raid:btn_cd:${guildId}:${userId}`;

const RAID_BOOST_PURCHASE_SCOPE = 'raid_boost_purchase';
const RAID_SABOTAGE_PURCHASE_SCOPE = 'raid_sabotage_purchase';
const RAID_SABOTAGE_STUN_SCOPE = 'raid_sabotage_stun';
const RAID_EFFECT_RECEIPT_TTL_MS = 30 * 24 * 60 * 60_000;
const RAID_BOOST_TTL_MS = 60 * 60_000;
const RAID_STUN_MS = 15_000;

const ABSENCE_THRESHOLD_MS = 14 * 24 * 60 * 60 * 1000; // 14 дней
const DEFAULT_RAID_SPONSOR_SHIELD = 5000; // спонсорские 5,000 при отсутствии пула
export const RAID_LAUNCH_LEASE_MS = 2 * 60_000;

function isPermanentChannelError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  return [10_003, 50_001, 50_013].includes(Number((error as { code?: unknown }).code));
}

function isPermanentMessageError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  return [10_003, 10_008, 50_001, 50_013].includes(Number((error as { code?: unknown }).code));
}

export function isUnknownDiscordMemberError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  return Number((error as { code?: unknown }).code) === 10_007;
}

const MAX_DISCORD_SNOWFLAKE = 18_446_744_073_709_551_615n;

export function isDiscordSnowflake(value: unknown): value is string {
  if (typeof value !== 'string' || !/^[1-9]\d{16,19}$/.test(value)) return false;
  return BigInt(value) <= MAX_DISCORD_SNOWFLAKE;
}

export async function isMemberAuthoritativelyAbsent(guild: any, userId: string): Promise<boolean> {
  // EconomyProfile also stores durable system ledgers such as "government".
  // They are not Discord users and must never be sent to the members endpoint
  // or classified as abandoned accounts.
  if (!isDiscordSnowflake(userId)) return false;

  try {
    await guild.members.fetch({ user: userId, force: true });
    return false;
  } catch (error) {
    if (isUnknownDiscordMemberError(error)) return true;
    // Permission/rate-limit/network failures are not evidence that a member left.
    throw error;
  }
}

export function isRecoverableRaidLaunch(
  status: string,
  messageId: string | null,
  startedAt: Date | null,
  nowMs = Date.now(),
): boolean {
  return status === 'active'
    && messageId === null
    && startedAt !== null
    && startedAt.getTime() <= nowMs - RAID_LAUNCH_LEASE_MS;
}

const RAID_MESSAGE_MARKER_PREFIX = 'Bublik raid:';

export function raidMessageMarker(raidId: string): string {
  return `${RAID_MESSAGE_MARKER_PREFIX}${raidId}`;
}

export function isRaidLaunchMessage(
  message: {
    author?: { id?: string } | null;
    embeds?: readonly { footer?: { text?: string | null } | null }[];
    components?: readonly unknown[];
  },
  botUserId: string,
  raidId: string,
): boolean {
  if (message.author?.id !== botUserId) return false;
  if (message.embeds?.some((embed) => embed.footer?.text === raidMessageMarker(raidId))) return true;

  const validIds = new Set([
    `raid:strike:${raidId}`,
    `raid:boost:${raidId}`,
    `raid:sabotage:${raidId}`,
  ]);
  const containsRaidButton = (component: unknown): boolean => {
    if (!component || typeof component !== 'object') return false;
    const raw = component as Record<string, unknown>;
    if (typeof raw.customId === 'string' && validIds.has(raw.customId)) return true;
    return Array.isArray(raw.components) && raw.components.some(containsRaidButton);
  };
  return message.components?.some(containsRaidButton) ?? false;
}

export function calculateRaidStrikeDamage(baseDamage: number, combo: number, boosted: boolean): number {
  const effectiveBase = boosted ? Math.floor(baseDamage * 1.5) : baseDamage;
  return effectiveBase + Math.floor(effectiveBase * 0.1 * Math.min(Math.max(combo, 0), 5));
}

export function isRaidTerminalRecoveryCandidate(status: string, currentHp: number): boolean {
  return status === 'active' && currentHp <= 0;
}

function raidEffectPurchaseKey(kind: 'boost' | 'sabotage', interactionId: string): string {
  return `raid-${kind}-purchase:${interactionId}`;
}

async function purchaseRaidBoost(
  raidId: string,
  guildId: string,
  userId: string,
  interactionId: string,
  cost: number,
): Promise<'purchased' | 'duplicate' | 'inactive'> {
  const db = getDatabase();
  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "economy_raids" WHERE "id" = ${raidId} FOR UPDATE`;
    const raid = await tx.economyRaid.findUnique({ where: { id: raidId } });
    if (!raid || raid.guildId !== guildId || raid.status !== 'active' || raid.currentHp <= 0) {
      return 'inactive';
    }

    const claimed = await claimOperationInTransaction(
      tx,
      raidEffectPurchaseKey('boost', interactionId),
      RAID_BOOST_PURCHASE_SCOPE,
      guildId,
      userId,
      { raidId, state: 'completed', cost, charges: 3 },
      new Date(Date.now() + RAID_EFFECT_RECEIPT_TTL_MS),
    );
    if (!claimed) return 'duplicate';

    await applyWalletDeltaInTransaction(
      tx,
      guildId,
      userId,
      -cost,
      'raid_buy_boost',
      `Purchased strike boost for raid ${raidId}`,
    );
    const expiresAt = new Date(Date.now() + RAID_BOOST_TTL_MS);
    await tx.operationClaim.createMany({
      data: Array.from({ length: 3 }, (_, index) => ({
        key: `raid-boost-charge:${interactionId}:${index}`,
        scope: RAID_BOOST_CHARGE_SCOPE,
        guildId,
        userId,
        metadata: { raidId, purchaseInteractionId: interactionId },
        expiresAt,
      })),
    });
    return 'purchased';
  });
}

async function purchaseRaidSabotage(
  raidId: string,
  guildId: string,
  userId: string,
  targetId: string,
  interactionId: string,
  cost: number,
): Promise<'purchased' | 'duplicate' | 'inactive'> {
  const db = getDatabase();
  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "economy_raids" WHERE "id" = ${raidId} FOR UPDATE`;
    const raid = await tx.economyRaid.findUnique({ where: { id: raidId } });
    if (!raid || raid.guildId !== guildId || raid.status !== 'active' || raid.currentHp <= 0) {
      return 'inactive';
    }

    const claimed = await claimOperationInTransaction(
      tx,
      raidEffectPurchaseKey('sabotage', interactionId),
      RAID_SABOTAGE_PURCHASE_SCOPE,
      guildId,
      userId,
      { raidId, targetId, state: 'completed', cost },
      new Date(Date.now() + RAID_EFFECT_RECEIPT_TTL_MS),
    );
    if (!claimed) return 'duplicate';

    await applyWalletDeltaInTransaction(
      tx,
      guildId,
      userId,
      -cost,
      'raid_buy_sabotage',
      `Sabotaged user ${targetId} in raid ${raidId}`,
      targetId,
    );
    await tx.operationClaim.create({
      data: {
        key: `raid-sabotage-stun:${interactionId}`,
        scope: RAID_SABOTAGE_STUN_SCOPE,
        guildId,
        userId: targetId,
        metadata: { raidId, sourceUserId: userId },
        expiresAt: new Date(Date.now() + RAID_STUN_MS),
      },
    });
    return 'purchased';
  });
}

async function getRaidStunTtl(guildId: string, raidId: string, userId: string): Promise<number> {
  const stun = await getDatabase().operationClaim.findFirst({
    where: {
      scope: RAID_SABOTAGE_STUN_SCOPE,
      guildId,
      userId,
      expiresAt: { gt: new Date() },
      metadata: { path: ['raidId'], equals: raidId },
    },
    orderBy: { expiresAt: 'desc' },
    select: { expiresAt: true },
  });
  return stun?.expiresAt ? Math.max(0, Math.ceil((stun.expiresAt.getTime() - Date.now()) / 1000)) : 0;
}

// ═══════════════════════════════════════════════
//  Scheduler & Background Jobs
// ═══════════════════════════════════════════════

async function compensateOrphanedRaidLaunch(raidId: string, staleBefore: Date): Promise<boolean> {
  const db = getDatabase();
  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "economy_raids" WHERE "id" = ${raidId} FOR UPDATE`;
    const raid = await tx.economyRaid.findUnique({
      where: { id: raidId },
      include: { _count: { select: { participants: true } } },
    });
    if (
      !raid
      || raid.status !== 'active'
      || raid.messageId !== null
      || !raid.startedAt
      || raid.startedAt > staleBefore
      || raid._count.participants > 0
    ) return false;

    await tx.economyRaid.update({
      where: { id: raid.id },
      data: {
        status: 'pending',
        maxHp: 0,
        currentHp: 0,
        channelId: null,
        messageId: null,
        startedAt: null,
        lastHitUserId: null,
      },
    });
    return true;
  });
}

async function findExistingRaidLaunchMessages(
  channel: TextChannel,
  botUserId: string,
  raidId: string,
  startedAt: Date,
): Promise<Message[]> {
  const matches: Message[] = [];
  const oldestRelevantTimestamp = startedAt.getTime() - 60_000;
  let before: string | undefined;

  for (let page = 0; page < 5; page++) {
    const batch = await channel.messages.fetch({ limit: 100, ...(before ? { before } : {}) });
    for (const message of batch.values()) {
      if (isRaidLaunchMessage(message, botUserId, raidId)) matches.push(message);
    }

    const oldest = batch.last();
    if (!oldest || batch.size < 100 || oldest.createdTimestamp < oldestRelevantTimestamp) break;
    before = oldest.id;
  }

  return matches.sort((a, b) => a.createdTimestamp - b.createdTimestamp);
}

async function getAvailableRaidChannel(client: Client, raid: { guildId: string; channelId: string | null }) {
  const guild = client.guilds.cache.get(raid.guildId);
  if (!guild || !isGuildAllowed(raid.guildId)) return null;
  const channelIds: string[] = raid.channelId ? [raid.channelId] : [];
  try {
    const config = await getEcoConfig(raid.guildId);
    if (config?.leaderboardChannelId && !channelIds.includes(config.leaderboardChannelId)) {
      channelIds.push(config.leaderboardChannelId);
    }
  } catch (error) {
    // The stored channel can still be used while the optional config cache is down.
    if (channelIds.length === 0) throw error;
  }
  for (const channelId of channelIds) {
    try {
      const channel = guild.channels.cache.get(channelId) ?? await guild.channels.fetch(channelId);
      if (channel?.isTextBased() && 'send' in channel && 'messages' in channel) {
        return channel as TextChannel;
      }
    } catch (error) {
      if (!isPermanentChannelError(error)) throw error;
    }
  }
  return null;
}

/** Recover legacy/crashed active raids that never persisted a Discord message. */
export async function recoverOrphanedRaidLaunches(client: Client): Promise<number> {
  const guildIds = [...client.guilds.cache.keys()].filter(isGuildAllowed);
  if (guildIds.length === 0) return 0;
  const db = getDatabase();
  const staleBefore = new Date(Date.now() - RAID_LAUNCH_LEASE_MS);
  const raids = await db.economyRaid.findMany({
    where: {
      guildId: { in: guildIds },
      status: 'active',
      messageId: null,
      startedAt: { lte: staleBefore },
    },
    include: {
      participants: { orderBy: { damage: 'desc' } },
      abandonedAccounts: true,
    },
    take: 100,
  });

  let recovered = 0;
  for (const raid of raids) {
    try {
      const guild = client.guilds.cache.get(raid.guildId);
      if (!guild || !isGuildAllowed(raid.guildId)) continue;
      if (!raid.channelId) {
        if (await compensateOrphanedRaidLaunch(raid.id, staleBefore)) recovered++;
        continue;
      }

      let channel = guild.channels.cache.get(raid.channelId) ?? null;
      if (!channel) {
        try {
          channel = await guild.channels.fetch(raid.channelId);
        } catch (error) {
          if (!isPermanentChannelError(error)) throw error;
        }
      }
      if (!channel?.isTextBased() || !('send' in channel)) {
        if (await compensateOrphanedRaidLaunch(raid.id, staleBefore)) recovered++;
        continue;
      }

      const leaseStartedAt = new Date();
      const claimed = await db.economyRaid.updateMany({
        where: {
          id: raid.id,
          status: 'active',
          messageId: null,
          startedAt: { lte: staleBefore },
        },
        data: { startedAt: leaseStartedAt },
      });
      if (claimed.count !== 1) continue;

      const textChannel = channel as TextChannel;
      const botUserId = client.user?.id;
      if (!botUserId) throw new Error('Bot user is unavailable during raid recovery');
      const existingMessages = await findExistingRaidLaunchMessages(
        textChannel,
        botUserId,
        raid.id,
        raid.startedAt!,
      );
      const existingMessage = existingMessages[0];
      const locale = await getGuildLocale(raid.guildId);
      const message = existingMessage ?? await textChannel.send({
        embeds: [buildRaidEmbed({ ...raid, startedAt: leaseStartedAt }, locale)],
        components: buildRaidButtons(raid),
      });
      const persisted = await db.economyRaid.updateMany({
        where: {
          id: raid.id,
          status: 'active',
          messageId: null,
          startedAt: leaseStartedAt,
        },
        data: { messageId: message.id },
      });
      if (persisted.count !== 1) {
        if (!existingMessage) await message.delete().catch(() => {});
        continue;
      }
      for (const duplicate of existingMessages.slice(1)) {
        await duplicate.delete().catch(() => {});
      }
      recovered++;
      log.info(
        `[${raid.guildId}] Recovered raid launch ${raid.id} with ${existingMessage ? 'relinked' : 'new'} message ${message.id}`,
      );
    } catch (error) {
      log.error(`Raid launch recovery failed for ${raid.id}; it will be retried`, error);
    }
  }
  return recovered;
}

/** Turn a deleted, moved or corrupted active raid panel back into a launch-recovery job. */
export async function recoverMissingRaidMessages(client: Client): Promise<number> {
  const guildIds = [...client.guilds.cache.keys()].filter(isGuildAllowed);
  if (guildIds.length === 0) return 0;
  const db = getDatabase();
  const raids = await db.economyRaid.findMany({
    where: {
      guildId: { in: guildIds },
      status: 'active',
      currentHp: { gt: 0 },
      messageId: { not: null },
    },
    orderBy: { startedAt: 'asc' },
    take: 100,
  });

  let recovered = 0;
  for (const raid of raids) {
    try {
      if (!isGuildAllowed(raid.guildId)) continue;
      const channel = await getAvailableRaidChannel(client, raid);
      if (!channel) continue;

      let message: Message | null = null;
      if (raid.channelId === channel.id && raid.messageId) {
        try {
          message = await channel.messages.fetch(raid.messageId);
        } catch (error) {
          if (!isPermanentMessageError(error)) throw error;
        }
      }
      if (
        message
        && client.user
        && isRaidLaunchMessage(message, client.user.id, raid.id)
      ) continue;

      // Only one process may detach the stale Discord id. The ordinary launch
      // recovery then uses its marker scan before it ever sends a replacement.
      const changed = await db.economyRaid.updateMany({
        where: {
          id: raid.id,
          guildId: raid.guildId,
          status: 'active',
          currentHp: { gt: 0 },
          messageId: raid.messageId,
        },
        data: {
          channelId: channel.id,
          messageId: null,
          startedAt: new Date(Date.now() - RAID_LAUNCH_LEASE_MS),
        },
      });
      recovered += changed.count;
    } catch (error) {
      log.error(`Raid message recovery failed for ${raid.id}; it will be retried`, error);
    }
  }
  return recovered;
}

/** Settle terminal raids independently of Discord and finish pending resolution UI. */
export async function recoverTerminalRaids(client: Client): Promise<number> {
  const guildIds = [...client.guilds.cache.keys()].filter(isGuildAllowed);
  if (guildIds.length === 0) return 0;
  const raids = await getDatabase().economyRaid.findMany({
    where: {
      guildId: { in: guildIds },
      OR: [
        { status: 'active', currentHp: { lte: 0 } },
        { status: 'resolved', messageId: null },
      ],
    },
    // "active" sorts before "resolved", so stale UI rows can never starve
    // monetary settlement work from this bounded batch.
    orderBy: [{ status: 'asc' }, { resolvedAt: 'asc' }, { startedAt: 'asc' }],
    take: 100,
  });

  let recovered = 0;
  for (const raid of raids) {
    if (!isGuildAllowed(raid.guildId)) continue;
    try {
      if (raid.status === 'resolved') {
        if (await publishResolvedRaidMessage(client, raid)) recovered++;
      } else if (await endRaid(raid.guildId, client, raid.id)) {
        recovered++;
      }
    } catch (error) {
      log.error(`Raid terminal recovery failed for ${raid.id}; it will be retried`, error);
    }
  }
  return recovered;
}

export function startRaidScheduler(client: Client): void {
  scheduleTask('economy:raid_launch_recovery', 60_000, async () => {
    await recoverTerminalRaids(client);
    await recoverMissingRaidMessages(client);
    await recoverOrphanedRaidLaunches(client);
  }, { exclusive: true, immediate: true });
  // 1. Ежедневный сбор балансов ушедших
  scheduleTask('economy:drain_left', 24 * 60 * 60 * 1000, async () => {
    await drainAllLeftUsers(client);
  }, { immediate: true });

  // 2. Проверка времени запуска рейда (раз в минуту)
  scheduleTask('economy:raid_cron', 60 * 1000, async () => {
    const now = new Date();
    // Запуск в воскресенье в 18:00 по московскому времени (UTC+3 -> 15:00 UTC)
    const isSunday = now.getUTCDay() === 0;
    const isTargetHour = now.getUTCHours() === 15;
    const isTargetMinute = now.getUTCMinutes() === 0;

    if (isSunday && isTargetHour && isTargetMinute) {
      log.info('Weekly cron triggered: starting Sunday Safe Raid for all guilds');
      await startRaidForAllGuilds(client);
    }
  });

  log.info('Планировщик штурма сейфов запущен');
}

export function stopRaidScheduler(): void {
  unscheduleTask('economy:raid_launch_recovery');
  unscheduleTask('economy:drain_left');
  unscheduleTask('economy:raid_cron');
  for (const queue of updateQueues.values()) {
    if (queue.timer) clearTimeout(queue.timer);
  }
  updateQueues.clear();
  log.info('Планировщик штурма сейфов остановлен');
}

/** Ретроспективная синхронизация участников, покинувших сервер до установки обновления */
export async function syncLeftMembers(client: Client): Promise<void> {
  const db = getDatabase();
  for (const [, guild] of client.guilds.cache) {
    try {
      if (!isGuildAllowed(guild.id)) continue;
      const config = await getEcoConfig(guild.id);
      if (!config?.enabled) continue;
      // Получаем всех участников сервера (Discord API chunking)
      const members = await getCompleteGuildMembers(guild);
      const memberIds = new Set(members.keys());

      // Получаем все профили экономики с ненулевым балансом
      const profiles = await db.economyProfile.findMany({
        where: {
          guildId: guild.id,
          OR: [
            { wallet: { gt: 0 } },
            { bank: { gt: 0 } }
          ]
        }
      });

      let addedCount = 0;
      for (const profile of profiles) {
        if (memberIds.has(profile.userId)) continue;
        try {
          if (!(await isMemberAuthoritativelyAbsent(guild, profile.userId))) {
            await db.leftMember.deleteMany({
              where: { guildId: guild.id, userId: profile.userId },
            });
            continue;
          }

          const inserted = await db.leftMember.createMany({
            data: [{ guildId: guild.id, userId: profile.userId, leftAt: new Date(0) }],
            skipDuplicates: true,
          });

          // Close the snapshot→insert race: if guildMemberAdd happened while the
          // row was being created, remove the stale marker immediately.
          if (!(await isMemberAuthoritativelyAbsent(guild, profile.userId))) {
            await db.leftMember.deleteMany({
              where: { guildId: guild.id, userId: profile.userId },
            });
            continue;
          }
          addedCount += inserted.count;
        } catch (error) {
          log.warn('Could not authoritatively verify retrospective guild absence', {
            guildId: guild.id,
            userId: profile.userId,
            error: String(error),
          });
        }
      }

      if (addedCount > 0) {
        log.info(`Синхронизация ушедших на сервере ${guild.name}: добавлено ${addedCount} ретроспективно ушедших участников.`);
      }
    } catch (err) {
      log.error(`Ошибка синхронизации ушедших участников для гильдии ${guild.name}`, err);
    }
  }
}

/** Сбор средств со всех ушедших участников на серверах */
export async function drainAllLeftUsers(client: Client): Promise<void> {
  try {
    // 1. Ретроспективно находим тех, кто вышел до обновления
    await syncLeftMembers(client).catch((err) =>
      log.error('Ошибка ретроспективной синхронизации ушедших', err)
    );

    // 2. Списываем средства
    for (const [, guild] of client.guilds.cache) {
      if (!isGuildAllowed(guild.id)) continue;
      const config = await getEcoConfig(guild.id);
      if (!config?.enabled) continue;

      const raid = await getOrCreatePendingRaid(guild.id);
      // Пока идёт активный рейд, балансы не трогаем: следующая итерация
      // безопасно подберёт LeftMember после освобождения activeKey.
      if (raid.status !== 'pending') continue;

      const drained = await drainAbandonedBalances(
        guild.id,
        ABSENCE_THRESHOLD_MS,
        raid.id,
        async (userId) => {
          if (!isGuildAllowed(guild.id)) throw new Error('guild_not_allowed');
          return isMemberAuthoritativelyAbsent(guild, userId);
        },
      );
      if (drained.length === 0) continue;

      log.info(`Списаны балансы ушедших на сервере ${guild.name}: ${drained.length} пользователей. Добавлено в джекпот рейда.`);
    }
  } catch (err) {
    log.error('Ошибка автоматического списания балансов ушедших', err);
  }
}

/** Запустить штурм во всех гильдиях */
async function startRaidForAllGuilds(client: Client): Promise<void> {
  if (![...client.guilds.cache.keys()].some(isGuildAllowed)) return;
  // Защита от двойного запуска
  const todayString = new Date().toISOString().split('T')[0];
  const r = getRedis();
  const lockKey = `economy:raid:global_lock:${todayString}`;
  const lock = await r.set(lockKey, '1', 'EX', 3600, 'NX');
  if (!lock) {
    log.warn('Штурм сейфа сегодня уже запускался — пропускаем');
    return;
  }

  for (const [guildId] of client.guilds.cache) {
    if (!isGuildAllowed(guildId)) continue;
    await startRaidForGuild(client, guildId).catch((err) =>
      log.error(`Не удалось запустить штурм в гильдии ${guildId}`, err),
    );
  }
}

/** Запустить штурм в конкретной гильдии */
export async function startRaidForGuild(client: Client, guildId: string): Promise<boolean> {
  if (!isGuildAllowed(guildId)) return false;
  const guild = client.guilds.cache.get(guildId);
  if (!guild) return false;

  const config = await getEcoConfig(guildId);
  if (!config?.enabled) return false;
  const channelId = config?.leaderboardChannelId;
  if (!channelId) {
    log.warn(`Канал лидерборда не настроен на сервере ${guild.name} (${guildId}) — штурм пропущен`);
    return false;
  }

  const channel = await guild.channels.fetch(channelId).catch(() => null) as TextChannel | null;
  if (!channel || !channel.isTextBased()) {
    log.warn(`Канал лидерборда ${channelId} на сервере ${guild.name} не найден — штурм пропущен`);
    return false;
  }

  // Проверить, идет ли уже активный штурм
  const active = await getActiveRaid(guildId);
  if (active) {
    log.warn(`Активный штурм уже запущен на сервере ${guild.name}`);
    return false;
  }

  const pending = await getOrCreatePendingRaid(guildId);
  let pool = pending.totalPool;

  // Спонсорская поддержка от гильдии, если джекпот пуст
  if (pool <= 0) {
    pool = DEFAULT_RAID_SPONSOR_SHIELD;
    await updateRaid(pending.id, { totalPool: pool });
  }

  const maxHp = Math.max(100, Math.floor(pool / 10)); // 1 HP = 10 шекелей
  const locale = await getGuildLocale(guildId);

  // Claim the launch before publishing. If the process dies during Discord I/O,
  // the recovery lease scans for the deterministic raid marker and relinks it.
  const startedAt = new Date();
  const db = getDatabase();
  const activated = await db.economyRaid.updateMany({
    where: { id: pending.id, guildId, status: 'pending', activeKey: guildId },
    data: {
      status: 'active',
      maxHp,
      currentHp: maxHp,
      startedAt,
      channelId,
      messageId: null,
    },
  });
  if (activated.count !== 1) {
    log.warn(`Штурм ${pending.id} уже был запущен другим процессом`);
    return false;
  }

  const activeRaid = {
    ...pending,
    totalPool: pool,
    status: 'active',
    maxHp,
    currentHp: maxHp,
    startedAt,
    channelId,
    messageId: null,
    participants: [],
  };
  let msg: Message;
  try {
    msg = await channel.send({
      embeds: [buildRaidEmbed(activeRaid, locale)],
      components: buildRaidButtons(activeRaid),
    });
  } catch (error) {
    log.error(`Не удалось опубликовать штурм ${pending.id}; recovery повторит попытку`, error);
    return false;
  }

  const persisted = await db.economyRaid.updateMany({
    where: {
      id: pending.id,
      guildId,
      status: 'active',
      messageId: null,
      startedAt,
    },
    data: { messageId: msg.id },
  }).catch(async (error) => {
    await msg.delete().catch(() => {});
    throw error;
  });
  if (persisted.count !== 1) {
    await msg.delete().catch(() => {});
    log.warn(`Штурм ${pending.id} потерял право на публикацию сообщения`);
    return false;
  }
  // Пинг всех участников
  await channel.send({ content: `@here 🚨 **${i18n.t('economy.cmd.raid.ping_announce', locale)}**` }).catch(() => null);

  log.info(`Штурм сейфа запущен на сервере ${guild.name} (Сообщение: ${msg.id})`);
  return true;
}

// ═══════════════════════════════════════════════
//  Throttling & Embed Builders
// ═══════════════════════════════════════════════

const updateQueues = new Map<string, {
  timer: ReturnType<typeof setTimeout> | null;
  lastUpdate: number;
  pending: boolean;
}>();

function queueRaidMessageUpdate(guildId: string, client: Client, raidId: string) {
  let queue = updateQueues.get(guildId);
  if (!queue) {
    queue = { timer: null, lastUpdate: 0, pending: false };
    updateQueues.set(guildId, queue);
  }

  if (queue.pending) return;

  const now = Date.now();
  const timeSinceLast = now - queue.lastUpdate;
  const delay = Math.max(0, 1500 - timeSinceLast); // Троттлинг 1.5 сек

  queue.pending = true;
  queue.timer = setTimeout(async () => {
    queue!.pending = false;
    queue!.lastUpdate = Date.now();
    queue!.timer = null;
    await pushRaidMessageUpdate(guildId, client, raidId).catch((err) =>
      log.error(`Failed to push raid update for ${guildId}: ${err.message}`),
    );
  }, delay);
}

async function pushRaidMessageUpdate(guildId: string, client: Client, raidId: string) {
  if (!isGuildAllowed(guildId)) return;
  const raid = await getRaidById(raidId);
  if (!raid || raid.guildId !== guildId) return;

  // Settlement must not depend on the Discord channel or message still existing.
  if (isRaidTerminalRecoveryCandidate(raid.status, raid.currentHp)) {
    await endRaid(guildId, client, raidId);
    return;
  }
  if (!raid.channelId || !raid.messageId || raid.status !== 'active') return;

  const guild = client.guilds.cache.get(guildId);
  if (!guild) return;

  const channel = guild.channels.cache.get(raid.channelId) as TextChannel | undefined;
  if (!channel) return;

  const msg = await channel.messages.fetch(raid.messageId).catch(() => null);
  if (!msg) return;

  const locale = await getGuildLocale(guildId);

  await msg.edit({
    embeds: [buildRaidEmbed(raid, locale)],
    components: buildRaidButtons(raid),
  }).catch(() => null);
}

function buildRaidEmbed(raid: any, locale: string): BublikEmbed {
  const percent = Math.max(0, Math.min(100, Math.floor((raid.currentHp / raid.maxHp) * 100)));
  const filled = Math.floor(percent / 10);
  const bar = '🟥'.repeat(filled) + '🟩'.repeat(10 - filled);

  const embed = new BublikEmbed()
    .setColor('#d97706') // Оранжевый градиент
    .setTitle(`🚨 ${i18n.t('economy.cmd.raid.title', locale)} 🚨`)
    .setDescription(
      `### ${i18n.t('economy.cmd.raid.pool_label', locale)}: **${raid.totalPool.toLocaleString()} ₪**\n` +
      `**${i18n.t('economy.cmd.raid.hp_label', locale)}**: ${bar} (${raid.currentHp} / ${raid.maxHp} HP)\n\n` +
      `*${i18n.t('economy.cmd.raid.instructions', locale)}*`
    )
    .setFooter({ text: raidMessageMarker(String(raid.id)) });

  // Список конфискованных балансов
  if (raid.abandonedAccounts && raid.abandonedAccounts.length > 0) {
    const lines = raid.abandonedAccounts.map((a: any) =>
      `> 👤 <@${a.userId}> — **${a.balance.toLocaleString()} ₪**`
    );
    embed.addFields({
      name: `💼 ${i18n.t('economy.cmd.raid.drained_title', locale)}`,
      value: lines.slice(0, 10).join('\n') + (lines.length > 10 ? `\n> *...и еще ${lines.length - 10}*` : ''),
    });
  }

  // Список топ взломщиков
  if (raid.participants && raid.participants.length > 0) {
    const lines = raid.participants.map((p: any, idx: number) => {
      const medals = ['🥇', '🥈', '🥉'];
      const prefix = medals[idx] ?? `**${idx + 1}.**`;
      const pct = Math.floor((p.damage / raid.maxHp) * 100);
      return `${prefix} <@${p.userId}> — **${p.damage} урона** (${pct}%)`;
    });
    embed.addFields({
      name: `👥 ${i18n.t('economy.cmd.raid.top_attackers', locale)}`,
      value: lines.slice(0, 5).join('\n'),
    });
  } else {
    embed.addFields({
      name: `👥 ${i18n.t('economy.cmd.raid.top_attackers', locale)}`,
      value: `> *${i18n.t('economy.cmd.raid.no_attackers_yet', locale)}*`,
    });
  }

  return embed;
}

function buildRaidResolvedEmbed(raid: any, locale: string): BublikEmbed {
  const embed = new BublikEmbed()
    .setColor('#059669') // Зеленый цвет успешного финала
    .setTitle(`🔓 ${i18n.t('economy.cmd.raid.broken_title', locale)} 🔓`)
    .setDescription(
      `### ${i18n.t('economy.cmd.raid.pool_label', locale)}: **${raid.totalPool.toLocaleString()} ₪**\n` +
      `*${i18n.t('economy.cmd.raid.broken_desc', locale)}*\n\n` +
      `🎯 **${i18n.t('economy.cmd.raid.last_hit', locale)}**: <@${raid.lastHitUserId || '?'}>`
    )
    .setFooter({ text: raidMessageMarker(String(raid.id)) });

  if (raid.participants && raid.participants.length > 0) {
    const lines = raid.participants.map((p: any, idx: number) => {
      const medals = ['🥇', '🥈', '🥉'];
      const prefix = medals[idx] ?? `**${idx + 1}.**`;
      return `${prefix} <@${p.userId}> — **+${(p.payout || 0).toLocaleString()} ₪** (${p.damage} урона)`;
    });
    embed.addFields({
      name: `🏆 ${i18n.t('economy.cmd.raid.rewards_title', locale)}`,
      value: lines.slice(0, 10).join('\n') + (lines.length > 10 ? `\n*...и еще ${lines.length - 10} участников*` : ''),
    });
  }

  return embed;
}

async function publishResolvedRaidMessage(
  client: Client,
  raidSnapshot: any,
  preferredMessageId?: string | null,
): Promise<boolean> {
  if (!raidSnapshot || !isGuildAllowed(raidSnapshot.guildId)) return false;
  const fresh = await getRaidById(raidSnapshot.id);
  if (!fresh || fresh.status !== 'resolved') return false;
  const channel = await getAvailableRaidChannel(client, fresh);
  const botUserId = client.user?.id;
  if (!channel || !botUserId) return false;

  let message: Message | null = null;
  const knownMessageId = preferredMessageId ?? fresh.messageId;
  if (knownMessageId && channel.id === fresh.channelId) {
    try {
      const fetched = await channel.messages.fetch(knownMessageId);
      if (isRaidLaunchMessage(fetched, botUserId, fresh.id)) message = fetched;
    } catch (error) {
      if (!isPermanentMessageError(error)) throw error;
    }
  }

  if (!message) {
    const markerMatches = await findExistingRaidLaunchMessages(
      channel,
      botUserId,
      fresh.id,
      fresh.startedAt ?? fresh.createdAt ?? new Date(0),
    );
    message = markerMatches[0] ?? null;
    for (const duplicate of markerMatches.slice(1)) await duplicate.delete().catch(() => {});
  }

  const locale = await getGuildLocale(fresh.guildId);
  let sent = false;
  if (message) {
    await message.edit({ embeds: [buildRaidResolvedEmbed(fresh, locale)], components: [] });
  } else {
    message = await channel.send({ embeds: [buildRaidResolvedEmbed(fresh, locale)], components: [] });
    sent = true;
  }

  const linked = await getDatabase().economyRaid.updateMany({
    where: { id: fresh.id, status: 'resolved', messageId: null },
    data: { channelId: channel.id, messageId: message.id },
  });
  if (linked.count !== 1 && sent) await message.delete().catch(() => {});
  return linked.count === 1 || !sent;
}

function buildRaidButtons(raid: any): ActionRowBuilder<ButtonBuilder>[] {
  const strikeBtn = new ButtonBuilder()
    .setCustomId(`raid:strike:${raid.id}`)
    .setLabel('💥 УДАР')
    .setStyle(ButtonStyle.Danger);

  const boostBtn = new ButtonBuilder()
    .setCustomId(`raid:boost:${raid.id}`)
    .setLabel('🌀 УСИЛЕНИЕ (100 ₪)')
    .setStyle(ButtonStyle.Success);

  const sabotageBtn = new ButtonBuilder()
    .setCustomId(`raid:sabotage:${raid.id}`)
    .setLabel('⚡ САБОТАЖ (200 ₪)')
    .setStyle(ButtonStyle.Primary);

  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(strikeBtn, boostBtn, sabotageBtn)
  ];
}

// ═══════════════════════════════════════════════
//  Raid Execution & Payouts logic
// ═══════════════════════════════════════════════

async function endRaid(guildId: string, client: Client, raidId: string): Promise<boolean> {
  if (!isGuildAllowed(guildId)) return false;
  try {
    const raid = await getRaidById(raidId);
    if (!raid || raid.guildId !== guildId) return false;
    if (raid.status === 'resolved') return publishResolvedRaidMessage(client, raid);
    if (!isRaidTerminalRecoveryCandidate(raid.status, raid.currentHp)) return false;

    const participants = raid.participants;
    if (participants.length === 0) {
      // Сейф остался нетронутым — отмена
      const cancelled = await getDatabase().economyRaid.updateMany({
        where: { id: raidId, guildId, status: 'active', currentHp: { lte: 0 } },
        data: { status: 'cancelled', activeKey: null, resolvedAt: new Date() },
      });
      return cancelled.count === 1;
    }

    const totalDamage = participants.reduce((acc: number, p: any) => acc + p.damage, 0);
    const payoutsMap = new Map<string, number>();

    // 1. 60% пропорционально урону
    const sharePool = Math.floor(raid.totalPool * 0.60);
    for (const p of participants) {
      const share = Math.floor(sharePool * (p.damage / totalDamage));
      payoutsMap.set(p.userId, (payoutsMap.get(p.userId) ?? 0) + share);
    }

    // 2. 25% Top-1 урона
    const top1Pool = Math.floor(raid.totalPool * 0.25);
    const top1User = participants[0].userId;
    payoutsMap.set(top1User, (payoutsMap.get(top1User) ?? 0) + top1Pool);

    // 3. 15% Last Hit
    const lastHitPool = Math.floor(raid.totalPool * 0.15);
    const lastHitUser = raid.lastHitUserId || top1User;
    payoutsMap.set(lastHitUser, (payoutsMap.get(lastHitUser) ?? 0) + lastHitPool);

    // Выплаты
    const payouts = Array.from(payoutsMap.entries()).map(([userId, amount]) => ({ userId, amount }));
    const paid = await resolveRaidPayouts(raidId, payouts, lastHitUser);
    if (!paid) {
      const alreadyResolved = await getRaidById(raidId);
      if (alreadyResolved?.status === 'resolved') {
        await publishResolvedRaidMessage(client, alreadyResolved);
        return true;
      }
      return false;
    }

    // Redis is a cache only: a cache outage must never roll back DB payouts.
    for (const participant of participants) {
      await invalidateProfileCache(guildId, participant.userId).catch((error) =>
        log.warn('Failed to invalidate raid payout cache', {
          guildId,
          userId: participant.userId,
          error: String(error),
        }),
      );
    }
    const resolved = await getRaidById(raidId);
    await publishResolvedRaidMessage(client, resolved, raid.messageId);

    log.info(`Штурм сейфа ${raidId} успешно завершен. Выплаты распределены.`);
    return true;
  } catch (err) {
    log.error(`Ошибка при завершении штурма ${raidId}`, err);
    return false;
  }
}

// ═══════════════════════════════════════════════
//  Button Interaction Handlers
// ═══════════════════════════════════════════════

export async function handleRaidInteraction(interaction: any): Promise<void> {
  const customId: string = interaction.customId || '';
  const parts = customId.split(':');
  const action = parts[1];
  const raidId = parts[2];

  if (!raidId || !interaction.guildId) return;

  const guildId = interaction.guildId;
  const userId = interaction.user.id;
  const locale = await getGuildLocale(guildId);

  // Проверка: идет ли рейд
  const raid = await getRaidById(raidId);
  if (!raid || raid.guildId !== guildId || raid.status !== 'active' || raid.currentHp <= 0) {
    return interaction.reply({
      embeds: [errorEmbed(i18n.t('economy.cmd.raid.err_not_active', locale))],
      flags: MessageFlags.Ephemeral
    });
  }

  // Проверка: оглушен ли игрок саботажем
  const r = getRedis();
  const stunTTL = await getRaidStunTtl(guildId, raidId, userId);
  if (stunTTL > 0) {
    return interaction.reply({
      embeds: [errorEmbed(i18n.t('economy.cmd.raid.err_stunned', locale, { sec: String(stunTTL) }))],
      flags: MessageFlags.Ephemeral
    });
  }

  if (action === 'strike') {
    // 3-секундный кулдаун на кнопку удара
    const btnCD = await r.set(BUTTON_COOLDOWN_KEY(guildId, userId), '1', 'EX', 3, 'NX');
    if (!btnCD) {
      return interaction.reply({
        embeds: [errorEmbed(i18n.t('economy.cmd.raid.err_btn_cooldown', locale))],
        flags: MessageFlags.Ephemeral
      });
    }

    // Расчет урона
    const baseDamage = secureRandomInt(10, 50);

    // Проверка буста
    // Расчет комбо (подряд удары без прерывания)
    const comboStr = await r.get(COMBOS_KEY(guildId, userId));
    const combo = comboStr ? parseInt(comboStr) : 0;
    const finalDamage = calculateRaidStrikeDamage(baseDamage, combo, false);
    const boostedDamage = calculateRaidStrikeDamage(baseDamage, combo, true);

    // Entitlement consumption and HP damage commit atomically in PostgreSQL.
    const damageResult = await addRaidDamage(
      raidId,
      userId,
      finalDamage,
      boostedDamage,
      interaction.id,
    );
    if (damageResult.duplicate) {
      await interaction.reply({
        content: 'Этот удар уже был обработан.',
        flags: MessageFlags.Ephemeral,
      }).catch(() => null);
      return;
    }
    const realDamage = damageResult.damage;
    if (realDamage <= 0) {
      return interaction.reply({
        embeds: [errorEmbed(i18n.t('economy.cmd.raid.err_not_active', locale))],
        flags: MessageFlags.Ephemeral,
      });
    }

    // Набиваем комбо (на 10 сек)
    await r.set(COMBOS_KEY(guildId, userId), String(combo + 1), 'EX', 10);

    // Удаляем комбо у остальных участников рейда (прерывание)
    for (const p of raid.participants) {
      if (p.userId !== userId) {
        await r.del(COMBOS_KEY(guildId, p.userId));
      }
    }

    await interaction.reply({
      content: `💥 **${i18n.t('economy.cmd.raid.strike_msg', locale, {
        dmg: String(realDamage),
        combo: combo > 0 ? ` (Combo x${combo + 1})` : '',
        boost: damageResult.boosted ? ' 🌀' : ''
      })}**`,
      flags: MessageFlags.Ephemeral
    }).catch(() => null);

    queueRaidMessageUpdate(guildId, interaction.client, raidId);
  }

  else if (action === 'boost') {
    // Стоимость 100 шекелей
    const cost = 100;

    try {
      const purchased = await purchaseRaidBoost(raidId, guildId, userId, interaction.id, cost);
      if (purchased === 'inactive') {
        return interaction.reply({
          embeds: [errorEmbed(i18n.t('economy.cmd.raid.err_not_active', locale))],
          flags: MessageFlags.Ephemeral,
        });
      }
    } catch (error) {
      if (!(error instanceof Error) || error.message !== 'insufficient_funds') throw error;
      return interaction.reply({
        embeds: [errorEmbed(i18n.t('economy.cmd.raid.err_no_money', locale, { cost: String(cost) }))],
        flags: MessageFlags.Ephemeral
      });
    }

    await invalidateProfileCache(guildId, userId).catch((error) =>
      log.warn('Failed to invalidate raid boost buyer cache', { guildId, userId, error: String(error) }),
    );

    await interaction.reply({
      embeds: [successEmbed(i18n.t('economy.cmd.raid.boost_acquired', locale))],
      flags: MessageFlags.Ephemeral
    }).catch(() => null);
  }

  else if (action === 'sabotage') {
    // Стоимость 200 шекелей
    const cost = 200;
    const db = getDatabase();

    const profile = await db.economyProfile.findUnique({
      where: { guildId_userId: { guildId, userId } }
    });
    if (!profile || profile.wallet < cost) {
      return interaction.reply({
        embeds: [errorEmbed(i18n.t('economy.cmd.raid.err_no_money', locale, { cost: String(cost) }))],
        flags: MessageFlags.Ephemeral
      });
    }

    // Вывести меню выбора пользователя
    const userSelect = new UserSelectMenuBuilder()
      .setCustomId(`raid:sabotage_select:${raidId}`)
      .setPlaceholder(i18n.t('economy.cmd.raid.select_sabotage_target', locale))
      .setMinValues(1)
      .setMaxValues(1);

    const row = new ActionRowBuilder<UserSelectMenuBuilder>().addComponents(userSelect);

    await interaction.reply({
      content: i18n.t('economy.cmd.raid.choose_sabotage_target', locale),
      components: [row],
      flags: MessageFlags.Ephemeral
    }).catch(() => null);
  }
}

export async function handleRaidSabotageSelect(interaction: any): Promise<void> {
  const customId: string = interaction.customId || '';
  const parts = customId.split(':');
  const raidId = parts[2];
  if (!raidId || !interaction.guildId) return;

  const guildId = interaction.guildId;
  const userId = interaction.user.id;
  const targetId = interaction.values[0];
  const locale = await getGuildLocale(guildId);

  if (userId === targetId) {
    return interaction.reply({
      embeds: [errorEmbed(i18n.t('economy.cmd.raid.err_sabotage_self', locale))],
      flags: MessageFlags.Ephemeral
    });
  }

  // Проверка рейдинга
  const raid = await getRaidById(raidId);
  if (!raid || raid.guildId !== guildId || raid.status !== 'active' || raid.currentHp <= 0) {
    return interaction.reply({
      embeds: [errorEmbed(i18n.t('economy.cmd.raid.err_not_active', locale))],
      flags: MessageFlags.Ephemeral
    });
  }

  const cost = 200;
  try {
    const purchased = await purchaseRaidSabotage(
      raidId,
      guildId,
      userId,
      targetId,
      interaction.id,
      cost,
    );
    if (purchased === 'inactive') {
      return interaction.reply({
        embeds: [errorEmbed(i18n.t('economy.cmd.raid.err_not_active', locale))],
        flags: MessageFlags.Ephemeral,
      });
    }
  } catch (error) {
    if (!(error instanceof Error) || error.message !== 'insufficient_funds') throw error;
    return interaction.reply({
      embeds: [errorEmbed(i18n.t('economy.cmd.raid.err_no_money', locale, { cost: String(cost) }))],
      flags: MessageFlags.Ephemeral,
    });
  }
  await invalidateProfileCache(guildId, userId).catch((error) =>
    log.warn('Failed to invalidate raid sabotage buyer cache', { guildId, userId, error: String(error) }),
  );

  // Combo is cosmetic/ephemeral; the paid stun itself is durable in PostgreSQL.
  const r = getRedis();
  await r.del(COMBOS_KEY(guildId, targetId)).catch(() => null);

  await interaction.update({
    content: null,
    embeds: [successEmbed(i18n.t('economy.cmd.raid.sabotage_success', locale, { target: `<@${targetId}>` }))],
    components: []
  }).catch(() => null);

  // Уведомить саботированного в канале рейда (опционально, тихий лог)
  const guild = interaction.client.guilds.cache.get(guildId);
  if (guild && raid.channelId) {
    const channel = guild.channels.cache.get(raid.channelId) as TextChannel | undefined;
    if (channel) {
      await channel.send({
        content: `⚡ <@${userId}> ${i18n.t('economy.cmd.raid.sabotage_channel_ann', locale, { target: `<@${targetId}>` })}`
      }).catch(() => null);
    }
  }
}
