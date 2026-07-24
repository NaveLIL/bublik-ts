// ═══════════════════════════════════════════════
//  Teams module — constants
// ═══════════════════════════════════════════════

// Prefix для customId компонентов
export const TM_PREFIX = 'tm';
export const TM_SEP = ':';

// Лимиты
export const DEFAULT_MIN_TEAM_SIZE = 10;
/** Discord user-select supports at most 25 selected users; the leader is #26. */
export const MAX_TEAM_SIZE = 26;
export const MAX_TEAM_NAME_LENGTH = 32;
export const MIN_TEAM_NAME_LENGTH = 2;

// Таймеры
export const INVITE_TIMEOUT_H = 24;
export const FORMATION_DAYS = 7;
export const DISBAND_GRACE_DAYS = 30;
export const REPORT_TIMEOUT_H = 3;
export const POLL_AUTO_HOURS_BEFORE = 2;

// Интервалы (мс)
export const INVITE_EXPIRY_CHECK_MS = 60_000;        // 1 минута — проверка истёкших инвайтов
export const DISBAND_CHECK_MS = 3_600_000;            // 1 час — проверка команд на расформирование
export const MEMBER_KICK_RECOVERY_CHECK_MS = 60_000;  // 1 минута — восстановление незавершённых исключений
export const MEMBER_KICK_RECOVERY_LEASE_MS = 120_000; // 2 минуты — защита активного запроса от recovery
export const LEADERBOARD_UPDATE_MS = 86_400_000;      // 24 часа — обновление лидерборда
export const POLL_AUTO_CHECK_MS = 300_000;            // 5 минут — проверка авто-опросов
export const POLL_MAX_AGE_MS = 86_400_000;             // 24 часа — авто-закрытие опроса
export const REPORT_REMINDER_MS = 60_000;             // 1 минута — проверка отчётов

// Сезоны: 6 штук, каждый по 2 месяца начиная с января
// Сезон 1 = Янв-Фев, Сезон 2 = Мар-Апр, ..., Сезон 6 = Ноя-Дек
export function getCurrentSeason(date = new Date()): { season: number; year: number } {
  const month = date.getMonth() + 1; // 1-12
  const season = Math.ceil(month / 2); // 1-6
  return { season, year: date.getFullYear() };
}

export function getSeasonLabel(season: number): string {
  const labels: Record<number, string> = {
    1: 'Январь — Февраль',
    2: 'Март — Апрель',
    3: 'Май — Июнь',
    4: 'Июль — Август',
    5: 'Сентябрь — Октябрь',
    6: 'Ноябрь — Декабрь',
  };
  return labels[season] ?? `Сезон ${season}`;
}

// Статусы
export const TeamStatus = {
  FORMING: 'forming',
  CREATION_CLEANUP: 'creation_cleanup',
  ACTIVE: 'active',
  DISBANDING: 'disbanding',
  DELETING: 'deleting',
  DISBANDED: 'disbanded',
} as const;

/** States in which leader/member mutations are still valid. */
export function isTeamOperationalStatus(status: string): boolean {
  return status === TeamStatus.FORMING ||
    status === TeamStatus.ACTIVE ||
    status === TeamStatus.DISBANDING;
}

export const InviteStatus = {
  PENDING: 'pending',
  ACCEPTED: 'accepted',
  DECLINED: 'declined',
  EXPIRED: 'expired',
} as const;

export const ApplicationStatus = {
  PENDING: 'pending',
  CREATION_CLEANUP: 'creation_cleanup',
  APPROVED: 'approved',
  REJECTED: 'rejected',
} as const;

export const PollStatus = {
  ACTIVE: 'active',
  CLOSED: 'closed',
} as const;
