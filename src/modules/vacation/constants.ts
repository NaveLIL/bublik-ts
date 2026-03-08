// ═══════════════════════════════════════════════
//  Vacation — Константы и перечисления
// ═══════════════════════════════════════════════

export const VAC_PREFIX = 'vac';
export const VAC_SEP = ':';

// ── Статусы заявок ──────────────────────────────
export enum VacationStatus {
  Pending   = 'pending',
  Active    = 'active',
  Denied    = 'denied',
  Expired   = 'expired',
  Completed = 'completed',
}

// ── Типы отпуска ────────────────────────────────
export enum VacationType {
  Regular = 'regular',
  Quick   = 'quick',
  Admin   = 'admin',
}

// ── Предопределённые причины ────────────────────
export interface VacationReason {
  label: string;
  value: string;
  emoji: string;
}

export const REASONS: VacationReason[] = [
  { label: 'Личные обстоятельства', value: 'personal',  emoji: '🏠' },
  { label: 'Здоровье',              value: 'health',    emoji: '🏥' },
  { label: 'Учёба / Работа',        value: 'work',      emoji: '💼' },
  { label: 'Путешествие',           value: 'travel',    emoji: '✈️' },
  { label: 'Выгорание / Усталость', value: 'burnout',   emoji: '😴' },
  { label: 'Другое (указать)',       value: 'other',     emoji: '📝' },
];

// ── Тайминги ────────────────────────────────────
export const AUTO_DENY_MS         = 3 * 60 * 60 * 1000;    // 3 часа — автоотклонение
export const REMINDER_BEFORE_MS   = 24 * 60 * 60 * 1000;   // 24 часа — напоминание
export const SCHEDULER_INTERVAL_MS = 60 * 1000;             // 1 минута — интервал проверки
export const MSK_OFFSET           = 3;                      // UTC+3 Москва
export const MIN_DURATION_MINUTES = 60;                     // минимум 1 час

// ── Хелперы ─────────────────────────────────────

/** Получить отображаемый текст причины */
export function getReasonLabel(value: string): string {
  const r = REASONS.find((x) => x.value === value);
  return r ? `${r.emoji} ${r.label}` : value;
}
