// ═══════════════════════════════════════════════
//  RegBattle — Жизненный цикл каналов и ролей
//
//  1. Вход в мастер-канал → создание отряда
//  2. Вход/выход из отряда → ротация ролей
//  3. Пустой канал → удаление с задержкой
//  4. Восстановление при рестарте
//  5. Целостность ролей (периодическая проверка)
// ═══════════════════════════════════════════════

import {
  VoiceState,
  VoiceChannel,
  TextChannel,
  ChannelType,
  GuildMember,
  Guild,
  Collection,
  Message,
  PermissionsBitField,
} from 'discord.js';
import { randomUUID } from 'node:crypto';
import type { BublikClient } from '../../bot';
import { logger } from '../../core/Logger';
import { errorReporter } from '../../core/ErrorReporter';
import { getDatabase } from '../../core/Database';
import { type MemberRoleLock, withMemberRoleLock } from '../../core/MemberRoleLock';
import { fetchSafeAutomaticRole } from '../../core/RolePolicy';
import { Config } from '../../config';

import {
  EMPTY_DELETE_DELAY_MS,
  ROLE_INTEGRITY_INTERVAL_MS,
  PLAYED_RESET_CHECK_INTERVAL_MS,
  RED_ZONE_THRESHOLD_MS,
  STATUS_PANEL_UPDATE_INTERVAL_MS,
} from './constants';

import {
  getConfig,
  getSquadByAnyVoice,
  getGuildSquads,
  createSquadWithAllocatedNumber,
  updateSquad,
  deleteSquad,
} from './database';

import {
  squadName,
  getSquadMemberCount,
  getSquadMembers,
  acquireCreationLock,
  releaseCreationLock,
  isCreationCooldown,
  setCreationCooldown,
} from './utils';

import {
  buildControlPanelEmbed,
  buildControlPanelButtons,
  buildStatusPanelEmbed,
  type StatusPanelSquad,
  type StatusPanelAbsentee,
} from './embeds';

import { recalculatePinger } from './pinger';
import { getGuildLocale } from '../../core/GuildConfig';
import { getRedis } from '../../core/Redis';
import { i18n } from '../../core/I18n';
import { scheduleTask, unscheduleTask } from '../../core/SchedulerManager';
import { isGuildAllowed } from '../../core/Whitelist';
import {
  getDuePlayedResetDate,
  canBypassSquadCreationWindow,
  isCommanderAuthorized,
  mayUsePbCommanderFallback,
  isUnknownChannelError,
  isUnknownMemberError,
  isUnknownMessageError,
  canCreatePbSquadAtMskMinute,
} from './safety';
import {
  type PbChannelKind,
  type PbVoiceSession,
  getVoiceSession,
  saveVoiceSession,
  deleteVoiceSession,
  deleteVoiceSessionState,
  listGuildVoiceSessions,
  getPlayedOrigin,
  savePlayedOrigin,
  deletePlayedOrigin,
  hasPbVoiceStateQuarantine,
  buildSessionEndPlan,
  buildPlayedResetRoleIds,
  buildPlayedOrigin,
  applySessionRoles,
  buildTeamSessionReturnRoleIds,
  applySessionEndRoles,
  canCarrySessionTo,
  hasPbRoleProvenance,
  suppressSessionForVacation,
  shouldCleanupInviteOnTransition,
} from './voiceSessions';
import {
  type PbPingEligibilitySnapshot,
  isPbRoleMutationSuppressed,
  isPbVacationExcluded,
  loadPbPingEligibilitySnapshot,
  pbPingCandidateFromMember,
} from './pingEligibility';
import { resolveTeamsVoiceIntegration } from './teamsVoiceResolver';
import {
  ensureCompleteIntegrityMemberSnapshot,
  resolveStableIntegrityLocation,
  runIsolatedIntegrityTasks,
} from './integrityPolicy';
import {
  assertStatusPanelPipelineSucceeded,
  isOwnedStatusPanelMessageIdentity,
  isStatusPanelTextChannel,
  parseStatusPanelAbsentState,
  StatusPanelPipelineError,
  shouldPurgeStatusPanelAbsentState,
  shouldReplaceStatusPanelRetry,
  statusPanelTrailingRetryDelay,
  statusPanelSquadSnapshot,
} from './statusPanelPolicy';

// Teams интеграция (ленивый импорт для избежания циклических зависимостей)
async function getTeamsVoice(client: BublikClient) {
  try {
    return await resolveTeamsVoiceIntegration(client);
  } catch (error) {
    log.error('Teams integration is unavailable; PB classification is fail-closed', {
      error: String(error),
    });
    throw error;
  }
}

const log = logger.child('RegBattle:Lifecycle');

// Таймеры удаления пустых каналов
const deleteTimers = new Map<string, ReturnType<typeof setTimeout>>();


const PLAYED_RESET_DONE_PREFIX = 'rb:played-reset:done';
const PLAYED_RESET_LOCK_PREFIX = 'rb:played-reset:lock';
const SQUAD_CREATE_LOCK_PREFIX = 'rb:squad-create:lock';
const ORPHAN_CHANNEL_PREFIX = 'rb:orphan-channel';
const PLAYED_RESET_CLAIM_SCOPE = 'regbattle_played_reset';
const PLAYED_RESET_BOOTSTRAP_SCOPE = 'regbattle_played_reset_bootstrap';

// Serialises duplicate/move voice events for one member. Durable state remains in Redis.
const memberTransitionQueues = new Map<string, Promise<void>>();
const integrityCompleteMemberSnapshots = new Set<string>();
const zeroSquadCleanupCompleted = new Set<string>();
interface StatusPanelRetryTimer {
  timer: ReturnType<typeof setTimeout>;
  dueAt: number;
}
const statusPanelRetryTimers = new Map<string, StatusPanelRetryTimer>();

function getMskClock(now = new Date()): { hour: number; minute: number; hhmm: string } {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Moscow',
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(now);

  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? '0');
  const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? '0');
  const hhmm = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
  return { hour, minute, hhmm };
}

function canCreateSquadNowMsk(now = new Date()): boolean {
  const { hour, minute } = getMskClock(now);
  return canCreatePbSquadAtMskMinute(hour * 60 + minute);
}

/** @deprecated Sessions are durable and must not be erased during hot reload. */
export function clearVoiceSessions(guildId: string): void {
  void guildId;
}

// ═══════════════════════════════════════════════
//  Статус-панель рекрутинга (persistent embed)
// ═══════════════════════════════════════════════

const STATUS_PANEL_KEY = 'rb:statuspanel'; // rb:statuspanel:{guildId} → v2 { channelId, messageId }
const STATUS_PANEL_LOCK_KEY = 'rb:statuspanel_lock'; // rb:statuspanel_lock:{guildId} → lock token
const STATUS_PANEL_INVALID_KEY = 'rb:statuspanel_invalid';
const NOTIFY_OFF_KEY = 'rb:notify_off';     // rb:notify_off:{squadId} → "1"
const ABSENT_TRACK_KEY = 'rb:absent';        // rb:absent:{guildId}:{userId} → JSON { acc: ms, onAt: ms|null }

interface StatusPanelReference {
  version: 2;
  channelId: string;
  messageId: string;
}

class StatusPanelPopulationConflictError extends Error {
  constructor(guildId: string) {
    super(`Status panel authoritative state changed for ${guildId}`);
    this.name = 'StatusPanelPopulationConflictError';
  }
}

function statusPanelConfigSnapshot(config: any | null): string {
  if (!config) return 'null';
  return JSON.stringify({
    id: config.id ?? null,
    updatedAt: config.updatedAt ?? null,
    announceChannelId: config.announceChannelId ?? null,
    reserveChannelId: config.reserveChannelId ?? null,
    pingRoleId: config.pingRoleId ?? null,
    playedTodayRoleId: config.playedTodayRoleId ?? null,
    playedResetHour: config.playedResetHour ?? 23,
    squadSize: config.squadSize ?? 8,
  });
}

class StatusPanelLeaseLostError extends Error {
  constructor(guildId: string) {
    super(`Status panel lease lost for ${guildId}`);
    this.name = 'StatusPanelLeaseLostError';
  }
}

function parseStatusPanelReference(
  raw: string | null,
  legacyChannelId: string,
): StatusPanelReference | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<StatusPanelReference>;
    if (
      parsed.version === 2 &&
      typeof parsed.channelId === 'string' && /^\d+$/.test(parsed.channelId) &&
      typeof parsed.messageId === 'string' && /^\d+$/.test(parsed.messageId)
    ) {
      return parsed as StatusPanelReference;
    }
  } catch {
    // Legacy deployments stored only the message snowflake.
  }
  return /^\d+$/.test(raw) && /^\d+$/.test(legacyChannelId)
    ? { version: 2, channelId: legacyChannelId, messageId: raw }
    : null;
}

function serializeStatusPanelReference(channelId: string, messageId: string): string {
  return JSON.stringify({ version: 2, channelId, messageId } satisfies StatusPanelReference);
}

function getStatusPanelTitleTokens(preferredLocale: string): string[] {
  const locales = new Set([preferredLocale, ...i18n.getAvailableLocales()]);
  return [...new Set([...locales]
    .map((locale) => i18n.t('regbattle.status_panel_title', locale).trim().toLowerCase())
    .filter((token) => token && token !== 'regbattle.status_panel_title'))];
}

function isOwnedStatusPanelMessage(
  message: Message,
  botId: string | undefined,
  titleTokens: readonly string[],
): boolean {
  return isOwnedStatusPanelMessageIdentity(message, botId, titleTokens);
}

async function deleteStatusPanelHistory(
  channel: TextChannel,
  isStatusPanelMessage: (message: Message) => boolean,
  assertLeaseOwned: () => Promise<void>,
): Promise<void> {
  let before: string | undefined;
  for (;;) {
    await assertLeaseOwned();
    const page = await channel.messages.fetch({ limit: 100, ...(before ? { before } : {}) });
    for (const message of page.values()) {
      if (!isStatusPanelMessage(message)) continue;
      await assertLeaseOwned();
      try {
        await message.delete();
      } catch (error) {
        if (!isUnknownMessageError(error)) throw error;
      }
    }
    if (page.size < 100) return;
    const oldest = page.last();
    if (!oldest || oldest.id === before) {
      throw new Error(`Status panel history pagination stalled in ${channel.id}`);
    }
    before = oldest.id;
  }
}

async function assertStatusPanelPopulation(
  guildId: string,
  expectedSnapshot: string,
  expectedConfigSnapshot: string,
  assertLeaseOwned: () => Promise<void>,
): Promise<void> {
  await assertLeaseOwned();
  const [currentSquads, currentConfig] = await Promise.all([
    getGuildSquads(guildId),
    getConfig(guildId),
  ]);
  const currentSnapshot = statusPanelSquadSnapshot(currentSquads);
  await assertLeaseOwned();
  if (
    currentSnapshot !== expectedSnapshot ||
    statusPanelConfigSnapshot(currentConfig) !== expectedConfigSnapshot
  ) {
    throw new StatusPanelPopulationConflictError(guildId);
  }
}

function scheduleStatusPanelRetry(
  guild: Guild,
  client: BublikClient,
  delayMs = 1_000,
): void {
  const dueAt = Date.now() + Math.max(1, delayMs);
  const existing = statusPanelRetryTimers.get(guild.id);
  if (!shouldReplaceStatusPanelRetry(existing?.dueAt ?? null, dueAt)) return;
  if (existing) clearTimeout(existing.timer);

  const scheduled = {} as StatusPanelRetryTimer;
  scheduled.dueAt = dueAt;
  scheduled.timer = setTimeout(() => {
    if (statusPanelRetryTimers.get(guild.id) !== scheduled) return;
    statusPanelRetryTimers.delete(guild.id);
    if (!isGuildAllowed(guild.id) || !client.guilds.cache.has(guild.id)) return;
    void getGuildSquads(guild.id).then(async (squads) => {
      if (squads.length === 0) {
        await deleteStatusPanel(guild.id, client);
      } else {
        await refreshStatusPanel(guild, client, true);
      }
    }).catch((error: unknown) => {
      log.warn(`Status panel retry failed for ${guild.id}`, { error: String(error) });
      scheduleStatusPanelRetry(guild, client, 5_000);
    });
  }, Math.max(1, dueAt - Date.now()));
  scheduled.timer.unref?.();
  statusPanelRetryTimers.set(guild.id, scheduled);
}

/** Безопасно собрать ключи по паттерну через SCAN (не блокирует Redis) */
async function scanRedisKeys(pattern: string): Promise<string[]> {
  const r = getRedis();
  const result: string[] = [];
  let cursor = '0';
  do {
    const [next, keys] = await r.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
    cursor = next;
    result.push(...keys);
  } while (cursor !== '0');
  return result;
}

async function acquireDistributedLock(key: string, ttlMs: number): Promise<string | null> {
  const token = randomUUID();
  const acquired = await getRedis().set(key, token, 'PX', ttlMs, 'NX');
  return acquired === 'OK' ? token : null;
}

async function releaseDistributedLock(key: string, token: string): Promise<void> {
  await getRedis().eval(
    'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end',
    1,
    key,
    token,
  );
}

async function renewDistributedLock(key: string, token: string, ttlMs: number): Promise<boolean> {
  const renewed = await getRedis().eval(
    'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("pexpire", KEYS[1], ARGV[2]) else return 0 end',
    1,
    key,
    token,
    String(ttlMs),
  );
  return Number(renewed) === 1;
}

async function trackOrphanChannel(guildId: string, channelId: string): Promise<void> {
  await getRedis().set(`${ORPHAN_CHANNEL_PREFIX}:${guildId}:${channelId}`, String(Date.now()));
}

async function forgetOrphanChannel(guildId: string, channelId: string): Promise<void> {
  await getRedis().del(`${ORPHAN_CHANNEL_PREFIX}:${guildId}:${channelId}`);
}

export async function deleteTrackedChannel(guild: Guild, channelId: string, reason: string): Promise<boolean> {
  await trackOrphanChannel(guild.id, channelId);
  try {
    const channel = guild.channels.cache.get(channelId) ?? await guild.channels.fetch(channelId);
    if (channel) await channel.delete(reason);
    await forgetOrphanChannel(guild.id, channelId);
    return true;
  } catch (error) {
    if (isUnknownChannelError(error)) {
      await forgetOrphanChannel(guild.id, channelId);
      return true;
    }
    log.error(`Discord-канал ${channelId} оставлен в durable cleanup queue`, {
      error: String(error),
    });
    return false;
  }
}

async function cleanupTrackedChannels(guild: Guild): Promise<void> {
  const keys = await scanRedisKeys(`${ORPHAN_CHANNEL_PREFIX}:${guild.id}:*`);
  for (const key of keys) {
    const channelId = key.slice(key.lastIndexOf(':') + 1);
    await deleteTrackedChannel(guild, channelId, 'RegBattle: recovery cleanup');
  }
}

async function fetchMemberForRecovery(
  guild: Guild,
  userId: string,
): Promise<{ member: GuildMember | null; confirmedMissing: boolean }> {
  try {
    return {
      member: await guild.members.fetch({ user: userId, force: true }),
      confirmedMissing: false,
    };
  } catch (error) {
    if (isUnknownMemberError(error)) return { member: null, confirmedMissing: true };
    throw error;
  }
}

async function hasDurablePlayedResetClaim(key: string): Promise<boolean> {
  return Boolean(await getDatabase().operationClaim.findUnique({
    where: { key },
    select: { key: true },
  }));
}

/**
 * First-deploy safety: legacy versions had no durable reset claims, so absence
 * of a historical claim cannot prove that reset was missed. Atomically install
 * a permanent sentinel and mark the currently due date as intentionally
 * skipped. Every later missing date is then a genuine catch-up candidate.
 */
async function bootstrapPlayedResetClaims(
  guildId: string,
  dueDate: string,
  dueClaimKey: string,
): Promise<boolean> {
  const sentinelKey = `regbattle:played-reset:bootstrap:${guildId}`;
  return getDatabase().$transaction(async (tx) => {
    const installed = await tx.operationClaim.createMany({
      data: [{
        key: sentinelKey,
        scope: PLAYED_RESET_BOOTSTRAP_SCOPE,
        guildId,
        metadata: { initializedAt: Date.now(), skippedDueDate: dueDate },
      }],
      skipDuplicates: true,
    });
    if (installed.count === 0) return false;
    await tx.operationClaim.createMany({
      data: [{
        key: dueClaimKey,
        scope: PLAYED_RESET_CLAIM_SCOPE,
        guildId,
        metadata: { dueDate, skippedBootstrap: true, completedAt: Date.now() },
        expiresAt: new Date(Date.now() + 180 * 24 * 60 * 60_000),
      }],
      skipDuplicates: true,
    });
    return true;
  });
}
const lastPanelUpdateAt = new Map<string, number>();
const lastPanelDedupeAt = new Map<string, number>();
const STATUS_PANEL_LOCK_TTL_MS = 5 * 60_000;
const STATUS_PANEL_LOCK_RENEW_MS = 60_000;
const STATUS_PANEL_DEDUPE_INTERVAL_MS = 5 * 60_000;

/** Проверить, отключены ли уведомления для отряда */
export async function isNotifyOff(squadId: string): Promise<boolean> {
  const val = await getRedis().get(`${NOTIFY_OFF_KEY}:${squadId}`);
  return val === '1';
}

/** Переключить уведомления для отряда */
export async function toggleNotify(squadId: string): Promise<boolean> {
  const r = getRedis();
  const key = `${NOTIFY_OFF_KEY}:${squadId}`;
  const current = await r.get(key);
  if (current === '1') {
    await r.del(key);
    return false; // notify теперь ON
  } else {
    await r.set(key, '1');
    return true; // notify теперь OFF
  }
}

/**
 * Отправить или обновить статус-панель рекрутинга в announce-канале.
 * Кратковременный дроссель: не чаще STATUS_PANEL_UPDATE_INTERVAL_MS.
 */
export async function refreshStatusPanel(
  guild: Guild,
  client: BublikClient,
  force = false,
  verifiedMembers?: Collection<string, GuildMember>,
): Promise<void> {
  const now = Date.now();
  const lastUpdate = lastPanelUpdateAt.get(guild.id) ?? 0;
  if (!force && now - lastUpdate < STATUS_PANEL_UPDATE_INTERVAL_MS) {
    scheduleStatusPanelRetry(
      guild,
      client,
      statusPanelTrailingRetryDelay(now, lastUpdate, STATUS_PANEL_UPDATE_INTERVAL_MS),
    );
    return;
  }
  lastPanelUpdateAt.set(guild.id, now);

  const r = getRedis();
  const panelLockKey = `${STATUS_PANEL_LOCK_KEY}:${guild.id}`;
  let lockToken: string | null = null;
  let lockLost = false;
  let lockRenewTimer: ReturnType<typeof setInterval> | null = null;
  let retryPopulationConflict = false;

  try {
    lockToken = await acquireDistributedLock(panelLockKey, STATUS_PANEL_LOCK_TTL_MS);
    if (!lockToken) {
      scheduleStatusPanelRetry(guild, client);
      return;
    }
    const ownedToken = lockToken;
    let renewalInFlight = false;
    lockRenewTimer = setInterval(() => {
      if (renewalInFlight || lockLost) return;
      renewalInFlight = true;
      void renewDistributedLock(panelLockKey, ownedToken, STATUS_PANEL_LOCK_TTL_MS)
        .then((renewed) => {
          if (!renewed) lockLost = true;
        })
        .catch(() => {
          lockLost = true;
        })
        .finally(() => {
          renewalInFlight = false;
        });
    }, STATUS_PANEL_LOCK_RENEW_MS);
    lockRenewTimer.unref?.();

    const assertPanelLockOwned = async (): Promise<void> => {
      let currentToken: string | null = null;
      try {
        if (!lockLost) currentToken = await r.get(panelLockKey);
      } catch {
        lockLost = true;
      }
      if (lockLost || currentToken !== ownedToken) {
        lockLost = true;
        throw new StatusPanelLeaseLostError(guild.id);
      }
    };

    const config = await getConfig(guild.id);
    if (!config?.announceChannelId) return;
    const absentResetHour = Math.max(0, Math.min(23, Number(config.playedResetHour ?? 23)));
    const absentEpoch = getDuePlayedResetDate(new Date(now), absentResetHour);

    const squads = await getGuildSquads(guild.id);
    const expectedSquadSnapshot = statusPanelSquadSnapshot(squads);
    const expectedConfigSnapshot = statusPanelConfigSnapshot(config);
    const assertPanelStateCurrent = (): Promise<void> =>
      assertStatusPanelPopulation(
        guild.id,
        expectedSquadSnapshot,
        expectedConfigSnapshot,
        assertPanelLockOwned,
      );
    if (squads.length > 0) zeroSquadCleanupCompleted.delete(guild.id);
    const locale = await getGuildLocale(guild.id);
    const panelKey = `${STATUS_PANEL_KEY}:${guild.id}`;
    const statusTitleTokens = getStatusPanelTitleTokens(locale);
    const botId = client.user?.id;

    const isStatusPanelMessage = (msg: Message): boolean =>
      isOwnedStatusPanelMessage(msg, botId, statusTitleTokens);

    // Если нет отрядов — удалить панель
    if (squads.length === 0) {
      await assertPanelStateCurrent();
      await clearAbsentTracking(guild.id, assertPanelStateCurrent);
      const reference = parseStatusPanelReference(
        await r.get(panelKey),
        config.announceChannelId,
      );
      const channelIds = new Set([config.announceChannelId]);
      if (reference) channelIds.add(reference.channelId);

      for (const channelId of channelIds) {
        let channel: TextChannel | null = null;
        try {
          const fetchedChannel = await client.channels.fetch(channelId);
          if (!fetchedChannel) continue;
          if (!isStatusPanelTextChannel(fetchedChannel, guild.id)) {
            log.warn(`Ignored unsafe status panel channel reference ${channelId} for ${guild.id}`);
            continue;
          }
          channel = fetchedChannel;
        } catch (error) {
          if (!isUnknownChannelError(error)) throw error;
        }
        if (!channel) continue;

        const referenceForChannel = reference?.channelId === channelId ? reference : null;
        if (referenceForChannel) {
          let referencedMessage: Message | null = null;
          try {
            referencedMessage = await channel.messages.fetch(referenceForChannel.messageId);
          } catch (error) {
            if (!isUnknownMessageError(error)) throw error;
          }
          if (referencedMessage && isStatusPanelMessage(referencedMessage)) {
            await assertPanelStateCurrent();
            try {
              await referencedMessage.delete();
            } catch (error) {
              if (!isUnknownMessageError(error)) throw error;
            }
          }
        }

        // Zero-squad cleanup is rare, so scan to the end instead of declaring
        // success after an arbitrary recent-message window.
        await deleteStatusPanelHistory(channel, isStatusPanelMessage, assertPanelStateCurrent);
      }

      await assertPanelStateCurrent();
      await r.del(panelKey);
      await assertPanelStateCurrent();
      zeroSquadCleanupCompleted.add(guild.id);
      return;
    }

    // Absentee classification and timer cleanup require a complete population.
    // A transient fetch failure must preserve both the previous panel and every
    // Redis timer instead of treating uncached offline members as stale.
    let members: Collection<string, GuildMember>;
    try {
      members = verifiedMembers ?? await guild.members.fetch();
    } catch (error) {
      log.warn(`Status panel ${guild.id} deferred: complete member snapshot unavailable`, {
        error: String(error),
      });
      scheduleStatusPanelRetry(guild, client, 5_000);
      return;
    }

    // Собрать данные для панели
    const squadInfos: StatusPanelSquad[] = [];
    for (const sq of squads) {
      const members = getSquadMembers(guild, sq.voiceChannelId, sq.airChannelId);
      const notifyOff = await isNotifyOff(sq.id);
      squadInfos.push({
        number: sq.number,
        count: members.length,
        size: config.squadSize,
        voiceChannelId: sq.voiceChannelId,
        ownerTag: guild.members.cache.get(sq.ownerId)?.user.tag ?? '???',
        members: members.map((m) => ({ id: m.id, displayName: m.displayName })),
        notifyOff,
      });
    }

    // Отсутствующие: имеют pingRole, не в ПБ-войсе, не играли сегодня
    // Таймер: накопительный. Онлайн → тикает. Оффлайн → пауза. Полночь МСК → сброс.
    const onlineIgnoring: StatusPanelAbsentee[] = [];
    const offlineAbsent: { id: string; displayName: string }[] = [];
    let onlineKosherCount = 0;
    let totalKosherCount = 0;
    if (config.pingRoleId) {
      const role = guild.roles.cache.get(config.pingRoleId);
      if (role) {
        const roleMembers = members.filter((member) =>
          member.roles.cache.has(config.pingRoleId));
        let eligibility: PbPingEligibilitySnapshot;
        try {
          eligibility = await loadPbPingEligibilitySnapshot(
            guild.id,
            [...roleMembers.keys()],
          );
        } catch (error) {
          // Never publish/track a partial absentee population while vacation
          // state is unavailable; the previous verified panel remains intact.
          log.warn(`Status panel ${guild.id} deferred: vacation snapshot unavailable`, {
            error: String(error),
          });
          scheduleStatusPanelRetry(guild, client, 5_000);
          return;
        }

        // Подготовить ПБ channel IDs
        const pbChannelIds = new Set<string>();
        for (const sq of squads) {
          pbChannelIds.add(sq.voiceChannelId);
          if (sq.airChannelId) pbChannelIds.add(sq.airChannelId);
        }
        if (config.reserveChannelId) pbChannelIds.add(config.reserveChannelId);

        // Собрать текущих кошерных: кто онлайн-игнорирует, кто оффлайн, кто в бою
        const onlineAbsentMap = new Map<string, GuildMember>();
        roleMembers.forEach((m) => {
          if (m.user.bot) return;
          if (isPbVacationExcluded(pbPingCandidateFromMember(m), eligibility)) return;
          totalKosherCount++;
          // В ПБ-войсе → в бою, не отсутствующий
          if (m.voice.channelId && pbChannelIds.has(m.voice.channelId)) return;
          const isOnline = m.presence?.status != null && m.presence.status !== 'offline';
          if (isOnline) onlineKosherCount++;
          // Пропустить тех, кто играл сегодня
          if (config.playedTodayRoleId && m.roles.cache.has(config.playedTodayRoleId)) return;

          if (isOnline) {
            onlineAbsentMap.set(m.id, m);
          } else {
            offlineAbsent.push({ id: m.id, displayName: m.displayName });
          }
        });

        await assertPanelStateCurrent();

        // Таймеры онлайн-игнорирующих через Redis (накопительные с паузой)
        const onlineAbsentIds = [...onlineAbsentMap.keys()];
        if (onlineAbsentIds.length > 0) {
          const absentKeys = onlineAbsentIds.map((id) => `${ABSENT_TRACK_KEY}:${guild.id}:${id}`);
          const existing = await r.mget(...absentKeys);

          const pipeline = r.pipeline();
          for (let i = 0; i < onlineAbsentIds.length; i++) {
            const userId = onlineAbsentIds[i];
            const raw = existing[i];
            let acc = 0;
            let onAt: number | null = null;

            if (raw) {
              try {
                const parsed = parseStatusPanelAbsentState(raw, now, absentEpoch);
                acc = parsed.acc ?? 0;
                onAt = parsed.onAt ?? null;
              } catch {
                // Миграция со старого формата (plain timestamp)
                const ts = Number(raw);
                if (!isNaN(ts) && ts > 0) acc = now - ts;
              }
            }

            // Если ранее был оффлайн (onAt=null), запустить таймер заново
            if (onAt === null) onAt = now;
            // Обновить в Redis
            pipeline.set(absentKeys[i], JSON.stringify({ epoch: absentEpoch, acc, onAt }));

            const totalMs = acc + (now - onAt);
            const minutesIgnoring = totalMs / 60_000;
            const m = onlineAbsentMap.get(userId)!;
            onlineIgnoring.push({
              id: userId,
              displayName: m.displayName,
              minutesIgnoring,
              redZone: totalMs >= RED_ZONE_THRESHOLD_MS,
              online: true,
            });
          }
          await assertPanelStateCurrent();
          let replies: unknown;
          try {
            replies = await pipeline.exec();
          } catch (error) {
            throw new StatusPanelPipelineError(
              `Status panel Redis pipeline rejected: ${String(error)}`,
            );
          }
          assertStatusPanelPipelineSucceeded(replies, onlineAbsentIds.length);
          await assertPanelStateCurrent();
        }

        // Оффлайн-участники: поставить таймер на паузу (onAt → null, сохранить acc)
        if (offlineAbsent.length > 0) {
          const offKeys = offlineAbsent.map((a) => `${ABSENT_TRACK_KEY}:${guild.id}:${a.id}`);
          const offExisting = await r.mget(...offKeys);
          const pipeline = r.pipeline();
          let queuedCommands = 0;
          for (let i = 0; i < offlineAbsent.length; i++) {
            const raw = offExisting[i];
            if (!raw) continue; // Нет записи → не трогаем, пока не появится онлайн
            try {
              const parsed = parseStatusPanelAbsentState(raw, now, absentEpoch);
              if (parsed.onAt !== null) {
                // Был онлайн → ушёл в оффлайн: зафиксировать накопленное
                const newAcc = (parsed.acc ?? 0) + (now - (parsed.onAt ?? now));
                pipeline.set(offKeys[i], JSON.stringify({ epoch: absentEpoch, acc: newAcc, onAt: null }));
                queuedCommands++;
              } else {
                pipeline.set(offKeys[i], JSON.stringify({ epoch: absentEpoch, acc: parsed.acc, onAt: null }));
                queuedCommands++;
              }
            } catch { /* миграция: удалить старый формат */ pipeline.del(offKeys[i]); }
          }
          // Exactly one SET/DEL is queued for every existing value, including
          // the defensive parser catch above.
          queuedCommands = offExisting.reduce((count, raw) => count + (raw ? 1 : 0), 0);
          if (queuedCommands > 0) {
            await assertPanelStateCurrent();
            let replies: unknown;
            try {
              replies = await pipeline.exec();
            } catch (error) {
              throw new StatusPanelPipelineError(
                `Status panel Redis pipeline rejected: ${String(error)}`,
              );
            }
            assertStatusPanelPipelineSucceeded(replies, queuedCommands);
            await assertPanelStateCurrent();
          }
        }

        // Очистить устаревшие ключи absent-трекинга (участники, которых нет ни в одной категории)
        const allAbsentKeys = await scanRedisKeys(`${ABSENT_TRACK_KEY}:${guild.id}:*`);
        const currentAbsentSet = new Set([...onlineAbsentIds, ...offlineAbsent.map((a) => a.id)]);
        const staleKeys = allAbsentKeys.filter((k) => !currentAbsentSet.has(k.split(':').pop()!));
        if (staleKeys.length > 0) {
          await assertPanelStateCurrent();
          await r.del(...staleKeys);
          await assertPanelStateCurrent();
        }

        // Сортировка: красная зона первыми, потом по времени
        onlineIgnoring.sort((a, b) => {
          if (a.redZone !== b.redZone) return a.redZone ? -1 : 1;
          return b.minutesIgnoring - a.minutesIgnoring;
        });
      }
    }

    // Играли сегодня
    const playedToday: { id: string; displayName: string }[] = [];
    if (config.playedTodayRoleId) {
      members
        .filter((member) => member.roles.cache.has(config.playedTodayRoleId))
        .forEach((m) => {
          if (!m.user.bot) {
            playedToday.push({ id: m.id, displayName: m.displayName });
          }
        });
    }

    const { embed, row } = buildStatusPanelEmbed(squadInfos, onlineIgnoring, playedToday, offlineAbsent, locale, onlineKosherCount, totalKosherCount);

    // Отправить или обновить
    await assertPanelStateCurrent();
    const fetchedAnnounceChannel = await client.channels.fetch(config.announceChannelId);
    if (!isStatusPanelTextChannel(fetchedAnnounceChannel, guild.id)) {
      throw new Error(`Status panel announce channel ${config.announceChannelId} is unavailable or not GuildText in ${guild.id}`);
    }
    const ch = fetchedAnnounceChannel;

    let reference = parseStatusPanelReference(await r.get(panelKey), config.announceChannelId);
    if (reference && reference.channelId !== config.announceChannelId) {
      let oldChannel: TextChannel | null = null;
      try {
        const fetchedOldChannel = await client.channels.fetch(reference.channelId);
        if (!fetchedOldChannel) {
          oldChannel = null;
        } else if (!isStatusPanelTextChannel(fetchedOldChannel, guild.id)) {
          log.warn(`Ignored unsafe old status panel channel reference ${reference.channelId} for ${guild.id}`);
        } else {
          oldChannel = fetchedOldChannel;
        }
      } catch (error) {
        if (!isUnknownChannelError(error)) throw error;
      }
      if (oldChannel) {
        let oldMessage: Message | null = null;
        try {
          oldMessage = await oldChannel.messages.fetch(reference.messageId);
        } catch (error) {
          if (!isUnknownMessageError(error)) throw error;
        }
        if (oldMessage && isStatusPanelMessage(oldMessage)) {
          await assertPanelStateCurrent();
          try {
            await oldMessage.delete();
          } catch (error) {
            if (!isUnknownMessageError(error)) throw error;
          }
        }
        await deleteStatusPanelHistory(oldChannel, isStatusPanelMessage, assertPanelStateCurrent);
      }
      await assertPanelStateCurrent();
      await r.del(panelKey);
      await assertPanelStateCurrent();
      reference = null;
    }

    if (reference) {
      let msg: Message | null = null;
      try {
        msg = await ch.messages.fetch(reference.messageId);
      } catch (error) {
        if (!isUnknownMessageError(error)) throw error;
      }
      if (msg && !isStatusPanelMessage(msg)) {
        // A corrupted/stale reference must never authorise editing or deleting
        // an unrelated message. Drop only the Redis pointer and rediscover an
        // owned panel below.
        await assertPanelStateCurrent();
        await r.del(panelKey);
        await assertPanelStateCurrent();
        reference = null;
        msg = null;
      }
      if (msg) {
        await assertPanelStateCurrent();
        await msg.edit({ embeds: [embed], components: [row] });
        await assertPanelStateCurrent();
        await r.set(panelKey, serializeStatusPanelReference(ch.id, msg.id));
        await assertPanelStateCurrent();

        // Периодически чистим дубли (не чаще раз в 5 минут)
        const lastDedupe = lastPanelDedupeAt.get(guild.id) ?? 0;
        if (now - lastDedupe >= STATUS_PANEL_DEDUPE_INTERVAL_MS) {
          const recent = await ch.messages.fetch({ limit: 50 });
          const duplicates = [...recent.values()].filter((m) => m.id !== msg.id && isStatusPanelMessage(m));
          for (const duplicate of duplicates) {
            await assertPanelStateCurrent();
            try {
              await duplicate.delete();
            } catch (error) {
              if (!isUnknownMessageError(error)) throw error;
            }
          }
          await assertPanelStateCurrent();
          lastPanelDedupeAt.set(guild.id, now);
        }

        return;
      }
      // Сообщение не найдено → отправить новое
    }

    // Ключ мог протухнуть/сбиться — попробуем найти существующую панель и реанимировать её
    const recent = await ch.messages.fetch({ limit: 50 });
    const candidates = [...recent.values()].filter(isStatusPanelMessage);
    if (candidates.length > 0) {
      candidates.sort((a, b) => b.createdTimestamp - a.createdTimestamp);
      const primary = candidates[0];
      await assertPanelStateCurrent();
      await primary.edit({ embeds: [embed], components: [row] });
      await assertPanelStateCurrent();
      await r.set(panelKey, serializeStatusPanelReference(ch.id, primary.id));
      await assertPanelStateCurrent();

      for (let i = 1; i < candidates.length; i++) {
        await assertPanelStateCurrent();
        try {
          await candidates[i].delete();
        } catch (error) {
          if (!isUnknownMessageError(error)) throw error;
        }
      }
      await assertPanelStateCurrent();
      lastPanelDedupeAt.set(guild.id, now);
      return;
    }

    // Отправить новую панель
    await assertPanelStateCurrent();
    const sent = await ch.send({ embeds: [embed], components: [row] });
    await assertPanelStateCurrent();
    await r.set(panelKey, serializeStatusPanelReference(ch.id, sent.id));
    await assertPanelStateCurrent();
    lastPanelDedupeAt.set(guild.id, now);
  } catch (err) {
    if (
      err instanceof StatusPanelPopulationConflictError ||
      err instanceof StatusPanelLeaseLostError ||
      err instanceof StatusPanelPipelineError
    ) {
      retryPopulationConflict = true;
      log.debug(err.message);
      return;
    }
    log.error('Ошибка обновления статус-панели', { error: String(err) });
  } finally {
    if (lockRenewTimer) clearInterval(lockRenewTimer);
    if (lockToken) await releaseDistributedLock(panelLockKey, lockToken).catch(() => null);
    if (retryPopulationConflict) scheduleStatusPanelRetry(guild, client);
  }
}

/** Удалить статус-панель (при расформировании последнего отряда) */
async function deleteStatusPanel(guildId: string, client: BublikClient): Promise<void> {
  const panelLockKey = `${STATUS_PANEL_LOCK_KEY}:${guildId}`;
  let lockToken: string | null = null;
  let lockLost = false;
  let lockRenewTimer: ReturnType<typeof setInterval> | null = null;
  let retryPopulationConflict = false;

  try {
    const r = getRedis();
    lockToken = await acquireDistributedLock(panelLockKey, STATUS_PANEL_LOCK_TTL_MS);
    if (!lockToken) {
      const guild = client.guilds.cache.get(guildId);
      if (guild) scheduleStatusPanelRetry(guild, client);
      return;
    }
    const ownedToken = lockToken;
    let renewalInFlight = false;
    lockRenewTimer = setInterval(() => {
      if (renewalInFlight || lockLost) return;
      renewalInFlight = true;
      void renewDistributedLock(panelLockKey, ownedToken, STATUS_PANEL_LOCK_TTL_MS)
        .then((renewed) => {
          if (!renewed) lockLost = true;
        })
        .catch(() => {
          lockLost = true;
        })
        .finally(() => {
          renewalInFlight = false;
        });
    }, STATUS_PANEL_LOCK_RENEW_MS);
    lockRenewTimer.unref?.();

    const assertPanelLockOwned = async (): Promise<void> => {
      let currentToken: string | null = null;
      try {
        if (!lockLost) currentToken = await r.get(panelLockKey);
      } catch {
        lockLost = true;
      }
      if (lockLost || currentToken !== ownedToken) {
        lockLost = true;
        throw new StatusPanelLeaseLostError(guildId);
      }
    };

    const [squads, config] = await Promise.all([
      getGuildSquads(guildId),
      getConfig(guildId),
    ]);
    const expectedSquadSnapshot = statusPanelSquadSnapshot(squads);
    const expectedConfigSnapshot = statusPanelConfigSnapshot(config);
    const assertPanelStateCurrent = (): Promise<void> =>
      assertStatusPanelPopulation(
        guildId,
        expectedSquadSnapshot,
        expectedConfigSnapshot,
        assertPanelLockOwned,
      );
    if (squads.length > 0) {
      zeroSquadCleanupCompleted.delete(guildId);
      return;
    }

    const panelKey = `${STATUS_PANEL_KEY}:${guildId}`;
    // Absence accounting is a data invariant and must never depend on Discord
    // channel/message availability.
    await assertPanelStateCurrent();
    await clearAbsentTracking(guildId, assertPanelStateCurrent);
    await assertPanelStateCurrent();

    const rawReference = await r.get(panelKey);
    let reference = parseStatusPanelReference(
      rawReference,
      config?.announceChannelId ?? '',
    );
    if (rawReference && !reference) {
      await assertPanelStateCurrent();
      const quarantined = Number(await r.eval(
        `if redis.call("get", KEYS[1]) ~= ARGV[1] then return -1 end
         if redis.call("get", KEYS[2]) ~= ARGV[2] then return 0 end
         redis.call("set", KEYS[3], ARGV[3])
         redis.call("del", KEYS[2])
         return 1`,
        3,
        panelLockKey,
        panelKey,
        `${STATUS_PANEL_INVALID_KEY}:${guildId}`,
        ownedToken,
        rawReference,
        JSON.stringify({ raw: rawReference, quarantinedAt: Date.now() }),
      ));
      await assertPanelStateCurrent();
      if (quarantined !== 1) throw new StatusPanelLeaseLostError(guildId);
      log.warn(`Quarantined invalid status panel reference for ${guildId}`);
      reference = null;
    }

    const locale = await getGuildLocale(guildId);
    const titleTokens = getStatusPanelTitleTokens(locale);
    const botId = client.user?.id;
    const isStatusPanelMessage = (message: Message): boolean =>
      isOwnedStatusPanelMessage(message, botId, titleTokens);

    const channelIds = new Set<string>();
    if (config?.announceChannelId) channelIds.add(config.announceChannelId);
    if (reference) channelIds.add(reference.channelId);
    for (const channelId of channelIds) {
      let channel: TextChannel | null = null;
      try {
        const fetchedChannel = await client.channels.fetch(channelId);
        if (!fetchedChannel) continue;
        if (!isStatusPanelTextChannel(fetchedChannel, guildId)) {
          log.warn(`Ignored unsafe status panel cleanup channel reference ${channelId} for ${guildId}`);
          continue;
        }
        channel = fetchedChannel;
      } catch (error) {
        if (!isUnknownChannelError(error)) throw error;
      }
      if (!channel) continue;

      const referenceForChannel = reference?.channelId === channelId ? reference : null;
      if (referenceForChannel) {
        let referencedMessage: Message | null = null;
        try {
          referencedMessage = await channel.messages.fetch(referenceForChannel.messageId);
        } catch (error) {
          if (!isUnknownMessageError(error)) throw error;
        }
        if (referencedMessage && isStatusPanelMessage(referencedMessage)) {
          await assertPanelStateCurrent();
          try {
            await referencedMessage.delete();
          } catch (error) {
            if (!isUnknownMessageError(error)) throw error;
          }
        }
      }

      await deleteStatusPanelHistory(channel, isStatusPanelMessage, assertPanelStateCurrent);
    }

    await assertPanelStateCurrent();
    await r.del(panelKey);
    await assertPanelStateCurrent();
    zeroSquadCleanupCompleted.add(guildId);

  } catch (error) {
    zeroSquadCleanupCompleted.delete(guildId);
    if (
      error instanceof StatusPanelPopulationConflictError ||
      error instanceof StatusPanelLeaseLostError
    ) {
      retryPopulationConflict = true;
      log.debug(error.message);
    } else {
      log.warn(`Status panel cleanup deferred for ${guildId}`, { error: String(error) });
    }
  } finally {
    if (lockRenewTimer) clearInterval(lockRenewTimer);
    if (lockToken) await releaseDistributedLock(panelLockKey, lockToken).catch(() => null);
    if (retryPopulationConflict) {
      const guild = client.guilds.cache.get(guildId);
      if (guild) scheduleStatusPanelRetry(guild, client);
    }
  }
}

/** Сбросить все таймеры отсутствующих для гильдии (полночь МСК) */
export async function clearAbsentTracking(
  guildId: string,
  assertLeaseOwned?: () => Promise<void>,
): Promise<void> {
  const r = getRedis();
  const keys = await scanRedisKeys(`${ABSENT_TRACK_KEY}:${guildId}:*`);
  if (keys.length > 0) {
    await assertLeaseOwned?.();
    await r.del(...keys);
    await assertLeaseOwned?.();
  }
}

/**
 * Daily reset shares the same lease as every absentee writer. It purges only
 * legacy/corrupt/older-epoch values: a refresh may already have accumulated
 * legitimate time after the current reset boundary. The Lua compare-and-delete
 * also prevents a stale owner from deleting a newer value.
 */
async function purgeStaleAbsentTrackingExclusively(
  guildId: string,
  currentEpoch: string,
): Promise<void> {
  const r = getRedis();
  const panelLockKey = `${STATUS_PANEL_LOCK_KEY}:${guildId}`;
  const token = await acquireDistributedLock(panelLockKey, STATUS_PANEL_LOCK_TTL_MS);
  if (!token) throw new Error(`Status panel lease is busy during absentee reset for ${guildId}`);

  let lockLost = false;
  let renewalInFlight = false;
  const renewTimer = setInterval(() => {
    if (renewalInFlight || lockLost) return;
    renewalInFlight = true;
    void renewDistributedLock(panelLockKey, token, STATUS_PANEL_LOCK_TTL_MS)
      .then((renewed) => {
        if (!renewed) lockLost = true;
      })
      .catch(() => {
        lockLost = true;
      })
      .finally(() => {
        renewalInFlight = false;
      });
  }, STATUS_PANEL_LOCK_RENEW_MS);
  renewTimer.unref?.();

  const assertLeaseOwned = async (): Promise<void> => {
    let currentToken: string | null = null;
    try {
      if (!lockLost) currentToken = await r.get(panelLockKey);
    } catch {
      lockLost = true;
    }
    if (lockLost || currentToken !== token) {
      lockLost = true;
      throw new StatusPanelLeaseLostError(guildId);
    }
  };

  try {
    await assertLeaseOwned();
    const keys = await scanRedisKeys(`${ABSENT_TRACK_KEY}:${guildId}:*`);
    for (let offset = 0; offset < keys.length; offset += 200) {
      const chunk = keys.slice(offset, offset + 200);
      await assertLeaseOwned();
      const values = await r.mget(...chunk);
      await assertLeaseOwned();

      const candidates: Array<{ key: string; raw: string }> = [];
      for (let index = 0; index < chunk.length; index++) {
        const raw = values[index];
        if (raw !== null && shouldPurgeStatusPanelAbsentState(raw, currentEpoch)) {
          candidates.push({ key: chunk[index], raw });
        }
      }
      if (candidates.length === 0) continue;

      const result = Number(await r.eval(
        `if redis.call("get", KEYS[1]) ~= ARGV[1] then return -1 end
         local deleted = 0
         for i = 2, #KEYS do
           if redis.call("get", KEYS[i]) == ARGV[i] then
             deleted = deleted + redis.call("del", KEYS[i])
           end
         end
         return deleted`,
        candidates.length + 1,
        panelLockKey,
        ...candidates.map((candidate) => candidate.key),
        token,
        ...candidates.map((candidate) => candidate.raw),
      ));
      if (result < 0) throw new StatusPanelLeaseLostError(guildId);
      await assertLeaseOwned();
    }
    await assertLeaseOwned();
  } finally {
    clearInterval(renewTimer);
    await releaseDistributedLock(panelLockKey, token).catch(() => null);
  }
}

/**
 * Собрать данные для ephemeral-кнопок статус-панели.
 * Вызывается из handlers при нажатии кнопок sp_ignoring / sp_played / sp_offline.
 */
export async function getStatusPanelData(guild: Guild, _client: BublikClient): Promise<{
  onlineIgnoring: StatusPanelAbsentee[];
  offlineAbsent: { id: string; displayName: string }[];
  playedToday: { id: string; displayName: string }[];
}> {
  const config = await getConfig(guild.id);
  const now = Date.now();
  const r = getRedis();

  const onlineIgnoring: StatusPanelAbsentee[] = [];
  const offlineAbsent: { id: string; displayName: string }[] = [];
  const playedToday: { id: string; displayName: string }[] = [];

  if (!config) return { onlineIgnoring, offlineAbsent, playedToday };
  const absentResetHour = Math.max(0, Math.min(23, Number(config.playedResetHour ?? 23)));
  const absentEpoch = getDuePlayedResetDate(new Date(now), absentResetHour);

  const squads = await getGuildSquads(guild.id);
  if (squads.length === 0) {
    return { onlineIgnoring, offlineAbsent, playedToday };
  }

  // Detail buttons must use the same complete, fail-closed population as the
  // persistent panel. A partial cache is never presented as authoritative.
  const members = await guild.members.fetch();

  if (config.pingRoleId) {
    const role = await guild.roles.fetch(config.pingRoleId, { force: true });
    if (role) {
      const pbChannelIds = new Set<string>();
      for (const sq of squads) {
        pbChannelIds.add(sq.voiceChannelId);
        if (sq.airChannelId) pbChannelIds.add(sq.airChannelId);
      }
      if (config.reserveChannelId) pbChannelIds.add(config.reserveChannelId);

      const roleMembers = members.filter((member) =>
        member.roles.cache.has(config.pingRoleId));
      const eligibility = await loadPbPingEligibilitySnapshot(
        guild.id,
        [...roleMembers.keys()],
      );

      const onlineAbsentIds: string[] = [];
      roleMembers.forEach((m) => {
        if (m.user.bot) return;
        if (isPbVacationExcluded(pbPingCandidateFromMember(m), eligibility)) return;
        if (m.voice.channelId && pbChannelIds.has(m.voice.channelId)) return;
        const isOnline = m.presence?.status != null && m.presence.status !== 'offline';
        if (config.playedTodayRoleId && m.roles.cache.has(config.playedTodayRoleId)) return;
        if (isOnline) {
          onlineAbsentIds.push(m.id);
        } else {
          offlineAbsent.push({ id: m.id, displayName: m.displayName });
        }
      });

      if (onlineAbsentIds.length > 0) {
        const absentKeys = onlineAbsentIds.map((id) => `${ABSENT_TRACK_KEY}:${guild.id}:${id}`);
        const existing = await r.mget(...absentKeys);
        for (let i = 0; i < onlineAbsentIds.length; i++) {
          const userId = onlineAbsentIds[i];
          const m = members.get(userId);
          if (!m) continue;
          let totalMs = 0;
          const raw = existing[i];
          if (raw) {
            try {
              const parsed = parseStatusPanelAbsentState(raw, now, absentEpoch);
              totalMs = (parsed.acc ?? 0) + (parsed.onAt ? now - parsed.onAt : 0);
            } catch {
              const ts = Number(raw);
              if (!isNaN(ts) && ts > 0) totalMs = now - ts;
            }
          }
          onlineIgnoring.push({
            id: userId,
            displayName: m.displayName,
            minutesIgnoring: totalMs / 60_000,
            redZone: totalMs >= RED_ZONE_THRESHOLD_MS,
            online: true,
          });
        }
        onlineIgnoring.sort((a, b) => {
          if (a.redZone !== b.redZone) return a.redZone ? -1 : 1;
          return b.minutesIgnoring - a.minutesIgnoring;
        });
      }
    }
  }

  if (config.playedTodayRoleId) {
    members
      .filter((member) => member.roles.cache.has(config.playedTodayRoleId))
      .forEach((m) => {
        if (!m.user.bot) playedToday.push({ id: m.id, displayName: m.displayName });
      });
  }

  return { onlineIgnoring, offlineAbsent, playedToday };
}

interface PbLocation {
  kind: 'none' | PbChannelKind;
  channelId: string | null;
  squad: any | null;
  squadVoiceId: string | null;
  team: { teamId: string; teamRoleId: string; teamName: string } | null;
}

class StalePbVoiceTransitionError extends Error {
  constructor(guildId: string, userId: string, expected: string | null, actual: string | null) {
    super(`PB voice transition became stale for ${guildId}:${userId} (${expected ?? 'none'} -> ${actual ?? 'none'})`);
    this.name = 'StalePbVoiceTransitionError';
  }
}

function createPbVoiceFence(member: GuildMember, expectedChannelId: string | null): () => void {
  return () => {
    const actualChannelId = member.voice.channelId;
    if (actualChannelId !== expectedChannelId) {
      throw new StalePbVoiceTransitionError(
        member.guild.id,
        member.id,
        expectedChannelId,
        actualChannelId,
      );
    }
  };
}

function isActivePbLocation(location: PbLocation): boolean {
  return location.kind === 'reserve' || location.kind === 'regular' ||
    location.kind === 'team' || location.kind === 'air';
}

async function resolvePbLocation(
  channelId: string | null,
  config: any,
  client: BublikClient,
): Promise<PbLocation> {
  if (!channelId) return { kind: 'none', channelId: null, squad: null, squadVoiceId: null, team: null };
  if (config.masterChannelId && channelId === config.masterChannelId) {
    return { kind: 'master', channelId, squad: null, squadVoiceId: null, team: null };
  }
  if (config.reserveChannelId && channelId === config.reserveChannelId) {
    return { kind: 'reserve', channelId, squad: null, squadVoiceId: null, team: null };
  }

  const squad = await getSquadByAnyVoice(channelId);
  if (!squad || squad.guildId !== config.guildId) {
    return { kind: 'none', channelId, squad: null, squadVoiceId: null, team: null };
  }
  const tv = await getTeamsVoice(client);
  // Without an active Teams generation we cannot prove that a persisted squad
  // is public. Disable squad role rotation until Teams is restored.
  if (!tv) {
    throw new Error('Teams voice integration is unavailable for PB squad classification');
  }
  const team = await tv.resolveTeamSquad(squad.voiceChannelId, squad.guildId);
  const isAir = Boolean(squad.airChannelId && channelId === squad.airChannelId);
  return {
    kind: isAir ? 'air' : team ? 'team' : 'regular',
    channelId,
    squad,
    squadVoiceId: squad.voiceChannelId,
    team,
  };
}

function uniqueRoleIds(ids: Array<string | null | undefined>): string[] {
  return [...new Set(ids.filter((id): id is string => Boolean(id)))];
}

async function buildEligibleSession(
  member: GuildMember,
  location: PbLocation,
  config: any,
): Promise<PbVoiceSession | null> {
  if (!isActivePbLocation(location) || !location.channelId) return null;
  if (await isPbRoleMutationSuppressed(member)) return null;
  const hasPing = Boolean(config.pingRoleId && member.roles.cache.has(config.pingRoleId));
  const hasPlayed = Boolean(config.playedTodayRoleId && member.roles.cache.has(config.playedTodayRoleId));
  // Team membership, an exact invite, squad ownership or commander capability
  // may authorise voice access, but can never manufacture role provenance.
  if (!hasPbRoleProvenance(hasPing, hasPlayed)) return null;
  const inheritedPlayedOrigin = hasPlayed ? await getPlayedOrigin(member.guild.id, member.id) : null;
  const tv = await getTeamsVoice(member.client as BublikClient);

  let source: PbVoiceSession['source'] = 'none';
  let eligibilityRoleId: string | null = null;
  let teamId: string | null = null;
  let inviteSquadVoiceId: string | null = null;
  let returnRoleIds: string[] = [];

  if (location.team && tv && await tv.isCurrentTeamMember(member.id, location.team.teamId, member.guild.id)) {
    source = 'team';
    teamId = location.team.teamId;
    eligibilityRoleId = location.team.teamRoleId;
    returnRoleIds = buildTeamSessionReturnRoleIds(
      location.team.teamRoleId,
      member.roles.cache.has(location.team.teamRoleId),
      config.playedTodayRoleId,
      hasPlayed,
      config.pingRoleId,
      hasPing,
    );
  } else if (location.team) {
    // A team squad is private: generic ping/played or membership in another
    // team is not enough. An exact, unexpired voice invite is required.
    if (location.squadVoiceId && tv && await tv.hasVoiceInvite(location.squadVoiceId, member.id)) {
      source = 'invite';
      inviteSquadVoiceId = location.squadVoiceId;
      returnRoleIds = uniqueRoleIds([
        hasPlayed ? config.playedTodayRoleId : null,
        hasPing ? config.pingRoleId : null,
      ]);
    }
  } else if (hasPlayed) {
    // Prefer played when broken legacy state contains both; short leave cannot
    // downgrade played -> ping.
    source = 'played';
    eligibilityRoleId = config.playedTodayRoleId;
    returnRoleIds = uniqueRoleIds([config.playedTodayRoleId, hasPing ? config.pingRoleId : null]);
  } else if (hasPing) {
    source = 'ping';
    eligibilityRoleId = config.pingRoleId;
    returnRoleIds = [config.pingRoleId];
  } else if (location.squadVoiceId && tv && await tv.hasVoiceInvite(location.squadVoiceId, member.id)) {
    source = 'invite';
    inviteSquadVoiceId = location.squadVoiceId;
  } else if (tv && !location.team) {
    const memberTeam = await tv.getMemberTeamEligibility(member.id, member.guild.id);
    if (memberTeam) {
      source = 'team';
      teamId = memberTeam.teamId;
      eligibilityRoleId = memberTeam.teamRoleId;
      returnRoleIds = buildTeamSessionReturnRoleIds(
        memberTeam.teamRoleId,
        member.roles.cache.has(memberTeam.teamRoleId),
        config.playedTodayRoleId,
        hasPlayed,
        config.pingRoleId,
        hasPing,
      );
    }
  }

  if (source === 'none') {
    const mayUseCommander = mayUsePbCommanderFallback(
      Boolean(location.team),
      location.squad?.ownerId === member.id,
      config.commanderRoleIds,
      new Set(member.roles.cache.keys()),
    );
    if (mayUseCommander) {
      source = 'commander';
      returnRoleIds = uniqueRoleIds([
        hasPlayed ? config.playedTodayRoleId : null,
        hasPing ? config.pingRoleId : null,
      ]);
    }
  }
  if (source === 'none') return null;

  return {
    version: 2,
    hadPingRole: hasPing,
    hadPlayedRole: hasPlayed,
    guildId: member.guild.id,
    userId: member.id,
    joinedAt: Date.now(),
    source,
    status: 'active',
    currentChannelId: location.channelId,
    currentChannelKind: location.kind as PbChannelKind,
    squadId: location.squad?.id ?? null,
    squadVoiceId: location.squadVoiceId,
    teamId,
    returnRoleIds,
    eligibilityRoleId,
    inviteSquadVoiceId,
    inSquadRoleId: config.inSquadRoleId ?? null,
    pingRoleId: config.pingRoleId ?? null,
    playedTodayRoleId: config.playedTodayRoleId ?? null,
    playedMinMinutes: config.playedMinMinutes ?? 15,
    playedResetRoleIds: buildPlayedResetRoleIds(inheritedPlayedOrigin),
  };
}

async function startPbSession(
  member: GuildMember,
  location: PbLocation,
  config: any,
  lock: MemberRoleLock,
  assertCurrentVoice?: () => void,
): Promise<PbVoiceSession | null> {
  if (!config.inSquadRoleId) {
    log.warn(`PB-сессия для ${member.user.tag} не начата: inSquadRole не настроена`);
    return null;
  }
  if (await hasPbVoiceStateQuarantine(member.guild.id, member.id)) {
    await lock.assertOwned();
    assertCurrentVoice?.();
    log.warn(`PB-сессия для ${member.user.tag} не начата: provenance находится в quarantine`);
    return null;
  }
  const session = await buildEligibleSession(member, location, config);
  if (!session) {
    log.debug(`PB роли не изменены для ${member.user.tag}: нет подтверждённой eligibility`);
    return null;
  }
  // Persist first. A Redis failure must leave Discord untouched.
  await lock.assertOwned();
  assertCurrentVoice?.();
  await saveVoiceSession(session, lock);
  await lock.assertOwned();
  assertCurrentVoice?.();
  await applySessionRoles(member, session, session.inSquadRoleId, lock, assertCurrentVoice);
  log.info(`PB-сессия начата: ${member.user.tag}, source=${session.source}, channel=${session.currentChannelKind}`);
  return session;
}

async function teamMembershipStillValid(member: GuildMember, session: PbVoiceSession): Promise<boolean> {
  if (session.source !== 'team' || !session.teamId) return true;
  const tv = await getTeamsVoice(member.client as BublikClient);
  return Boolean(tv && await tv.isCurrentTeamMember(member.id, session.teamId, member.guild.id));
}

/** Finish the exact persisted rotation. Failed mutations remain retryable. */
async function finishPbSessionLocked(
  member: GuildMember,
  config: any,
  forceAwardPlayed: boolean | undefined,
  lock: MemberRoleLock,
  assertCurrentVoice?: () => void,
): Promise<boolean> {
  await lock.assertOwned();
  assertCurrentVoice?.();
  let session = await getVoiceSession(member.guild.id, member.id);
  await lock.assertOwned();
  assertCurrentVoice?.();
  if (!session) return false;

  const now = session.endedAt ?? Date.now();
  const minutesPlayed = Math.max(0, now - session.joinedAt) / 60_000;
  const minRequired = session.playedMinMinutes ?? config.playedMinMinutes ?? 15;
  const roleSuppressed = await isPbRoleMutationSuppressed(member);
  await lock.assertOwned();
  assertCurrentVoice?.();
  const awardPlayed = roleSuppressed || session.version === 1
    ? false
    : session.status === 'ending'
      ? Boolean(session.awardPlayed)
      : (forceAwardPlayed ?? (Boolean(session.playedTodayRoleId ?? config.playedTodayRoleId) && minutesPlayed >= minRequired));

  // Membership can be revoked mid-battle. Never re-grant its Discord role.
  if (session.source === 'team' && session.eligibilityRoleId) {
    const membershipValid = await teamMembershipStillValid(member, session);
    await lock.assertOwned();
    assertCurrentVoice?.();
    if (!membershipValid) {
      const revokedRoleId = session.eligibilityRoleId;
      session = { ...session, returnRoleIds: session.returnRoleIds.filter((id) => id !== revokedRoleId) };
    }
  }

  session = { ...session, status: 'ending', endedAt: now, awardPlayed };
  assertCurrentVoice?.();
  await saveVoiceSession(session, lock);
  await lock.assertOwned();
  assertCurrentVoice?.();

  // Vacation is authoritative over PB provenance. Remove only the transient
  // in-squad capability, retain the session, and retry the exact return/award
  // after the durable vacation state becomes terminal.
  if (roleSuppressed) {
    session = suppressSessionForVacation(session);
    assertCurrentVoice?.();
    await saveVoiceSession(session, lock);
    await lock.assertOwned();
    assertCurrentVoice?.();
    const cleanupApplied = await applySessionEndRoles(member, {
      removeRoleIds: uniqueRoleIds([session.inSquadRoleId ?? config.inSquadRoleId]),
      addRoleIds: [],
      shouldMarkPlayed: false,
    }, lock, assertCurrentVoice);
    if (!cleanupApplied) return false;
    if (session.inviteSquadVoiceId) {
      const tv = await getTeamsVoice(member.client as BublikClient);
      if (tv) {
        await lock.assertOwned();
        assertCurrentVoice?.();
        await tv.cleanupVoiceInvitePerms(session.inviteSquadVoiceId, member.id, member.guild, true);
        await lock.assertOwned();
        assertCurrentVoice?.();
        session = { ...session, inviteSquadVoiceId: null };
        await saveVoiceSession(session, lock);
      }
    }
    return false;
  }

  const plan = buildSessionEndPlan(
    session,
    session.inSquadRoleId ?? config.inSquadRoleId,
    session.pingRoleId ?? config.pingRoleId,
    session.playedTodayRoleId ?? config.playedTodayRoleId,
    awardPlayed,
  );
  if (plan.shouldMarkPlayed) {
    await lock.assertOwned();
    assertCurrentVoice?.();
    await savePlayedOrigin(
      buildPlayedOrigin(session, session.pingRoleId ?? config.pingRoleId),
      lock,
    );
  }

  assertCurrentVoice?.();
  const applied = await applySessionEndRoles(member, plan, lock, assertCurrentVoice);
  if (!applied) return false;

  if (session.inviteSquadVoiceId) {
    const tv = await getTeamsVoice(member.client as BublikClient);
    if (!tv) return false;
    if (tv) {
      try {
        await lock.assertOwned();
        assertCurrentVoice?.();
        await tv.cleanupVoiceInvitePerms(session.inviteSquadVoiceId, member.id, member.guild, true);
        await lock.assertOwned();
        assertCurrentVoice?.();
      } catch (error) {
        log.warn(`PB-сессия ${session.guildId}:${session.userId} сохранена: invite permissions не очищены`, {
          error: String(error),
        });
        return false;
      }
    }
  }
  // A previous V1 ending attempt may already have written an unverified played
  // origin before crashing. Remove it before deleting the legacy session so it
  // can never manufacture a role during a later daily reset.
  if (session.version === 1) {
    await lock.assertOwned();
    assertCurrentVoice?.();
    await deleteVoiceSessionState(member.guild.id, member.id, lock);
  } else {
    await lock.assertOwned();
    assertCurrentVoice?.();
    await deleteVoiceSession(member.guild.id, member.id, lock);
  }
  log.info(`PB-сессия завершена: ${member.user.tag}, ${Math.round(minutesPlayed)} мин, played=${awardPlayed}`);
  return true;
}

/** Public recovery entry point; live voice transitions already hold this lock. */
export async function finishPbSession(
  member: GuildMember,
  config: any,
  forceAwardPlayed?: boolean,
  assertCurrentVoice?: () => void,
): Promise<boolean> {
  return withMemberRoleLock(member.guild.id, member.id, async (lock) => {
    await lock.assertOwned();
    assertCurrentVoice?.();
    return finishPbSessionLocked(member, config, forceAwardPlayed, lock, assertCurrentVoice);
  });
}

function mayCarrySession(session: PbVoiceSession, location: PbLocation): boolean {
  if (!isActivePbLocation(location)) return false;
  return canCarrySessionTo(session, {
    teamId: location.team?.teamId ?? null,
    squadVoiceId: location.squadVoiceId,
  });
}

async function reconcilePbTransition(
  member: GuildMember,
  oldLocation: PbLocation,
  newLocation: PbLocation,
  config: any,
  lock: MemberRoleLock,
): Promise<void> {
  const assertCurrentVoice = createPbVoiceFence(member, newLocation.channelId);
  await lock.assertOwned();
  assertCurrentVoice();
  if (isActivePbLocation(newLocation) && newLocation.squadVoiceId) {
    const tv = await getTeamsVoice(member.client as BublikClient);
    await lock.assertOwned();
    assertCurrentVoice();
    if (tv) {
      await tv.recordVoiceInviteOccupancy(newLocation.squadVoiceId, member.id);
      await lock.assertOwned();
      assertCurrentVoice();
    }
  }
  let session = await getVoiceSession(member.guild.id, member.id);
  await lock.assertOwned();
  assertCurrentVoice();
  // Vacation owns role state. Freeze an already-active/carryable PB session at
  // the first observed transition so time spent while away is never counted.
  const roleSuppressed = session ? await isPbRoleMutationSuppressed(member) : false;
  await lock.assertOwned();
  assertCurrentVoice();
  if (session && roleSuppressed) {
    await finishPbSessionLocked(member, config, false, lock, assertCurrentVoice);
    return;
  }
  // Legacy V1 did not prove ping/played possession. Close it without an award;
  // if an exact source role is safely restored, normal V2 eligibility may then
  // start a fresh session from authoritative current Discord state.
  if (session?.version === 1) {
    assertCurrentVoice();
    if (!(await finishPbSessionLocked(member, config, false, lock, assertCurrentVoice))) return;
    session = null;
  }
  if (session?.status === 'ending') {
    assertCurrentVoice();
    if (!(await finishPbSessionLocked(member, config, undefined, lock, assertCurrentVoice))) return;
    session = null;
  }

  if (session && isActivePbLocation(newLocation) && mayCarrySession(session, newLocation)) {
    const membershipValid = await teamMembershipStillValid(member, session);
    await lock.assertOwned();
    assertCurrentVoice();
    if (!membershipValid || !(session.inSquadRoleId ?? config.inSquadRoleId)) {
      await finishPbSessionLocked(member, config, false, lock, assertCurrentVoice);
      return;
    }
    session = {
      ...session,
      currentChannelId: newLocation.channelId!,
      currentChannelKind: newLocation.kind as PbChannelKind,
      squadId: newLocation.squad?.id ?? null,
      squadVoiceId: newLocation.squadVoiceId,
    };
    await lock.assertOwned();
    assertCurrentVoice();
    await saveVoiceSession(session, lock);
    await lock.assertOwned();
    assertCurrentVoice();
    await applySessionRoles(
      member,
      session,
      session.inSquadRoleId ?? config.inSquadRoleId,
      lock,
      assertCurrentVoice,
    );
    return;
  }

  if (session) {
    // Не перезаписываем незавершённую сессию новым provenance. При частичной
    // ошибке Discord REST старая запись остаётся в status=ending для retry.
    assertCurrentVoice();
    if (!(await finishPbSessionLocked(member, config, undefined, lock, assertCurrentVoice))) return;
  }
  if (isActivePbLocation(newLocation)) {
    const started = await startPbSession(member, newLocation, config, lock, assertCurrentVoice);
    if (started) return;
  } else if (isActivePbLocation(oldLocation)) {
    log.debug(`PB transition without session: ${member.user.tag} left ${oldLocation.kind}`);
  }

  // Guests without ping/played provenance intentionally have no PB session,
  // but their exact private-squad overwrite must still be removed on leaving
  // that squad. Main <-> air moves share squadVoiceId and keep the invite.
  if (shouldCleanupInviteOnTransition(oldLocation.squadVoiceId, newLocation.squadVoiceId)) {
    const tv = await getTeamsVoice(member.client as BublikClient);
    await lock.assertOwned();
    assertCurrentVoice();
    if (tv) {
      await tv.cleanupVoiceInvitePerms(oldLocation.squadVoiceId!, member.id, member.guild);
      await lock.assertOwned();
      assertCurrentVoice();
    }
  }
}

async function runMemberTransition(
  member: GuildMember,
  task: (lock: MemberRoleLock) => Promise<void>,
): Promise<void> {
  const key = `${member.guild.id}:${member.id}`;
  const previous = memberTransitionQueues.get(key) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(() =>
    withMemberRoleLock(member.guild.id, member.id, async (lock) => {
      await lock.assertOwned();
      try {
        await task(lock);
      } catch (error) {
        if (error instanceof StalePbVoiceTransitionError) {
          log.debug(error.message);
          return;
        }
        throw error;
      }
    }));
  memberTransitionQueues.set(key, current);
  try {
    await current;
  } finally {
    if (memberTransitionQueues.get(key) === current) memberTransitionQueues.delete(key);
  }
}

// ═══════════════════════════════════════════════
//  voiceStateUpdate — ядро системы
// ═══════════════════════════════════════════════

export async function handleVoiceStateUpdate(
  oldState: VoiceState,
  newState: VoiceState,
  client: BublikClient,
): Promise<void> {
  if (oldState.channelId === newState.channelId) return;
  const member = newState.member ?? oldState.member;
  if (!member || member.user.bot) return;

  try {
    await runMemberTransition(member, async (lock) => {
      const config = await getConfig(member.guild.id);
      if (!config) return;
      const [oldLocation, newLocation] = await Promise.all([
        resolvePbLocation(oldState.channelId, config, client),
        resolvePbLocation(newState.channelId, config, client),
      ]);

      // One old -> new transition owns all session changes. This fixes the old
      // join-before-leave race for squad <-> reserve and squad <-> squad moves.
      await reconcilePbTransition(member, oldLocation, newLocation, config, lock);

      if (newLocation.kind === 'master') {
        const assertMasterVoice = createPbVoiceFence(member, config.masterChannelId);
        assertMasterVoice();
        const pending = await getVoiceSession(member.guild.id, member.id);
        assertMasterVoice();
        if (pending?.status === 'ending') {
          assertMasterVoice();
          await member.voice.disconnect('Не удалось безопасно завершить предыдущую PB-сессию').catch(() => null);
          return;
        }
        await handleMasterJoin(newState, member, config, client, lock, assertMasterVoice);
      }

      if (newLocation.squad) {
        cancelDeleteTimer(newLocation.squad.voiceChannelId);
        if (newLocation.squad.airChannelId) cancelDeleteTimer(newLocation.squad.airChannelId);
        await updateControlPanel(newLocation.squad, member.guild, client);
      }
      if (oldLocation.squad) {
        if (oldLocation.squad.id !== newLocation.squad?.id) {
          await updateControlPanel(oldLocation.squad, member.guild, client);
        }
        scheduleDeletionIfEmpty(oldLocation.squad, member.guild, client);
      }

      const touchesPb = oldLocation.kind !== 'none' || newLocation.kind !== 'none';
      if (touchesPb) {
        await refreshStatusPanel(member.guild, client);
        recalculatePinger(member.guild.id);
      }
    });
  } catch (err) {
    log.error('Ошибка в voiceStateUpdate', { error: String(err) });
    errorReporter.eventError(err, 'voiceStateUpdate', 'regbattle');
  }
}

function scheduleDeletionIfEmpty(squad: any, guild: Guild, client: BublikClient): void {
  const mainVc = guild.channels.cache.get(squad.voiceChannelId) as VoiceChannel | undefined;
  const mainEmpty = !mainVc || mainVc.members.filter((m) => !m.user.bot).size === 0;
  const airVc = squad.airChannelId
    ? (guild.channels.cache.get(squad.airChannelId) as VoiceChannel | undefined)
    : null;
  const airEmpty = !airVc || airVc.members.filter((m) => !m.user.bot).size === 0;
  if (mainEmpty && airEmpty) scheduleSquadDeletion(squad, guild, client);
}

// ═══════════════════════════════════════════════
//  Вход в мастер-канал → создание отряда
// ═══════════════════════════════════════════════

async function handleMasterJoin(
  state: VoiceState,
  member: GuildMember,
  config: any,
  client: BublikClient,
  lock: MemberRoleLock,
  assertMasterVoice: () => void,
): Promise<void> {
  assertMasterVoice();
  // Полуоткрытые окна подготовки (МСК): 16:30–01:00 и 03:30–10:00.
  // Explicit owner-only bypass exists solely in development mode.
  const isDev = canBypassSquadCreationWindow(member.id, Config.isDev, Config.ownerId);

  if (!isDev && !canCreateSquadNowMsk()) {
    const { hhmm } = getMskClock();
    assertMasterVoice();
    await member.voice.disconnect('Создание отрядов доступно 16:30–01:00 и 03:30–10:00 МСК').catch(() => null);
    log.info(`Отклонено: ${member.user.tag} попытка создания отряда вне окна (МСК ${hhmm})`);
    return;
  }

  if (isDev) {
    log.info(`Dev-bypass: ${member.user.tag} создаёт отряд вне временного окна`);
  }

  // Проверка роли полевого командира
  const isCommander = isCommanderAuthorized(
    config.commanderRoleIds,
    new Set(member.roles.cache.keys()),
    member.permissions.has(PermissionsBitField.Flags.ManageGuild),
  );

  if (!isCommander) {
    assertMasterVoice();
    await member.voice.disconnect('Нет роли полевого командира').catch(() => null);
    return;
  }

  // Проверка: у пользователя уже есть активный отряд?
  const existingSquads = await getGuildSquads(state.guild.id);
  assertMasterVoice();
  const alreadyOwns = existingSquads.find((s: any) => s.ownerId === member.id);
  if (alreadyOwns) {
    assertMasterVoice();
    await member.voice.disconnect('У вас уже есть активный отряд').catch(() => null);
    log.info(`Отклонено: ${member.user.tag} уже владеет отрядом ${alreadyOwns.number}`);
    return;
  }

  // Антирейс: блокировка создания
  assertMasterVoice();
  if (!acquireCreationLock(member.id)) {
    assertMasterVoice();
    await member.voice.disconnect('Создание вашего отряда уже обрабатывается').catch(() => null);
    return;
  }

  const guildId = state.guild.id;
  const distributedLockKey = `${SQUAD_CREATE_LOCK_PREFIX}:${guildId}`;
  let distributedLockToken: string | null = null;
  let vc: VoiceChannel | null = null;
  let squad: any | null = null;
  let integrationAttempted = false;
  let moveDispatched = false;

  try {
    distributedLockToken = await acquireDistributedLock(distributedLockKey, 2 * 60_000);
    assertMasterVoice();
    await lock.assertOwned();
    assertMasterVoice();
    if (!distributedLockToken) {
      assertMasterVoice();
      await member.voice.disconnect('Другой отряд уже создаётся').catch(() => null);
      return;
    }

    if (isCreationCooldown(member.id)) {
      assertMasterVoice();
      await member.voice.disconnect('Кулдаун создания отряда').catch(() => null);
      return;
    }

    // Re-check under the cross-process lock. The unique (guildId, ownerId)
    // constraint remains the final authority if a second process raced us.
    const lockedSquads = await getGuildSquads(guildId);
    assertMasterVoice();
    if (lockedSquads.some((candidate: any) => candidate.ownerId === member.id)) {
      assertMasterVoice();
      await member.voice.disconnect('У вас уже есть активный отряд').catch(() => null);
      return;
    }

    const masterChannel = await state.guild.channels.fetch(config.masterChannelId);
    assertMasterVoice();
    const masterVoice = masterChannel && masterChannel.type === ChannelType.GuildVoice
      ? masterChannel as VoiceChannel
      : null;
    if (!masterVoice) throw new Error('RegBattle master voice channel is unavailable');

    const inheritedOverwrites = masterVoice
      ? masterVoice.permissionOverwrites.cache.map((ow) => ({
          id: ow.id,
          type: ow.type,
          allow: ow.allow,
          deny: ow.deny,
        }))
      : [];

    // Создать голосовой канал
    assertMasterVoice();
    vc = await state.guild.channels.create({
      name: '⚔️ Создание отряда…',
      type: ChannelType.GuildVoice,
      parent: masterVoice?.parentId || config.categoryId || undefined,
      userLimit: 0, // без лимита (до 99)
      permissionOverwrites: inheritedOverwrites,
    });
    assertMasterVoice();

    // Сохранить в БД
    await lock.assertOwned();
    assertMasterVoice();
    squad = await createSquadWithAllocatedNumber({
      guildId,
      voiceChannelId: vc.id,
      ownerId: member.id,
      configId: config.id,
    });
    assertMasterVoice();
    zeroSquadCleanupCompleted.delete(guildId);
    // Seed the first durable squad before any fallible Discord UI/integration
    // work. Existing pinger states additionally self-heal from cycle signatures.
    recalculatePinger(guildId);
    assertMasterVoice();
    await vc.setName(squadName(squad.number), 'RegBattle: атомарно выделен номер отряда');
    assertMasterVoice();

    // === Teams интеграция: проверить, является ли командир лидером/членом команды ===
    const tv = await getTeamsVoice(client);
    assertMasterVoice();
    if (!tv) throw new Error('Teams voice integration is unavailable during PB squad creation');
    if (tv) {
      integrationAttempted = true;
      assertMasterVoice();
      const teamInfo = await tv.onSquadCreated(vc.id, member.id, guildId, squad.number);
      assertMasterVoice();
      if (teamInfo?.isTeamSquad) {
        if (!teamInfo.teamRoleId) {
          throw new Error(`Team squad ${vc.id} has no durable team role`);
        }
        assertMasterVoice();
        await tv.enforcePrivateTeamSquadPermissions(vc, member.id, teamInfo.teamRoleId);
        assertMasterVoice();
        log.info(`Командный отряд: «${squad.number}» привязан к команде ${teamInfo.teamId}`);
      }
    }

    // Mapping/session is durable before the move, so the resulting voice event
    // cannot temporarily classify a team squad as regular.
    await lock.assertOwned();
    assertMasterVoice();
    moveDispatched = true;
    try {
      await member.voice.setChannel(vc, 'Создание отряда ПБ');
    } catch (error) {
      if (member.voice.channelId !== vc.id) throw error;
      log.warn(`Discord move ${member.id} в ${vc.id} завершился, но REST ответил ошибкой`, {
        error: String(error),
      });
    }
    const assertSquadVoice = createPbVoiceFence(member, vc.id);
    assertSquadVoice();

    // Apply immediately as well; the subsequent Discord event is idempotent.
    const newLocation = await resolvePbLocation(vc.id, config, client);
    assertSquadVoice();
    await reconcilePbTransition(
      member,
      { kind: 'master', channelId: config.masterChannelId, squad: null, squadVoiceId: null, team: null },
      newLocation,
      config,
      lock,
    );
    assertSquadVoice();

    setCreationCooldown(member.id);

    // Небольшая задержка для применения прав
    await new Promise((r) => setTimeout(r, 500));
    assertSquadVoice();

    // Отправить панель управления в текстовый чат VC
    await sendControlPanel(vc, squad, member, config);
    assertSquadVoice();

    // Отправить/обновить статус-панель рекрутинга (вместо отдельного объявления)
    await refreshStatusPanel(member.guild, client, true);

    // Запустить пингер для этой гильдии
    recalculatePinger(guildId);

    log.info(`Отряд ${squad.number} создан: ${vc.id} командир ${member.user.tag}`);
  } catch (err) {
    // Before a successful move, creation is compensated Discord-first. If
    // Discord cannot confirm deletion, retain the DB row (or durable Redis
    // cleanup marker when no row exists) so the channel is never untracked.
    if (vc && !moveDispatched) {
      const deleted = await deleteTrackedChannel(state.guild, vc.id, 'RegBattle: rollback failed squad creation');
      if (deleted && squad) {
        const integrationClean = !integrationAttempted || await teardownSquadIntegration(squad, client);
        if (integrationClean) {
          try {
            await deleteSquad(squad.id);
          } catch (deleteError) {
            log.error(`DB cleanup отряда ${squad.id} будет повторён`, { error: String(deleteError) });
            scheduleSquadDeletion(squad, state.guild, client);
          }
        }
      }
    } else if (squad && moveDispatched) {
      // Once the Discord move is dispatched its result can be ambiguous. Keep
      // the tracked squad and use the ordinary empty-squad grace period; this
      // must never destroy a channel that the commander or others may occupy.
      scheduleDeletionIfEmpty(squad, state.guild, client);
    }
    const staleTransition = err instanceof StalePbVoiceTransitionError;
    if (!staleTransition && member.voice.channelId === config.masterChannelId) {
      await member.voice.disconnect('Не удалось безопасно создать отряд; повторите вход').catch(() => null);
    }
    if (staleTransition) {
      log.debug(err.message);
      throw err;
    }
    log.error(`Ошибка создания отряда для ${member.user.tag}`, { error: String(err) });
    errorReporter.moduleError(err, 'regbattle', `Создание отряда для ${member.user.tag}`);
  } finally {
    if (distributedLockToken) {
      await releaseDistributedLock(distributedLockKey, distributedLockToken).catch((error: unknown) =>
        log.warn('Не удалось освободить distributed squad-create lock', { error: String(error) }));
    }
    releaseCreationLock(member.id);
  }
}

// ═══════════════════════════════════════════════
//  Панель управления
// ═══════════════════════════════════════════════

async function sendControlPanel(
  vc: VoiceChannel,
  squad: any,
  owner: GuildMember,
  config: any,
): Promise<void> {
  const locale = await getGuildLocale(owner.guild.id);
  const maxRetries = 3;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const count = getSquadMemberCount(owner.guild, squad.voiceChannelId, squad.airChannelId);
      const embed = buildControlPanelEmbed(
        squad.number,
        owner.user.tag,
        count,
        config.squadSize,
        !!squad.airChannelId,
        locale,
      );
      const notifyOffState = await isNotifyOff(squad.id);
      const buttons = buildControlPanelButtons(squad.id, !!squad.airChannelId, locale, notifyOffState);

      const msg = await vc.send({
        embeds: [embed],
        components: buttons,
      });

      await updateSquad(squad.id, { panelMessageId: msg.id });
      return;
    } catch (err) {
      if (attempt < maxRetries) {
        await new Promise((r) => setTimeout(r, 1000));
      } else {
        log.warn(`Не удалось отправить панель ПБ в ${vc.id} после ${maxRetries} попыток`, { error: String(err) });
      }
    }
  }
}

/**
 * Обновить панель управления отрядом (числа, кнопки)
 */
export async function updateControlPanel(squad: any, guild: Guild, _client: BublikClient): Promise<void> {
  if (!squad.panelMessageId) return;

  try {
    const vc = guild.channels.cache.get(squad.voiceChannelId) as VoiceChannel | undefined;
    if (!vc) return;

    const locale = await getGuildLocale(guild.id);
    const count = getSquadMemberCount(guild, squad.voiceChannelId, squad.airChannelId);
    const owner = await guild.members.fetch(squad.ownerId).catch(() => null);

    const embed = buildControlPanelEmbed(
      squad.number,
      owner?.user.tag ?? 'Неизвестный',
      count,
      squad.config.squadSize,
      !!squad.airChannelId,
      locale,
    );
    const notifyOffState = await isNotifyOff(squad.id);
    const buttons = buildControlPanelButtons(squad.id, !!squad.airChannelId, locale, notifyOffState);

    const msg = await vc.messages.fetch(squad.panelMessageId).catch(() => null);
    if (msg) {
      await msg.edit({ embeds: [embed], components: buttons });
    }
  } catch {
    // Панель недоступна — не критично
  }
}

// ═══════════════════════════════════════════════
//  Удаление пустого отряда
// ═══════════════════════════════════════════════

function cancelDeleteTimer(channelId: string): void {
  const timer = deleteTimers.get(channelId);
  if (timer) {
    clearTimeout(timer);
    deleteTimers.delete(channelId);
  }
}

/** One idempotent exit point for the Teams session and squad-scoped Redis state. */
export async function teardownSquadIntegration(squad: any, client: BublikClient): Promise<boolean> {
  try {
    const tv = await getTeamsVoice(client);
    if (!tv) return false;
    if (tv) {
      await tv.onSquadDeleted(
        squad.voiceChannelId,
        squad.ownerId,
        client,
      );
    }
    await getRedis().del(`${NOTIFY_OFF_KEY}:${squad.id}`);
    return true;
  } catch (error) {
    log.error('Teams/Redis: ошибка teardown отряда; DB tracker сохранён', {
      error: String(error),
    });
    return false;
  }
}

function scheduleSquadDeletion(squad: any, guild: Guild, client: BublikClient): void {
  const isStillAuthorized = (): boolean =>
    isGuildAllowed(guild.id) && client.guilds.cache.has(guild.id);
  if (!isStillAuthorized()) return;
  // Не дублировать таймер
  if (deleteTimers.has(squad.voiceChannelId)) return;

  const timer = setTimeout(async () => {
    deleteTimers.delete(squad.voiceChannelId);
    // Whitelist/cache state may change after the timer was scheduled. Never
    // mutate Discord, Redis or DB for a guild whose authority was revoked.
    if (!isStillAuthorized()) return;
    try {

    // Перепроверить: всё ещё пусто?
    const mainVc = guild.channels.cache.get(squad.voiceChannelId) as VoiceChannel | undefined;
    const mainEmpty = !mainVc || mainVc.members.filter((m) => !m.user.bot).size === 0;

    const airVc = squad.airChannelId
      ? (guild.channels.cache.get(squad.airChannelId) as VoiceChannel | undefined)
      : null;
    const airEmpty = !airVc || airVc.members.filter((m) => !m.user.bot).size === 0;

    if (!mainEmpty || !airEmpty) return; // Кто-то зашёл

    // Discord-first deletion: the DB row remains a retryable tracker until
    // every external channel deletion has been confirmed.
    const airDeleted = !squad.airChannelId || (
      isStillAuthorized() &&
      await deleteTrackedChannel(guild, squad.airChannelId, 'ПБ: отряд расформирован')
    );
    if (!isStillAuthorized()) return;
    const mainDeleted = await deleteTrackedChannel(
      guild,
      squad.voiceChannelId,
      'ПБ: отряд расформирован',
    );
    if (!airDeleted || !mainDeleted) {
      log.warn(`Удаление отряда ${squad.id} отложено: Discord cleanup не подтверждён`);
      return;
    }

    const squadNumber = squad.number;
    if (!isStillAuthorized()) return;
    if (!(await teardownSquadIntegration(squad, client))) return;
    if (!isStillAuthorized()) return;
    await deleteSquad(squad.id);

    // Обновить статус-панель (или удалить, если отрядов не осталось)
    const remainingSquads = await getGuildSquads(guild.id);
    if (!isStillAuthorized()) return;
    if (remainingSquads.length === 0) {
      await deleteStatusPanel(guild.id, client);
    } else {
      await refreshStatusPanel(guild, client, true);
    }

    recalculatePinger(guild.id);
    log.info(`Отряд ${squadNumber} расформирован (пустой): ${squad.voiceChannelId}`);
    } catch (error) {
      log.error(`Удаление отряда ${squad.id} будет повторено`, { error: String(error) });
      scheduleSquadDeletion(squad, guild, client);
    }
  }, EMPTY_DELETE_DELAY_MS);

  deleteTimers.set(squad.voiceChannelId, timer);
}

// ═══════════════════════════════════════════════
//  Восстановление при рестарте
// ═══════════════════════════════════════════════

export async function restoreSquads(
  client: BublikClient,
  isCurrent: () => boolean = () => true,
): Promise<void> {
  try {
    if (!isCurrent()) return;

    for (const [, guild] of client.guilds.cache) {
      if (!isCurrent()) return;
      if (!isGuildAllowed(guild.id)) continue;
      try {
      // Предотвратить орфанинг отрядов из-за неполного кэша каналов на старте
      try {
        await guild.channels.fetch();
      } catch (error) {
        log.warn(`Restore отложен для ${guild.id}: не получен полный список каналов`, {
          error: String(error),
        });
        continue;
      }
      if (!isCurrent()) return;
      await cleanupTrackedChannels(guild);
      if (!isCurrent()) return;
      const config = await getConfig(guild.id);
      if (!config) continue;

      const squads = await getGuildSquads(guild.id);

      for (const squad of squads) {
        if (!isCurrent()) return;
        const vc = guild.channels.cache.get(squad.voiceChannelId);

        if (!vc) {
          // Канал не существует → удалить запись
          let externalCleanupComplete = true;
          if (squad.airChannelId) {
            externalCleanupComplete = await deleteTrackedChannel(
              guild,
              squad.airChannelId,
              'ПБ: главный канал недоступен',
            );
          }
          if (!externalCleanupComplete) continue;
          if (!(await teardownSquadIntegration(squad, client))) continue;
          try {
            await deleteSquad(squad.id);
          } catch (error) {
            log.warn(`DB cleanup отряда ${squad.id} отложен`, { error: String(error) });
            scheduleSquadDeletion(squad, guild, client);
            continue;
          }
          log.debug(`Cleanup: удалена запись отряда для несуществующего канала ${squad.voiceChannelId}`);
          continue;
        }

        // Проверить авиа-канал
        if (squad.airChannelId) {
          const airVc = guild.channels.cache.get(squad.airChannelId);
          if (!airVc) {
            await updateSquad(squad.id, { airChannelId: null });
            log.debug(`Cleanup: авиа-канал ${squad.airChannelId} не найден`);
          }
        }

        // Если пуст → планировать удаление
        if (vc.type === ChannelType.GuildVoice) {
          const mainEmpty = (vc as VoiceChannel).members.filter((m) => !m.user.bot).size === 0;
          const airVc = squad.airChannelId
            ? (guild.channels.cache.get(squad.airChannelId) as VoiceChannel | undefined)
            : null;
          const airEmpty = !airVc || airVc.members.filter((m) => !m.user.bot).size === 0;

          if (mainEmpty && airEmpty) {
            if (!isCurrent()) return;
            scheduleSquadDeletion(squad, guild, client);
          } else {
            // Existing durable sessions retain joinedAt. New sessions are only
            // inferred from authoritative current eligibility.
            const mainMembers = (vc as VoiceChannel).members.filter((m) => !m.user.bot);
            for (const [, m] of mainMembers) {
              if (!isCurrent()) return;
              const location = await resolvePbLocation(squad.voiceChannelId, config, client);
              await runMemberTransition(m, (lock) => reconcilePbTransition(
                  m,
                  { kind: 'none', channelId: null, squad: null, squadVoiceId: null, team: null },
                  location,
                  config,
                  lock,
                ));
            }
            if (airVc && airVc.type === ChannelType.GuildVoice) {
              const airMembers = (airVc as VoiceChannel).members.filter((m) => !m.user.bot);
              for (const [, m] of airMembers) {
                if (!isCurrent()) return;
                const location = await resolvePbLocation(airVc.id, config, client);
                await runMemberTransition(m, (lock) => reconcilePbTransition(
                    m,
                    { kind: 'none', channelId: null, squad: null, squadVoiceId: null, team: null },
                    location,
                    config,
                    lock,
                  ));
              }
            }
          }
        }
      }

      // Reserve participates in exactly the same state machine.
      if (config.reserveChannelId) {
        const reserve = guild.channels.cache.get(config.reserveChannelId);
        if (reserve?.type === ChannelType.GuildVoice) {
          const location = await resolvePbLocation(reserve.id, config, client);
          for (const [, member] of (reserve as VoiceChannel).members) {
            if (!isCurrent()) return;
            if (!member.user.bot) {
              await runMemberTransition(member, (lock) => reconcilePbTransition(
                  member,
                  { kind: 'none', channelId: null, squad: null, squadVoiceId: null, team: null },
                  location,
                  config,
                  lock,
                ));
            }
          }
        }
      }

      // Finish sessions whose disconnect event was missed while the bot was down.
      const durableSessions = await listGuildVoiceSessions(guild.id);
      for (const session of durableSessions) {
        if (!isCurrent()) return;
        let fetched: Awaited<ReturnType<typeof fetchMemberForRecovery>>;
        try {
          fetched = await fetchMemberForRecovery(guild, session.userId);
        } catch (error) {
          log.warn(`PB-сессия ${guild.id}:${session.userId} сохранена для retry: Discord fetch transient`, {
            error: String(error),
          });
          continue;
        }
        if (fetched.confirmedMissing) {
          await deleteMissingMemberPbState(guild, session.userId);
          continue;
        }
        const member = fetched.member;
        if (!member) continue;
        const expectedChannelId = member.voice.channelId;
        const assertCurrentVoice = createPbVoiceFence(member, expectedChannelId);
        const location = await resolvePbLocation(expectedChannelId, config, client);
        assertCurrentVoice();
        if (!isActivePbLocation(location) || !mayCarrySession(session, location)) {
          await finishPbSession(member, config, undefined, assertCurrentVoice);
        }
      }

      // Рассчитать пингер
      if (!isCurrent()) return;
      recalculatePinger(guild.id);

      // Восстановить статус-панель
      const squadsAfterRestore = await getGuildSquads(guild.id);
      if (squadsAfterRestore.length > 0) {
        await refreshStatusPanel(guild, client, true);
      } else {
        await deleteStatusPanel(guild.id, client);
      }
      } catch (error) {
        log.error(`Restore PB для гильдии ${guild.id} отложен без очистки provenance`, {
          error: String(error),
        });
      }
    }

    log.info('Отряды ПБ восстановлены');
  } catch (err) {
    log.error('Ошибка восстановления отрядов ПБ', { error: String(err) });
  }
}

// ═══════════════════════════════════════════════
//  Целостность ролей — периодическая проверка
// ═══════════════════════════════════════════════

async function deleteMissingMemberPbState(guild: Guild, userId: string): Promise<void> {
  await withMemberRoleLock(guild.id, userId, async (lock) => {
    const latest = await fetchMemberForRecovery(guild, userId);
    await lock.assertOwned();
    if (!latest.confirmedMissing) return;
    await deleteVoiceSessionState(guild.id, userId, lock);
  });
}

export function startRoleIntegrityChecker(client: BublikClient): void {
  scheduleTask('regbattle:integrity', ROLE_INTEGRITY_INTERVAL_MS, async () => {
    await checkRoleIntegrity(client);
  });
}

export function stopRoleIntegrityChecker(): void {
  unscheduleTask('regbattle:integrity');
  unscheduleTask('regbattle:playedReset');

  // Отменить все таймеры удаления
  for (const timer of deleteTimers.values()) {
    clearTimeout(timer);
  }
  deleteTimers.clear();
  for (const retry of statusPanelRetryTimers.values()) clearTimeout(retry.timer);
  statusPanelRetryTimers.clear();
  integrityCompleteMemberSnapshots.clear();
  zeroSquadCleanupCompleted.clear();
}

/**
 * Проверка целостности ролей:
 * 1. Каждому в ПБ-войсе — выдать inSquadRole, снять pingRole
 * 2. Каждому с inSquadRole НЕ в ПБ-войсе — вернуть pingRole, снять inSquadRole
 *
 * Используем VoiceChannel.members (авторитетный источник кто в канале),
 * а НЕ member.voice.channelId из guild.members.cache (может быть stale).
 */
async function checkRoleIntegrity(client: BublikClient): Promise<void> {
  await runIsolatedIntegrityTasks(client.guilds.cache.values(), async (guild) => {
    if (!isGuildAllowed(guild.id)) return;
    const [config, squads] = await Promise.all([
      getConfig(guild.id),
      getGuildSquads(guild.id),
    ]);
    if (squads.length === 0) {
      if (!zeroSquadCleanupCompleted.has(guild.id)) {
        await deleteStatusPanel(guild.id, client);
      }
    } else {
      zeroSquadCleanupCompleted.delete(guild.id);
    }
    if (!config) {
      // A removed/corrupt guild configuration must not strand durable role
      // rotations forever. The session itself contains the exact role IDs that
      // may be restored, so close it without inventing configuration defaults.
      const sessions = await listGuildVoiceSessions(guild.id);
      for (const session of sessions) {
        try {
          const fetched = await fetchMemberForRecovery(guild, session.userId);
          if (fetched.member) {
            await runMemberTransition(fetched.member, async (lock) => {
              const assertCurrentVoice = createPbVoiceFence(
                fetched.member!,
                fetched.member!.voice.channelId,
              );
              assertCurrentVoice();
              await finishPbSessionLocked(
                fetched.member!,
                {},
                false,
                lock,
                assertCurrentVoice,
              );
            });
          } else if (fetched.confirmedMissing) {
            await deleteMissingMemberPbState(guild, session.userId);
          }
        } catch (error) {
          log.warn(`Integrity сохранил PB-сессию ${guild.id}:${session.userId}: конфигурация отсутствует`, {
            error: String(error),
          });
        }
      }
      return;
    }
    const pbChannelIds = new Set<string>();
    for (const sq of squads) {
      pbChannelIds.add(sq.voiceChannelId);
      if (sq.airChannelId) pbChannelIds.add(sq.airChannelId);
    }
    if (config.reserveChannelId) {
      pbChannelIds.add(config.reserveChannelId);
    }

    if (config.inSquadRoleId) {
      const membersInPb = new Map<string, { member: GuildMember; location: PbLocation }>();
      for (const channelId of pbChannelIds) {
        const vc = guild.channels.cache.get(channelId);
        if (vc && vc.type === ChannelType.GuildVoice) {
          const location = await resolvePbLocation(channelId, config, client);
          for (const [, member] of (vc as VoiceChannel).members) {
            if (!member.user.bot) membersInPb.set(member.id, { member, location });
          }
        }
      }

      // Presence alone is never eligibility. Reconcile starts only sessions
      // backed by ping/played/team/invite/commander provenance. A missing
      // in-squad role disables new rotations but does not block teardown below.
      await runIsolatedIntegrityTasks(membersInPb.values(), async ({ member }) => {
        await runMemberTransition(member, async (lock) => {
          const currentLocation = await resolveStableIntegrityLocation(
            () => member.voice.channelId,
            (channelId) => resolvePbLocation(channelId, config, client),
            (resolved) => resolved.channelId,
          );
          if (!currentLocation || !isActivePbLocation(currentLocation)) return;
          await reconcilePbTransition(
            member,
            { kind: 'none', channelId: null, squad: null, squadVoiceId: null, team: null },
            currentLocation,
            config,
            lock,
          );
        });
      }, ({ member }, error) => {
        log.warn(`Integrity deferred PB member ${guild.id}:${member.id}`, {
          error: String(error),
        });
      });
    }

    // Complete missed disconnects and pending teardown attempts from Redis.
    const sessions = await listGuildVoiceSessions(guild.id);
    for (const session of sessions) {
      try {
        const fetched = await fetchMemberForRecovery(guild, session.userId);
        if (fetched.member) {
          await runMemberTransition(fetched.member, async (lock) => {
            const currentLocation = await resolveStableIntegrityLocation(
              () => fetched.member!.voice.channelId,
              (channelId) => resolvePbLocation(channelId, config, client),
              (resolved) => resolved.channelId,
            );
            if (!currentLocation) return;
            const assertCurrentVoice = createPbVoiceFence(
              fetched.member!,
              currentLocation.channelId,
            );
            await lock.assertOwned();
            assertCurrentVoice();
            const currentSession = await getVoiceSession(guild.id, fetched.member!.id);
            await lock.assertOwned();
            assertCurrentVoice();
            if (!currentSession) return;

            const canReplay = currentSession.version === 2 &&
              currentSession.status === 'active' &&
              Boolean(currentSession.inSquadRoleId) &&
              isActivePbLocation(currentLocation) &&
              mayCarrySession(currentSession, currentLocation) &&
              !(await isPbRoleMutationSuppressed(fetched.member!)) &&
              await teamMembershipStillValid(fetched.member!, currentSession);
            await lock.assertOwned();
            assertCurrentVoice();
            if (canReplay) {
              const replayedSession: PbVoiceSession = {
                ...currentSession,
                currentChannelId: currentLocation.channelId!,
                currentChannelKind: currentLocation.kind as PbChannelKind,
                squadId: currentLocation.squad?.id ?? null,
                squadVoiceId: currentLocation.squadVoiceId,
              };
              await saveVoiceSession(replayedSession, lock);
              await lock.assertOwned();
              assertCurrentVoice();
              await applySessionRoles(
                fetched.member!,
                replayedSession,
                replayedSession.inSquadRoleId,
                lock,
                assertCurrentVoice,
              );
              return;
            }
            await finishPbSessionLocked(
              fetched.member!,
              config,
              undefined,
              lock,
              assertCurrentVoice,
            );
          });
        } else if (fetched.confirmedMissing) {
          await deleteMissingMemberPbState(guild, session.userId);
        }
      } catch (error) {
        log.warn(`Integrity сохранил PB-сессию ${guild.id}:${session.userId} для retry`, {
          error: String(error),
        });
      }
    }

    // Remove only the stale inSquad capability when no valid session exists.
    // Never invent ping/played/team roles while cleaning legacy contamination.
    if (!config.inSquadRoleId) return;
    await ensureCompleteIntegrityMemberSnapshot(
      guild.id,
      integrityCompleteMemberSnapshots,
      () => guild.members.fetch(),
    );
    const inSquadRole = guild.roles.cache.get(config.inSquadRoleId);
    if (!inSquadRole) return;
    for (const [, member] of inSquadRole.members) {
      if (member.user.bot) continue;
      await withMemberRoleLock(guild.id, member.id, async (lock) => {
        // Re-check after acquiring the same lock used by session creation.
        if (await getVoiceSession(guild.id, member.id)) return;
        if (await hasPbVoiceStateQuarantine(guild.id, member.id)) return;
        await lock.assertOwned();
        await member.roles.remove(config.inSquadRoleId, 'RegBattle: stale role without proven session');
        await lock.assertOwned();
        log.warn(`Integrity: снята orphan inSquadRole у ${member.user.tag}; роли не выдавались`);
      }).catch((error) => {
        log.warn(`Integrity deferred stale inSquad cleanup for ${guild.id}:${member.id}`, {
          error: String(error),
        });
      });
    }
  }, (guild, error) => {
    if (!isGuildAllowed(guild.id)) return;
    log.warn(`Integrity deferred guild ${guild.id}; later guilds continue`, {
      error: String(error),
    });
  });
}

// ═══════════════════════════════════════════════
//  Сброс роли «Играл сегодня» — ежедневный
//  Проверяется каждую минуту, срабатывает 1 раз
//  в указанный час (МСК).
// ═══════════════════════════════════════════════

export function startPlayedResetScheduler(client: BublikClient): void {
  scheduleTask('regbattle:playedReset', PLAYED_RESET_CHECK_INTERVAL_MS, async () => {
    await checkPlayedReset(client);
  }, { exclusive: true, immediate: true });

  log.info('Планировщик сброса «Играл сегодня» запущен');
}

export function stopPlayedResetScheduler(): void {
  unscheduleTask('regbattle:playedReset');
}

export function clearLifecycleState(): void {
  for (const timer of deleteTimers.values()) {
    clearTimeout(timer);
  }
  deleteTimers.clear();
  for (const retry of statusPanelRetryTimers.values()) clearTimeout(retry.timer);
  statusPanelRetryTimers.clear();
  memberTransitionQueues.clear();
}

async function resetPlayedRolesSafely(
  guild: Guild,
  playedTodayRoleId: string,
  pbMemberIds: Set<string>,
): Promise<{ count: number; complete: boolean }> {
  const role = guild.roles.cache.get(playedTodayRoleId);
  if (!role) return { count: 0, complete: true };
  let count = 0;
  let complete = true;

  for (const [, member] of [...role.members]) {
    if (member.user.bot || pbMemberIds.has(member.id)) continue;
    try {
      await withMemberRoleLock(guild.id, member.id, async (lock) => {
        if (await hasPbVoiceStateQuarantine(guild.id, member.id)) {
          throw new Error(`PB provenance is quarantined for ${guild.id}:${member.id}`);
        }
        const origin = await getPlayedOrigin(guild.id, member.id);
        await lock.assertOwned();
        // Restore first. Transient errors leave playedToday in place for retry.
        for (const roleId of buildPlayedResetRoleIds(origin)) {
          if (!member.roles.cache.has(roleId)) {
            const safeRole = await fetchSafeAutomaticRole(guild, roleId);
            await lock.assertOwned();
            await member.roles.add(safeRole, 'RegBattle: восстановление роли из played provenance');
            await lock.assertOwned();
          }
        }
        await lock.assertOwned();
        await member.roles.remove(playedTodayRoleId, 'RegBattle: ежедневный proven reset');
        await lock.assertOwned();
        await deletePlayedOrigin(guild.id, member.id, lock);
      });
      count++;
    } catch (error) {
      complete = false;
      log.error(`Не удалось безопасно сбросить playedToday у ${member.user.tag}`, { error: String(error) });
    }
  }
  return { count, complete };
}

async function checkPlayedReset(client: BublikClient): Promise<void> {
  const now = new Date();

  for (const [, guild] of client.guilds.cache) {
    if (!isGuildAllowed(guild.id)) continue;
    const config = await getConfig(guild.id);
    if (!config || !config.playedTodayRoleId) continue;

    const resetHour = Math.max(0, Math.min(23, Number(config.playedResetHour ?? 23)));
    const dueDate = getDuePlayedResetDate(now, resetHour);
    const doneKey = `${PLAYED_RESET_DONE_PREFIX}:${guild.id}:${dueDate}`;
    const durableClaimKey = `regbattle:played-reset:${guild.id}:${dueDate}`;
    const lockKey = `${PLAYED_RESET_LOCK_PREFIX}:${guild.id}:${dueDate}`;
    if (await hasDurablePlayedResetClaim(durableClaimKey)) continue;
    const resetLockTtlMs = 5 * 60_000;
    const token = await acquireDistributedLock(lockKey, resetLockTtlMs);
    if (!token) continue;
    let resetLockLost = false;
    const renewTimer = setInterval(() => {
      void renewDistributedLock(lockKey, token, resetLockTtlMs).then((renewed) => {
        if (!renewed) {
          resetLockLost = true;
          log.warn(`Daily PB reset lock ${guild.id}:${dueDate} потерян`);
        }
      }).catch((error: unknown) =>
        {
          resetLockLost = true;
          log.warn(`Daily PB reset lock ${guild.id}:${dueDate} не продлён`, { error: String(error) });
        });
    }, 60_000);

    try {
      // Double-check after acquiring the cross-process lock.
      if (await hasDurablePlayedResetClaim(durableClaimKey)) continue;

      if (await bootstrapPlayedResetClaims(guild.id, dueDate, durableClaimKey)) {
        await getRedis().set(
          doneKey,
          JSON.stringify({ completedAt: Date.now(), skippedBootstrap: true }),
          'EX',
          120 * 24 * 60 * 60,
        );
        log.info(`Daily PB reset ${guild.id}:${dueDate} bootstrap-safe skip installed`);
        continue;
      }

      // Role.members is cache-backed. A failed authoritative fetch must not
      // produce a false successful durable claim.
      await guild.members.fetch();
      await guild.roles.fetch(config.playedTodayRoleId);

      // Собрать ID участников, которые сейчас в ПБ-войсах (их не трогать)
      const squads = await getGuildSquads(guild.id);
      const pbMemberIds = new Set<string>();
      for (const sq of squads) {
        const mainVc = guild.channels.cache.get(sq.voiceChannelId);
        if (mainVc && mainVc.type === ChannelType.GuildVoice) {
          (mainVc as VoiceChannel).members.forEach((m) => {
            if (!m.user.bot) pbMemberIds.add(m.id);
          });
        }
        if (sq.airChannelId) {
          const airVc = guild.channels.cache.get(sq.airChannelId);
          if (airVc && airVc.type === ChannelType.GuildVoice) {
            (airVc as VoiceChannel).members.forEach((m) => {
              if (!m.user.bot) pbMemberIds.add(m.id);
            });
          }
        }
      }
      if (config.reserveChannelId) {
        const reserveVc = guild.channels.cache.get(config.reserveChannelId);
        if (reserveVc && reserveVc.type === ChannelType.GuildVoice) {
          (reserveVc as VoiceChannel).members.forEach((m) => {
            if (!m.user.bot) pbMemberIds.add(m.id);
          });
        }
      }

      const { count, complete } = await resetPlayedRolesSafely(guild, config.playedTodayRoleId, pbMemberIds);
      if (count > 0) {
        log.info(`Сброс «Играл сегодня» для ${guild.name}: ${count} участников`);
      }

      const stillOwnsLock = !resetLockLost && await getRedis().get(lockKey) === token;
      if (complete && stillOwnsLock) {
        await purgeStaleAbsentTrackingExclusively(guild.id, dueDate);
        await getDatabase().operationClaim.createMany({
          data: [{
            key: durableClaimKey,
            scope: PLAYED_RESET_CLAIM_SCOPE,
            guildId: guild.id,
            metadata: { dueDate, completedAt: Date.now() },
            expiresAt: new Date(Date.now() + 180 * 24 * 60 * 60_000),
          }],
          skipDuplicates: true,
        });
        await getRedis().set(doneKey, JSON.stringify({ completedAt: Date.now() }), 'EX', 120 * 24 * 60 * 60);
        log.info(`Daily PB reset ${guild.id}:${dueDate} durable claim completed`);
      }
    } catch (error) {
      log.error(`Daily PB reset ${guild.id}:${dueDate} сохранён для retry`, { error: String(error) });
    } finally {
      clearInterval(renewTimer);
      await releaseDistributedLock(lockKey, token).catch((error: unknown) =>
        log.warn(`Не удалось освободить daily reset lock ${guild.id}`, { error: String(error) }));
    }
  }
}
