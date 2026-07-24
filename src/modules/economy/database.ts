// ═══════════════════════════════════════════════
//  Economy — CRUD с Redis-кэшированием
//
//  EconomyConfig:  настройки гильдии
//  EconomyProfile: кошелёк + банк пользователя
//  EconomyTransaction: история операций
// ═══════════════════════════════════════════════

import { getDatabase } from '../../core/Database';
import { getRedis } from '../../core/Redis';
import { logger } from '../../core/Logger';
import type { Prisma } from '@prisma/client';
import {
  REDIS_ECO_CONFIG,
  REDIS_ECO_PROFILE,
  CONFIG_CACHE_TTL,
  PROFILE_CACHE_TTL,
  WANTED_DEFAULTS,
} from './constants';
import { addInventoryItem } from './inventory';
import { mutateCacheBestEffort, readThroughJsonCache, type CacheFailurePhase } from './cache-aside';
import { rebuildPbVoiceSecondsFromRecords } from './voice-reward-metadata';
import { getUserPerks } from './perks';

const log = logger.child('Economy:Database');

function reportCacheFailure(
  resource: 'config' | 'profile',
  guildId: string,
  phase: CacheFailurePhase,
  error: unknown,
  userId?: string,
): void {
  log.warn('Economy cache operation failed; durable database remains authoritative', {
    resource,
    guildId,
    userId,
    phase,
    error: String(error),
  });
}

// ═══════════════════════════════════════════════
//  EconomyConfig
// ═══════════════════════════════════════════════

/** Получить pbRoleIds из кэшированного конфига (утилита) */
export async function getPbRoleIds(guildId: string): Promise<string[]> {
  const config = await getEcoConfig(guildId);
  return config?.pbRoleIds ?? [];
}

/** Получить конфиг экономики гильдии (с кэшем) */
export async function getEcoConfig(guildId: string) {
  const key = `${REDIS_ECO_CONFIG}:${guildId}`;
  return readThroughJsonCache({
    coherenceKey: key,
    readCache: () => getRedis().get(key),
    readSource: () => getDatabase().economyConfig.findUnique({ where: { guildId } }),
    serialize: serializeConfig,
    writeCache: (encoded) => getRedis().setex(key, CONFIG_CACHE_TTL, encoded),
    validateCached: (value) => Boolean(
      value
      && typeof value === 'object'
      && !Array.isArray(value)
      && (value as { guildId?: unknown }).guildId === guildId
    ),
    onCacheFailure: (phase, error) => reportCacheFailure('config', guildId, phase, error),
  });
}

/** Создать или обновить конфиг экономики */
export async function upsertEcoConfig(guildId: string, data: Record<string, any>) {
  const config = await getDatabase().economyConfig.upsert({
    where: { guildId },
    create: { guildId, ...data },
    update: data,
  });
  await invalidateConfigCache(guildId);
  return config;
}

/** Удалить конфиг */
export async function deleteEcoConfig(guildId: string) {
  await getDatabase().economyConfig.deleteMany({ where: { guildId } });
  await invalidateConfigCache(guildId);
}

/** Инвалидация кэша конфига */
export async function invalidateConfigCache(guildId: string) {
  const key = `${REDIS_ECO_CONFIG}:${guildId}`;
  await mutateCacheBestEffort(
    () => getRedis().del(key),
    (phase, error) => reportCacheFailure('config', guildId, phase, error),
    key,
    CONFIG_CACHE_TTL * 1_000,
  );
}

/** Увеличить сумму джекпота слотов */
export async function incrementSlotsJackpot(guildId: string, amount: number): Promise<number> {
  const db = getDatabase();
  const config = await db.economyConfig.update({
    where: { guildId },
    data: { slotsJackpot: { increment: amount } },
  });
  await invalidateConfigCache(guildId);
  return config.slotsJackpot;
}

/** Сбросить джекпот слотов к начальному значению (seed) */
export async function resetSlotsJackpot(guildId: string, seed = 1000): Promise<void> {
  const db = getDatabase();
  await db.economyConfig.update({
    where: { guildId },
    data: { slotsJackpot: seed },
  });
  await invalidateConfigCache(guildId);
}

// ═══════════════════════════════════════════════
//  EconomyProfile
// ═══════════════════════════════════════════════

/** Получить или создать профиль пользователя */
export async function getOrCreateProfile(guildId: string, userId: string) {
  const key = `${REDIS_ECO_PROFILE}:${guildId}:${userId}`;
  return readThroughJsonCache({
    coherenceKey: key,
    readCache: () => getRedis().get(key),
    readSource: () => getDatabase().economyProfile.upsert({
      where: { guildId_userId: { guildId, userId } },
      create: { guildId, userId },
      update: {},
    }),
    serialize: serializeProfile,
    writeCache: (encoded) => getRedis().setex(key, PROFILE_CACHE_TTL, encoded),
    validateCached: (value) => Boolean(
      value
      && typeof value === 'object'
      && !Array.isArray(value)
      && (value as { guildId?: unknown }).guildId === guildId
      && (value as { userId?: unknown }).userId === userId
    ),
    onCacheFailure: (phase, error) => reportCacheFailure('profile', guildId, phase, error, userId),
  });
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
  const key = `${REDIS_ECO_PROFILE}:${guildId}:${userId}`;
  await mutateCacheBestEffort(
    () => getRedis().del(key),
    (phase, error) => reportCacheFailure('profile', guildId, phase, error, userId),
    key,
    PROFILE_CACHE_TTL * 1_000,
  );
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
    SELECT * FROM "economy_profiles"
    WHERE "guildId" = ${guildId}
    ORDER BY ("wallet" + "bank") DESC
    LIMIT ${limit}::int
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

/**
 * Восстановить накопленные PB voice-секунды из истории транзакций.
 * 1 транзакция earn_voice = 10 минут активного тика.
 */
export async function rebuildPbVoiceSecondsFromTransactions(
  guildId: string,
  userId: string,
): Promise<number> {
  const records = await getDatabase().economyTransaction.findMany({
    where: {
      guildId,
      userId,
      type: 'earn_voice',
    },
    select: { targetId: true, details: true },
    orderBy: { createdAt: 'asc' },
  });

  return rebuildPbVoiceSecondsFromRecords(records);
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
    robCooldown: Number(config.robCooldown),
    heistCooldownInit: Number(config.heistCooldownInit ?? 0),
    heistCooldownMember: Number(config.heistCooldownMember ?? 0),
    wantedDecayMs: Number(config.wantedDecayMs ?? 0),
    wantedCaptureCooldown: Number(config.wantedCaptureCooldown ?? 0),
    dirtyExpireMs: Number(config.dirtyExpireMs ?? 0),
    safeDurationMs: Number(config.safeDurationMs ?? 0),
  };
}

// ═══════════════════════════════════════════════
//  Heist (CRUD)
// ═══════════════════════════════════════════════

const HEIST_MEMBERSHIP_GRACE_MS = 10 * 60_000;
const TERMINAL_HEIST_STATUSES = new Set(['success', 'fail', 'cancelled', 'expired']);

export function heistMembershipClaimKey(guildId: string, userId: string): string {
  return `heist-membership:${guildId}:${userId}`;
}

export function isHeistMembershipClaimReclaimable(
  expiresAt: Date | null,
  ownerStatus: string | null,
  nowMs = Date.now(),
): boolean {
  if (ownerStatus !== null && TERMINAL_HEIST_STATUSES.has(ownerStatus)) return true;
  if (ownerStatus !== null) return false;
  return expiresAt !== null && expiresAt.getTime() <= nowMs;
}

function heistIdFromClaimMetadata(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null;
  const heistId = (metadata as Record<string, unknown>).heistId;
  return typeof heistId === 'string' && heistId.length > 0 ? heistId : null;
}

async function claimHeistMembership(
  tx: Prisma.TransactionClient,
  guildId: string,
  userId: string,
  heistId: string,
  expiresAt: Date,
): Promise<boolean> {
  const claimKey = heistMembershipClaimKey(guildId, userId);
  await tx.$queryRaw`SELECT "key" FROM "operation_claims" WHERE "key" = ${claimKey} FOR UPDATE`;
  const existing = await tx.operationClaim.findUnique({ where: { key: claimKey } });

  if (existing) {
    const ownerHeistId = heistIdFromClaimMetadata(existing.metadata);
    const owner = ownerHeistId
      ? await tx.economyHeist.findUnique({ where: { id: ownerHeistId }, select: { status: true } })
      : null;
    if (!isHeistMembershipClaimReclaimable(existing.expiresAt, owner?.status ?? null)) return false;
    await tx.operationClaim.deleteMany({
      where: {
        key: claimKey,
        scope: 'heist_membership',
        ...(ownerHeistId
          ? { metadata: { path: ['heistId'], equals: ownerHeistId } }
          : {}),
      },
    });
  }

  const claimed = await tx.operationClaim.createMany({
    data: [{
      key: claimKey,
      scope: 'heist_membership',
      guildId,
      userId,
      metadata: { heistId },
      expiresAt,
    }],
    skipDuplicates: true,
  });
  return claimed.count === 1;
}

export async function releaseHeistMembershipClaims(
  guildId: string,
  heistId: string,
  userIds: string[],
  database: Pick<Prisma.TransactionClient, 'operationClaim'> = getDatabase(),
): Promise<void> {
  if (userIds.length === 0) return;
  await database.operationClaim.deleteMany({
    where: {
      key: { in: userIds.map((userId) => heistMembershipClaimKey(guildId, userId)) },
      scope: 'heist_membership',
      metadata: { path: ['heistId'], equals: heistId },
    },
  });
}

export async function createHeist(data: {
  guildId: string;
  initiatorId: string;
  victimId: string;
  channelId: string;
  expiresAt: Date;
}) {
  const db = getDatabase();
  return db.$transaction(async (tx) => {
    const heist = await tx.economyHeist.create({
      data: {
        ...data,
        status: 'assembling',
        members: { create: { userId: data.initiatorId } },
      },
      include: { members: true },
    });
    const claimed = await claimHeistMembership(
      tx,
      data.guildId,
      data.initiatorId,
      heist.id,
      new Date(data.expiresAt.getTime() + HEIST_MEMBERSHIP_GRACE_MS),
    );
    if (!claimed) throw new Error('heist_membership_active');
    return heist;
  });
}

export async function getHeist(heistId: string) {
  return getDatabase().economyHeist.findUnique({
    where: { id: heistId },
    include: { members: true },
  });
}

export async function getActiveHeistForInitiator(guildId: string, initiatorId: string) {
  return getDatabase().economyHeist.findFirst({
    where: { guildId, initiatorId, status: { in: ['assembling', 'running'] } },
    include: { members: true },
  });
}

export async function setHeistMessage(heistId: string, messageId: string) {
  return getDatabase().economyHeist.update({
    where: { id: heistId },
    data: { messageId },
  });
}

export async function joinHeistMember(
  heistId: string,
  userId: string,
  maxMembers: number,
): Promise<{ type: 'ok' | 'expired' | 'already' | 'full' }> {
  const db = getDatabase();
  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "economy_heists" WHERE "id" = ${heistId} FOR UPDATE`;
    const heist = await tx.economyHeist.findUnique({
      where: { id: heistId },
      include: { members: true },
    });
    if (!heist || heist.status !== 'assembling' || heist.expiresAt.getTime() <= Date.now()) {
      return { type: 'expired' };
    }
    if (heist.members.some((member) => member.userId === userId)) return { type: 'already' };
    if (heist.members.length >= maxMembers) return { type: 'full' };

    const claimed = await claimHeistMembership(
      tx,
      heist.guildId,
      userId,
      heistId,
      new Date(heist.expiresAt.getTime() + HEIST_MEMBERSHIP_GRACE_MS),
    );
    if (!claimed) return { type: 'already' };

    await tx.economyHeistMember.create({ data: { heistId, userId } });
    return { type: 'ok' };
  });
}

export async function getExpiredAssemblingHeists() {
  return getDatabase().economyHeist.findMany({
    where: { status: 'assembling', expiresAt: { lte: new Date() } },
    include: { members: true },
  });
}

// ═══════════════════════════════════════════════
//  Wanted
// ═══════════════════════════════════════════════

/**
 * Прибавить звезду розыска. Если decay-таймер не запущен —
 * выставляется now + decayMs. Иначе сохраняется текущий.
 */
export async function addWantedStar(
  guildId: string,
  userId: string,
  decayMs: number,
): Promise<{ stars: number }> {
  const db = getDatabase();
  const decayDate = new Date(Date.now() + decayMs);
  const updatedStars = await db.$transaction(async (tx) => {
    const profile = await tx.economyProfile.upsert({
      where: { guildId_userId: { guildId, userId } },
      create: { guildId, userId },
      update: {},
    });
    await tx.$queryRaw`SELECT "id" FROM "economy_profiles" WHERE "id" = ${profile.id} FOR UPDATE`;
    const fresh = await tx.economyProfile.findUniqueOrThrow({ where: { id: profile.id } });
    const updated = await tx.economyProfile.update({
      where: { id: fresh.id },
      data: {
        wantedStars: { increment: 1 },
        wantedNextDecay: fresh.wantedNextDecay ?? decayDate,
      },
      select: { wantedStars: true },
    });
    return updated.wantedStars;
  });

  await invalidateProfileCache(guildId, userId);
  return { stars: updatedStars };
}

export function calculateEffectiveWantedDecayMs(baseDecayMs: unknown, multiplier: unknown): number {
  const numericBase = Number(baseDecayMs);
  const safeBase = Number.isSafeInteger(numericBase) && numericBase >= 60_000
    ? numericBase
    : WANTED_DEFAULTS.decayMs;
  const numericMultiplier = Number(multiplier);
  const safeMultiplier = Number.isFinite(numericMultiplier)
    ? Math.max(0.3, Math.min(2, numericMultiplier))
    : 1;
  const effective = Math.floor(safeBase * safeMultiplier);
  return Number.isSafeInteger(effective) ? Math.max(60_000, effective) : WANTED_DEFAULTS.decayMs;
}

export function wantedDecayAfterIncrement(
  current: Date | null,
  now: number,
  effectiveDecayMs: number,
): Date {
  if (current && Number.isFinite(current.getTime())) return current;
  const safeNow = Number.isFinite(now) ? now : Date.now();
  const safeDecay = calculateEffectiveWantedDecayMs(effectiveDecayMs, 1);
  return new Date(safeNow + safeDecay);
}

/** Просканировать due-профили и снять по одной звезде (опционально по конкретной гильдии). */
export async function decayWantedStars(decayMs: number, guildId?: string): Promise<number> {
  const db = getDatabase();
  const due = await db.economyProfile.findMany({
    where: {
      ...(guildId ? { guildId } : {}),
      wantedStars: { gt: 0 },
      wantedNextDecay: { lte: new Date() },
    },
    select: { id: true, guildId: true, userId: true, wantedStars: true },
  });

  if (due.length === 0) return 0;

  let decayed = 0;
  for (const candidate of due) {
    const perks = await getUserPerks(candidate.guildId, candidate.userId);
    const effectiveDecayMs = calculateEffectiveWantedDecayMs(decayMs, perks.wantedDecayMul);
    const changed = await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "economy_profiles" WHERE "id" = ${candidate.id} FOR UPDATE`;
      const fresh = await tx.economyProfile.findUnique({ where: { id: candidate.id } });
      if (
        !fresh ||
        fresh.wantedStars <= 0 ||
        !fresh.wantedNextDecay ||
        fresh.wantedNextDecay.getTime() > Date.now()
      ) return false;

      const newStars = fresh.wantedStars - 1;
      await tx.economyProfile.update({
        where: { id: fresh.id },
        data: {
          wantedStars: newStars,
          wantedNextDecay: newStars > 0 ? new Date(Date.now() + effectiveDecayMs) : null,
        },
      });
      return true;
    });
    if (changed) {
      decayed++;
      await invalidateProfileCache(candidate.guildId, candidate.userId);
    }
  }

  return decayed;
}

/** Топ разыскиваемых */
export async function getWantedTop(guildId: string, limit = 10) {
  return getDatabase().economyProfile.findMany({
    where: { guildId, wantedStars: { gt: 0 } },
    orderBy: [{ wantedStars: 'desc' }, { updatedAt: 'desc' }],
    take: limit,
    select: { userId: true, wantedStars: true, wantedNextDecay: true },
  });
}

/** Был ли user недавней жертвой target (для capture-бонуса) */
export async function wasRecentVictim(
  guildId: string,
  hunterId: string,
  robberId: string,
  withinMs: number,
): Promise<boolean> {
  const since = new Date(Date.now() - withinMs);
  const count = await getDatabase().economyTransaction.count({
    where: {
      guildId,
      userId: hunterId,
      targetId: robberId,
      type: { in: ['rob_victim', 'heist_victim'] },
      createdAt: { gte: since },
    },
  });
  return count > 0;
}

// ═══════════════════════════════════════════════
//  Сейф / Отмычка
// ═══════════════════════════════════════════════

export function isSafeActive(profile: { safeUntil?: Date | null } | null): boolean {
  if (!profile?.safeUntil) return false;
  return new Date(profile.safeUntil).getTime() > Date.now();
}

// ═══════════════════════════════════════════════
//  Грязные деньги
// ═══════════════════════════════════════════════

/**
 * Пометить часть кошелька как «грязные» на expireMs.
 * Существующий dirtyAmount складывается, dirtyClearAt отодвигается на now+expireMs
 * (продлевается всегда, чтобы свежие грязные не «протухали» вместе со старыми).
 */
export async function addDirtyMoney(
  guildId: string,
  userId: string,
  amount: number,
  expireMs: number,
): Promise<void> {
  if (amount <= 0) return;
  await getDatabase().economyProfile.update({
    where: { guildId_userId: { guildId, userId } },
    data: {
      dirtyAmount: { increment: amount },
      dirtyClearAt: new Date(Date.now() + expireMs),
    },
  });
  await invalidateProfileCache(guildId, userId);
}

/**
 * Сбросить просроченные грязные (24ч прошло) — деньги становятся «чистыми» сами.
 * Возвращает кол-во затронутых профилей.
 */
export async function expireDirtyMoney(): Promise<number> {
  // Авто-списание отключено по просьбе пользователя. Деньги изымаются только при аресте.
  return 0;
}

// ═══════════════════════════════════════════════
//  Сейф / Отмычка (магазин)
// ═══════════════════════════════════════════════

async function debitInventoryPurchase(
  tx: any,
  profile: any,
  price: number,
  type: string,
  details: string,
): Promise<any | null> {
  await tx.$queryRaw`SELECT "id" FROM "economy_profiles" WHERE "id" = ${profile.id} FOR UPDATE`;
  const before = await tx.economyProfile.findUniqueOrThrow({ where: { id: profile.id } });
  if (before.wallet - before.dirtyAmount < price) return null;
  const debited = await tx.economyProfile.updateMany({
    where: { id: profile.id, wallet: { gte: price } },
    data: { wallet: { decrement: price }, totalSpent: { increment: BigInt(price) } },
  });
  if (debited.count !== 1) return null;
  let updated = await tx.economyProfile.findUniqueOrThrow({ where: { id: profile.id } });
  if (updated.dirtyAmount > updated.wallet) {
    updated = await tx.economyProfile.update({
      where: { id: profile.id },
      data: {
        dirtyAmount: Math.max(0, updated.wallet),
        dirtyClearAt: updated.wallet > 0 ? updated.dirtyClearAt : null,
      },
    });
  }
  await tx.economyTransaction.create({
    data: {
      guildId: profile.guildId,
      userId: profile.userId,
      type,
      amount: -price,
      balance: updated.wallet,
      profileId: profile.id,
      details,
    },
  });
  return updated;
}

/**
 * Купить сейф. Списывает price, ставит safeUntil = max(now, current) + durationMs.
 * Возвращает результат: ok / no_money / already_active.
 */
export async function buySafe(
  guildId: string,
  userId: string,
  price: number,
  durationMs: number,
): Promise<{ type: 'ok'; wallet: number } | { type: 'no_money'; need: number }> {
  const db = getDatabase();
  const result = await db.$transaction(async (tx) => {
    const profile = await tx.economyProfile.upsert({
      where: { guildId_userId: { guildId, userId } },
      create: { guildId, userId },
      update: {},
    });

    const updated = await debitInventoryPurchase(tx, profile, price, 'buy_safe', 'Safe item acquired in inventory');
    if (!updated) return { type: 'no_money' as const, need: price };

    await addInventoryItem(
      tx,
      guildId,
      userId,
      'safe',
      '💼 Сейф (Базовый)',
      'utility',
      1,
      { durationMs },
      `Защищает 50% ваших сбережений в банке от взлома на ${Math.max(1, Math.round(durationMs / 86_400_000))} дн. при активации.`
    );

    return { type: 'ok' as const, wallet: updated.wallet };
  });

  await invalidateProfileCache(guildId, userId);
  return result;
}

export async function buyLockpick(
  guildId: string,
  userId: string,
  price: number,
): Promise<{ type: 'ok'; wallet: number } | { type: 'no_money'; need: number }> {
  const db = getDatabase();
  const result = await db.$transaction(async (tx) => {
    const profile = await tx.economyProfile.upsert({
      where: { guildId_userId: { guildId, userId } },
      create: { guildId, userId },
      update: {},
    });

    const updated = await debitInventoryPurchase(tx, profile, price, 'buy_lockpick', 'Lockpick item acquired in inventory');
    if (!updated) return { type: 'no_money' as const, need: price };

    await addInventoryItem(
      tx,
      guildId,
      userId,
      'lockpick',
      '🔒 Отмычка для сейфов',
      'contraband',
      1,
      null,
      'Используется для взлома сейфов других игроков.'
    );

    return { type: 'ok' as const, wallet: updated.wallet };
  });

  await invalidateProfileCache(guildId, userId);
  return result;
}

export async function buyMask(
  guildId: string,
  userId: string,
  price: number,
): Promise<{ type: 'ok'; wallet: number } | { type: 'no_money'; need: number }> {
  const db = getDatabase();
  const result = await db.$transaction(async (tx) => {
    const profile = await tx.economyProfile.upsert({
      where: { guildId_userId: { guildId, userId } },
      create: { guildId, userId },
      update: {},
    });

    const updated = await debitInventoryPurchase(tx, profile, price, 'buy_mask', 'Mask item acquired in inventory');
    if (!updated) return { type: 'no_money' as const, need: price };

    await addInventoryItem(
      tx,
      guildId,
      userId,
      'mask',
      '🎭 Маска-балаклава',
      'contraband',
      1,
      null,
      'Скрывает ваше лицо во время краж и грабежей.'
    );

    return { type: 'ok' as const, wallet: updated.wallet };
  });

  await invalidateProfileCache(guildId, userId);
  return result;
}

/**
 * Атомарно «съесть» отмычку. Возвращает true если списали (была в наличии).
 * Используется в /rob — единичный +20% бонус.
 */
export async function consumeLockpick(guildId: string, userId: string): Promise<boolean> {
  const db = getDatabase();
  const res = await db.$transaction(async (tx) => {
    const item = await tx.economyInventoryItem.findUnique({
      where: { guildId_userId_itemKey: { guildId, userId, itemKey: 'lockpick' } }
    });
    if (!item || item.quantity <= 0) return false;

    if (item.quantity === 1) {
      await tx.economyInventoryItem.delete({
        where: { guildId_userId_itemKey: { guildId, userId, itemKey: 'lockpick' } }
      });
    } else {
      await tx.economyInventoryItem.update({
        where: { guildId_userId_itemKey: { guildId, userId, itemKey: 'lockpick' } },
        data: { quantity: { decrement: 1 } }
      });
    }
    return true;
  });

  if (res) {
    await invalidateProfileCache(guildId, userId);
  }
  return res;
}

/**
 * Атомарно «съесть» маску. Возвращает true если списали (была в наличии).
 * Используется в /rob — скрывает имя и защищает от звезд розыска.
 */
export async function consumeMask(guildId: string, userId: string): Promise<boolean> {
  const db = getDatabase();
  const res = await db.$transaction(async (tx) => {
    const item = await tx.economyInventoryItem.findUnique({
      where: { guildId_userId_itemKey: { guildId, userId, itemKey: 'mask' } }
    });
    if (!item || item.quantity <= 0) return false;

    if (item.quantity === 1) {
      await tx.economyInventoryItem.delete({
        where: { guildId_userId_itemKey: { guildId, userId, itemKey: 'mask' } }
      });
    } else {
      await tx.economyInventoryItem.update({
        where: { guildId_userId_itemKey: { guildId, userId, itemKey: 'mask' } },
        data: { quantity: { decrement: 1 } }
      });
    }
    return true;
  });

  if (res) {
    await invalidateProfileCache(guildId, userId);
  }
  return res;
}

function serializeProfile(profile: any) {
  return {
    ...profile,
    totalEarned: Number(profile.totalEarned),
    totalSpent: Number(profile.totalSpent),
  };
}

// ═══════════════════════════════════════════════
//  Штурм сейфа (Safe Raid)
// ═══════════════════════════════════════════════

/**
 * Находит участников, вышедших более 14 дней назад, списывает их баланс в 0,
 * записывает транзакцию и возвращает их ID и суммы для пополнения джекпота.
 */
export async function drainAbandonedBalances(
  guildId: string,
  minAbsenceMs: number,
  raidId: string | undefined,
  confirmAbsent: (userId: string) => Promise<boolean>,
): Promise<Array<{ userId: string; amount: number }>> {
  const db = getDatabase();
  const threshold = new Date(Date.now() - minAbsenceMs);

  // Найти всех LeftMember, покинувших сервер раньше threshold
  const leftUsers = await db.leftMember.findMany({
    where: { guildId, leftAt: { lte: threshold } },
  });

  if (leftUsers.length === 0) return [];

  const drained: Array<{ userId: string; amount: number }> = [];

  for (const left of leftUsers) {
    // Discord membership is authoritative; a stale LeftMember row alone must
    // never authorize an irreversible balance drain.
    if (!(await confirmAbsent(left.userId))) {
      await db.leftMember.deleteMany({ where: { id: left.id, guildId } });
      continue;
    }
    const item = await db.$transaction(async (tx) => {
      // deleteMany — once-only claim этой записи LeftMember.
      const claimed = await tx.leftMember.deleteMany({ where: { id: left.id, guildId } });
      if (claimed.count !== 1) return null;

      const profile = await tx.economyProfile.findUnique({
        where: { guildId_userId: { guildId, userId: left.userId } },
      });
      if (!profile || (profile.wallet <= 0 && profile.bank <= 0)) return null;

      await tx.$queryRaw`SELECT "id" FROM "economy_profiles" WHERE "id" = ${profile.id} FOR UPDATE`;
      const fresh = await tx.economyProfile.findUniqueOrThrow({ where: { id: profile.id } });
      const amount = Math.max(0, fresh.wallet) + Math.max(0, fresh.bank);
      if (amount <= 0) return null;

      await tx.economyProfile.update({
        where: { id: fresh.id },
        data: { wallet: 0, bank: 0, dirtyAmount: 0, dirtyClearAt: null },
      });
      await tx.economyTransaction.create({
        data: {
          guildId,
          userId: left.userId,
          type: 'abandoned_drain',
          amount: -amount,
          balance: 0,
          profileId: fresh.id,
          details: 'Balance drained due to absence > 14 days',
        },
      });

      if (raidId) {
        const raidClaim = await tx.economyRaid.updateMany({
          where: { id: raidId, guildId, status: 'pending', activeKey: guildId },
          data: { totalPool: { increment: amount } },
        });
        if (raidClaim.count !== 1) throw new Error('pending_raid_changed');
        await tx.economyRaidAbandoned.upsert({
          where: { raidId_userId: { raidId, userId: left.userId } },
          create: { raidId, userId: left.userId, balance: amount },
          update: { balance: { increment: amount } },
        });
      }
      return { userId: left.userId, amount };
    });

    if (item) {
      await invalidateProfileCache(guildId, left.userId);
      drained.push(item);
    }
  }

  return drained;
}

/** Получить или создать текущий аккумулирующий (pending) рейд */
export async function getOrCreatePendingRaid(guildId: string): Promise<any> {
  const db = getDatabase();
  return db.economyRaid.upsert({
    where: { activeKey: guildId },
    create: { guildId, activeKey: guildId, status: 'pending' },
    update: {},
    include: { abandonedAccounts: true },
  });
}

/** Добавить ушедшего игрока и его конфискованные деньги в pending-рейд */
export async function addToPendingRaid(
  raidId: string,
  userId: string,
  balance: number,
): Promise<void> {
  const db = getDatabase();
  await db.$transaction([
    db.economyRaidAbandoned.upsert({
      where: { raidId_userId: { raidId, userId } },
      create: { raidId, userId, balance },
      update: { balance: { increment: balance } },
    }),
    db.economyRaid.update({
      where: { id: raidId },
      data: { totalPool: { increment: balance } },
    }),
  ]);
}

/** Найти активный рейд */
export async function getActiveRaid(guildId: string): Promise<any> {
  return getDatabase().economyRaid.findFirst({
    where: { guildId, status: 'active' },
    include: {
      participants: { orderBy: { damage: 'desc' } },
      abandonedAccounts: true,
    },
  });
}

/** Статистика текущего рейда */
export async function getRaidById(raidId: string): Promise<any> {
  return getDatabase().economyRaid.findUnique({
    where: { id: raidId },
    include: {
      participants: { orderBy: { damage: 'desc' } },
      abandonedAccounts: true,
    },
  });
}

/** Обновить статус или поля рейда */
export async function updateRaid(raidId: string, data: any): Promise<any> {
  return getDatabase().economyRaid.update({
    where: { id: raidId },
    data,
  });
}

/** Нанести урон сейфу */
export const RAID_BOOST_CHARGE_SCOPE = 'raid_boost_charge';
export const RAID_STRIKE_SCOPE = 'raid_strike';

export async function addRaidDamage(
  raidId: string,
  userId: string,
  damage: number,
  boostedDamage?: number,
  interactionId?: string,
): Promise<{ damage: number; isLastHit: boolean; currentHp: number; boosted: boolean; duplicate: boolean }> {
  const db = getDatabase();
  return db.$transaction(async (tx) => {
    const raid = await tx.economyRaid.findUnique({ where: { id: raidId } });
    if (!raid) throw new Error('raid_not_found');
    await tx.$queryRaw`SELECT "id" FROM "economy_raids" WHERE "id" = ${raidId} FOR UPDATE`;
    const fresh = await tx.economyRaid.findUniqueOrThrow({ where: { id: raidId } });
    if (fresh.status !== 'active' || fresh.currentHp <= 0) {
      return { damage: 0, isLastHit: false, currentHp: fresh.currentHp, boosted: false, duplicate: false };
    }

    const strikeClaimKey = interactionId ? `raid-strike:${interactionId}` : null;
    if (strikeClaimKey) {
      const claimed = await tx.operationClaim.createMany({
        data: [{
          key: strikeClaimKey,
          scope: RAID_STRIKE_SCOPE,
          guildId: fresh.guildId,
          userId,
          metadata: { raidId, state: 'completed' },
          expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60_000),
        }],
        skipDuplicates: true,
      });
      if (claimed.count !== 1) {
        return { damage: 0, isLastHit: false, currentHp: fresh.currentHp, boosted: false, duplicate: true };
      }
    }

    const boostClaim = boostedDamage !== undefined && boostedDamage > damage
      ? await tx.operationClaim.findFirst({
          where: {
            scope: RAID_BOOST_CHARGE_SCOPE,
            guildId: fresh.guildId,
            userId,
            expiresAt: { gt: new Date() },
            metadata: { path: ['raidId'], equals: raidId },
          },
          orderBy: { createdAt: 'asc' },
          select: { key: true },
        })
      : null;
    const requestedDamage = boostClaim ? boostedDamage! : damage;
    const actualDamage = Math.max(0, Math.min(Math.floor(requestedDamage), fresh.currentHp));
    const currentHp = fresh.currentHp - actualDamage;
    const isLastHit = actualDamage > 0 && currentHp === 0;
    await tx.economyRaid.update({
      where: { id: raidId },
      data: {
        currentHp,
        lastHitUserId: isLastHit ? userId : undefined,
      },
    });
    if (actualDamage > 0) await tx.economyRaidParticipant.upsert({
      where: { raidId_userId: { raidId, userId } },
      create: { raidId, userId, damage: actualDamage },
      update: { damage: { increment: actualDamage } },
    });
    if (actualDamage > 0 && boostClaim) {
      await tx.operationClaim.delete({ where: { key: boostClaim.key } });
    }
    return {
      damage: actualDamage,
      isLastHit,
      currentHp,
      boosted: Boolean(boostClaim),
      duplicate: false,
    };
  });
}

/** Начислить награды победителям рейда */
export async function resolveRaidPayouts(
  raidId: string,
  payouts: Array<{ userId: string; amount: number }>,
  lastHitUserId: string,
): Promise<boolean> {
  const db = getDatabase();
  const raid = await db.economyRaid.findUnique({
    where: { id: raidId },
    select: { guildId: true },
  });
  if (!raid) return false;

  const resolved = await db.$transaction(async (tx) => {
    // Durable CAS: только один resolver получает право на выплаты.
    const claimed = await tx.economyRaid.updateMany({
      where: { id: raidId, status: 'active', activeKey: raid.guildId },
      data: {
        status: 'resolved',
        activeKey: null,
        // A null messageId is a durable "resolution UI pending" marker. The
        // raid reconciler relinks the original marker or publishes a replacement.
        messageId: null,
        resolvedAt: new Date(),
        lastHitUserId,
      },
    });
    if (claimed.count !== 1) return false;

    // 2. Начислить награды и записать транзакции
    for (const p of payouts) {
      if (p.amount <= 0) continue;

      const profile = await tx.economyProfile.upsert({
        where: { guildId_userId: { guildId: raid.guildId, userId: p.userId } },
        create: {
          guildId: raid.guildId,
          userId: p.userId,
          wallet: p.amount,
          totalEarned: BigInt(p.amount),
        },
        update: { wallet: { increment: p.amount }, totalEarned: { increment: BigInt(p.amount) } },
      });

      await tx.economyRaidParticipant.update({
        where: { raidId_userId: { raidId, userId: p.userId } },
        data: { payout: p.amount },
      });

      await tx.economyTransaction.create({
        data: {
          guildId: raid.guildId,
          userId: p.userId,
          type: 'raid_payout',
          amount: p.amount,
          balance: profile.wallet,
          profileId: profile.id,
          details: `Safe raid payout from raid ${raidId}`,
        },
      });
    }
    return true;
  });
  return resolved;
}
