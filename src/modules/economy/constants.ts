// ═══════════════════════════════════════════════
//  Economy — Константы, ставки и PB-роли
//
//  Шекели (₪) — валюта клана EREZ.
//  Всё настраиваемое хранится в EconomyConfig (БД),
//  здесь — только hardcoded лимиты и PB-привязки.
// ═══════════════════════════════════════════════

/** Префикс для customId всех компонентов экономики */
export const ECO_PREFIX = 'eco';

/** Разделитель в customId */
export const ECO_SEP = ':';

/** Символ валюты */
export const CURRENCY = '₪';

/** Название валюты (для текстов) */
export const CURRENCY_NAME = 'шекелей';

// ── Redis префиксы ───────────────────────────

export const REDIS_ECO_CONFIG   = 'eco:cfg';     // eco:cfg:{guildId}
export const REDIS_ECO_PROFILE  = 'eco:prof';    // eco:prof:{guildId}:{userId}
export const REDIS_ECO_VOICE    = 'eco:voice';   // eco:voice:{guildId}:{userId}  — last join time
export const REDIS_ECO_LOCK     = 'eco:lock';    // eco:lock:{guildId}:{userId}   — финансовая блокировка
export const REDIS_ECO_CD       = 'eco:cd';      // eco:cd:{type}:{guildId}:{userId}

/** TTL кэша конфигурации (секунд) */
export const CONFIG_CACHE_TTL = 600; // 10 мин

/** TTL кэша профиля (секунд) */
export const PROFILE_CACHE_TTL = 300; // 5 мин

/** TTL финансовой блокировки (секунд) — защита от race condition */
export const LOCK_TTL = 10; // 10 секунд

// ── Голосовой заработок ──────────────────────

/** Интервал начислений за войс (мс) — раз в 10 минут */
export const VOICE_TICK_INTERVAL_MS = 600_000;

/** Мин. людей в канале для начислений (по умолчанию) */
export const VOICE_MIN_MEMBERS = 2;

// ── Дефолтные значения заработка ─────────────

export const DEFAULTS = {
  voiceRateBase: 50,        // ₪/ч в обычных войсах
  voiceRatePb: 200,         // ₪/ч в ПБ-войсах

  dailyBase: 500,           // базовый дейли
  dailyStreakAdd: 50,       // +₪50 за каждый день стрика
  dailyStreakMax: 500,      // макс. бонус стрика (+₪500)
  weeklyBase: 5000,
  weeklyPbBonus: 2000,      // бонус если ПБ на неделе

  workMin: 200,
  workMax: 800,
  crimeMin: 0,
  crimeMax: 2000,
  crimeSuccessRate: 60,     // 60%
  crimeFine: 500,
  begMin: 5,
  begMax: 100,

  transferTax: 5,           // 5%
  bankWithdrawTax: 2,       // 2%
} as const;

// ── Кулдауны (мс) ───────────────────────────

export const COOLDOWNS = {
  daily:  86_400_000,       // 24ч
  weekly: 604_800_000,      // 7д
  work:   14_400_000,       // 4ч
  crime:  28_800_000,       // 8ч
  beg:    30_000,           // 30с
  rob:    14_400_000,       // 4ч (фаза 2)
} as const;

// ── Казино дефолты ──────────────────────

export const CASINO_DEFAULTS = {
  minBet: 50,
  maxBet: 50_000,
  slotsJackpotMultiplier: 10,
  slotsTripleMultiplier: 5,
  slotsDoubleMultiplier: 2,
  coinflipMultiplier: 1.9,     // возврат x1.9 (хаус-эдж 5%)
  diceMultiplier: 2.5,         // угадал точное число
  diceRangeMultiplier: 1.5,    // угадал higher/lower
  blackjackMultiplier: 2.0,    // обычный выигрыш
  blackjackBjMultiplier: 2.5,  // блэкджек (21 с 2 карт)
} as const;

// ── Ограбления дефолты ───────────────────

export const ROB_DEFAULTS = {
  successRate: 45,
  minSteal: 100,
  maxPercent: 30,
  fine: 500,
  minVictimWallet: 500,        // мин. в кошельке жертвы
} as const;

// ── PB роли → множитель / лимит банка ────────
//
// Роли привязываются по ID в рантайме.
// Здесь — порядок ролей (от низшей к высшей)
// и соответствующие бонусы.
// ═════════════════════════════════════════════

export interface PbRoleTier {
  /** Название роли (для логов / эмбедов) */
  name: string;
  /** Требуемые часы в ПБ (для справки) */
  hours: number;
  /** Глобальный множитель заработка */
  multiplier: number;
  /** Лимит банковского счёта (Infinity = безлимит) */
  bankLimit: number;
}

/**
 * PB-роли от низшей к высшей.
 * Индекс = позиция в массиве config.pbRoleIds (порядок важен!).
 * При поиске роли пользователя — идём от конца, первая найденная = тир.
 */
export const PB_TIERS: PbRoleTier[] = [
  { name: 'Шалом, полковые!',         hours: 50,    multiplier: 1.0,  bankLimit: 10_000   },
  { name: 'Кошерный Воин',            hours: 100,   multiplier: 1.1,  bankLimit: 25_000   },
  { name: 'Моше Даян Войса',          hours: 200,   multiplier: 1.2,  bankLimit: 50_000   },
  { name: 'Маца и Меркава',           hours: 400,   multiplier: 1.3,  bankLimit: 100_000  },
  { name: 'Шаббатний Ветеран',        hours: 600,   multiplier: 1.4,  bankLimit: 200_000  },
  { name: 'Голда Меир Одобряет',      hours: 800,   multiplier: 1.5,  bankLimit: 350_000  },
  { name: 'Гордость Василия',         hours: 1200,  multiplier: 1.7,  bankLimit: 500_000  },
  { name: 'Моссад Войсовых Каналов',  hours: 2000,  multiplier: 1.9,  bankLimit: 750_000  },
  { name: 'Раввин Полковых Боёв',     hours: 3500,  multiplier: 2.2,  bankLimit: 1_000_000 },
  { name: 'Мазл Тов, Легенда!',       hours: 5000,  multiplier: 2.5,  bankLimit: Infinity },
];

/** Базовый лимит банка (без PB-роли) */
export const BASE_BANK_LIMIT = 5_000;

/** Базовый множитель (без PB-роли) */
export const BASE_MULTIPLIER = 1.0;

// ── Типы транзакций ──────────────────────────

export const TX = {
  // Заработок
  EARN_DAILY:   'earn_daily',
  EARN_WEEKLY:  'earn_weekly',
  EARN_WORK:    'earn_work',
  EARN_CRIME:   'earn_crime',
  EARN_BEG:     'earn_beg',
  EARN_VOICE:   'earn_voice',

  // Переводы
  TRANSFER_OUT: 'transfer_out',
  TRANSFER_IN:  'transfer_in',

  // Банк
  BANK_DEPOSIT:  'bank_deposit',
  BANK_WITHDRAW: 'bank_withdraw',

  // Штрафы
  CRIME_FINE:   'crime_fine',
  ROB_FINE:     'rob_fine',

  // Ограбления
  ROB_SUCCESS:  'rob_success',
  ROB_VICTIM:   'rob_victim',

  // Казино
  CASINO_WIN:   'casino_win',
  CASINO_LOSE:  'casino_lose',
  CASINO_BJ:    'casino_bj',

  // Магазин
  SHOP_BUY:     'shop_buy',
} as const;

// ── Emoji для embed-ов ───────────────────────

export const EMOJI = {
  SHEKEL:     '💰',
  WALLET:     '👛',
  BANK:       '🏦',
  DAILY:      '📅',
  WEEKLY:     '📆',
  WORK:       '⛏️',
  CRIME:      '🔫',
  BEG:        '🙏',
  VOICE:      '🎙️',
  TRANSFER:   '💸',
  STREAK:     '🔥',
  LEADERBOARD:'🏆',
  UP:         '📈',
  DOWN:       '📉',
  LOCK:       '🔒',
  NEWS:       '📰',
  STAR:       '⭐',
  CROWN:      '👑',
  ERROR:      '❌',
  SUCCESS:    '✅',
  CLOCK:      '⏰',
  ARROW_RIGHT:'▸',
  DICE:       '🎲',
  SLOTS:      '🎰',
  COIN:       '🪙',
  CARDS:      '🃏',
  ROB:        '🕵️',
  SHOP:       '🛍️',
  CART:       '🛒',
} as const;

// ── Новостные пороги ─────────────────────────

/** Мин. сумма заработка для попадания в новости */
export const NEWS_EARN_THRESHOLD = 5_000;

/** Мин. сумма перевода для попадания в новости */
export const NEWS_TRANSFER_THRESHOLD = 10_000;

/** Мин. стрик для попадания в новости */
export const NEWS_STREAK_THRESHOLD = 7;

/** Milestone баланса (каждые N шекелей — новость) */
export const NEWS_BALANCE_MILESTONES = [10_000, 50_000, 100_000, 500_000, 1_000_000];
