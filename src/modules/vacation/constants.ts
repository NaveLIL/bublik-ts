// ═══════════════════════════════════════════════
//  Vacation — Константы и перечисления
// ═══════════════════════════════════════════════

import { i18n } from '../../core/I18n';

export const VAC_PREFIX = 'vac';
export const VAC_SEP = ':';

// ── Статусы заявок ──────────────────────────────
export enum VacationStatus {
  Pending   = 'pending',
  Activating = 'activating',
  Active    = 'active',
  Restoring = 'restoring',
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
  { label: 'vacation.reason_personal', value: 'personal',  emoji: '🏠' },
  { label: 'vacation.reason_health',   value: 'health',    emoji: '🏥' },
  { label: 'vacation.reason_work',     value: 'work',      emoji: '💼' },
  { label: 'vacation.reason_travel',   value: 'travel',    emoji: '✈️' },
  { label: 'vacation.reason_burnout',  value: 'burnout',   emoji: '😴' },
  { label: 'vacation.reason_other',    value: 'other',     emoji: '📝' },
];

// ── Тайминги ────────────────────────────────────
export const AUTO_DENY_MIN_MS      = 1 * 60 * 60 * 1000;    // 1 час — минимум для запроса к БД (реальный порог — autoDenyHours в конфиге)
export const REMINDER_BEFORE_MS   = 24 * 60 * 60 * 1000;   // 24 часа — напоминание
export const SCHEDULER_INTERVAL_MS = 60 * 1000;             // 1 минута — интервал проверки
export const MSK_OFFSET           = 3;                      // UTC+3 Москва
export const MIN_DURATION_MINUTES = 60;                     // минимум 1 час

// ── Хелперы ─────────────────────────────────────

/** Получить отображаемый текст причины */
export function getReasonLabel(value: string, locale: string): string {
  const r = REASONS.find((x) => x.value === value);
  return r ? `${r.emoji} ${i18n.t(r.label, locale)}` : value;
}

// ── Небесные Стражи ─────────────────────────────
export const NS_PREFIX = 'ns';

/** Роль-маркер «Небесный страж» — проверка доступа к кнопке */
export const NS_ACCESS_ROLE_ID = '1391676669206462524';

/** Роли НС, которые НЕ снимаются при ПБ-щите (все остальные снимаются) */
export const NS_KEEP_ROLE_IDS = new Set([
  '1391678674872438844',
  '1391678304712527932',
  '1391692583436288041',
  '1391692802655785062',
  '1391692713124167750',
  '1391692225754431599',
  '1391692354682884106',
  '1391676669206462524',
]);

/** Канал логов НС-панели */
export const NS_LOG_CHANNEL_ID = '1391677953514930206';

/** Длительность ПБ-щита (4 часа) */
export const NS_SHIELD_DURATION_MS = 4 * 60 * 60 * 1000;

/** Длительность рофл-наказания (10 минут) */
export const NS_TROLL_DURATION_MS = 10 * 60 * 1000;

/** Rate limit кнопки «Небесные стражи» на основной панели (1 мин) */
export const NS_BUTTON_COOLDOWN_MS = 60 * 1000;

/** Rate limit рофл-кнопки (30 мин) */
export const NS_TROLL_COOLDOWN_MS = 30 * 60 * 1000;

/** Rate limit кнопок НС-панели отпуска (1 мин) */
export const NS_PANEL_COOLDOWN_MS = 60 * 1000;

/** Максимальная длительность НС-отпуска (30 дней) */
export const NS_MAX_VACATION_DAYS = 30;

/** Типы НС-записей */
export enum NsType {
  Shield   = 'shield',   // ПБ-щит (4ч, роли снимаются кроме НС)
  Troll    = 'troll',    // рофл (10мин, все роли)
  Vacation = 'vacation', // отпуск (панель, без ролей)
}
