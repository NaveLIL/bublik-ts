// ═══════════════════════════════════════════════
//  RegBattle — Константы и типы
//
//  Система полковых боёв (ПБ):
//  временные голосовые каналы с управлением,
//  пингами, авиацией и ротацией ролей.
// ═══════════════════════════════════════════════

/** Префикс для customId всех компонентов */
export const RB_PREFIX = 'rb';

/** Разделитель в customId */
export const RB_SEP = ':';

// ── Шаблоны имён каналов ─────────────────────

export const SQUAD_NAME_TEMPLATE = '⟪ ・ОТРЯД {n}・⟫';
export const AIR_NAME_TEMPLATE = '・AIR {n}・';

// ── Размеры по умолчанию ──────────────────────

export const DEFAULT_SQUAD_SIZE = 8;
export const DEFAULT_AIR_SIZE = 4;

// ── Таймеры и интервалы (мс) ──────────────────

/** Задержка перед удалением пустого канала */
export const EMPTY_DELETE_DELAY_MS = 120_000; // 2 минуты

/** Интервал проверки пингера */
export const PINGER_INTERVAL_MS = 10_000; // 10 секунд

/** Интервал пинга роли при рекрутинге */
export const ROLE_PING_INTERVAL_MS = 5 * 60_000; // 5 минут

/** Интервал именного пинга при эскалации */
export const INDIVIDUAL_PING_INTERVAL_MS = 30_000; // 30 секунд

/** Интервал предложения запасных (когда отряд полон) */
export const FULL_SUGGEST_INTERVAL_MS = 15 * 60_000; // 15 минут

/** Длительность мьюта по кнопке «Распоряжения» */
export const ORDERS_MUTE_DURATION_MS = 30_000; // 30 секунд

/** Кулдаун кнопки «Пинг в ЛС» */
export const DM_PING_COOLDOWN_MS = 5 * 60_000; // 5 минут

/** Задержка между отправкой DM (антиспам) */
export const DM_SEND_DELAY_MS = 1_000; // 1 секунда

/** Интервал проверки целостности ролей */
export const ROLE_INTEGRITY_INTERVAL_MS = 60_000; // 60 секунд

/** Кол-во пингов роли до эскалации к именным (по умолчанию) */
export const DEFAULT_PING_ESCALATE_AFTER = 3;

/** Кулдаун создания канала (мс) */
export const CREATION_COOLDOWN_MS = 10_000; // 10 секунд
