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
import { i18n } from '../../core/I18n';
import { invalidateProfileCache, getEcoConfig } from './database';
import { applyWalletDeltaInTransaction, getPbTier, withFinancialLock, checkCooldown } from './profile';
import { getUserPerks } from './perks';
import { getActiveBoosts, applyEarnBoost, applyWantedMul } from './events';
import { TX, DEFAULTS, COOLDOWNS, CURRENCY } from './constants';
import { secureChancePercent, secureRandomFloat, secureRandomInt } from './random';
import { createDeferredWantedClaimInTransaction } from './deferred-wanted';

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
  treasuryState?: 'full' | 'partial' | 'dry';
  expectedAmount?: number;
  salary?: number;
  isGovEmployee?: boolean;
  wantedAdded?: boolean;
  maskUsed?: boolean;
  isMajorJob?: boolean;
  wantedStarsToAdd?: number;
  wantedDecayMs?: number;
}

async function getFreshProfile(guildId: string, userId: string) {
  const db = getDatabase();
  return db.economyProfile.upsert({
    where: { guildId_userId: { guildId, userId } },
    create: { guildId, userId },
    update: {},
  });
}

// ═══════════════════════════════════════════════
//  /daily — ежедневная награда
// ═══════════════════════════════════════════════

export async function claimDaily(
  guildId: string,
  member: GuildMember,
  pbRoleIds: string[],
  locale?: string,
): Promise<EarnResult> {
  const userId = member.id;
  const config = await getEcoConfig(guildId);
  const cooldownMs = config ? Number(config.dailyCooldown) : COOLDOWNS.daily;
  const baseAmount = config?.dailyBase ?? DEFAULTS.dailyBase;
  const streakAdd = config?.dailyStreakAdd ?? DEFAULTS.dailyStreakAdd;
  const streakMax = config?.dailyStreakMax ?? DEFAULTS.dailyStreakMax;

  const result = await withFinancialLock(guildId, userId, async () => {
    const profile = await getFreshProfile(guildId, userId);

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
    const boosts = await getActiveBoosts(guildId);
    const finalAmount = applyEarnBoost(Math.floor(rawAmount * multiplier), boosts);

    const db = getDatabase();
    const isPolice = config?.policeRoleId ? member.roles.cache.has(config.policeRoleId) : false;
    const isStaff = config?.govStaffRoleId ? member.roles.cache.has(config.govStaffRoleId) : false;

    let baseSalary = 0;
    if (isPolice) baseSalary = 300;
    else if (isStaff) baseSalary = 150;

    const payout = await db.$transaction(async (tx) => {
      const gov = await tx.economyProfile.upsert({
        where: { guildId_userId: { guildId, userId: 'government' } },
        create: { guildId, userId: 'government', wallet: 0 },
        update: {},
      });
      // Один shared treasury обслуживает много user-lock'ов, поэтому берём
      // row-lock в БД до расчёта partial payout.
      for (const id of [gov.id, profile.id].sort()) {
        await tx.$queryRaw`SELECT "id" FROM "economy_profiles" WHERE "id" = ${id} FOR UPDATE`;
      }
      const freshGov = await tx.economyProfile.findUniqueOrThrow({ where: { id: gov.id } });

      const salaryMultiplier = freshGov.wallet <= 0 ? 0 : freshGov.wallet < 5000 ? 0.5 : 1;
      const finalSalary = Math.floor(baseSalary * salaryMultiplier);
      const expected = finalAmount + finalSalary;
      const paidAmount = Math.max(0, Math.min(expected, freshGov.wallet));
      const treasuryState: 'full' | 'partial' | 'dry' =
        paidAmount === 0 ? 'dry' : paidAmount < expected ? 'partial' : 'full';

      if (paidAmount > 0) {
        await applyWalletDeltaInTransaction(
          tx, guildId, 'government', -paidAmount, 'treasury_payout_daily',
          `Выплата пособия + оклада /daily игроку ${userId}`, userId,
        );
        await applyWalletDeltaInTransaction(
          tx, guildId, userId, paidAmount, TX.EARN_DAILY,
          i18n.t('economy.tx_daily_details', locale, { streak: newStreak, bonus: `${CURRENCY}${streakBonus}`, multiplier }),
        );
      }

      const updated = await tx.economyProfile.update({
        where: { guildId_userId: { guildId, userId } },
        data: {
          lastDaily: now,
          dailyStreak: newStreak,
          bestDailyStreak: Math.max(newStreak, profile.bestDailyStreak),
        },
      });
      return { paidAmount, treasuryState, updated, expected, finalSalary };
    });
    const { paidAmount, treasuryState, updated, expected, finalSalary } = payout;

    await invalidateProfileCache(guildId, userId);

    return {
      success: true,
      amount: paidAmount,
      multiplier,
      baseAmount,
      wallet: updated.wallet,
      bank: updated.bank,
      streak: newStreak,
      bestStreak: Math.max(newStreak, profile.bestDailyStreak),
      details: streakBonus > 0
        ? i18n.t('economy.daily_streak_detail', locale, { streak: newStreak, bonus: `${CURRENCY}${streakBonus}` })
        : undefined,
      treasuryState,
      expectedAmount: expected,
      salary: finalSalary,
      isGovEmployee: baseSalary > 0,
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
  locale?: string,
): Promise<EarnResult> {
  const userId = member.id;
  const config = await getEcoConfig(guildId);
  const cooldownMs = config ? Number(config.weeklyCooldown) : COOLDOWNS.weekly;
  const base = config?.weeklyBase ?? DEFAULTS.weeklyBase;
  const pbBonus = config?.weeklyPbBonus ?? DEFAULTS.weeklyPbBonus;

  const result = await withFinancialLock(guildId, userId, async () => {
    const profile = await getFreshProfile(guildId, userId);

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
    const boosts = await getActiveBoosts(guildId);
    const finalAmount = applyEarnBoost(Math.floor(rawAmount * multiplier), boosts);

    const db = getDatabase();

    const payout = await db.$transaction(async (tx) => {
      const gov = await tx.economyProfile.upsert({
        where: { guildId_userId: { guildId, userId: 'government' } },
        create: { guildId, userId: 'government', wallet: 0 },
        update: {},
      });
      for (const id of [gov.id, profile.id].sort()) {
        await tx.$queryRaw`SELECT "id" FROM "economy_profiles" WHERE "id" = ${id} FOR UPDATE`;
      }
      const freshGov = await tx.economyProfile.findUniqueOrThrow({ where: { id: gov.id } });
      const paidAmount = Math.max(0, Math.min(finalAmount, freshGov.wallet));
      const treasuryState: 'full' | 'partial' | 'dry' =
        paidAmount === 0 ? 'dry' : paidAmount < finalAmount ? 'partial' : 'full';

      if (paidAmount > 0) {
        await applyWalletDeltaInTransaction(
          tx, guildId, 'government', -paidAmount, 'treasury_payout_weekly',
          `Выплата пособия /weekly игроку ${userId}`, userId,
        );
        await applyWalletDeltaInTransaction(
          tx,
          guildId,
          userId,
          paidAmount,
          TX.EARN_WEEKLY,
          playedPbThisWeek
            ? i18n.t('economy.tx_weekly_pb_yes', locale, { bonus: `${CURRENCY}${pbBonus}`, multiplier })
            : i18n.t('economy.tx_weekly_pb_no', locale, { multiplier }),
        );
      }

      const updated = await tx.economyProfile.update({
        where: { guildId_userId: { guildId, userId } },
        data: { lastWeekly: new Date() },
      });
      return { paidAmount, treasuryState, updated };
    });
    const { paidAmount, treasuryState, updated } = payout;

    await invalidateProfileCache(guildId, userId);

    return {
      success: true,
      amount: paidAmount,
      multiplier,
      baseAmount: base,
      wallet: updated.wallet,
      bank: updated.bank,
      details: playedPbThisWeek
        ? i18n.t('economy.weekly_pb_bonus_detail', locale, { bonus: `${CURRENCY}${pbBonus.toLocaleString('ru-RU')}` })
        : undefined,
      treasuryState,
      expectedAmount: finalAmount,
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
function getWorkScenarios(locale?: string): string[] {
  return [
    i18n.t('economy.work_1', locale),
    i18n.t('economy.work_2', locale),
    i18n.t('economy.work_3', locale),
    i18n.t('economy.work_4', locale),
    i18n.t('economy.work_5', locale),
    i18n.t('economy.work_6', locale),
    i18n.t('economy.work_7', locale),
    i18n.t('economy.work_8', locale),
    i18n.t('economy.work_9', locale),
    i18n.t('economy.work_10', locale),
    i18n.t('economy.work_11', locale),
    i18n.t('economy.work_12', locale),
  ];
}

export async function doWork(
  guildId: string,
  member: GuildMember,
  pbRoleIds: string[],
  locale?: string,
): Promise<EarnResult> {
  const userId = member.id;
  const config = await getEcoConfig(guildId);
  const cooldownMs = config ? Number(config.workCooldown) : COOLDOWNS.work;
  const min = config?.workMin ?? DEFAULTS.workMin;
  const max = config?.workMax ?? DEFAULTS.workMax;

  const result = await withFinancialLock(guildId, userId, async () => {
    const profile = await getFreshProfile(guildId, userId);

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
    const baseAmount = secureRandomInt(min, max);
    const boosts = await getActiveBoosts(guildId);
    const finalAmount = applyEarnBoost(Math.floor(baseAmount * multiplier), boosts);
    const scenarios = getWorkScenarios(locale);
    const scenario = scenarios[Math.floor(Math.random() * scenarios.length)];

    const db = getDatabase();
    const updated = await db.$transaction(async (tx) => {
      await applyWalletDeltaInTransaction(tx, guildId, userId, finalAmount, TX.EARN_WORK, scenario);
      return tx.economyProfile.update({
        where: { id: profile.id },
        data: { lastWork: new Date() },
      });
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

function getCrimeSuccessScenarios(locale?: string): string[] {
  return [
    i18n.t('economy.crime_success_1', locale),
    i18n.t('economy.crime_success_2', locale),
    i18n.t('economy.crime_success_3', locale),
    i18n.t('economy.crime_success_4', locale),
    i18n.t('economy.crime_success_5', locale),
    i18n.t('economy.crime_success_6', locale),
  ];
}

function getCrimeFailScenarios(locale?: string): string[] {
  return [
    i18n.t('economy.crime_fail_1', locale),
    i18n.t('economy.crime_fail_2', locale),
    i18n.t('economy.crime_fail_3', locale),
    i18n.t('economy.crime_fail_4', locale),
    i18n.t('economy.crime_fail_5', locale),
    i18n.t('economy.crime_fail_6', locale),
  ];
}

export async function doCrime(
  guildId: string,
  member: GuildMember,
  pbRoleIds: string[],
  locale: string | undefined,
  wantedSourceKey: string,
): Promise<EarnResult> {
  const userId = member.id;
  const config = await getEcoConfig(guildId);
  const cooldownMs = config ? Number(config.crimeCooldown) : COOLDOWNS.crime;
  const min = config?.crimeMin ?? DEFAULTS.crimeMin;
  const max = config?.crimeMax ?? DEFAULTS.crimeMax;
  const baseSuccessRate = config?.crimeSuccessRate ?? DEFAULTS.crimeSuccessRate;
  const fine = config?.crimeFine ?? DEFAULTS.crimeFine;

  // Перк +crimeBonus к successRate
  const perks = await getUserPerks(guildId, userId);
  const successRate = Math.max(5, Math.min(98, baseSuccessRate + (perks.crimeBonus ?? 0)));

  const result = await withFinancialLock(guildId, userId, async () => {
    const profile = await getFreshProfile(guildId, userId);

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
    const isSuccess = secureChancePercent(successRate);

    const db = getDatabase();

    if (isSuccess) {
      const baseAmount = Math.max(1, secureRandomInt(min, max));
      const boosts = await getActiveBoosts(guildId);

      // Шанс 15% на крупное дело (Крупный куш ×2)
      const isMajorJob = secureRandomFloat() < 0.15;
      const jobMultiplier = isMajorJob ? 2 : 1;

      const finalAmount = applyEarnBoost(Math.floor(baseAmount * multiplier * jobMultiplier), boosts);
      const successScenarios = getCrimeSuccessScenarios(locale);
      const scenario = isMajorJob
        ? `🔥 **КРУПНОЕ ДЕЛО!** ${successScenarios[Math.floor(Math.random() * successScenarios.length)]}`
        : successScenarios[Math.floor(Math.random() * successScenarios.length)];

      const wantedChance = isMajorJob ? 1.0 : 0.3;
      const wantedTriggered = config?.wantedEnabled !== false && secureRandomFloat() < wantedChance;
      const baseDecay = Number(config?.wantedDecayMs ?? 172_800_000);
      const wantedDecayMs = wantedTriggered
        ? Math.max(60_000, Math.floor(baseDecay * (perks.wantedDecayMul ?? 1)))
        : 0;
      const wantedStarsToAdd = wantedTriggered ? applyWantedMul(isMajorJob ? 2 : 1, boosts) : 0;
      let maskUsed = false;

      const updated = await db.$transaction(async (tx) => {
        await applyWalletDeltaInTransaction(
          tx,
          guildId,
          userId,
          finalAmount,
          TX.EARN_CRIME,
          `✅ ${scenario}`,
        );
        const result = await tx.economyProfile.update({
          where: { id: profile.id },
          data: { lastCrime: new Date() },
        });

        if (wantedTriggered) {
          const mask = await tx.economyInventoryItem.findUnique({
            where: { guildId_userId_itemKey: { guildId, userId, itemKey: 'mask' } },
          });
          if (mask) {
            await tx.$queryRaw`SELECT "id" FROM "economy_inventory_items" WHERE "id" = ${mask.id} FOR UPDATE`;
            const freshMask = await tx.economyInventoryItem.findUnique({ where: { id: mask.id } });
            if (freshMask && freshMask.quantity > 0) {
              if (freshMask.quantity === 1) {
                await tx.economyInventoryItem.delete({ where: { id: freshMask.id } });
              } else {
                await tx.economyInventoryItem.update({
                  where: { id: freshMask.id },
                  data: { quantity: { decrement: 1 } },
                });
              }
              maskUsed = true;
            }
          }
          if (!maskUsed) {
            await createDeferredWantedClaimInTransaction(
              tx,
              wantedSourceKey,
              guildId,
              userId,
              wantedStarsToAdd,
              wantedDecayMs,
              new Date(Date.now() + 300_000),
            );
          }
        }
        return result;
      });

      const wantedAdded = wantedTriggered && !maskUsed;

      await invalidateProfileCache(guildId, userId);

      return {
        success: true,
        amount: finalAmount,
        multiplier,
        baseAmount: baseAmount * jobMultiplier,
        wallet: updated.wallet,
        bank: updated.bank,
        details: scenario,
        wantedAdded,
        wantedStarsToAdd,
        wantedDecayMs,
        maskUsed,
        isMajorJob,
      } as EarnResult;
    } else {
      // Провал — штраф (не ниже 0)
      const failScenarios = getCrimeFailScenarios(locale);
      const scenario = failScenarios[Math.floor(Math.random() * failScenarios.length)];

      const { updated, actualFine } = await db.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "economy_profiles" WHERE "id" = ${profile.id} FOR UPDATE`;
        const fresh = await tx.economyProfile.findUnique({
          where: { id: profile.id },
        });
        if (!fresh) throw new Error('no_profile');

        const f = Math.min(fine, Math.max(0, fresh.wallet));
        await applyWalletDeltaInTransaction(
          tx,
          guildId,
          userId,
          -f,
          TX.CRIME_FINE,
          `❌ ${scenario}`,
        );
        const result = await tx.economyProfile.update({
          where: { id: profile.id },
          data: { lastCrime: new Date() },
        });
        return { updated: result, actualFine: f };
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

function getBegScenarios(locale?: string): string[] {
  return [
    i18n.t('economy.beg_1', locale),
    i18n.t('economy.beg_2', locale),
    i18n.t('economy.beg_3', locale),
    i18n.t('economy.beg_4', locale),
    i18n.t('economy.beg_5', locale),
    i18n.t('economy.beg_6', locale),
    i18n.t('economy.beg_7', locale),
  ];
}

export async function doBeg(
  guildId: string,
  member: GuildMember,
  pbRoleIds: string[],
  locale?: string,
): Promise<EarnResult> {
  const userId = member.id;
  const config = await getEcoConfig(guildId);
  const cooldownMs = config ? Number(config.begCooldown) : COOLDOWNS.beg;
  const min = config?.begMin ?? DEFAULTS.begMin;
  const max = config?.begMax ?? DEFAULTS.begMax;

  const result = await withFinancialLock(guildId, userId, async () => {
    const profile = await getFreshProfile(guildId, userId);

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
    const baseAmount = secureRandomInt(min, max);
    const boosts = await getActiveBoosts(guildId);
    const finalAmount = applyEarnBoost(Math.floor(baseAmount * multiplier), boosts);
    const scenarios = getBegScenarios(locale);
    const scenario = scenarios[Math.floor(Math.random() * scenarios.length)];

    const db = getDatabase();
    const updated = await db.$transaction(async (tx) => {
      await applyWalletDeltaInTransaction(tx, guildId, userId, finalAmount, TX.EARN_BEG, scenario);
      return tx.economyProfile.update({
        where: { id: profile.id },
        data: { lastBeg: new Date() },
      });
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
