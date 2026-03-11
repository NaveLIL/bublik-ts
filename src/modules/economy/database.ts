// ═══════════════════════════════════════════════
//  Economy — CRUD с Redis-кэшированием
//
//  EconomyConfig:  настройки гильдии
//  EconomyProfile: кошелёк + банк пользователя
//  EconomyTransaction: история операций
// ═══════════════════════════════════════════════

import { getDatabase } from '../../core/Database';
import { getRedis } from '../../core/Redis';
import { REDIS_ECO_CONFIG, REDIS_ECO_PROFILE, CONFIG_CACHE_TTL, PROFILE_CACHE_TTL } from './constants';

// ═══════════════════════════════════════════════
//  EconomyConfig
// ═══════════════════════════════════════════════

/** Получить конфиг экономики гильдии (с кэшем) */
export async function getEcoConfig(guildId: string) {
  const r = getRedis();
  const key = `${REDIS_ECO_CONFIG}:${guildId}`;
  const cached = await r.get(key);
  if (cached) return JSON.parse(cached);

  const config = await getDatabase().economyConfig.findUnique({ where: { guildId } });
  if (config) {
    const serializable = serializeConfig(config);
    await r.setex(key, CONFIG_CACHE_TTL, JSON.stringify(serializable));
    return serializable;
  }
  return null;
}

/** Создать или обновить конфиг экономики */
export async function upsertEcoConfig(guildId: string, data: Record<string, any>) {
  const config = await getDatabase().economyConfig.upsert({
    where: { guildId },
    create: { guildId, ...data },
    update: data,
  });

  const key = `${REDIS_ECO_CONFIG}:${guildId}`;
  const serializable = serializeConfig(config);
  await getRedis().setex(key, CONFIG_CACHE_TTL, JSON.stringify(serializable));
  return config;
}

/** Удалить конфиг */
export async function deleteEcoConfig(guildId: string) {
  await getDatabase().economyConfig.deleteMany({ where: { guildId } });
  await getRedis().del(`${REDIS_ECO_CONFIG}:${guildId}`);
}

/** Инвалидация кэша конфига */
export async function invalidateConfigCache(guildId: string) {
  await getRedis().del(`${REDIS_ECO_CONFIG}:${guildId}`);
}

// ═══════════════════════════════════════════════
//  EconomyProfile
// ═══════════════════════════════════════════════

/** Получить или создать профиль пользователя */
export async function getOrCreateProfile(guildId: string, userId: string) {
  const r = getRedis();
  const key = `${REDIS_ECO_PROFILE}:${guildId}:${userId}`;
  const cached = await r.get(key);
  if (cached) return JSON.parse(cached);

  const profile = await getDatabase().economyProfile.upsert({
    where: { guildId_userId: { guildId, userId } },
    create: { guildId, userId },
    update: {},
  });

  const serializable = serializeProfile(profile);
  await r.setex(key, PROFILE_CACHE_TTL, JSON.stringify(serializable));
  return serializable;
}

/** Обновить профиль (с инвалидацией кэша) */
export async function updateProfile(
  guildId: string,
  userId: string,
  data: Record<string, any>,
) {
  const profile = await getDatabase().economyProfile.update({
    where: { guildId_userId: { guildId, userId } },
    data,
  });

  await invalidateProfileCache(guildId, userId);
  return profile;
}

/** Инвалидация кэша профиля  */
export async function invalidateProfileCache(guildId: string, userId: string) {
  await getRedis().del(`${REDIS_ECO_PROFILE}:${guildId}:${userId}`);
}

/** Топ пользователей по сумме wallet + bank */
export async function getLeaderboard(guildId: string, limit = 10) {
  const db = getDatabase();

  // Используем raw SQL для правильной сортировки по wallet+bank
  const profiles = await db.$queryRaw<Array<{
    id: string; guildId: string; userId: string;
    wallet: number; bank: number; bankLimit: number;
    dailyStreak: number; totalEarned: bigint; totalSpent: bigint;
  }>>`
    SELECT * FROM "EconomyProfile"
    WHERE "guildId" = ${guildId}
    ORDER BY ("wallet" + "bank") DESC
    LIMIT ${limit}
  `;

  return profiles.map((p) => ({
    ...p,
    totalEarned: Number(p.totalEarned),
    totalSpent: Number(p.totalSpent),
  }));
}

// ═══════════════════════════════════════════════
//  EconomyTransaction
// ═══════════════════════════════════════════════

/** Записать транзакцию */
export async function createTransaction(data: {
  guildId: string;
  userId: string;
  type: string;
  amount: number;
  balance: number;
  profileId: string;
  targetId?: string;
  details?: string;
}) {
  return getDatabase().economyTransaction.create({ data });
}

/** Получить историю транзакций пользователя */
export async function getTransactionHistory(
  guildId: string,
  userId: string,
  limit = 10,
) {
  return getDatabase().economyTransaction.findMany({
    where: { guildId, userId },
    orderBy: { createdAt: 'desc' },
    take: limit,
  });
}

/** Количество транзакций определённого типа за период */
export async function countTransactions(
  guildId: string,
  userId: string,
  type: string,
  since: Date,
) {
  return getDatabase().economyTransaction.count({
    where: {
      guildId,
      userId,
      type,
      createdAt: { gte: since },
    },
  });
}

// ═══════════════════════════════════════════════
//  Утилиты сериализации (BigInt → number для JSON)
// ═══════════════════════════════════════════════

function serializeConfig(config: any) {
  return {
    ...config,
    dailyCooldown: Number(config.dailyCooldown),
    weeklyCooldown: Number(config.weeklyCooldown),
    workCooldown: Number(config.workCooldown),
    crimeCooldown: Number(config.crimeCooldown),
    begCooldown: Number(config.begCooldown),
  };
}

function serializeProfile(profile: any) {
  return {
    ...profile,
    totalEarned: Number(profile.totalEarned),
    totalSpent: Number(profile.totalSpent),
  };
}
