// ═══════════════════════════════════════════════
//  Сезонные эвенты / временные бусты
//
//  Конфиг хранится в EconomyConfig:
//   - eventName, eventEndsAt: ручной эвент админа
//   - eventEarnMul / eventRobMul / eventWantedMul: множители (100 = x1.0)
//   - eventWeekendEnabled + eventWeekendEarnMul / eventWeekendRobMul:
//       автоматический буст по субботам/воскресеньям (UTC)
//
//  Ручной эвент и weekend-буст СТАКАЮТСЯ (перемножаются).
// ═══════════════════════════════════════════════

import { getEcoConfig } from './database';

export interface ActiveBoosts {
  earnMul: number;    // множитель (1.0 = базовый)
  robMul: number;
  wantedMul: number;
  isWeekend: boolean;
  eventName: string;  // "" если нет ручного
  eventEndsAt: Date | null;
}

const NEUTRAL: ActiveBoosts = {
  earnMul: 1,
  robMul: 1,
  wantedMul: 1,
  isWeekend: false,
  eventName: '',
  eventEndsAt: null,
};

/** Получить активные множители для гильдии. Никогда не бросает. */
export async function getActiveBoosts(guildId: string): Promise<ActiveBoosts> {
  try {
    const cfg = await getEcoConfig(guildId);
    if (!cfg) return NEUTRAL;

    const now = new Date();
    const day = now.getUTCDay();           // 0=вс, 6=сб
    const isWeekend = day === 0 || day === 6;

    // Проверка истечения ручного эвента
    let eventName = cfg.eventName ?? '';
    let eventEndsAt = cfg.eventEndsAt ?? null;
    let eEarn = cfg.eventEarnMul ?? 100;
    let eRob = cfg.eventRobMul ?? 100;
    let eWanted = cfg.eventWantedMul ?? 100;

    if (eventName && eventEndsAt && eventEndsAt.getTime() < now.getTime()) {
      // Эвент истёк — игнорим (в фоне очистится через cleanupExpiredEvents)
      eventName = '';
      eventEndsAt = null;
      eEarn = 100;
      eRob = 100;
      eWanted = 100;
    }

    let wEarn = 100;
    let wRob = 100;
    if (isWeekend && cfg.eventWeekendEnabled) {
      wEarn = cfg.eventWeekendEarnMul ?? 150;
      wRob = cfg.eventWeekendRobMul ?? 150;
    }

    return {
      earnMul: (eEarn / 100) * (wEarn / 100),
      robMul: (eRob / 100) * (wRob / 100),
      wantedMul: eWanted / 100,
      isWeekend,
      eventName,
      eventEndsAt,
    };
  } catch {
    return NEUTRAL;
  }
}

/** Применить earn-бусты к сумме. */
export function applyEarnBoost(amount: number, boosts: ActiveBoosts): number {
  return Math.floor(amount * boosts.earnMul);
}

/** Применить rob-бусты к сумме (для /rob, /heist добычи). */
export function applyRobBoost(amount: number, boosts: ActiveBoosts): number {
  return Math.floor(amount * boosts.robMul);
}

/** Сколько звёзд получить (по умолчанию 1). С wantedMul=2.0 → 2 звезды. */
export function applyWantedMul(baseStars: number, boosts: ActiveBoosts): number {
  return Math.max(0, Math.round(baseStars * boosts.wantedMul));
}

/** Короткий бэйдж для embed-ов: "🎉 ДВОЙНОЙ КУШ x1.5" или "" если нейтрально. */
export function formatBoostBadge(boosts: ActiveBoosts, locale = 'ru'): string {
  const parts: string[] = [];
  if (boosts.eventName) {
    parts.push(`🎉 ${boosts.eventName}`);
  }
  if (boosts.isWeekend && (boosts.earnMul > 1 || boosts.robMul > 1)) {
    parts.push(locale.startsWith('en') ? '🎊 Weekend boost' : '🎊 Бонус выходного');
  }
  if (parts.length === 0) return '';
  const muls: string[] = [];
  if (boosts.earnMul !== 1) muls.push(`💰x${boosts.earnMul.toFixed(2)}`);
  if (boosts.robMul !== 1) muls.push(`🦹x${boosts.robMul.toFixed(2)}`);
  if (boosts.wantedMul !== 1) muls.push(`⭐x${boosts.wantedMul.toFixed(2)}`);
  return `${parts.join(' • ')} (${muls.join(' ')})`;
}
