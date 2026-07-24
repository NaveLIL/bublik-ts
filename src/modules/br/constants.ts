// ═══════════════════════════════════════════════
//  BR — Константы
// ═══════════════════════════════════════════════

export const BR_PREFIX = 'br';
export const BR_SEP = ':';

// Кэш конфига панели
export const BR_CACHE_PREFIX = 'br:panel';
export const BR_CACHE_TTL = 600;
export const BR_DATA_CACHE_PREFIX = 'br:data';
export const BR_DATA_CACHE_TTL = 300;

// ── Категории ──────────────────────────────────
export const CATEGORIES = ['tanks', 'planes', 'helis', 'spaa'] as const;
export type Category = (typeof CATEGORIES)[number];

export const CATEGORY_EMOJI: Record<Category, string> = {
  tanks: '🛡️',
  planes: '✈️',
  helis: '🚁',
  spaa: '🎯',
};

// ── Приоритеты (порядок важен — high → normal → low) ──
export const PRIORITIES = ['high', 'normal', 'low'] as const;
export type Priority = (typeof PRIORITIES)[number];

export const PRIORITY_EMOJI: Record<Priority, string> = {
  high: '🟢',
  normal: '🟡',
  low: '🔴',
};

// ANSI-цвета для блоков ```ansi (Discord)
export const PRIORITY_ANSI: Record<Priority, string> = {
  high: '\u001b[1;32m',   // ярко-зелёный
  normal: '\u001b[1;33m', // ярко-жёлтый
  low: '\u001b[1;31m',    // ярко-красный
};
export const ANSI_RESET = '\u001b[0m';

// ── Ограничения Discord ─────────────────────────
export const MAX_NAME_LENGTH = 64;
export const MAX_BULK_LENGTH = 4000;
export const MAX_SELECT_OPTIONS = 25;

// ── Маппинг старых русских значений → новых ключей (для миграции и совместимости ввода) ──
export const LEGACY_CATEGORY_MAP: Record<string, Category> = {
  'танки': 'tanks',
  'tanks': 'tanks',
  'самолеты': 'planes',
  'самолёты': 'planes',
  'planes': 'planes',
  'вертолеты': 'helis',
  'вертолёты': 'helis',
  'helis': 'helis',
  'зсу': 'spaa',
  'spaa': 'spaa',
};

export const LEGACY_PRIORITY_MAP: Record<string, Priority> = {
  'приоритетно': 'high',
  'high': 'high',
  'нормально': 'normal',
  'normal': 'normal',
  'в крайнем случае': 'low',
  'low': 'low',
};

export function normalizeCategory(input: string): Category | null {
  return LEGACY_CATEGORY_MAP[input.trim().toLowerCase()] ?? null;
}

export function normalizePriority(input: string): Priority | null {
  return LEGACY_PRIORITY_MAP[input.trim().toLowerCase()] ?? null;
}

// ── Цвет embed по БР ────────────────────────────
export function getBrColor(br: string | number): number {
  const v = typeof br === 'string' ? parseFloat(br) : br;
  if (isNaN(v)) return 0x5865f2;
  if (v <= 5.0) return 0x57f287;   // green
  if (v <= 8.0) return 0x3498db;   // blue
  if (v <= 11.0) return 0xe67e22;  // orange
  return 0xed4245;                 // red
}

export function getBrEmoji(br: string | number): string {
  const v = typeof br === 'string' ? parseFloat(br) : br;
  if (isNaN(v)) return '⚪';
  if (v <= 5.0) return '🟢';
  if (v <= 8.0) return '🔵';
  if (v <= 11.0) return '🟠';
  return '🔴';
}

// ── Локализованные подписи ──────────────────────
export const I18N_CATEGORY_KEY: Record<Category, string> = {
  tanks: 'br.cat_tanks',
  planes: 'br.cat_planes',
  helis: 'br.cat_helis',
  spaa: 'br.cat_spaa',
};

export const I18N_PRIORITY_KEY: Record<Priority, string> = {
  high: 'br.pri_high',
  normal: 'br.pri_normal',
  low: 'br.pri_low',
};
