// ═══════════════════════════════════════════════
//  Economy — Embed-билдеры
//
//  Все embed-ы экономики проходят через BublikEmbed.
//  Единый стиль: футер, цвет, таймстемп.
// ═══════════════════════════════════════════════

import { GuildMember } from 'discord.js';
import { BublikEmbed } from '../../core/EmbedBuilder';
import { i18n } from '../../core/I18n';
import { EMOJI, CURRENCY } from './constants';
import { fmt, formatCooldown } from './profile';
import { EarnResult } from './earnings';

// ── Подсказки для /balance ───────────────────
const BALANCE_TIPS = [
  '💡 Используй `/daily` каждый день для стрика — бонус растёт!',
  '💡 В ПБ-войсе зарабатываешь в 4 раза больше!',
  '💡 `/crime` — рискни ради большого куша!',
  '💡 Повышай ПБ-тир — больше множитель и лимит банка!',
  '💡 `/rob` — укради шекели у другого игрока!',
  '💡 `/slots`, `/blackjack`, `/dice` — испытай удачу в казино!',
  '💡 `/shop list` — посмотри роли за шекели!',
  '💡 Деньги в банке защищены от ограбления!',
  '💡 `/pay` — переведи шекели другу!',
  '💡 Стрик 10+ дней = максимальный бонус `/daily`!',
  '💡 В `/slots` разыгрывается прогрессивный Джекпот! Собери 3 мешка золота (💰), чтобы сорвать его!',
];

// ═══════════════════════════════════════════════
//  Баланс
// ═══════════════════════════════════════════════

export function buildBalanceEmbed(
  member: GuildMember,
  wallet: number,
  bank: number,
  bankLimit: number,
  tierName: string,
  multiplier: number,
  pbHoursText: string,
  dailyStreak: number,
  totalEarned: number,
  totalSpent: number,
  dirtyAmount: number,
  locale: string,
): BublikEmbed {
  const totalBalance = wallet + bank;
  const bankLimitStr = bankLimit === Infinity ? '∞' : bankLimit.toLocaleString('ru-RU');
  const bankUsage = bankLimit === Infinity
    ? `${bank.toLocaleString('ru-RU')}`
    : `${bank.toLocaleString('ru-RU')} / ${bankLimitStr}`;

  const dirtyText = dirtyAmount > 0
    ? `\n💸 **Грязные наличные:** **${fmt(dirtyAmount)} ₪** (нужно легализовать в \`/launder\`)\n`
    : '';

  return new BublikEmbed()
    .setColor(0xf1c40f)
    .setAuthor({
      name: i18n.t('economy.balance_author', locale, { user: member.displayName }),
      iconURL: member.displayAvatarURL({ size: 64 }),
    })
    .setDescription(
      `### ${EMOJI.SHEKEL} ${i18n.t('economy.balance_total', locale, { amount: fmt(totalBalance) })}\n` +
      `\n` +
      `${EMOJI.WALLET} ${i18n.t('economy.balance_wallet', locale, { amount: fmt(wallet) })}\n` +
      `${EMOJI.BANK} ${i18n.t('economy.balance_bank', locale, { usage: `${CURRENCY}${bankUsage}` })}\n` +
      dirtyText +
      `\n` +
      `${EMOJI.STREAK} ${i18n.t('economy.balance_streak', locale, { days: dailyStreak })}\n` +
      `${EMOJI.STAR} ${i18n.t('economy.balance_pb_tier', locale, { tier: tierName, multiplier })}\n` +
      `${EMOJI.VOICE} PB-стаж: **${pbHoursText}**\n` +
      `\n` +
      `───────────────────\n` +
      `${EMOJI.UP} ${i18n.t('economy.balance_earned', locale, { amount: fmt(totalEarned) })}\n` +
      `${EMOJI.DOWN} ${i18n.t('economy.balance_spent', locale, { amount: fmt(totalSpent) })}`,
    )
    .setFooter({ text: BALANCE_TIPS[Math.floor(Math.random() * BALANCE_TIPS.length)] });
}

// ═══════════════════════════════════════════════
//  Результаты заработка
// ═══════════════════════════════════════════════

export function buildDailyEmbed(result: EarnResult, member: GuildMember, locale: string): BublikEmbed {
  const streakText = result.streak
    ? `${EMOJI.STREAK} ${i18n.t('economy.daily_streak_label', locale, { streak: result.streak })}`
    : '';

  // Прогресс-бар стрика: 10 дней = максимальный бонус стрика
  const maxStreakDays = 10;
  const streak = result.streak ?? 0;
  const progress = Math.min(streak, maxStreakDays);
  const filled = Math.round((progress / maxStreakDays) * 10);
  const empty = 10 - filled;
  const progressBar = '▰'.repeat(filled) + '▱'.repeat(empty);
  const streakProgress = streak > 0
    ? `\n${progressBar} ${progress}/${maxStreakDays}`
    : '';

  // Подсказка о следующем бонусе
  const nextTip = streak > 0 && streak < maxStreakDays
    ? `\n💡 *Ещё ${maxStreakDays - streak} дн. до макс. бонуса стрика!*`
    : streak >= maxStreakDays
      ? `\n${EMOJI.CROWN} *Максимальный бонус стрика!*`
      : '';

  return new BublikEmbed()
    .setColor(0x2ecc71)
    .setAuthor({
      name: i18n.t('economy.daily_author', locale, { user: member.displayName }),
      iconURL: member.displayAvatarURL({ size: 64 }),
    })
    .setDescription(
      `${EMOJI.DAILY} ${i18n.t('economy.daily_received', locale, { amount: fmt(result.amount) })}\n\n` +
      (result.details ? `${result.details}\n` : '') +
      (result.multiplier > 1 ? `${EMOJI.STAR} ${i18n.t('economy.pb_multiplier', locale, { multiplier: result.multiplier })}\n` : '') +
      (streakText ? `${streakText}${streakProgress}${nextTip}\n` : '') +
      `\n${EMOJI.WALLET} ${i18n.t('economy.wallet_display', locale, { amount: fmt(result.wallet) })}`,
    );
}

export function buildWeeklyEmbed(result: EarnResult, member: GuildMember, locale: string): BublikEmbed {
  return new BublikEmbed()
    .setColor(0x3498db)
    .setAuthor({
      name: i18n.t('economy.weekly_author', locale, { user: member.displayName }),
      iconURL: member.displayAvatarURL({ size: 64 }),
    })
    .setDescription(
      `${EMOJI.WEEKLY} ${i18n.t('economy.weekly_received', locale, { amount: fmt(result.amount) })}\n\n` +
      (result.details ? `${result.details}\n` : '') +
      (result.multiplier > 1 ? `${EMOJI.STAR} ${i18n.t('economy.pb_multiplier', locale, { multiplier: result.multiplier })}\n` : '') +
      `\n${EMOJI.WALLET} ${i18n.t('economy.wallet_display', locale, { amount: fmt(result.wallet) })}`,
    );
}

export function buildWorkEmbed(result: EarnResult, member: GuildMember, locale: string): BublikEmbed {
  return new BublikEmbed()
    .setColor(0xe67e22)
    .setAuthor({
      name: i18n.t('economy.work_author', locale, { user: member.displayName }),
      iconURL: member.displayAvatarURL({ size: 64 }),
    })
    .setDescription(
      `${EMOJI.WORK} *${result.details || i18n.t('economy.work_default_detail', locale)}*\n\n` +
      `${i18n.t('economy.work_earned', locale, { amount: fmt(result.amount) })}\n` +
      (result.multiplier > 1 ? `${EMOJI.STAR} ${i18n.t('economy.pb_multiplier', locale, { multiplier: result.multiplier })}\n` : '') +
      `\n${EMOJI.WALLET} ${i18n.t('economy.wallet_display', locale, { amount: fmt(result.wallet) })}`,
    );
}

export function buildCrimeEmbed(result: EarnResult, member: GuildMember, locale: string): BublikEmbed {
  const isSuccess = result.amount >= 0;

  return new BublikEmbed()
    .setColor(isSuccess ? 0x9b59b6 : 0xe74c3c)
    .setAuthor({
      name: i18n.t('economy.crime_author', locale, { user: member.displayName }),
      iconURL: member.displayAvatarURL({ size: 64 }),
    })
    .setDescription(
      `${EMOJI.CRIME} *${result.details || (isSuccess ? i18n.t('economy.crime_success_default', locale) : i18n.t('economy.crime_fail_default', locale))}*\n\n` +
      (isSuccess
        ? `${EMOJI.SUCCESS} ${i18n.t('economy.crime_gained', locale, { amount: fmt(result.amount) })}`
        : `${EMOJI.ERROR} ${i18n.t('economy.crime_fine', locale, { amount: fmt(Math.abs(result.amount)) })}`) +
      '\n' +
      (result.multiplier > 1 ? `${EMOJI.STAR} ${i18n.t('economy.pb_multiplier', locale, { multiplier: result.multiplier })}\n` : '') +
      `\n${EMOJI.WALLET} ${i18n.t('economy.wallet_display', locale, { amount: fmt(result.wallet) })}`,
    );
}

export function buildBegEmbed(result: EarnResult, member: GuildMember, locale: string): BublikEmbed {
  return new BublikEmbed()
    .setColor(0x95a5a6)
    .setAuthor({
      name: i18n.t('economy.beg_author', locale, { user: member.displayName }),
      iconURL: member.displayAvatarURL({ size: 64 }),
    })
    .setDescription(
      `${EMOJI.BEG} *${result.details || i18n.t('economy.beg_default_detail', locale)}*\n\n` +
      `${i18n.t('economy.beg_received', locale, { amount: fmt(result.amount) })}\n` +
      `\n${EMOJI.WALLET} ${i18n.t('economy.wallet_display', locale, { amount: fmt(result.wallet) })}`,
    );
}

// ═══════════════════════════════════════════════
//  Кулдаун
// ═══════════════════════════════════════════════

export function buildCooldownEmbed(command: string, remaining: number, locale: string): BublikEmbed {
  return new BublikEmbed()
    .setColor(0xe74c3c)
    .setDescription(
      `${EMOJI.CLOCK} ${i18n.t('economy.cooldown_text', locale, { command, time: formatCooldown(remaining) })}`,
    );
}

// ═══════════════════════════════════════════════
//  Банковские операции
// ═══════════════════════════════════════════════

export function buildDepositEmbed(
  member: GuildMember,
  amount: number,
  wallet: number,
  bank: number,
  locale: string,
): BublikEmbed {
  return new BublikEmbed()
    .setColor(0x2ecc71)
    .setAuthor({
      name: i18n.t('economy.deposit_author', locale, { user: member.displayName }),
      iconURL: member.displayAvatarURL({ size: 64 }),
    })
    .setDescription(
      `${EMOJI.BANK} ${i18n.t('economy.deposit_text', locale, { amount: fmt(amount) })}\n\n` +
      `${EMOJI.WALLET} ${i18n.t('economy.deposit_wallet', locale, { amount: fmt(wallet) })}\n` +
      `${EMOJI.BANK} ${i18n.t('economy.deposit_bank', locale, { amount: fmt(bank) })}`,
    );
}

export function buildWithdrawEmbed(
  member: GuildMember,
  amount: number,
  tax: number,
  wallet: number,
  bank: number,
  locale: string,
): BublikEmbed {
  return new BublikEmbed()
    .setColor(0xe67e22)
    .setAuthor({
      name: i18n.t('economy.withdraw_author', locale, { user: member.displayName }),
      iconURL: member.displayAvatarURL({ size: 64 }),
    })
    .setDescription(
      `${EMOJI.BANK} ${i18n.t('economy.withdraw_text', locale, { amount: fmt(amount + tax) })}\n` +
      (tax > 0 ? `${EMOJI.DOWN} ${i18n.t('economy.withdraw_commission', locale, { amount: fmt(tax) })}\n` : '') +
      `${EMOJI.WALLET} ${i18n.t('economy.withdraw_received', locale, { amount: fmt(amount) })}\n\n` +
      `${EMOJI.WALLET} ${i18n.t('economy.withdraw_wallet', locale, { amount: fmt(wallet) })}\n` +
      `${EMOJI.BANK} ${i18n.t('economy.withdraw_bank', locale, { amount: fmt(bank) })}`,
    );
}

// ═══════════════════════════════════════════════
//  Перевод
// ═══════════════════════════════════════════════

export function buildTransferEmbed(
  sender: GuildMember,
  receiverId: string,
  amount: number,
  tax: number,
  received: number,
  locale: string,
): BublikEmbed {
  return new BublikEmbed()
    .setColor(0x3498db)
    .setAuthor({
      name: i18n.t('economy.transfer_author', locale, { user: sender.displayName }),
      iconURL: sender.displayAvatarURL({ size: 64 }),
    })
    .setDescription(
      `${EMOJI.TRANSFER} ${i18n.t('economy.transfer_for', locale, { receiver: `<@${receiverId}>` })}\n\n` +
      `${EMOJI.ARROW_RIGHT} ${i18n.t('economy.transfer_amount', locale, { amount: fmt(amount) })}\n` +
      `${EMOJI.DOWN} ${i18n.t('economy.transfer_tax', locale, { tax: fmt(tax), percent: amount > 0 ? Math.round(tax / amount * 100) : 0 })}\n` +
      `${EMOJI.SUCCESS} ${i18n.t('economy.transfer_received', locale, { amount: fmt(received) })}`,
    );
}

// ═══════════════════════════════════════════════
//  Лидерборд
// ═══════════════════════════════════════════════

export function buildLeaderboardEmbed(
  guildName: string,
  entries: { userId: string; wallet: number; bank: number }[],
  page: number,
  totalPages: number,
  locale: string,
): BublikEmbed {
  const medals = ['🥇', '🥈', '🥉'];
  const startIdx = page * 10;

  const lines = entries.map((e, i) => {
    const rank = startIdx + i + 1;
    const medal = rank <= 3 ? medals[rank - 1] : `**${rank}.**`;
    const total = e.wallet + e.bank;
    return `${medal} <@${e.userId}> — ${fmt(total)} (${EMOJI.WALLET} ${fmt(e.wallet)} | ${EMOJI.BANK} ${fmt(e.bank)})`;
  });

  return new BublikEmbed()
    .setColor(0xf1c40f)
    .setTitle(`${EMOJI.LEADERBOARD} ${i18n.t('economy.leaderboard_title', locale, { guild: guildName })}`)
    .setDescription(lines.join('\n') || i18n.t('economy.leaderboard_empty', locale))
    .setFooter({ text: i18n.t('economy.leaderboard_footer', locale, { page: page + 1, total: totalPages }) });
}

// ═══════════════════════════════════════════════
//  Ошибки
// ═══════════════════════════════════════════════

export function ecoError(message: string): BublikEmbed {
  return new BublikEmbed()
    .error()
    .setDescription(`${EMOJI.ERROR} ${message}`);
}

export function ecoSuccess(message: string): BublikEmbed {
  return new BublikEmbed()
    .success()
    .setDescription(`${EMOJI.SUCCESS} ${message}`);
}

// ═══════════════════════════════════════════════
//  Locked (операция отклонена из-за лока)
// ═══════════════════════════════════════════════

export function ecoLocked(locale: string): BublikEmbed {
  return new BublikEmbed()
    .error()
    .setDescription(
      `${EMOJI.LOCK} ${i18n.t('economy.locked', locale)}`,
    );
}

// ═══════════════════════════════════════════════
//  Настройка (admin)
// ═══════════════════════════════════════════════

export function buildSetupEmbed(
  guildName: string,
  enabled: boolean,
  newsChannelId: string | null,
  logChannelId: string | null,
  leaderboardChannelId: string | null,
  welcomeBonus: number,
  policeRoleId: string | null,
  govStaffRoleId: string | null,
  locale: string,
): BublikEmbed {
  const notCfg = i18n.t('economy.setup_not_configured', locale);
  return new BublikEmbed()
    .setColor(enabled ? 0x2ecc71 : 0xe74c3c)
    .setTitle(`${EMOJI.SHEKEL} ${i18n.t('economy.setup_title', locale)}`)
    .setDescription(
      `${i18n.t('economy.setup_guild', locale, { name: guildName })}\n\n` +
      `${EMOJI.ARROW_RIGHT} ${enabled ? i18n.t('economy.setup_status_on', locale) : i18n.t('economy.setup_status_off', locale)}\n` +
      `${EMOJI.NEWS} ${i18n.t('economy.setup_news_channel', locale, { channel: newsChannelId ? `<#${newsChannelId}>` : notCfg })}\n` +
      `${EMOJI.ARROW_RIGHT} ${i18n.t('economy.setup_log_channel', locale, { channel: logChannelId ? `<#${logChannelId}>` : notCfg })}\n` +
      `${EMOJI.LEADERBOARD} **Авто-лидерборд:** ${leaderboardChannelId ? `<#${leaderboardChannelId}>` : notCfg}\n` +
      `${EMOJI.CAPTURE} **Полиция (ЯМАМ/МАГАВ):** ${policeRoleId ? `<@&${policeRoleId}>` : notCfg}\n` +
      `💼 **Мэрия (Госслужащие):** ${govStaffRoleId ? `<@&${govStaffRoleId}>` : notCfg}\n` +
      `${EMOJI.STAR} **Стартовый капитал:** ${welcomeBonus > 0 ? fmt(welcomeBonus) : 'Отключён'}`,
    );
}
