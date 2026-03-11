// ═══════════════════════════════════════════════
//  Economy — Профиль и финансовые операции
//
//  Все изменения баланса проходят через Prisma
//  $transaction + Redis-лок для защиты от race
//  conditions. Ни один путь не может вызвать
//  negative balance.
// ═══════════════════════════════════════════════

import { GuildMember } from 'discord.js';
import { getDatabase } from '../../core/Database';
import { getRedis } from '../../core/Redis';
import { logger } from '../../core/Logger';
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
export async function acquireLock(guildId: string, userId: string): Promise<boolean> {
  const r = getRedis();
  const key = `${REDIS_ECO_LOCK}:${guildId}:${userId}`;
  const result = await r.set(key, '1', 'EX', LOCK_TTL, 'NX');
  return result === 'OK';
}

/** Освободить финансовый лок */
export async function releaseLock(guildId: string, userId: string): Promise<void> {
  await getRedis().del(`${REDIS_ECO_LOCK}:${guildId}:${userId}`);
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
  const locked = await acquireLock(guildId, userId);
  if (!locked) return null;

  try {
    return await fn();
  } finally {
    await releaseLock(guildId, userId);
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
          tierName: tier.name,
        };
      }
    }
  }

  return {
    multiplier: BASE_MULTIPLIER,
    bankLimit: BASE_BANK_LIMIT,
    tierIndex: -1,
    tierName: 'Без ПБ-роли',
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
): Promise<BalanceResult> {
  const db = getDatabase();

  try {
    const updated = await db.$transaction(async (tx) => {
      // Fresh read inside transaction (bypass cache)
      const current = await tx.economyProfile.findUnique({
        where: { guildId_userId: { guildId, userId } },
      });

      if (!current) {
        // Auto-create profile if missing
        const created = await tx.economyProfile.create({ data: { guildId, userId } });
        if (created.wallet + amount < 0) throw new Error('insufficient_funds');
        const result = await tx.economyProfile.update({
          where: { guildId_userId: { guildId, userId } },
          data: {
            wallet: { increment: amount },
            totalEarned: amount > 0 ? { increment: BigInt(amount) } : undefined,
            totalSpent: amount < 0 ? { increment: BigInt(Math.abs(amount)) } : undefined,
          },
        });
        await tx.economyTransaction.create({
          data: { guildId, userId, type: txType, amount, balance: result.wallet, profileId: created.id, targetId, details },
        });
        return result;
      }

      if (current.wallet + amount < 0) throw new Error('insufficient_funds');

      const result = await tx.economyProfile.update({
        where: { guildId_userId: { guildId, userId } },
        data: {
          wallet: { increment: amount },
          totalEarned: amount > 0 ? { increment: BigInt(amount) } : undefined,
          totalSpent: amount < 0 ? { increment: BigInt(Math.abs(amount)) } : undefined,
        },
      });

      await tx.economyTransaction.create({
        data: { guildId, userId, type: txType, amount, balance: result.wallet, profileId: current.id, targetId, details },
      });

      return result;
    });

    await invalidateProfileCache(guildId, userId);
    return { success: true, wallet: updated.wallet, bank: updated.bank };
  } catch (err: any) {
    if (err.message === 'insufficient_funds') {
      const profile = await getOrCreateProfile(guildId, userId);
      return { success: false, wallet: profile.wallet, bank: profile.bank, error: 'insufficient_funds' };
    }
    throw err;
  }
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
      const current = await tx.economyProfile.findUnique({
        where: { guildId_userId: { guildId, userId } },
      });
      if (!current) throw new Error('profile_not_found');

      if (current.wallet < amount) throw new Error('insufficient_funds');

      const effectiveLimit = bankLimit === Infinity ? Number.MAX_SAFE_INTEGER : bankLimit;
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
          details: `Депозит: ${CURRENCY}${actualAmount.toLocaleString('ru-RU')}`,
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
      const current = await tx.economyProfile.findUnique({
        where: { guildId_userId: { guildId, userId } },
      });
      if (!current) throw new Error('profile_not_found');
      if (current.bank < amount) throw new Error('insufficient_bank');

      const result = await tx.economyProfile.update({
        where: { guildId_userId: { guildId, userId } },
        data: {
          bank: { decrement: amount },
          wallet: { increment: received },
        },
      });

      await tx.economyTransaction.create({
        data: {
          guildId, userId, type: TX.BANK_WITHDRAW,
          amount: received, balance: result.wallet, profileId: current.id,
          details: `Снятие: ${CURRENCY}${amount.toLocaleString('ru-RU')}, комиссия: ${CURRENCY}${tax.toLocaleString('ru-RU')} (${taxPercent}%)`,
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
export async function transferShekels(
  guildId: string,
  senderId: string,
  receiverId: string,
  amount: number,
  taxPercent: number,
): Promise<{ success: boolean; tax: number; error?: string }> {
  if (senderId === receiverId) {
    return { success: false, tax: 0, error: 'self_transfer' };
  }

  if (amount <= 0) {
    return { success: false, tax: 0, error: 'invalid_amount' };
  }

  const db = getDatabase();
  const tax = Math.floor(amount * taxPercent / 100);
  const received = amount - tax;

  try {
    // Атомарная interactive транзакция — fresh reads внутри
    await db.$transaction(async (tx) => {
      const senderProfile = await tx.economyProfile.findUnique({
        where: { guildId_userId: { guildId, userId: senderId } },
      });
      if (!senderProfile) throw new Error('insufficient_funds');
      if (senderProfile.wallet < amount) throw new Error('insufficient_funds');

      // Ensure receiver exists
      const receiverProfile = await tx.economyProfile.upsert({
        where: { guildId_userId: { guildId, userId: receiverId } },
        create: { guildId, userId: receiverId },
        update: {},
      });

      const updatedSender = await tx.economyProfile.update({
        where: { guildId_userId: { guildId, userId: senderId } },
        data: {
          wallet: { decrement: amount },
          totalSpent: { increment: BigInt(amount) },
        },
      });

      const updatedReceiver = await tx.economyProfile.update({
        where: { guildId_userId: { guildId, userId: receiverId } },
        data: {
          wallet: { increment: received },
          totalEarned: { increment: BigInt(received) },
        },
      });

      await tx.economyTransaction.create({
        data: {
          guildId, userId: senderId, type: TX.TRANSFER_OUT,
          amount: -amount, balance: updatedSender.wallet,
          profileId: senderProfile.id, targetId: receiverId,
          details: `Перевод: ${CURRENCY}${amount.toLocaleString('ru-RU')}, налог: ${CURRENCY}${tax.toLocaleString('ru-RU')} (${taxPercent}%)`,
        },
      });

      await tx.economyTransaction.create({
        data: {
          guildId, userId: receiverId, type: TX.TRANSFER_IN,
          amount: received, balance: updatedReceiver.wallet,
          profileId: receiverProfile.id, targetId: senderId,
          details: `Получено: ${CURRENCY}${received.toLocaleString('ru-RU')} от <@${senderId}>`,
        },
      });
    });

    await invalidateProfileCache(guildId, senderId);
    await invalidateProfileCache(guildId, receiverId);
    return { success: true, tax };
  } catch (err: any) {
    if (err.message === 'insufficient_funds') {
      return { success: false, tax: 0, error: 'insufficient_funds' };
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
