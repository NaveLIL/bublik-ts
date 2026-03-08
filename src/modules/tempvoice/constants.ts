// ═══════════════════════════════════════════════
//  TempVoice — константы и типы
// ═══════════════════════════════════════════════

/** Состояния канала */
export enum ChannelState {
  Unlocked = 'unlocked',
  Locked = 'locked',
  Hidden = 'hidden',
}

/** Уровни доступа пользователя */
export enum AccessLevel {
  Owner = 'owner',
  Moderator = 'moderator',   // immuneRole
  Booster = 'booster',       // server boosters с расширенными правами
  Trusted = 'trusted',       // доверенные (добавлены владельцем)
  Normal = 'normal',         // обычные пользователи
  Blocked = 'blocked',       // заблокированные
}

/** Страницы панели управления */
export enum PanelPage {
  Main = 'main',
  Access = 'access',
  Settings = 'settings',
}

/** Префикс для customId всех компонентов */
export const TV_PREFIX = 'tv';

/** Разделитель в customId */
export const TV_SEP = ':';

/** Максимум переименований за период */
export const MAX_RENAMES = 2;

/** Период сброса переименований (мс) — 10 минут */
export const RENAME_RESET_MS = 10 * 60 * 1_000;

/** Задержка перед удалением пустого канала (мс) */
export const EMPTY_DELETE_DELAY_MS = 8_000;

/** Интервал очистки неактивных каналов (мс) — 1 час */
export const CLEANUP_INTERVAL_MS = 60 * 60 * 1_000;

/** Максимальный возраст неактивного канала (мс) — 24 часа */
export const MAX_INACTIVE_MS = 24 * 60 * 60 * 1_000;

/** Rate-limit: макс. действий за окно */
export const RATE_LIMIT_MAX = 8;

/** Rate-limit: окно (мс) — 15 секунд */
export const RATE_LIMIT_WINDOW_MS = 15_000;

/** Таймаут коллектора Select Menu (мс) */
export const COLLECTOR_TIMEOUT_MS = 30_000;

/** Кулдаун создания канала (мс) — 10 секунд */
export const CREATION_COOLDOWN_MS = 10_000;

/** Переменные шаблона имени */
export const NAME_VARIABLES: Record<string, string> = {
  '{username}': 'Имя пользователя',
  '{nickname}': 'Никнейм на сервере',
  '{game}': 'Текущая игра',
  '{count}': 'Порядковый номер',
};

/** Голосовые регионы */
export const VOICE_REGIONS = [
  { value: 'auto', label: '🌐 Авто' },
  { value: 'brazil', label: '🇧🇷 Бразилия' },
  { value: 'hongkong', label: '🇭🇰 Гонконг' },
  { value: 'india', label: '🇮🇳 Индия' },
  { value: 'japan', label: '🇯🇵 Япония' },
  { value: 'russia', label: '🇷🇺 Россия' },
  { value: 'rotterdam', label: '🇳🇱 Роттердам' },
  { value: 'singapore', label: '🇸🇬 Сингапур' },
  { value: 'southafrica', label: '🇿🇦 Южная Африка' },
  { value: 'sydney', label: '🇦🇺 Сидней' },
  { value: 'us-central', label: '🇺🇸 США (центр)' },
  { value: 'us-east', label: '🇺🇸 США (восток)' },
  { value: 'us-west', label: '🇺🇸 США (запад)' },
] as const;

/** Варианты битрейта */
export const BITRATE_OPTIONS = [
  { value: '32000', label: '32 кбит/с' },
  { value: '64000', label: '64 кбит/с' },
  { value: '80000', label: '80 кбит/с' },
  { value: '96000', label: '96 кбит/с' },
  { value: '128000', label: '128 кбит/с (буст ур.1)' },
  { value: '256000', label: '256 кбит/с (буст ур.2)' },
  { value: '384000', label: '384 кбит/с (буст ур.3)' },
] as const;
