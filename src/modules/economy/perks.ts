// ═══════════════════════════════════════════════
//  Role Perks — бонусы от ролей в магазине
//
//  Перки накапливаются с активных (не истёкших) покупок ShopPurchase
//  игрока. Хранятся как JSON в ShopItem.perks.
//
//  Numeric perks суммируются. Multipliers перемножаются.
// ═══════════════════════════════════════════════

import { getDatabase } from '../../core/Database';
import { cacheGet, cacheSet, cacheDel } from '../../core/Redis';

export interface Perks {
  robBonus?: number;        // + к successRate /rob атакующему (0..30)
  robDefense?: number;      // − к successRate атакующего, когда юзер — жертва (0..30)
  crimeBonus?: number;      // + к successRate /crime (0..20)
  captureBonus?: number;    // + к chance /capture (0..20)
  wantedDecayMul?: number;  // × к decayMs (0.3..2.0). <1 = звёзды сгорают быстрее
  dirtyMul?: number;        // × к доле грязных при /rob (0..1). 0 = весь доход чистый
  cooldownMul?: number;     // × к remaining-time проверке (0.5..1.0). <1 = меньше ждать
}

// Безопасные диапазоны (anti-OP / anti-troll). Чтобы суммы не уходили в космос.
const CLAMP: Record<keyof Perks, [number, number]> = {
  robBonus:       [0, 30],
  robDefense:     [0, 30],
  crimeBonus:     [0, 20],
  captureBonus:   [0, 20],
  wantedDecayMul: [0.3, 2.0],
  dirtyMul:       [0, 1],
  cooldownMul:    [0.5, 1.0],
};

const NUMERIC: (keyof Perks)[] = ['robBonus', 'robDefense', 'crimeBonus', 'captureBonus'];
const MULTIPLIER: (keyof Perks)[] = ['wantedDecayMul', 'dirtyMul', 'cooldownMul'];

export const PERK_LABELS: Record<keyof Perks, { ru: string; en: string; emoji: string }> = {
  robBonus:       { emoji: '🎯', ru: 'Бонус к /rob',         en: '/rob bonus' },
  robDefense:     { emoji: '🛡️', ru: 'Защита от /rob',       en: '/rob defense' },
  crimeBonus:     { emoji: '🔫', ru: 'Бонус к /crime',       en: '/crime bonus' },
  captureBonus:   { emoji: '🚓', ru: 'Бонус к /capture',     en: '/capture bonus' },
  wantedDecayMul: { emoji: '⏱️', ru: 'Сгорание звёзд',       en: 'Star decay' },
  dirtyMul:       { emoji: '🧼', ru: 'Меньше грязных денег', en: 'Less dirty money' },
  cooldownMul:    { emoji: '⚡', ru: 'Уменьшенные кулдауны', en: 'Reduced cooldowns' },
};

const ALL_KEYS = new Set<keyof Perks>([...NUMERIC, ...MULTIPLIER]);

const CACHE_TTL_S = 5 * 60;
const cacheKey = (g: string, u: string) => `perks:${g}:${u}`;

// ═══════════════════════════════════════════════
//  Парсинг
// ═══════════════════════════════════════════════

/** Sanitize raw perks-object: drop unknown keys, clamp values. Возвращает null если ничего не осталось. */
export function sanitizePerks(input: unknown): Perks | null {
  if (!input || typeof input !== 'object') return null;
  const out: Perks = {};
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if (!ALL_KEYS.has(k as keyof Perks)) continue;
    const num = typeof v === 'number' ? v : parseFloat(String(v));
    if (!Number.isFinite(num)) continue;
    const [min, max] = CLAMP[k as keyof Perks];
    out[k as keyof Perks] = Math.max(min, Math.min(max, num));
  }
  return Object.keys(out).length > 0 ? out : null;
}

/** Парсит строку формата `robBonus=10,dirtyMul=0.8` → Perks. */
export function parsePerksString(str: string | null | undefined): Perks | null {
  if (!str) return null;
  const obj: Record<string, number> = {};
  for (const pair of str.split(/[,;\s]+/)) {
    const [k, v] = pair.split('=').map((s) => s.trim());
    if (!k || !v) continue;
    const num = parseFloat(v);
    if (Number.isFinite(num)) obj[k] = num;
  }
  return sanitizePerks(obj);
}

// ═══════════════════════════════════════════════
//  Объединение
// ═══════════════════════════════════════════════

/** Складывает несколько Perks в один: суммирует numeric, перемножает multipliers. */
export function combinePerks(list: Perks[]): Perks {
  const out: Perks = {};
  for (const k of NUMERIC) {
    let s = 0;
    let any = false;
    for (const p of list) {
      const v = p[k];
      if (typeof v === 'number') { s += v; any = true; }
    }
    if (any) {
      const [min, max] = CLAMP[k];
      out[k] = Math.max(min, Math.min(max, s));
    }
  }
  for (const k of MULTIPLIER) {
    let m = 1;
    let any = false;
    for (const p of list) {
      const v = p[k];
      if (typeof v === 'number') { m *= v; any = true; }
    }
    if (any) {
      const [min, max] = CLAMP[k];
      out[k] = Math.max(min, Math.min(max, m));
    }
  }
  return out;
}

// ═══════════════════════════════════════════════
//  Главный API
// ═══════════════════════════════════════════════

/**
 * Все активные перки игрока (по непросроченным ShopPurchase).
 * Кэшируется в Redis на 5 минут.
 */
export async function getUserPerks(guildId: string, userId: string): Promise<Perks> {
  const key = cacheKey(guildId, userId);
  try {
    const cached = await cacheGet<Perks>(key);
    if (cached) return cached;
  } catch { /* ignore cache errors */ }

  const db = getDatabase();
  const now = new Date();
  const purchases = await db.shopPurchase.findMany({
    where: {
      guildId,
      userId,
      OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
    },
    include: { item: true },
  });

  const perksList: Perks[] = [];
  for (const p of purchases) {
    if (!p.item || !p.item.isActive) continue;
    const sanitized = sanitizePerks(p.item.perks);
    if (sanitized) perksList.push(sanitized);
  }

  // Добавляем перки из предметов в инвентаре игрока
  const invItems = await db.economyInventoryItem.findMany({
    where: {
      guildId,
      userId,
    }
  });

  for (const item of invItems) {
    if (!item.perks) continue;
    const parsed = typeof item.perks === 'string' ? JSON.parse(item.perks) : item.perks;
    const sanitized = sanitizePerks(parsed);
    if (sanitized) perksList.push(sanitized);
  }

  const merged = combinePerks(perksList);

  try {
    await cacheSet(key, merged, CACHE_TTL_S);
  } catch { /* ignore */ }

  return merged;
}

/** Сбросить кэш перков (вызывать при покупке/истечении/удалении). */
export async function invalidateUserPerks(guildId: string, userId: string): Promise<void> {
  try { await cacheDel(cacheKey(guildId, userId)); } catch { /* ignore */ }
}

// ═══════════════════════════════════════════════
//  Форматирование (для UI)
// ═══════════════════════════════════════════════

/** Описание одного перка в человеко-читаемом формате. */
export function formatPerkValue(key: keyof Perks, value: number, locale = 'ru'): string {
  const lbl = PERK_LABELS[key];
  const name = locale.startsWith('en') ? lbl.en : lbl.ru;
  if (NUMERIC.includes(key)) {
    return `${lbl.emoji} ${name} +${value}%`;
  }
  // multipliers
  const pct = Math.round((1 - value) * 100);
  if (pct === 0) return `${lbl.emoji} ${name} ×${value.toFixed(2)}`;
  if (pct > 0) return `${lbl.emoji} ${name} −${pct}%`;
  return `${lbl.emoji} ${name} +${-pct}%`;
}

/** Бэйдж со всеми перками одной строкой. */
export function formatPerksInline(perks: Perks | null, locale = 'ru'): string {
  if (!perks) return '';
  const parts: string[] = [];
  for (const k of [...NUMERIC, ...MULTIPLIER]) {
    const v = perks[k as keyof Perks];
    if (typeof v === 'number') parts.push(formatPerkValue(k as keyof Perks, v, locale));
  }
  return parts.join(' • ');
}
