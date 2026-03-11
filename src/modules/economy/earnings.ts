// ═══════════════════════════════════════════════
//  Economy — Логика заработка
//
//  daily, weekly, work, crime, beg
//  Каждая функция:
//  1. Проверяет кулдаун (DateTime в БД, NOT Redis)
//  2. Рассчитывает сумму с учётом PB-множителя
//  3. Обновляет профиль атомарно
//  4. Возвращает результат для embed-а
// ═══════════════════════════════════════════════

import { GuildMember } from 'discord.js';
import { getDatabase } from '../../core/Database';
import { logger } from '../../core/Logger';
import {
  getOrCreateProfile,
  createTransaction,
  invalidateProfileCache,
  getEcoConfig,
} from './database';
import { getPbTier, addToWallet, withFinancialLock, checkCooldown, fmt } from './profile';
import { TX, DEFAULTS, COOLDOWNS, CURRENCY } from './constants';

const log = logger.child('Economy:earnings');

// ── Интерфейс результата ─────────────────────

export interface EarnResult {
  success: boolean;
  amount: number;
  multiplier: number;
  baseAmount: number;
  wallet: number;
  bank: number;
  streak?: number;
  bestStreak?: number;
  cooldownRemaining?: number;   // мс до следующего использования
  error?: string;
  details?: string;             // доп. информация для embed-а
}

// ═══════════════════════════════════════════════
//  /daily — ежедневная награда
// ═══════════════════════════════════════════════

export async function claimDaily(
  guildId: string,
  member: GuildMember,
  pbRoleIds: string[],
): Promise<EarnResult> {
  const userId = member.id;
  const config = await getEcoConfig(guildId);
  const cooldownMs = config ? Number(config.dailyCooldown) : COOLDOWNS.daily;
  const baseAmount = config?.dailyBase ?? DEFAULTS.dailyBase;
  const streakAdd = config?.dailyStreakAdd ?? DEFAULTS.dailyStreakAdd;
  const streakMax = config?.dailyStreakMax ?? DEFAULTS.dailyStreakMax;

  const result = await withFinancialLock(guildId, userId, async () => {
    const profile = await getOrCreateProfile(guildId, userId);

    // Проверка кулдауна
    const remaining = checkCooldown(profile.lastDaily, cooldownMs);
    if (remaining > 0) {
      return {
        success: false,
        amount: 0,
        multiplier: 1,
        baseAmount: 0,
        wallet: profile.wallet,
        bank: profile.bank,
        cooldownRemaining: remaining,
        error: 'cooldown',
      } as EarnResult;
    }

    // Стрик: если последний дейли был < 48ч назад — стрик +1, иначе сброс
    const now = new Date();
    let newStreak = 1;
    if (profile.lastDaily) {
      const elapsed = now.getTime() - new Date(profile.lastDaily).getTime();
      if (elapsed < cooldownMs * 2) {
        // Не пропустил день — стрик продолжается
        newStreak = profile.dailyStreak + 1;
      }
      // Иначе стрик = 1 (сброс)
    }

    // Расчёт суммы
    const streakBonus = Math.min((newStreak - 1) * streakAdd, streakMax);
    const { multiplier } = getPbTier(member, pbRoleIds);
    const rawAmount = baseAmount + streakBonus;
    const finalAmount = Math.floor(rawAmount * multiplier);

    // Обновляем профиль
    const db = getDatabase();
    const updated = await db.economyProfile.update({
      where: { guildId_userId: { guildId, userId } },
      data: {
        wallet: { increment: finalAmount },
        lastDaily: now,
        dailyStreak: newStreak,
        bestDailyStreak: Math.max(newStreak, profile.bestDailyStreak),
        totalEarned: { increment: BigInt(finalAmount) },
      },
    });

    await createTransaction({
      guildId,
      userId,
      type: TX.EARN_DAILY,
      amount: finalAmount,
      balance: updated.wallet,
      profileId: profile.id,
      details: `Стрик: ${newStreak} | Бонус стрика: ${CURRENCY}${streakBonus} | Множитель: x${multiplier}`,
    });

    await invalidateProfileCache(guildId, userId);

    return {
      success: true,
      amount: finalAmount,
      multiplier,
      baseAmount,
      wallet: updated.wallet,
      bank: updated.bank,
      streak: newStreak,
      bestStreak: Math.max(newStreak, profile.bestDailyStreak),
      details: streakBonus > 0
        ? `Стрик ${newStreak} дн. → бонус ${CURRENCY}${streakBonus}`
        : undefined,
    } as EarnResult;
  });

  if (!result) {
    return { success: false, amount: 0, multiplier: 1, baseAmount: 0, wallet: 0, bank: 0, error: 'locked' };
  }

  return result;
}

// ═══════════════════════════════════════════════
//  /weekly — еженедельная награда
// ═══════════════════════════════════════════════

export async function claimWeekly(
  guildId: string,
  member: GuildMember,
  pbRoleIds: string[],
  playedPbThisWeek: boolean,
): Promise<EarnResult> {
  const userId = member.id;
  const config = await getEcoConfig(guildId);
  const cooldownMs = config ? Number(config.weeklyCooldown) : COOLDOWNS.weekly;
  const base = config?.weeklyBase ?? DEFAULTS.weeklyBase;
  const pbBonus = config?.weeklyPbBonus ?? DEFAULTS.weeklyPbBonus;

  const result = await withFinancialLock(guildId, userId, async () => {
    const profile = await getOrCreateProfile(guildId, userId);

    const remaining = checkCooldown(profile.lastWeekly, cooldownMs);
    if (remaining > 0) {
      return {
        success: false,
        amount: 0,
        multiplier: 1,
        baseAmount: 0,
        wallet: profile.wallet,
        bank: profile.bank,
        cooldownRemaining: remaining,
        error: 'cooldown',
      } as EarnResult;
    }

    const { multiplier } = getPbTier(member, pbRoleIds);
    const rawAmount = base + (playedPbThisWeek ? pbBonus : 0);
    const finalAmount = Math.floor(rawAmount * multiplier);

    const db = getDatabase();
    const updated = await db.economyProfile.update({
      where: { guildId_userId: { guildId, userId } },
      data: {
        wallet: { increment: finalAmount },
        lastWeekly: new Date(),
        totalEarned: { increment: BigInt(finalAmount) },
      },
    });

    await createTransaction({
      guildId,
      userId,
      type: TX.EARN_WEEKLY,
      amount: finalAmount,
      balance: updated.wallet,
      profileId: profile.id,
      details: `ПБ-бонус: ${playedPbThisWeek ? `+${CURRENCY}${pbBonus}` : 'нет'} | Множитель: x${multiplier}`,
    });

    await invalidateProfileCache(guildId, userId);

    return {
      success: true,
      amount: finalAmount,
      multiplier,
      baseAmount: base,
      wallet: updated.wallet,
      bank: updated.bank,
      details: playedPbThisWeek
        ? `ПБ-бонус: +${CURRENCY}${pbBonus.toLocaleString('ru-RU')}`
        : undefined,
    } as EarnResult;
  });

  if (!result) {
    return { success: false, amount: 0, multiplier: 1, baseAmount: 0, wallet: 0, bank: 0, error: 'locked' };
  }

  return result;
}

// ═══════════════════════════════════════════════
//  /work — работа (гарантированный заработок)
// ═══════════════════════════════════════════════

/**
 * Сценарии работы для embed-ов (рандомная фраза).
 */
const WORK_SCENARIOS = [
  'Вы торговали фалафелем на рынке Кармель',
  'Вы собирали апельсины в кибуце',
  'Вы таксовали по Тель-Авиву',
  'Вы чинили кондиционеры в Беэр-Шеве',
  'Вы продавали хумус на набережной',
  'Вы разрабатывали стартап в Герцлии',
  'Вы охраняли банкомат в Хайфе',
  'Вы учили туристов ивриту',
  'Вы доставляли шаурму по Иерусалиму',
  'Вы программировали ботов для Discord',
  'Вы были экскурсоводом на Мёртвом море',
  'Вы ремонтировали танк Меркава',
];

export async function doWork(
  guildId: string,
  member: GuildMember,
  pbRoleIds: string[],
): Promise<EarnResult> {
  const userId = member.id;
  const config = await getEcoConfig(guildId);
  const cooldownMs = config ? Number(config.workCooldown) : COOLDOWNS.work;
  const min = config?.workMin ?? DEFAULTS.workMin;
  const max = config?.workMax ?? DEFAULTS.workMax;

  const result = await withFinancialLock(guildId, userId, async () => {
    const profile = await getOrCreateProfile(guildId, userId);

    const remaining = checkCooldown(profile.lastWork, cooldownMs);
    if (remaining > 0) {
      return {
        success: false,
        amount: 0,
        multiplier: 1,
        baseAmount: 0,
        wallet: profile.wallet,
        bank: profile.bank,
        cooldownRemaining: remaining,
        error: 'cooldown',
      } as EarnResult;
    }

    const { multiplier } = getPbTier(member, pbRoleIds);
    const baseAmount = Math.floor(Math.random() * (max - min + 1)) + min;
    const finalAmount = Math.floor(baseAmount * multiplier);
    const scenario = WORK_SCENARIOS[Math.floor(Math.random() * WORK_SCENARIOS.length)];

    const db = getDatabase();
    const updated = await db.economyProfile.update({
      where: { guildId_userId: { guildId, userId } },
      data: {
        wallet: { increment: finalAmount },
        lastWork: new Date(),
        totalEarned: { increment: BigInt(finalAmount) },
      },
    });

    await createTransaction({
      guildId,
      userId,
      type: TX.EARN_WORK,
      amount: finalAmount,
      balance: updated.wallet,
      profileId: profile.id,
      details: scenario,
    });

    await invalidateProfileCache(guildId, userId);

    return {
      success: true,
      amount: finalAmount,
      multiplier,
      baseAmount,
      wallet: updated.wallet,
      bank: updated.bank,
      details: scenario,
    } as EarnResult;
  });

  if (!result) {
    return { success: false, amount: 0, multiplier: 1, baseAmount: 0, wallet: 0, bank: 0, error: 'locked' };
  }

  return result;
}

// ═══════════════════════════════════════════════
//  /crime — преступление (рискованный заработок)
// ═══════════════════════════════════════════════

const CRIME_SUCCESS_SCENARIOS = [
  'Вы успешно ограбили кондитерскую',
  'Вы взломали криптокошелёк',
  'Вы продали поддельные билеты на концерт',
  'Вы обманули казино в Эйлате',
  'Вы провернули схему с недвижимостью',
  'Вы украли рецепт секретного хумуса',
];

const CRIME_FAIL_SCENARIOS = [
  'Вас поймала полиция',
  'Камера засекла ваше лицо',
  'Сообщник вас сдал',
  'Охранник оказался разрядником Крав Маги',
  'Шин Бет уже ждал вас на месте',
  'Бабушка у подъезда вызвала МАГАВ',
];

export async function doCrime(
  guildId: string,
  member: GuildMember,
  pbRoleIds: string[],
): Promise<EarnResult> {
  const userId = member.id;
  const config = await getEcoConfig(guildId);
  const cooldownMs = config ? Number(config.crimeCooldown) : COOLDOWNS.crime;
  const min = config?.crimeMin ?? DEFAULTS.crimeMin;
  const max = config?.crimeMax ?? DEFAULTS.crimeMax;
  const successRate = config?.crimeSuccessRate ?? DEFAULTS.crimeSuccessRate;
  const fine = config?.crimeFine ?? DEFAULTS.crimeFine;

  const result = await withFinancialLock(guildId, userId, async () => {
    const profile = await getOrCreateProfile(guildId, userId);

    const remaining = checkCooldown(profile.lastCrime, cooldownMs);
    if (remaining > 0) {
      return {
        success: false,
        amount: 0,
        multiplier: 1,
        baseAmount: 0,
        wallet: profile.wallet,
        bank: profile.bank,
        cooldownRemaining: remaining,
        error: 'cooldown',
      } as EarnResult;
    }

    const { multiplier } = getPbTier(member, pbRoleIds);
    const isSuccess = Math.random() * 100 < successRate;

    const db = getDatabase();

    if (isSuccess) {
      const baseAmount = Math.max(1, Math.floor(Math.random() * (max - min + 1)) + min);
      const finalAmount = Math.floor(baseAmount * multiplier);
      const scenario = CRIME_SUCCESS_SCENARIOS[Math.floor(Math.random() * CRIME_SUCCESS_SCENARIOS.length)];

      const updated = await db.economyProfile.update({
        where: { guildId_userId: { guildId, userId } },
        data: {
          wallet: { increment: finalAmount },
          lastCrime: new Date(),
          totalEarned: { increment: BigInt(finalAmount) },
        },
      });

      await createTransaction({
        guildId,
        userId,
        type: TX.EARN_CRIME,
        amount: finalAmount,
        balance: updated.wallet,
        profileId: profile.id,
        details: `✅ ${scenario}`,
      });

      await invalidateProfileCache(guildId, userId);

      return {
        success: true,
        amount: finalAmount,
        multiplier,
        baseAmount,
        wallet: updated.wallet,
        bank: updated.bank,
        details: scenario,
      } as EarnResult;
    } else {
      // Провал — штраф (не ниже 0)
      const scenario = CRIME_FAIL_SCENARIOS[Math.floor(Math.random() * CRIME_FAIL_SCENARIOS.length)];

      // $transaction с fresh read для защиты от race condition (concurrent rob)
      const { updated, actualFine } = await db.$transaction(async (tx) => {
        const fresh = await tx.economyProfile.findUnique({
          where: { guildId_userId: { guildId, userId } },
        });
        if (!fresh) throw new Error('no_profile');

        const f = Math.min(fine, Math.max(0, fresh.wallet));

        const result = await tx.economyProfile.update({
          where: { guildId_userId: { guildId, userId } },
          data: {
            wallet: { decrement: f },
            lastCrime: new Date(),
            totalSpent: f > 0 ? { increment: BigInt(f) } : undefined,
          },
        });

        // Защита: если concurrent rob вызвал negative wallet — корректируем
        if (result.wallet < 0) {
          const overflow = Math.abs(result.wallet);
          const correctedFine = Math.max(0, f - overflow);
          await tx.economyProfile.update({
            where: { guildId_userId: { guildId, userId } },
            data: {
              wallet: 0,
              totalSpent: overflow > 0 ? { decrement: BigInt(overflow) } : undefined,
            },
          });
          return { updated: { ...result, wallet: 0 }, actualFine: correctedFine };
        }

        return { updated: result, actualFine: f };
      });

      await createTransaction({
        guildId,
        userId,
        type: TX.CRIME_FINE,
        amount: -actualFine,
        balance: updated.wallet,
        profileId: profile.id,
        details: `❌ ${scenario}`,
      });

      await invalidateProfileCache(guildId, userId);

      return {
        success: true, // операция выполнена (но результат — убыток)
        amount: -actualFine,
        multiplier,
        baseAmount: -fine,
        wallet: updated.wallet,
        bank: updated.bank,
        details: scenario,
      } as EarnResult;
    }
  });

  if (!result) {
    return { success: false, amount: 0, multiplier: 1, baseAmount: 0, wallet: 0, bank: 0, error: 'locked' };
  }

  return result;
}

// ═══════════════════════════════════════════════
//  /beg — попрошайничество (мелочь)
// ═══════════════════════════════════════════════

const BEG_SCENARIOS = [
  'Щедрый прохожий кинул вам монетку',
  'Турист из Москвы дал на чай',
  'Бабушка пожалела вас на рынке',
  'Солдат-срочник поделился стипендией',
  'Вы нашли мелочь на автобусной остановке',
  'Официант отдал вам чаевые',
  'Кто-то оставил сдачу в автомате',
];

export async function doBeg(
  guildId: string,
  member: GuildMember,
  pbRoleIds: string[],
): Promise<EarnResult> {
  const userId = member.id;
  const config = await getEcoConfig(guildId);
  const cooldownMs = config ? Number(config.begCooldown) : COOLDOWNS.beg;
  const min = config?.begMin ?? DEFAULTS.begMin;
  const max = config?.begMax ?? DEFAULTS.begMax;

  const result = await withFinancialLock(guildId, userId, async () => {
    const profile = await getOrCreateProfile(guildId, userId);

    const remaining = checkCooldown(profile.lastBeg, cooldownMs);
    if (remaining > 0) {
      return {
        success: false,
        amount: 0,
        multiplier: 1,
        baseAmount: 0,
        wallet: profile.wallet,
        bank: profile.bank,
        cooldownRemaining: remaining,
        error: 'cooldown',
      } as EarnResult;
    }

    const { multiplier } = getPbTier(member, pbRoleIds);
    const baseAmount = Math.floor(Math.random() * (max - min + 1)) + min;
    const finalAmount = Math.floor(baseAmount * multiplier);
    const scenario = BEG_SCENARIOS[Math.floor(Math.random() * BEG_SCENARIOS.length)];

    const db = getDatabase();
    const updated = await db.economyProfile.update({
      where: { guildId_userId: { guildId, userId } },
      data: {
        wallet: { increment: finalAmount },
        lastBeg: new Date(),
        totalEarned: { increment: BigInt(finalAmount) },
      },
    });

    await createTransaction({
      guildId,
      userId,
      type: TX.EARN_BEG,
      amount: finalAmount,
      balance: updated.wallet,
      profileId: profile.id,
      details: scenario,
    });

    await invalidateProfileCache(guildId, userId);

    return {
      success: true,
      amount: finalAmount,
      multiplier,
      baseAmount,
      wallet: updated.wallet,
      bank: updated.bank,
      details: scenario,
    } as EarnResult;
  });

  if (!result) {
    return { success: false, amount: 0, multiplier: 1, baseAmount: 0, wallet: 0, bank: 0, error: 'locked' };
  }

  return result;
}
