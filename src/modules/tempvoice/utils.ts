// ═══════════════════════════════════════════════
//  TempVoice — утилиты
// ═══════════════════════════════════════════════

import {
  GuildMember,
  VoiceChannel,
  PermissionsBitField,
  OverwriteResolvable,
  OverwriteType,
  ChannelType,
  Guild,
} from 'discord.js';
import type { TempvoiceGenerator, TempvoiceChannel } from '@prisma/client';
import { AccessLevel, ChannelState, RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_MS, CREATION_COOLDOWN_MS } from './constants';
import { getTrusted, getBlocked } from './database';
import { scheduleTask, unscheduleTask } from '../../core/SchedulerManager';
import { getRedis } from '../../core/Redis';
import { randomUUID } from 'node:crypto';
import {
  buildPendingVoiceSettlement,
  isPendingVoiceSettlement,
  pendingVoiceSettlementKey,
  type PendingVoiceSettlement,
} from './recovery';

// ═══════════════════════════════════════════════
//  Rate Limiter (in-memory, per-user)
// ═══════════════════════════════════════════════

const rateLimits = new Map<string, number[]>();
const creationCooldowns = new Map<string, number>();

export function startRateLimitCleanup(): void {
  scheduleTask('tempvoice:rateLimitCleanup', 60_000, async () => {
    const now = Date.now();
    for (const [key, timestamps] of rateLimits) {
      const valid = timestamps.filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
      if (valid.length === 0) rateLimits.delete(key);
      else rateLimits.set(key, valid);
    }
    for (const [key, ts] of creationCooldowns) {
      if (now - ts > CREATION_COOLDOWN_MS) creationCooldowns.delete(key);
    }
  });
}

export function stopRateLimitCleanup(): void {
  unscheduleTask('tempvoice:rateLimitCleanup');
  rateLimits.clear();
  creationCooldowns.clear();
}

// Запуск при загрузке модуля
/** Проверить rate-limit. Возвращает true если лимит превышен */
export function isRateLimited(userId: string): boolean {
  const now = Date.now();
  const timestamps = rateLimits.get(userId) ?? [];
  const valid = timestamps.filter((t) => now - t < RATE_LIMIT_WINDOW_MS);

  if (valid.length >= RATE_LIMIT_MAX) return true;

  valid.push(now);
  rateLimits.set(userId, valid);
  return false;
}

/** Проверить кулдаун создания канала */
export function isCreationCooldown(userId: string): boolean {
  const last = creationCooldowns.get(userId);
  if (last && Date.now() - last < CREATION_COOLDOWN_MS) return true;
  creationCooldowns.set(userId, Date.now());
  return false;
}

// ═══════════════════════════════════════════════
//  Блокировка создания (антирейс)
// ═══════════════════════════════════════════════

const creationLocks = new Set<string>();

export function acquireCreationLock(userId: string): boolean {
  if (creationLocks.has(userId)) return false;
  creationLocks.add(userId);
  // Автоматический сброс через 10с на случай ошибки
  setTimeout(() => creationLocks.delete(userId), 10_000);
  return true;
}

export function releaseCreationLock(userId: string): void {
  creationLocks.delete(userId);
}

// ═══════════════════════════════════════════════
//  Активные взаимодействия (антидубли select menu)
// ═══════════════════════════════════════════════

const activeInteractions = new Set<string>();

export function hasActiveInteraction(userId: string): boolean {
  return activeInteractions.has(userId);
}

export function setActiveInteraction(userId: string): void {
  activeInteractions.add(userId);
  setTimeout(() => activeInteractions.delete(userId), 35_000);
}

export function clearActiveInteraction(userId: string): void {
  activeInteractions.delete(userId);
}

// ═══════════════════════════════════════════════
//  Определение уровня доступа
// ═══════════════════════════════════════════════

export async function getAccessLevel(
  member: GuildMember,
  channelData: TempvoiceChannel,
  generator: TempvoiceGenerator,
): Promise<AccessLevel> {
  // Владелец канала
  if (member.id === channelData.ownerId) return AccessLevel.Owner;

  // Модератор (любая из immuneRoleIds)
  if (generator.immuneRoleIds.length > 0 && generator.immuneRoleIds.some((id) => member.roles.cache.has(id))) {
    return AccessLevel.Moderator;
  }

  // Проверка блокировки
  const blocked = await getBlocked(channelData.id);
  if (blocked.includes(member.id)) return AccessLevel.Blocked;

  // Наградная роль (выше бустера)
  if (generator.rewardRoleId && member.roles.cache.has(generator.rewardRoleId)) {
    return AccessLevel.Reward;
  }

  // Доверенный
  const trusted = await getTrusted(channelData.id);
  if (trusted.includes(member.id)) return AccessLevel.Trusted;

  // Бустер
  if (generator.boosterPerks && member.premiumSince) return AccessLevel.Booster;

  return AccessLevel.Normal;
}

/** Проверить, может ли пользователь управлять каналом */
export function canManage(level: AccessLevel): boolean {
  return level === AccessLevel.Owner || level === AccessLevel.Moderator;
}

/** Проверить, расширенные ли права (бустер+, наградная роль+) */
export function hasElevated(level: AccessLevel): boolean {
  return (
    level === AccessLevel.Owner ||
    level === AccessLevel.Moderator ||
    level === AccessLevel.Reward ||
    level === AccessLevel.Booster
  );
}

// ═══════════════════════════════════════════════
//  Шаблон имени канала
// ═══════════════════════════════════════════════

export function resolveChannelName(
  template: string,
  member: GuildMember,
  count: number,
): string {
  const game = member.presence?.activities?.find((a) => a.type === 0)?.name;

  let name = template
    .replace(/{username}/gi, member.user.username)
    .replace(/{nickname}/gi, member.displayName)
    .replace(/{game}/gi, game ?? member.displayName)
    .replace(/{count}/gi, String(count));

  // Ограничение Discord: 1–100 символов
  if (name.length > 100) name = name.slice(0, 100);
  if (name.length === 0) name = member.displayName;

  return name;
}

// ═══════════════════════════════════════════════
//  Permission Overwrites
// ═══════════════════════════════════════════════

/** Построить permission overwrites для канала по его состоянию */
export async function buildPermissionOverwrites(
  channelData: TempvoiceChannel,
  generator: TempvoiceGenerator,
  guild: Guild,
  botId: string,
): Promise<OverwriteResolvable[]> {
  // Discord expects one canonical overwrite per subject. A Map also guarantees
  // that managed TempVoice subjects replace inherited generator entries.
  const overwrites = new Map<string, OverwriteResolvable>();
  const trusted = await getTrusted(channelData.id);
  const blocked = await getBlocked(channelData.id);
  const subjects = normalizePermissionSubjects(trusted, blocked);

  const state = channelData.state as ChannelState;
  const guildId = guild.id;

  // Копировать права РОЛЕЙ с мастер-канала (генератора)
  const generatorChannel = guild.channels.cache.get(generator.channelId);
  if (generatorChannel && 'permissionOverwrites' in generatorChannel) {
    for (const [id, overwrite] of generatorChannel.permissionOverwrites.cache) {
      // Копируем только role-оверрайды, но не @everyone (его мы управляем отдельно)
      if (overwrite.type === 0 && id !== guildId) {
        overwrites.set(id, {
          id,
          type: OverwriteType.Role,
          allow: overwrite.allow.toArray(),
          deny: overwrite.deny.toArray(),
        });
      }
    }
  }

  // @everyone: зависит от состояния
  switch (state) {
    case ChannelState.Locked:
      overwrites.set(guildId, {
        id: guildId, // @everyone role ID = guild ID
        type: OverwriteType.Role,
        deny: [PermissionsBitField.Flags.Connect],
        allow: [PermissionsBitField.Flags.ViewChannel],
      });
      break;
    case ChannelState.Hidden:
      overwrites.set(guildId, {
        id: guildId,
        type: OverwriteType.Role,
        deny: [
          PermissionsBitField.Flags.Connect,
          PermissionsBitField.Flags.ViewChannel,
        ],
      });
      break;
    default: // unlocked
      overwrites.set(guildId, {
        id: guildId,
        type: OverwriteType.Role,
        allow: [
          PermissionsBitField.Flags.Connect,
          PermissionsBitField.Flags.ViewChannel,
        ],
      });
  }

  // Бот: полный доступ (нужен для панели управления и управления каналом)
  overwrites.set(botId, {
    id: botId,
    type: OverwriteType.Member,
    allow: [
      PermissionsBitField.Flags.ViewChannel,
      PermissionsBitField.Flags.Connect,
      PermissionsBitField.Flags.SendMessages,
      PermissionsBitField.Flags.ManageChannels,
      PermissionsBitField.Flags.MoveMembers,
      PermissionsBitField.Flags.MuteMembers,
      PermissionsBitField.Flags.DeafenMembers,
      PermissionsBitField.Flags.ReadMessageHistory,
      PermissionsBitField.Flags.EmbedLinks,
    ],
  });

  // Владелец: полное управление
  overwrites.set(channelData.ownerId, {
    id: channelData.ownerId,
    type: OverwriteType.Member,
    allow: [
      PermissionsBitField.Flags.Connect,
      PermissionsBitField.Flags.ViewChannel,
      PermissionsBitField.Flags.ManageChannels,
      PermissionsBitField.Flags.MuteMembers,
      PermissionsBitField.Flags.DeafenMembers,
      PermissionsBitField.Flags.MoveMembers,
      PermissionsBitField.Flags.Stream,
      PermissionsBitField.Flags.Speak,
    ],
  });

  // Immune Roles: обход всех ограничений
  for (const roleId of generator.immuneRoleIds) {
    if (roleId === guildId || !guild.roles.cache.has(roleId)) continue;
    overwrites.set(roleId, {
      id: roleId,
      type: OverwriteType.Role,
      allow: [
        PermissionsBitField.Flags.Connect,
        PermissionsBitField.Flags.ViewChannel,
        PermissionsBitField.Flags.ManageChannels,
        PermissionsBitField.Flags.MuteMembers,
        PermissionsBitField.Flags.DeafenMembers,
        PermissionsBitField.Flags.MoveMembers,
      ],
    });
  }

  // Доверенные: могут подключаться даже когда заблокировано/скрыто
  for (const userId of subjects.trusted) {
    if (userId === botId || userId === channelData.ownerId) continue;
    overwrites.set(userId, {
      id: userId,
      type: OverwriteType.Member,
      allow: [
        PermissionsBitField.Flags.Connect,
        PermissionsBitField.Flags.ViewChannel,
        PermissionsBitField.Flags.Speak,
        PermissionsBitField.Flags.Stream,
      ],
    });
  }

  // Заблокированные: полный запрет
  for (const userId of subjects.blocked) {
    if (userId === botId || userId === channelData.ownerId) continue;
    overwrites.set(userId, {
      id: userId,
      type: OverwriteType.Member,
      deny: [
        PermissionsBitField.Flags.Connect,
        PermissionsBitField.Flags.ViewChannel,
        PermissionsBitField.Flags.Speak,
        PermissionsBitField.Flags.Stream,
        PermissionsBitField.Flags.SendMessages,
      ],
    });
  }

  return [...overwrites.values()];
}

/** A corrupt/legacy dual row must never emit duplicate Discord overwrites. */
export function normalizePermissionSubjects(
  trusted: readonly string[],
  blocked: readonly string[],
): { trusted: string[]; blocked: string[] } {
  const blockedSet = new Set(blocked.filter(Boolean));
  return {
    trusted: [...new Set(trusted.filter((id) => Boolean(id) && !blockedSet.has(id)))],
    blocked: [...blockedSet],
  };
}

/** Найти голосовой канал участника (из tempvoice) */
export function getMemberVoiceChannel(member: GuildMember): VoiceChannel | null {
  const vc = member.voice.channel;
  if (!vc || vc.type !== ChannelType.GuildVoice) return null;
  return vc as VoiceChannel;
}

// ═══════════════════════════════════════════════
//  Redis Voice Sessions (Hot-Reload / Restart Safe)
// ═══════════════════════════════════════════════

export interface VoiceSession {
  sessionId: string;
  joinedAt: number;
  channelId: string;
  generatorId: string;
}

const REDIS_SESSION_PREFIX = 'tempvoice:session';
const REDIS_PENDING_SETTLEMENT_PREFIX = 'tempvoice:pending-settlement:';

const CLOSE_SESSION_SCRIPT = `
local raw = redis.call('GET', KEYS[1])
if not raw then return 0 end
local ok, current = pcall(cjson.decode, raw)
if not ok then return 0 end
local matches = current.sessionId == ARGV[1]
if current.sessionId == nil then
  matches = current.channelId == ARGV[2] and tonumber(current.joinedAt) == tonumber(ARGV[3])
end
if not matches then return 0 end
if ARGV[4] ~= '' then
  redis.call('SET', KEYS[2], ARGV[4])
end
redis.call('DEL', KEYS[1])
return 1
`;

function parseVoiceSession(data: string, guildId: string, userId: string): VoiceSession | null {
  try {
    const parsed = JSON.parse(data) as Partial<VoiceSession>;
    if (
      typeof parsed.joinedAt !== 'number' ||
      typeof parsed.channelId !== 'string' ||
      typeof parsed.generatorId !== 'string'
    ) return null;
    return {
      joinedAt: parsed.joinedAt,
      channelId: parsed.channelId,
      generatorId: parsed.generatorId,
      sessionId: parsed.sessionId ?? `${guildId}:${userId}:${parsed.channelId}:${parsed.joinedAt}`,
    };
  } catch {
    return null;
  }
}

/** Start a session without overwriting a concurrent leave/join transition. */
export async function setVoiceSessionIfAbsent(
  guildId: string,
  userId: string,
  session: Omit<VoiceSession, 'sessionId'> & { sessionId?: string },
): Promise<boolean> {
  const result = await getRedis().set(
    `${REDIS_SESSION_PREFIX}:${guildId}:${userId}`,
    JSON.stringify({ ...session, sessionId: session.sessionId ?? randomUUID() }),
    'NX',
  );
  return result === 'OK';
}

export async function getVoiceSession(guildId: string, userId: string): Promise<VoiceSession | null> {
  const r = getRedis();
  const data = await r.get(`${REDIS_SESSION_PREFIX}:${guildId}:${userId}`);
  if (!data) return null;
  const session = parseVoiceSession(data, guildId, userId);
  if (!session) await r.del(`${REDIS_SESSION_PREFIX}:${guildId}:${userId}`);
  return session;
}

export async function hasVoiceSession(guildId: string, userId: string): Promise<boolean> {
  const r = getRedis();
  const exists = await r.exists(`${REDIS_SESSION_PREFIX}:${guildId}:${userId}`);
  return exists === 1;
}

export async function deleteVoiceSession(guildId: string, userId: string): Promise<void> {
  const r = getRedis();
  await r.del(`${REDIS_SESSION_PREFIX}:${guildId}:${userId}`);
}

/**
 * Atomically detach the current session and persist its settlement before a new
 * session can replace it. The pending row has no TTL: accounting must survive
 * restarts and temporary database outages.
 */
export async function closeVoiceSessionToOutbox(
  guildId: string,
  userId: string,
  session: VoiceSession,
  endedAt = Date.now(),
): Promise<{ closed: boolean; pending: PendingVoiceSettlement | null }> {
  const r = getRedis();
  const pending = buildPendingVoiceSettlement(guildId, userId, session, endedAt);
  const pendingKey = pendingVoiceSettlementKey(session.sessionId);
  const changed = await r.eval(
    CLOSE_SESSION_SCRIPT,
    2,
    `${REDIS_SESSION_PREFIX}:${guildId}:${userId}`,
    pendingKey,
    session.sessionId,
    session.channelId,
    String(session.joinedAt),
    pending ? JSON.stringify(pending) : '',
  );
  const closed = Number(changed) === 1;
  return { closed, pending: closed ? pending : null };
}

export async function deletePendingVoiceSettlement(sessionId: string): Promise<void> {
  await getRedis().del(pendingVoiceSettlementKey(sessionId));
}

/** Enumerate durable accounting rows without discarding a row we cannot decode. */
export async function listPendingVoiceSettlements(): Promise<PendingVoiceSettlement[]> {
  const r = getRedis();
  const keys: string[] = [];
  let cursor = '0';
  do {
    const [nextCursor, page] = await r.scan(
      cursor,
      'MATCH',
      `${REDIS_PENDING_SETTLEMENT_PREFIX}*`,
      'COUNT',
      100,
    );
    cursor = nextCursor;
    keys.push(...page);
  } while (cursor !== '0');

  if (keys.length === 0) return [];
  const values = await r.mget(...keys);
  const pending: PendingVoiceSettlement[] = [];
  for (let index = 0; index < keys.length; index++) {
    try {
      const value: unknown = values[index] ? JSON.parse(values[index]!) : null;
      if (isPendingVoiceSettlement(value)) pending.push(value);
    } catch { /* preserve malformed durable data for manual recovery */ }
  }
  return pending;
}

export interface StoredVoiceSession {
  guildId: string;
  userId: string;
  session: VoiceSession;
}

/** Enumerate persisted sessions so startup removes only genuinely stale rows. */
export async function listVoiceSessions(): Promise<StoredVoiceSession[]> {
  const r = getRedis();
  const prefix = `${REDIS_SESSION_PREFIX}:`;
  const keys: string[] = [];
  let cursor = '0';
  do {
    const [nextCursor, page] = await r.scan(cursor, 'MATCH', `${prefix}*`, 'COUNT', 100);
    cursor = nextCursor;
    keys.push(...page);
  } while (cursor !== '0');

  if (keys.length === 0) return [];
  const values = await r.mget(...keys);
  const result: StoredVoiceSession[] = [];
  const invalidKeys: string[] = [];
  for (let index = 0; index < keys.length; index++) {
    const suffix = keys[index].slice(prefix.length);
    const splitAt = suffix.indexOf(':');
    if (splitAt < 1 || !values[index]) {
      invalidKeys.push(keys[index]);
      continue;
    }
    const guildId = suffix.slice(0, splitAt);
    const userId = suffix.slice(splitAt + 1);
    const session = parseVoiceSession(values[index]!, guildId, userId);
    if (session) result.push({ guildId, userId, session });
    else invalidKeys.push(keys[index]);
  }
  if (invalidKeys.length > 0) await r.del(...invalidKeys);
  return result;
}
