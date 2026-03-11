// ═══════════════════════════════════════════════
//  Economy — Embed-билдеры
//
//  Все embed-ы экономики проходят через BublikEmbed.
//  Единый стиль: футер, цвет, таймстемп.
// ═══════════════════════════════════════════════

import { GuildMember } from 'discord.js';
import { BublikEmbed } from '../../core/EmbedBuilder';
import { EMOJI, CURRENCY, PB_TIERS } from './constants';
import { fmt, formatCooldown } from './profile';
import { EarnResult } from './earnings';

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
  dailyStreak: number,
  totalEarned: number,
  totalSpent: number,
): BublikEmbed {
  const totalBalance = wallet + bank;
  const bankLimitStr = bankLimit === Infinity ? '∞' : bankLimit.toLocaleString('ru-RU');
  const bankUsage = bankLimit === Infinity
    ? `${bank.toLocaleString('ru-RU')}`
    : `${bank.toLocaleString('ru-RU')} / ${bankLimitStr}`;

  return new BublikEmbed()
    .setColor(0xf1c40f)
    .setAuthor({
      name: `${member.displayName} — Баланс`,
      iconURL: member.displayAvatarURL({ size: 64 }),
    })
    .setDescription(
      `### ${EMOJI.SHEKEL} Всего: **${fmt(totalBalance)}**\n` +
      `\n` +
      `${EMOJI.WALLET} **Кошелёк:** ${fmt(wallet)}\n` +
      `${EMOJI.BANK} **Банк:** ${CURRENCY}${bankUsage}\n` +
      `\n` +
      `${EMOJI.STREAK} **Стрик:** ${dailyStreak} дн.\n` +
      `${EMOJI.STAR} **ПБ-тир:** ${tierName} (x${multiplier})\n` +
      `\n` +
      `───────────────────\n` +
      `${EMOJI.UP} Заработано: ${fmt(totalEarned)}\n` +
      `${EMOJI.DOWN} Потрачено: ${fmt(totalSpent)}`,
    );
}

// ═══════════════════════════════════════════════
//  Результаты заработка
// ═══════════════════════════════════════════════

export function buildDailyEmbed(result: EarnResult, member: GuildMember): BublikEmbed {
  const streakText = result.streak
    ? `${EMOJI.STREAK} **Стрик:** ${result.streak} дн.`
    : '';

  return new BublikEmbed()
    .setColor(0x2ecc71)
    .setAuthor({
      name: `${member.displayName} — Дейли`,
      iconURL: member.displayAvatarURL({ size: 64 }),
    })
    .setDescription(
      `${EMOJI.DAILY} Вы получили **${fmt(result.amount)}** шекелей!\n\n` +
      (result.details ? `${result.details}\n` : '') +
      (result.multiplier > 1 ? `${EMOJI.STAR} ПБ-множитель: **x${result.multiplier}**\n` : '') +
      (streakText ? `${streakText}\n` : '') +
      `\n${EMOJI.WALLET} Кошелёк: **${fmt(result.wallet)}**`,
    );
}

export function buildWeeklyEmbed(result: EarnResult, member: GuildMember): BublikEmbed {
  return new BublikEmbed()
    .setColor(0x3498db)
    .setAuthor({
      name: `${member.displayName} — Еженедельный бонус`,
      iconURL: member.displayAvatarURL({ size: 64 }),
    })
    .setDescription(
      `${EMOJI.WEEKLY} Вы получили **${fmt(result.amount)}** шекелей!\n\n` +
      (result.details ? `${result.details}\n` : '') +
      (result.multiplier > 1 ? `${EMOJI.STAR} ПБ-множитель: **x${result.multiplier}**\n` : '') +
      `\n${EMOJI.WALLET} Кошелёк: **${fmt(result.wallet)}**`,
    );
}

export function buildWorkEmbed(result: EarnResult, member: GuildMember): BublikEmbed {
  return new BublikEmbed()
    .setColor(0xe67e22)
    .setAuthor({
      name: `${member.displayName} — Работа`,
      iconURL: member.displayAvatarURL({ size: 64 }),
    })
    .setDescription(
      `${EMOJI.WORK} *${result.details || 'Вы хорошо поработали'}*\n\n` +
      `Заработано: **${fmt(result.amount)}**\n` +
      (result.multiplier > 1 ? `${EMOJI.STAR} ПБ-множитель: **x${result.multiplier}**\n` : '') +
      `\n${EMOJI.WALLET} Кошелёк: **${fmt(result.wallet)}**`,
    );
}

export function buildCrimeEmbed(result: EarnResult, member: GuildMember): BublikEmbed {
  const isSuccess = result.amount >= 0;

  return new BublikEmbed()
    .setColor(isSuccess ? 0x9b59b6 : 0xe74c3c)
    .setAuthor({
      name: `${member.displayName} — Преступление`,
      iconURL: member.displayAvatarURL({ size: 64 }),
    })
    .setDescription(
      `${EMOJI.CRIME} *${result.details || (isSuccess ? 'Успешное дело!' : 'Вас поймали!')}*\n\n` +
      (isSuccess
        ? `${EMOJI.SUCCESS} Получено: **${fmt(result.amount)}**`
        : `${EMOJI.ERROR} Штраф: **${fmt(Math.abs(result.amount))}**`) +
      '\n' +
      (result.multiplier > 1 ? `${EMOJI.STAR} ПБ-множитель: **x${result.multiplier}**\n` : '') +
      `\n${EMOJI.WALLET} Кошелёк: **${fmt(result.wallet)}**`,
    );
}

export function buildBegEmbed(result: EarnResult, member: GuildMember): BublikEmbed {
  return new BublikEmbed()
    .setColor(0x95a5a6)
    .setAuthor({
      name: `${member.displayName} — Попрошайничество`,
      iconURL: member.displayAvatarURL({ size: 64 }),
    })
    .setDescription(
      `${EMOJI.BEG} *${result.details || 'Вам дали немного монет'}*\n\n` +
      `Получено: **${fmt(result.amount)}**\n` +
      `\n${EMOJI.WALLET} Кошелёк: **${fmt(result.wallet)}**`,
    );
}

// ═══════════════════════════════════════════════
//  Кулдаун
// ═══════════════════════════════════════════════

export function buildCooldownEmbed(command: string, remaining: number): BublikEmbed {
  return new BublikEmbed()
    .setColor(0xe74c3c)
    .setDescription(
      `${EMOJI.CLOCK} **${command}** будет доступна через **${formatCooldown(remaining)}**`,
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
): BublikEmbed {
  return new BublikEmbed()
    .setColor(0x2ecc71)
    .setAuthor({
      name: `${member.displayName} — Депозит`,
      iconURL: member.displayAvatarURL({ size: 64 }),
    })
    .setDescription(
      `${EMOJI.BANK} В банк внесено: **${fmt(amount)}**\n\n` +
      `${EMOJI.WALLET} Кошелёк: **${fmt(wallet)}**\n` +
      `${EMOJI.BANK} Банк: **${fmt(bank)}**`,
    );
}

export function buildWithdrawEmbed(
  member: GuildMember,
  amount: number,
  tax: number,
  wallet: number,
  bank: number,
): BublikEmbed {
  return new BublikEmbed()
    .setColor(0xe67e22)
    .setAuthor({
      name: `${member.displayName} — Снятие`,
      iconURL: member.displayAvatarURL({ size: 64 }),
    })
    .setDescription(
      `${EMOJI.BANK} Снято из банка: **${fmt(amount + tax)}**\n` +
      (tax > 0 ? `${EMOJI.DOWN} Комиссия: **${fmt(tax)}**\n` : '') +
      `${EMOJI.WALLET} Получено: **${fmt(amount)}**\n\n` +
      `${EMOJI.WALLET} Кошелёк: **${fmt(wallet)}**\n` +
      `${EMOJI.BANK} Банк: **${fmt(bank)}**`,
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
): BublikEmbed {
  return new BublikEmbed()
    .setColor(0x3498db)
    .setAuthor({
      name: `${sender.displayName} — Перевод`,
      iconURL: sender.displayAvatarURL({ size: 64 }),
    })
    .setDescription(
      `${EMOJI.TRANSFER} Перевод для <@${receiverId}>\n\n` +
      `${EMOJI.ARROW_RIGHT} **Сумма:** ${fmt(amount)}\n` +
      `${EMOJI.DOWN} **Налог:** ${fmt(tax)} (${amount > 0 ? Math.round(tax / amount * 100) : 0}%)\n` +
      `${EMOJI.SUCCESS} **Получено:** ${fmt(received)}`,
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
    .setTitle(`${EMOJI.LEADERBOARD} Лидерборд — ${guildName}`)
    .setDescription(lines.join('\n') || 'Пока никто не заработал ни шекеля!')
    .setFooter({ text: `Страница ${page + 1}/${totalPages} • © NaveL for EREZ 2024–2026` });
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

export function ecoLocked(): BublikEmbed {
  return new BublikEmbed()
    .error()
    .setDescription(
      `${EMOJI.LOCK} Подождите, предыдущая операция ещё выполняется…`,
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
): BublikEmbed {
  return new BublikEmbed()
    .setColor(enabled ? 0x2ecc71 : 0xe74c3c)
    .setTitle(`${EMOJI.SHEKEL} Экономика — Настройки`)
    .setDescription(
      `**Гильдия:** ${guildName}\n\n` +
      `${EMOJI.ARROW_RIGHT} **Статус:** ${enabled ? '✅ Включена' : '❌ Выключена'}\n` +
      `${EMOJI.NEWS} **Канал новостей:** ${newsChannelId ? `<#${newsChannelId}>` : 'Не настроен'}\n` +
      `${EMOJI.ARROW_RIGHT} **Канал логов:** ${logChannelId ? `<#${logChannelId}>` : 'Не настроен'}`,
    );
}
