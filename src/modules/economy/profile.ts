// ═══════════════════════════════════════════════
//  Economy — Профиль и финансовые операции
//
//  Все изменения баланса проходят через Prisma
//  $transaction + Redis-лок для защиты от race
//  conditions. Ни один путь не может вызвать
//  negative balance.
// ═══════════════════════════════════════════════

import { GuildMember } from 'discord.js';
import { randomUUID } from 'node:crypto';
import type { Prisma, EconomyProfile } from '@prisma/client';
import { getDatabase } from '../../core/Database';
import { getRedis } from '../../core/Redis';
import { logger } from '../../core/Logger';
import { i18n } from '../../core/I18n';
import { clampDirtyAmount, getCleanWallet } from './safety-policy';
import {
  getOrCreateProfile,
  invalidateProfileCache,
} from './database';
import {
  REDIS_ECO_LOCK,
  LOCK_TTL,
  PB_TIERS,
  BASE_BANK_LIMIT,
  BASE_MULTIPLIER,
  CURRENCY,
  TX,
} from './constants';

const log = logger.child('Economy:profile');

// ═══════════════════════════════════════════════
//  Redis-лок (защита от double-click / race)
// ═══════════════════════════════════════════════

/**
 * Попытаться захватить финансовый лок.
 * Возвращает true если лок получен, false если уже занят.
 */
export async function acquireLock(guildId: string, userId: string): Promise<string | null> {
  const r = getRedis();
  const key = `${REDIS_ECO_LOCK}:${guildId}:${userId}`;
  const token = randomUUID();
  const result = await r.set(key, token, 'EX', LOCK_TTL, 'NX');
  return result === 'OK' ? token : null;
}

/**
 * Освободить финансовый лок, только если он всё ещё принадлежит вызывающему.
 * Это не даёт старому владельцу удалить лок нового владельца после истечения TTL.
 */
export async function releaseLock(guildId: string, userId: string, token: string): Promise<boolean> {
  const key = `${REDIS_ECO_LOCK}:${guildId}:${userId}`;
  const released = await getRedis().eval(
    `if redis.call('get', KEYS[1]) == ARGV[1] then
       return redis.call('del', KEYS[1])
     end
     return 0`,
    1,
    key,
    token,
  );
  return Number(released) === 1;
}

/** Продлить только собственный лок. */
async function renewLock(guildId: string, userId: string, token: string): Promise<boolean> {
  const key = `${REDIS_ECO_LOCK}:${guildId}:${userId}`;
  const renewed = await getRedis().eval(
    `if redis.call('get', KEYS[1]) == ARGV[1] then
       return redis.call('expire', KEYS[1], ARGV[2])
     end
     return 0`,
    1,
    key,
    token,
    String(LOCK_TTL),
  );
  return Number(renewed) === 1;
}

/**
 * Выполнить финансовую операцию с локом.
 * Если лок уже занят — возвращает null (операция отклонена).
 */
export async function withFinancialLock<T>(
  guildId: string,
  userId: string,
  fn: () => Promise<T>,
): Promise<T | null> {
  return withFinancialLocks(guildId, [userId], fn);
}

/** Stable lock order used by every multi-account financial operation. */
export function financialLockOrder(userIds: readonly string[]): string[] {
  return [...new Set(userIds)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * Acquire all participant locks in one deterministic order. Partial acquisition
 * is rolled back, and owner tokens prevent an expired holder from releasing a
 * newer lock. This makes opposite-direction transfers safe.
 */
export async function withFinancialLocks<T>(
  guildId: string,
  userIds: readonly string[],
  fn: () => Promise<T>,
): Promise<T | null> {
  const orderedUserIds = financialLockOrder(userIds);
  if (orderedUserIds.length === 0) throw new Error('financial_lock_participants_required');

  const held: Array<{ userId: string; token: string }> = [];
  try {
    for (const userId of orderedUserIds) {
      const token = await acquireLock(guildId, userId);
      if (!token) {
        for (const lock of [...held].reverse()) {
          await releaseLock(guildId, lock.userId, lock.token).catch(() => false);
        }
        return null;
      }
      held.push({ userId, token });
    }
  } catch (error) {
    for (const lock of [...held].reverse()) {
      await releaseLock(guildId, lock.userId, lock.token).catch(() => false);
    }
    throw error;
  }

  // Долгие Discord/DB операции не должны переживать TTL и начинать выполняться
  // параллельно. Продлеваем лок, пока callback не завершён.
  const renewEveryMs = Math.max(1_000, Math.floor(LOCK_TTL * 1_000 / 3));
  const heartbeat = setInterval(() => {
    for (const lock of held) {
      renewLock(guildId, lock.userId, lock.token).catch((err) =>
        log.error('Не удалось продлить финансовый лок', {
          guildId,
          userId: lock.userId,
          error: String(err),
        }),
      );
    }
  }, renewEveryMs);
  heartbeat.unref?.();

  try {
    return await fn();
  } finally {
    clearInterval(heartbeat);
    for (const lock of [...held].reverse()) {
      await releaseLock(guildId, lock.userId, lock.token).catch((err) =>
        log.error('Не удалось безопасно освободить финансовый лок', {
          guildId,
          userId: lock.userId,
          error: String(err),
        }),
      );
    }
  }
}

// ═══════════════════════════════════════════════
//  PB-роль → множитель / банковский лимит
// ═══════════════════════════════════════════════

/**
 * Определить PB-тир пользователя по его ролям.
 * pbRoleIds — массив ID ролей PB-тиров (от низшей к высшей,
 * порядок должен совпадать с PB_TIERS в constants.ts).
 * Возвращает { multiplier, bankLimit, tierIndex, tierName }.
 */
export function getPbTier(
  member: GuildMember,
  pbRoleIds: string[],
  locale?: string,
): { multiplier: number; bankLimit: number; tierIndex: number; tierName: string } {
  // Идём от конца (высшая роль), первая найденная — тир пользователя
  for (let i = pbRoleIds.length - 1; i >= 0; i--) {
    if (pbRoleIds[i] && member.roles.cache.has(pbRoleIds[i])) {
      const tier = PB_TIERS[i];
      if (tier) {
        return {
          multiplier: tier.multiplier,
          bankLimit: tier.bankLimit,
          tierIndex: i,
          tierName: i18n.t(`economy.pb_tier_${i + 1}`, locale),
        };
      }
    }
  }

  return {
    multiplier: BASE_MULTIPLIER,
    bankLimit: BASE_BANK_LIMIT,
    tierIndex: -1,
    tierName: i18n.t('economy.profile.no_pb_tier', locale),
  };
}

// ═══════════════════════════════════════════════
//  Основные финансовые операции
// ═══════════════════════════════════════════════

export interface BalanceResult {
  success: boolean;
  wallet: number;
  bank: number;
  error?: string;
}

const POSTGRES_INT_MAX = 2_147_483_647;

export interface WalletDeltaOptions {
  /**
   * Обычные покупки могут тратить наличные независимо от их происхождения.
   * При этом dirtyAmount уменьшается только когда после списания он перестал бы
   * помещаться в кошелёк. Переводы/банк по-прежнему отдельно запрещают dirty.
   */
  preserveDirtyInvariant?: boolean;
  /** false — операция может тратить только чистую часть кошелька. */
  allowDirtySpend?: boolean;
}

/**
 * Durable once-only claim. Ключ уникален в БД, поэтому работает между
 * процессами и после рестарта. Claim должен создаваться в той же транзакции,
 * что и защищаемый финансовый side-effect.
 */
export async function claimOperationInTransaction(
  tx: Prisma.TransactionClient,
  key: string,
  scope: string,
  guildId?: string,
  userId?: string,
  metadata?: Prisma.InputJsonValue,
  expiresAt?: Date,
): Promise<boolean> {
  const claimed = await tx.operationClaim.createMany({
    data: [{ key, scope, guildId, userId, metadata, expiresAt }],
    skipDuplicates: true,
  });
  return claimed.count === 1;
}

/**
 * Атомарный примитив изменения кошелька для использования внутри уже открытой
 * Prisma-транзакции. Отрицательная дельта выполняется через условный UPDATE,
 * поэтому два параллельных списания не могут оба потратить один баланс.
 */
export async function applyWalletDeltaInTransaction(
  tx: Prisma.TransactionClient,
  guildId: string,
  userId: string,
  amount: number,
  txType: string,
  details?: string,
  targetId?: string,
  options: WalletDeltaOptions = {},
): Promise<EconomyProfile> {
  if (!Number.isSafeInteger(amount) || Math.abs(amount) > POSTGRES_INT_MAX) {
    throw new Error('invalid_amount');
  }

  const profile = await tx.economyProfile.upsert({
    where: { guildId_userId: { guildId, userId } },
    create: { guildId, userId },
    update: {},
  });

  if (amount < 0) {
    const debit = Math.abs(amount);
    if (options.allowDirtySpend === false) {
      await tx.$queryRaw`SELECT "id" FROM "economy_profiles" WHERE "id" = ${profile.id} FOR UPDATE`;
      const fresh = await tx.economyProfile.findUniqueOrThrow({ where: { id: profile.id } });
      if (getCleanWallet(fresh.wallet, fresh.dirtyAmount) < debit) throw new Error('dirty_blocked');
    }
    const debited = await tx.economyProfile.updateMany({
      where: { id: profile.id, wallet: { gte: debit } },
      data: {
        wallet: { decrement: debit },
        totalSpent: { increment: BigInt(debit) },
      },
    });
    if (debited.count !== 1) throw new Error('insufficient_funds');
  } else if (amount > 0) {
    const credited = await tx.economyProfile.updateMany({
      where: { id: profile.id, wallet: { lte: POSTGRES_INT_MAX - amount } },
      data: {
        wallet: { increment: amount },
        totalEarned: { increment: BigInt(amount) },
      },
    });
    if (credited.count !== 1) throw new Error('balance_overflow');
  }

  let updated = await tx.economyProfile.findUniqueOrThrow({ where: { id: profile.id } });

  // Любая разрешённая трата наличных обязана сохранять dirtyAmount <= wallet.
  if (options.preserveDirtyInvariant !== false && updated.dirtyAmount > updated.wallet) {
    updated = await tx.economyProfile.update({
      where: { id: profile.id },
      data: {
        dirtyAmount: clampDirtyAmount(updated.wallet, updated.dirtyAmount),
        dirtyClearAt: updated.wallet > 0 ? updated.dirtyClearAt : null,
      },
    });
  }

  await tx.economyTransaction.create({
    data: {
      guildId,
      userId,
      type: txType,
      amount,
      balance: updated.wallet,
      profileId: updated.id,
      targetId,
      details,
    },
  });

  return updated;
}

/**
 * Добавить шекели в кошелёк.
 * Использует Prisma interactive $transaction для атомарности:
 * fresh read → check → increment → log.
 */
export async function addToWallet(
  guildId: string,
  userId: string,
  amount: number,
  txType: string,
  details?: string,
  targetId?: string,
  options: WalletDeltaOptions = {},
): Promise<BalanceResult> {
  const db = getDatabase();

  try {
    const updated = await db.$transaction((tx) =>
      applyWalletDeltaInTransaction(tx, guildId, userId, amount, txType, details, targetId, options),
    );

    await invalidateProfileCache(guildId, userId);
    return { success: true, wallet: updated.wallet, bank: updated.bank };
  } catch (err: any) {
    if (err.message === 'insufficient_funds' || err.message === 'dirty_blocked') {
      const profile = await getOrCreateProfile(guildId, userId);
      return { success: false, wallet: profile.wallet, bank: profile.bank, error: err.message };
    }
    if (err.message === 'balance_overflow' || err.message === 'invalid_amount') {
      const profile = await getOrCreateProfile(guildId, userId);
      return { success: false, wallet: profile.wallet, bank: profile.bank, error: err.message };
    }
    throw err;
  }
}

/** Стартовый капитал можно начислить пользователю только один раз на сервер. */
export async function grantWelcomeBonusOnce(
  guildId: string,
  userId: string,
  amount: number,
  details = 'Стартовый капитал',
): Promise<{ granted: boolean; wallet: number }> {
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    throw new Error('invalid_amount');
  }

  const db = getDatabase();
  const result = await db.$transaction(async (tx) => {
    const claimed = await claimOperationInTransaction(
      tx,
      `welcome-bonus:${guildId}:${userId}`,
      'welcome_bonus',
      guildId,
      userId,
      { amount },
    );
    if (!claimed) {
      const profile = await tx.economyProfile.upsert({
        where: { guildId_userId: { guildId, userId } },
        create: { guildId, userId },
        update: {},
      });
      return { granted: false, wallet: profile.wallet };
    }

    const updated = await applyWalletDeltaInTransaction(
      tx,
      guildId,
      userId,
      amount,
      TX.WELCOME_BONUS,
      details,
    );
    return { granted: true, wallet: updated.wallet };
  });

  if (result.granted) await invalidateProfileCache(guildId, userId);
  return result;
}

/**
 * Перевод из кошелька в банк (deposit).
 * Prisma interactive $transaction — fresh read внутри.
 */
export async function depositToBank(
  guildId: string,
  userId: string,
  amount: number,
  bankLimit: number,
): Promise<BalanceResult> {
  if (amount <= 0) {
    return { success: false, wallet: 0, bank: 0, error: 'invalid_amount' };
  }

  const db = getDatabase();

  try {
    const updated = await db.$transaction(async (tx) => {
      const profile = await tx.economyProfile.findUnique({
        where: { guildId_userId: { guildId, userId } },
      });
      if (!profile) throw new Error('profile_not_found');
      await tx.$queryRaw`SELECT "id" FROM "economy_profiles" WHERE "id" = ${profile.id} FOR UPDATE`;
      const current = await tx.economyProfile.findUniqueOrThrow({ where: { id: profile.id } });

      if (current.wallet < amount) throw new Error('insufficient_funds');

      const cleanWallet = getCleanWallet(current.wallet, current.dirtyAmount ?? 0);
      if (cleanWallet < amount) throw new Error('dirty_blocked');

      // Prisma Int хранится как PostgreSQL INT4: "безлимит" означает максимум
      // физического типа, а не Number.MAX_SAFE_INTEGER.
      const effectiveLimit = bankLimit === Infinity
        ? POSTGRES_INT_MAX
        : Math.min(POSTGRES_INT_MAX, Math.max(0, Math.floor(bankLimit)));
      const maxDeposit = Math.max(0, effectiveLimit - current.bank);
      if (maxDeposit === 0) throw new Error('bank_full');

      const actualAmount = Math.min(amount, maxDeposit);

      const result = await tx.economyProfile.update({
        where: { guildId_userId: { guildId, userId } },
        data: {
          wallet: { decrement: actualAmount },
          bank: { increment: actualAmount },
        },
      });

      await tx.economyTransaction.create({
        data: {
          guildId, userId, type: TX.BANK_DEPOSIT,
          amount: -actualAmount, balance: result.wallet, profileId: current.id,
          details: i18n.t('economy.profile.tx_deposit', undefined, { amount: actualAmount.toLocaleString('ru-RU') }),
        },
      });

      return result;
    });

    await invalidateProfileCache(guildId, userId);
    return { success: true, wallet: updated.wallet, bank: updated.bank };
  } catch (err: any) {
    const profile = await getOrCreateProfile(guildId, userId);
    const errorMap: Record<string, string> = {
      insufficient_funds: 'insufficient_funds',
      bank_full: 'bank_full',
      profile_not_found: 'insufficient_funds',
      dirty_blocked: 'dirty_blocked',
    };
    return { success: false, wallet: profile.wallet, bank: profile.bank, error: errorMap[err.message] || 'error' };
  }
}

/**
 * Снятие из банка в кошелёк (withdraw).
 * Prisma interactive $transaction — fresh read.
 * Взимается комиссия (bankWithdrawTax %).
 */
export async function withdrawFromBank(
  guildId: string,
  userId: string,
  amount: number,
  taxPercent: number,
): Promise<BalanceResult & { tax: number }> {
  if (amount <= 0) {
    return { success: false, wallet: 0, bank: 0, tax: 0, error: 'invalid_amount' };
  }

  const db = getDatabase();
  const tax = Math.floor(amount * taxPercent / 100);
  const received = amount - tax;

  try {
    const updated = await db.$transaction(async (tx) => {
      const profile = await tx.economyProfile.findUnique({
        where: { guildId_userId: { guildId, userId } },
      });
      if (!profile) throw new Error('profile_not_found');
      await tx.$queryRaw`SELECT "id" FROM "economy_profiles" WHERE "id" = ${profile.id} FOR UPDATE`;
      const current = await tx.economyProfile.findUniqueOrThrow({ where: { id: profile.id } });
      if (current.bank < amount) throw new Error('insufficient_bank');

      const result = await tx.economyProfile.update({
        where: { guildId_userId: { guildId, userId } },
        data: {
          bank: { decrement: amount },
          wallet: { increment: received },
        },
      });

      if (tax > 0) {
        const gov = await tx.economyProfile.upsert({
          where: { guildId_userId: { guildId, userId: 'government' } },
          create: { guildId, userId: 'government', wallet: tax },
          update: { wallet: { increment: tax } },
        });
        await tx.economyTransaction.create({
          data: {
            guildId, userId: 'government', type: 'tax_bank_withdraw',
            amount: tax, balance: gov.wallet, profileId: gov.id, targetId: userId,
            details: `Налог со снятия наличных игроком ${userId}`,
          },
        });
      }

      await tx.economyTransaction.create({
        data: {
          guildId, userId, type: TX.BANK_WITHDRAW,
          amount: received, balance: result.wallet, profileId: current.id,
          details: i18n.t('economy.profile.tx_withdraw', undefined, { amount: amount.toLocaleString('ru-RU'), tax: tax.toLocaleString('ru-RU'), percent: taxPercent }),
        },
      });

      return result;
    });

    await invalidateProfileCache(guildId, userId);
    return { success: true, wallet: updated.wallet, bank: updated.bank, tax };
  } catch (err: any) {
    const profile = await getOrCreateProfile(guildId, userId);
    const errorMap: Record<string, string> = {
      insufficient_bank: 'insufficient_bank',
      profile_not_found: 'insufficient_bank',
    };
    return { success: false, wallet: profile.wallet, bank: profile.bank, tax: 0, error: errorMap[err.message] || 'error' };
  }
}

/**
 * Перевод шекелей другому пользователю.
 * Взимается налог (transferTax %).
 */
export function readPersistedTransferResult(
  metadata: unknown,
  senderId: string,
  receiverId: string,
  amount: number,
): { tax: number } | null {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null;
  const saved = metadata as Record<string, unknown>;
  if (
    saved.senderId !== senderId ||
    saved.receiverId !== receiverId ||
    saved.amount !== amount ||
    !Number.isSafeInteger(saved.tax) ||
    Number(saved.tax) < 0 ||
    Number(saved.tax) > amount ||
    saved.received !== amount - Number(saved.tax)
  ) return null;
  return { tax: Number(saved.tax) };
}

export async function transferShekels(
  guildId: string,
  senderId: string,
  receiverId: string,
  amount: number,
  taxPercent: number,
  operationId: string,
): Promise<{ success: boolean; tax: number; duplicate?: boolean; error?: string } | null> {
  if (senderId === receiverId) {
    return { success: false, tax: 0, error: 'self_transfer' };
  }

  if (!Number.isSafeInteger(amount) || amount <= 0 || !operationId.trim()) {
    return { success: false, tax: 0, error: 'invalid_amount' };
  }

  const db = getDatabase();
  const tax = Math.floor(amount * taxPercent / 100);
  const received = amount - tax;
  if (!Number.isSafeInteger(tax) || tax < 0 || received < 0) {
    return { success: false, tax: 0, error: 'invalid_amount' };
  }

  const claimKey = `economy:transfer:${guildId}:${operationId}`;
  const participants = tax > 0
    ? [senderId, receiverId, 'government']
    : [senderId, receiverId];

  try {
    const result = await withFinancialLocks(guildId, participants, async () =>
      db.$transaction(async (tx) => {
        // Upserts and row locks follow the same order for A→B and B→A.
        const profiles = new Map<string, EconomyProfile>();
        for (const userId of financialLockOrder(participants)) {
          const profile = await tx.economyProfile.upsert({
            where: { guildId_userId: { guildId, userId } },
            create: { guildId, userId },
            update: {},
          });
          profiles.set(userId, profile);
        }
        for (const profileId of [...profiles.values()].map((profile) => profile.id).sort()) {
          await tx.$queryRaw`SELECT "id" FROM "economy_profiles" WHERE "id" = ${profileId} FOR UPDATE`;
        }

        const existingClaim = await tx.operationClaim.findUnique({ where: { key: claimKey } });
        if (existingClaim) {
          const saved = readPersistedTransferResult(
            existingClaim.metadata,
            senderId,
            receiverId,
            amount,
          );
          if (!saved) {
            return { success: false, tax: 0, error: 'operation_conflict' } as const;
          }
          return { success: true, tax: saved.tax, duplicate: true } as const;
        }

        const claimed = await claimOperationInTransaction(
          tx,
          claimKey,
          'economy_transfer',
          guildId,
          senderId,
          { senderId, receiverId, amount, tax, received, operationId },
        );
        if (!claimed) throw new Error('transfer_claim_race');

        const senderProfile = await tx.economyProfile.findUniqueOrThrow({
          where: { guildId_userId: { guildId, userId: senderId } },
        });
        if (getCleanWallet(senderProfile.wallet, senderProfile.dirtyAmount) < amount) {
          throw new Error(senderProfile.wallet < amount ? 'insufficient_funds' : 'dirty_blocked');
        }

        await applyWalletDeltaInTransaction(
          tx,
          guildId,
          senderId,
          -amount,
          TX.TRANSFER_OUT,
          i18n.t('economy.profile.tx_transfer_out', undefined, {
            amount: amount.toLocaleString('ru-RU'),
            tax: tax.toLocaleString('ru-RU'),
            percent: taxPercent,
          }),
          receiverId,
          { allowDirtySpend: false },
        );
        await applyWalletDeltaInTransaction(
          tx,
          guildId,
          receiverId,
          received,
          TX.TRANSFER_IN,
          i18n.t('economy.profile.tx_transfer_in', undefined, {
            received: received.toLocaleString('ru-RU'),
            senderId,
          }),
          senderId,
        );
        if (tax > 0) {
          await applyWalletDeltaInTransaction(
            tx,
            guildId,
            'government',
            tax,
            'tax_transfer',
            `Налог с перевода от ${senderId} к ${receiverId}`,
            senderId,
          );
        }

        return { success: true, tax } as const;
      }),
    );

    if (result === null) return null;

    await invalidateProfileCache(guildId, senderId);
    await invalidateProfileCache(guildId, receiverId);
    if (tax > 0) await invalidateProfileCache(guildId, 'government');
    return result;
  } catch (err: any) {
    if (err.message === 'insufficient_funds') {
      return { success: false, tax: 0, error: 'insufficient_funds' };
    }
    if (err.message === 'dirty_blocked') {
      return { success: false, tax: 0, error: 'dirty_blocked' };
    }
    if (err.message === 'transfer_claim_race') {
      return { success: false, tax: 0, error: 'operation_conflict' };
    }
    throw err;
  }
}

// ═══════════════════════════════════════════════
//  Утилиты
// ═══════════════════════════════════════════════

/** Форматирование суммы: ₪1,234 */
export function fmt(amount: number): string {
  return `${CURRENCY}${Math.abs(amount).toLocaleString('ru-RU')}`;
}

/** Проверка кулдауна. Возвращает оставшееся время (мс) или 0 если кулдаун прошёл */
export function checkCooldown(lastUsed: Date | null, cooldownMs: number): number {
  if (!lastUsed) return 0;
  const elapsed = Date.now() - new Date(lastUsed).getTime();
  const remaining = cooldownMs - elapsed;
  return remaining > 0 ? remaining : 0;
}

/** Форматирование кулдауна в «Xч Yм Zс» */
export function formatCooldown(ms: number): string {
  const totalSeconds = Math.ceil(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  const parts: string[] = [];
  if (hours > 0) parts.push(`${hours}ч`);
  if (minutes > 0) parts.push(`${minutes}м`);
  if (seconds > 0 || parts.length === 0) parts.push(`${seconds}с`);

  return parts.join(' ');
}
