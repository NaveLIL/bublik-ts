// ═══════════════════════════════════════════════
//  TempVoice — работа с базой данных
// ═══════════════════════════════════════════════

import { getDatabase } from '../../core/Database';
import { cacheGet, cacheSet, cacheDel } from '../../core/Redis';
import type {
  TempvoiceGenerator,
  TempvoiceChannel,
  TempvoiceUserSettings,
} from '@prisma/client';

const CACHE_TTL = 600; // 10 минут

// ═══════════════════════════════════════════════
//  Генераторы
// ═══════════════════════════════════════════════

/** Получить генератор по ID голосового канала */
export async function getGenerator(channelId: string): Promise<TempvoiceGenerator | null> {
  const cacheKey = `tv:gen:${channelId}`;
  const cached = await cacheGet<TempvoiceGenerator>(cacheKey);
  if (cached) return cached;

  const db = getDatabase();
  const gen = await db.tempvoiceGenerator.findUnique({
    where: { channelId },
  });

  if (gen) await cacheSet(cacheKey, gen, CACHE_TTL);
  return gen;
}

/** Получить генератор по внутреннему ID (cuid) */
export async function getGeneratorById(id: string): Promise<TempvoiceGenerator | null> {
  const cacheKey = `tv:gen:id:${id}`;
  const cached = await cacheGet<TempvoiceGenerator>(cacheKey);
  if (cached) return cached;

  const db = getDatabase();
  const gen = await db.tempvoiceGenerator.findUnique({
    where: { id },
  });

  if (gen) await cacheSet(cacheKey, gen, CACHE_TTL);
  return gen;
}

/** Получить все генераторы гильдии */
export async function getGuildGenerators(guildId: string): Promise<TempvoiceGenerator[]> {
  const db = getDatabase();
  return db.tempvoiceGenerator.findMany({ where: { guildId } });
}

/** Создать генератор */
export async function createGenerator(data: {
  guildId: string;
  channelId: string;
  categoryId: string;
  defaultName?: string;
  immuneRoleIds?: string[];
}): Promise<TempvoiceGenerator> {
  const db = getDatabase();
  const gen = await db.tempvoiceGenerator.create({ data });
  await cacheSet(`tv:gen:${data.channelId}`, gen, CACHE_TTL);
  return gen;
}

/** Обновить генератор */
export async function updateGenerator(
  channelId: string,
  data: Partial<Omit<TempvoiceGenerator, 'id' | 'createdAt' | 'updatedAt'>>,
): Promise<TempvoiceGenerator> {
  const db = getDatabase();
  const gen = await db.tempvoiceGenerator.update({
    where: { channelId },
    data,
  });
  await cacheSet(`tv:gen:${channelId}`, gen, CACHE_TTL);
  // Инвалидировать кэш по ID тоже
  await cacheDel(`tv:gen:id:${gen.id}`);
  return gen;
}

/** Удалить генератор */
export async function deleteGenerator(channelId: string): Promise<void> {
  const db = getDatabase();
  const gen = await db.tempvoiceGenerator.findUnique({ where: { channelId } });
  // deleteMany is idempotent for an already-removed row but still propagates
  // real database failures to the caller.
  await db.tempvoiceGenerator.deleteMany({ where: { channelId } });
  await cacheDel(`tv:gen:${channelId}`);
  if (gen) await cacheDel(`tv:gen:id:${gen.id}`);
}

// ═══════════════════════════════════════════════
//  Активные каналы
// ═══════════════════════════════════════════════

/** Получить канал по ID */
export async function getChannel(channelId: string): Promise<TempvoiceChannel | null> {
  const cacheKey = `tv:ch:${channelId}`;
  const cached = await cacheGet<TempvoiceChannel>(cacheKey);
  if (cached) return cached;

  const db = getDatabase();
  const ch = await db.tempvoiceChannel.findUnique({
    where: { id: channelId },
  });

  if (ch) await cacheSet(cacheKey, ch, CACHE_TTL);
  return ch;
}

/** Получить все каналы пользователя */
export async function getUserChannels(ownerId: string, guildId: string): Promise<TempvoiceChannel[]> {
  const db = getDatabase();
  return db.tempvoiceChannel.findMany({ where: { ownerId, guildId } });
}

/** Создать запись канала */
export async function createChannel(data: {
  id: string;
  guildId: string;
  ownerId: string;
  generatorId: string;
  state?: string;
}): Promise<TempvoiceChannel> {
  const db = getDatabase();
  const ch = await db.tempvoiceChannel.create({ data });
  await cacheSet(`tv:ch:${data.id}`, ch, CACHE_TTL);
  return ch;
}

/** Обновить канал */
export async function updateChannel(
  channelId: string,
  data: Partial<Omit<TempvoiceChannel, 'id' | 'createdAt'>>,
): Promise<TempvoiceChannel> {
  const db = getDatabase();
  const ch = await db.tempvoiceChannel.update({
    where: { id: channelId },
    data: { ...data, lastActivity: new Date() },
  });
  await cacheSet(`tv:ch:${channelId}`, ch, CACHE_TTL);
  return ch;
}

/** Compare-and-set ownership; exactly one concurrent claimant can win. */
export async function transferChannelOwnership(
  channelId: string,
  expectedOwnerId: string,
  newOwnerId: string,
): Promise<TempvoiceChannel | null> {
  const db = getDatabase();
  const claimed = await db.tempvoiceChannel.updateMany({
    where: { id: channelId, ownerId: expectedOwnerId },
    data: { ownerId: newOwnerId, lastActivity: new Date() },
  });
  if (claimed.count !== 1) {
    await cacheDel(`tv:ch:${channelId}`);
    return null;
  }
  const updated = await db.tempvoiceChannel.findUnique({ where: { id: channelId } });
  if (updated) await cacheSet(`tv:ch:${channelId}`, updated, CACHE_TTL);
  return updated;
}

/** Compare-and-set channel state to prevent double-click lost updates. */
export async function updateChannelState(
  channelId: string,
  expectedState: string,
  newState: string,
): Promise<TempvoiceChannel | null> {
  const db = getDatabase();
  const changed = await db.tempvoiceChannel.updateMany({
    where: { id: channelId, state: expectedState },
    data: { state: newState, lastActivity: new Date() },
  });
  if (changed.count !== 1) {
    await cacheDel(`tv:ch:${channelId}`);
    return null;
  }
  const updated = await db.tempvoiceChannel.findUnique({ where: { id: channelId } });
  if (updated) await cacheSet(`tv:ch:${channelId}`, updated, CACHE_TTL);
  return updated;
}

/** Удалить запись канала */
export async function deleteChannel(channelId: string): Promise<void> {
  const db = getDatabase();
  await db.tempvoiceChannel.deleteMany({ where: { id: channelId } });
  await cacheDel(`tv:ch:${channelId}`);
}

/** Получить все активные каналы гильдии */
export async function getGuildChannels(guildId: string): Promise<TempvoiceChannel[]> {
  const db = getDatabase();
  return db.tempvoiceChannel.findMany({ where: { guildId } });
}

/** Получить активные каналы конкретного генератора. */
export async function getGeneratorChannels(generatorId: string): Promise<TempvoiceChannel[]> {
  return getDatabase().tempvoiceChannel.findMany({ where: { generatorId } });
}

/** Получить все неактивные каналы (старше maxAge мс) */
export async function getInactiveChannels(maxAgeMs: number): Promise<TempvoiceChannel[]> {
  const db = getDatabase();
  const cutoff = new Date(Date.now() - maxAgeMs);
  return db.tempvoiceChannel.findMany({
    where: { lastActivity: { lt: cutoff } },
  });
}

// ═══════════════════════════════════════════════
//  Доверенные / заблокированные
// ═══════════════════════════════════════════════

/** Добавить доверенного пользователя */
export async function addTrusted(channelId: string, userId: string): Promise<void> {
  const db = getDatabase();
  await db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "tempvoice_channels" WHERE "id" = ${channelId} FOR UPDATE`;
    await tx.tempvoiceBlocked.deleteMany({ where: { channelId, userId } });
    await tx.tempvoiceTrusted.upsert({
      where: { channelId_userId: { channelId, userId } },
      create: { channelId, userId },
      update: {},
    });
  });
}

/** Удалить доверенного пользователя */
export async function removeTrusted(channelId: string, userId: string): Promise<void> {
  const db = getDatabase();
  await db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "tempvoice_channels" WHERE "id" = ${channelId} FOR UPDATE`;
    await tx.tempvoiceTrusted.deleteMany({ where: { channelId, userId } });
  });
}

/** Получить список доверенных */
export async function getTrusted(channelId: string): Promise<string[]> {
  const db = getDatabase();
  const rows = await db.tempvoiceTrusted.findMany({
    where: { channelId },
    select: { userId: true },
  });
  return rows.map((r) => r.userId);
}

/** Добавить в блок-лист */
export async function addBlocked(channelId: string, userId: string): Promise<void> {
  const db = getDatabase();
  await db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "tempvoice_channels" WHERE "id" = ${channelId} FOR UPDATE`;
    await tx.tempvoiceTrusted.deleteMany({ where: { channelId, userId } });
    await tx.tempvoiceBlocked.upsert({
      where: { channelId_userId: { channelId, userId } },
      create: { channelId, userId },
      update: {},
    });
  });
}

/** Убрать из блок-листа */
export async function removeBlocked(channelId: string, userId: string): Promise<void> {
  const db = getDatabase();
  await db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "tempvoice_channels" WHERE "id" = ${channelId} FOR UPDATE`;
    await tx.tempvoiceBlocked.deleteMany({ where: { channelId, userId } });
  });
}

/** Получить список заблокированных */
export async function getBlocked(channelId: string): Promise<string[]> {
  const db = getDatabase();
  const rows = await db.tempvoiceBlocked.findMany({
    where: { channelId },
    select: { userId: true },
  });
  return rows.map((r) => r.userId);
}

// ═══════════════════════════════════════════════
//  Пользовательские настройки
// ═══════════════════════════════════════════════

/** Получить сохранённые настройки пользователя */
export async function getUserSettings(
  userId: string,
  guildId: string,
): Promise<TempvoiceUserSettings | null> {
  const db = getDatabase();
  return db.tempvoiceUserSettings.findUnique({
    where: { userId_guildId: { userId, guildId } },
  });
}

/** Сохранить настройки пользователя */
export async function saveUserSettings(
  userId: string,
  guildId: string,
  data: { savedName?: string; savedLimit?: number; savedBitrate?: number; savedRegion?: string },
): Promise<void> {
  const db = getDatabase();
  await db.tempvoiceUserSettings.upsert({
    where: { userId_guildId: { userId, guildId } },
    create: { userId, guildId, ...data },
    update: data,
  });
}

/** Persist a completed Redis voice session exactly once. */
export async function addVoiceMinutesOnce(
  userId: string,
  guildId: string,
  minutes: number,
  sessionId: string,
): Promise<{ settings: TempvoiceUserSettings; applied: boolean }> {
  const db = getDatabase();
  return db.$transaction(async (tx) => {
    const claim = await tx.operationClaim.createMany({
      data: [{
        key: `tempvoice:voice:${guildId}:${userId}:${sessionId}`,
        scope: 'tempvoice_voice_session',
        guildId,
        userId,
        metadata: { minutes },
        // The Redis outbox deliberately has no TTL. Expiring this claim could
        // replay an acknowledged-but-not-yet-deleted outbox row months later.
        expiresAt: null,
      }],
      skipDuplicates: true,
    });

    const settings = await tx.tempvoiceUserSettings.upsert({
      where: { userId_guildId: { userId, guildId } },
      create: { userId, guildId, totalVoiceMinutes: claim.count === 1 ? minutes : 0 },
      update: claim.count === 1 ? { totalVoiceMinutes: { increment: minutes } } : {},
    });
    return { settings, applied: claim.count === 1 };
  });
}

export async function cleanupExpiredVoiceClaims(guildIds: string[]): Promise<number> {
  if (guildIds.length === 0) return 0;
  const result = await getDatabase().operationClaim.deleteMany({
    where: {
      scope: 'tempvoice_voice_session',
      guildId: { in: guildIds },
      expiresAt: { lte: new Date() },
    },
  });
  return result.count;
}

/** Отметить что награда выдана */
export async function markRewardGranted(userId: string, guildId: string): Promise<void> {
  const db = getDatabase();
  await db.tempvoiceUserSettings.upsert({
    where: { userId_guildId: { userId, guildId } },
    create: { userId, guildId, rewardGranted: true },
    update: { rewardGranted: true },
  });
}

/** Получить топ пользователей по голосовому времени */
export async function getVoiceLeaderboard(guildId: string, limit = 10): Promise<TempvoiceUserSettings[]> {
  const db = getDatabase();
  return db.tempvoiceUserSettings.findMany({
    where: { guildId, totalVoiceMinutes: { gt: 0 } },
    orderBy: { totalVoiceMinutes: 'desc' },
    take: limit,
  });
}
