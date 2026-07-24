// ═══════════════════════════════════════════════
//  Economy — Константы, ставки и PB-роли
//
//  Шекели (₪) — валюта клана EREZ.
//  Всё настраиваемое хранится в EconomyConfig (БД),
//  здесь — только hardcoded лимиты и PB-привязки.
// ═══════════════════════════════════════════════

import { i18n } from '../../core/I18n';

/** Префикс для customId всех компонентов экономики */
export const ECO_PREFIX = 'eco';

/** Разделитель в customId */
export const ECO_SEP = ':';

/** Символ валюты */
export const CURRENCY = '₪';

/** Название валюты (для текстов) */
export const CURRENCY_NAME = 'шекелей';

/** ID главного администратора (владельца) для особых привилегий */

// ── Redis префиксы ───────────────────────────

export const REDIS_ECO_CONFIG   = 'eco:cfg';     // eco:cfg:{guildId}
export const REDIS_ECO_PROFILE  = 'eco:prof';    // eco:prof:{guildId}:{userId}
export const REDIS_ECO_VOICE    = 'eco:voice';   // owner-scoped continuous-presence observations
export const REDIS_ECO_LOCK     = 'eco:lock';    // eco:lock:{guildId}:{userId}   — финансовая блокировка
export const REDIS_ECO_CD       = 'eco:cd';      // eco:cd:{type}:{guildId}:{userId}

/** TTL кэша конфигурации (секунд) */
export const CONFIG_CACHE_TTL = 600; // 10 мин

/** TTL кэша профиля (секунд) */
export const PROFILE_CACHE_TTL = 300; // 5 мин

/** TTL финансовой блокировки (секунд) — защита от race condition */
export const LOCK_TTL = 60; // 60 секунд

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
  beg:    300_000,          // 5 минут (интерактивная чашка на площади)
  rob:    14_400_000,       // 4ч (фаза 2)
} as const;

// ── Казино дефолты ──────────────────────

export const CASINO_DEFAULTS = {
  minBet: 50,
  maxBet: 50_000,
  slotsJackpotMultiplier: 10,
  slotsTripleMultiplier: 5,
  slotsDoubleMultiplier: 2,
  slotsJackpotSeed: 1000,
  slotsJackpotPercent: 0.02,
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

// ── Heist дефолты ───────────────────────

export const HEIST_DEFAULTS = {
  cooldownInit: 86_400_000,     // 24ч
  cooldownMember: 43_200_000,   // 12ч
  assembleMs: 300_000,          // 5 мин на сбор команды
  minMembers: 2,
  maxMembers: 4,
  baseChance: 60,               // 2 чел = 60%
  chancePerMember: 15,          // +15% за каждого сверх минимума
  safePenalty: 20,              // -20% если у жертвы сейф
  minPercent: 8,                // 8% от банка
  maxPercent: 15,
  fine: 1000,                   // штраф каждому при провале
  minVictimBank: 2000,
} as const;

// ── Wanted дефолты ──────────────────────

export const WANTED_DEFAULTS = {
  decayMs: 172_800_000,         // 48ч на одну звезду
  captureMin: 3,                // мин. звёзд для capture
  captureChance: 70,
  victimBonus: 50,              // +50% если ловит сама жертва
  captureCooldown: 21_600_000,  // 6ч охотнику
  captureReward: 20,            // 20% кошелька цели
  captureFine: 750,
  maxStarsDisplay: 5,
} as const;

// ── Грязные деньги дефолты ──────────────

export const DIRTY_DEFAULTS = {
  expireMs: 86_400_000,         // 24ч
  launderTax: 15,               // 15% комиссия (отмыв ручной)
} as const;

// ── Сейф / Отмычка дефолты ──────────────

export const SAFE_DEFAULTS = {
  durationMs: 604_800_000,      // 7 дней
  price: 10_000,
  mode: 'partial' as 'partial' | 'immune',  // 'partial' = -50% добычи, 'immune' = иммунитет
  partialFactor: 0.5,           // оставляет половину добычи при partial
} as const;

export const LOCKPICK_DEFAULTS = {
  price: 3_000,
  bonus: 20,                    // +20% к successRate
} as const;

export const MASK_DEFAULTS = {
  price: 1_500,
} as const;

// ── PB роли → множитель / лимит банка ────────
//
// Роли привязываются по ID в рантайме.
// Здесь — порядок ролей (от низшей к высшей)
// и соответствующие бонусы.
// ═════════════════════════════════════════════

export interface PbRoleTier {
  /** i18n-ключ названия роли */
  nameKey: string;
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
  { nameKey: 'economy.pb_tier_1',  hours: 50,    multiplier: 1.0,  bankLimit: 10_000   }, // gitleaks:allow -- localization key
  { nameKey: 'economy.pb_tier_2',  hours: 100,   multiplier: 1.1,  bankLimit: 25_000   }, // gitleaks:allow -- localization key
  { nameKey: 'economy.pb_tier_3',  hours: 200,   multiplier: 1.2,  bankLimit: 50_000   }, // gitleaks:allow -- localization key
  { nameKey: 'economy.pb_tier_4',  hours: 400,   multiplier: 1.3,  bankLimit: 100_000  }, // gitleaks:allow -- localization key
  { nameKey: 'economy.pb_tier_5',  hours: 600,   multiplier: 1.4,  bankLimit: 200_000  }, // gitleaks:allow -- localization key
  { nameKey: 'economy.pb_tier_6',  hours: 800,   multiplier: 1.5,  bankLimit: 350_000  }, // gitleaks:allow -- localization key
  { nameKey: 'economy.pb_tier_7',  hours: 1200,  multiplier: 1.7,  bankLimit: 500_000  }, // gitleaks:allow -- localization key
  { nameKey: 'economy.pb_tier_8',  hours: 2000,  multiplier: 1.9,  bankLimit: 750_000  }, // gitleaks:allow -- localization key
  { nameKey: 'economy.pb_tier_9',  hours: 3500,  multiplier: 2.2,  bankLimit: 1_000_000 }, // gitleaks:allow -- localization key
  { nameKey: 'economy.pb_tier_10', hours: 5000,  multiplier: 2.5,  bankLimit: Infinity }, // gitleaks:allow -- localization key
];

/**
 * Получить локализованное название PB-тира по индексу.
 */
export function getPbTierName(index: number, locale?: string): string {
  const tier = PB_TIERS[index];
  if (!tier) return i18n.t('economy.profile.no_pb_tier', locale);
  return i18n.t(tier.nameKey, locale);
}

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

  // Heist
  HEIST_SUCCESS: 'heist_success',  // доля участника
  HEIST_VICTIM:  'heist_victim',   // списание у жертвы
  HEIST_FINE:    'heist_fine',     // штраф участнику при провале

  // Wanted / Capture
  CAPTURE_REWARD: 'capture_reward',
  CAPTURE_LOSS:   'capture_loss',
  CAPTURE_FINE:   'capture_fine',
  CAPTURE_CONFISCATE: 'capture_confiscate',
  CAPTURE_BONUS:  'capture_bonus',

  // Грязные деньги
  LAUNDER_TAX:    'launder_tax',
  LAUNDER_NET:    'launder_net',
  DIRTY_DECAY_FINE: 'dirty_decay_fine',

  // Сейф / Отмычка / Маска
  BUY_SAFE:       'buy_safe',
  BUY_LOCKPICK:   'buy_lockpick',
  BUY_MASK:       'buy_mask',

  // Казино
  CASINO_WIN:   'casino_win',
  CASINO_LOSE:  'casino_lose',
  CASINO_BJ:    'casino_bj',

  // Магазин
  SHOP_BUY:     'shop_buy',

  // Маркетплейс игроков
  MARKET_FEE:        'market_fee',         // взнос за заявку
  MARKET_REFUND:     'market_refund',      // возврат при отказе
  MARKET_INCOME:     'market_income',      // комиссия продавцу с продажи

  // Бонус
  WELCOME_BONUS: 'welcome_bonus',
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
  HEIST:      '🏦',
  WANTED:     '⭐',
  CAPTURE:    '🚔',
  SAFE:       '🔐',
  LOCKPICK:   '🗝️',
  DIRTY:      '💵',
  LAUNDER:    '🧼',
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

/** Мин. сумма голосового тика для новости */
export const NEWS_VOICE_EARN_THRESHOLD = 30;

/** Кулдаун (сек) между voice-новостями для одного участника */
export const NEWS_VOICE_COOLDOWN_SEC = 6 * 60 * 60;
