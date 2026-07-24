// ═══════════════════════════════════════════════
//  Economy — Новостной канал
//
//  Красивые embed-ы о заметных экономических событиях:
//  • Крупный заработок (> NEWS_EARN_THRESHOLD)
//  • Крупный перевод  (> NEWS_TRANSFER_THRESHOLD)
//  • Достижение milestone баланса
//  • Рекордный daily-стрик (> NEWS_STREAK_THRESHOLD)
//  • Crime-джекпоты
// ═══════════════════════════════════════════════

import { Client, TextChannel } from 'discord.js';
import { logger } from '../../core/Logger';
import { BublikEmbed } from '../../core/EmbedBuilder';
import { i18n } from '../../core/I18n';
import { getRedis } from '../../core/Redis';
import { getEcoConfig } from './database';
import {
  EMOJI,
  CURRENCY,
  NEWS_EARN_THRESHOLD,
  NEWS_TRANSFER_THRESHOLD,
  NEWS_STREAK_THRESHOLD,
  NEWS_BALANCE_MILESTONES,
  NEWS_VOICE_EARN_THRESHOLD,
  NEWS_VOICE_COOLDOWN_SEC,
} from './constants';
import { fmt } from './profile';
import { pickPhrase } from './phrases';

const log = logger.child('Economy:news');

// ═══════════════════════════════════════════════
//  Публикация в канал новостей
// ═══════════════════════════════════════════════

/**
 * Отправить embed в новостной канал экономики.
 * Если канал не настроен — тихо возвращаемся.
 */
async function postNews(client: Client, guildId: string, embed: BublikEmbed): Promise<void> {
  try {
    const config = await getEcoConfig(guildId);
    if (!config?.newsChannelId) return;

    const channel = await client.channels.fetch(config.newsChannelId).catch(() => null);
    if (!channel || !(channel instanceof TextChannel)) return;

    await channel.send({ embeds: [embed] });
  } catch (err) {
    log.error('Не удалось отправить новость экономики', err);
  }
}

// ═══════════════════════════════════════════════
//  Генераторы новостей
// ═══════════════════════════════════════════════

/** Крупный заработок (daily/weekly/work/crime/voice) */
export async function newsEarning(
  client: Client,
  guildId: string,
  userId: string,
  type: string,
  amount: number,
  locale: string,
  details?: string,
): Promise<void> {
  if (type === 'earn_voice') {
    if (amount < NEWS_VOICE_EARN_THRESHOLD) return;

    // Anti-spam: не чаще одного voice-новостного события в 6 часов на участника
    try {
      const redis = getRedis();
      const key = `eco:news:voice:${guildId}:${userId}`;
      const locked = await redis.get(key);
      if (locked) return;
      await redis.setex(key, NEWS_VOICE_COOLDOWN_SEC, '1');
    } catch {
      // Если Redis недоступен, не блокируем публикацию события
    }
  } else if (amount < NEWS_EARN_THRESHOLD) {
    return;
  }

  const typeNames: Record<string, string> = {
    earn_daily: `${EMOJI.DAILY} ${i18n.t('economy.news_type_daily', locale)}`,
    earn_weekly: `${EMOJI.WEEKLY} ${i18n.t('economy.news_type_weekly', locale)}`,
    earn_work: `${EMOJI.WORK} ${i18n.t('economy.news_type_work', locale)}`,
    earn_crime: `${EMOJI.CRIME} ${i18n.t('economy.news_type_crime', locale)}`,
    earn_voice: `${EMOJI.VOICE} ${i18n.t('economy.news_type_voice', locale)}`,
  };

  const embed = new BublikEmbed()
    .setColor(0x2ecc71)
    .setTitle(`${EMOJI.NEWS} ${i18n.t('economy.news_big_earning_title', locale)}`)
    .setDescription(
      `${i18n.t('economy.news_big_earning_text', locale, { user: `<@${userId}>`, amount: fmt(amount) })}\n\n` +
      `${EMOJI.ARROW_RIGHT} ${i18n.t('economy.news_big_earning_type', locale, { type: typeNames[type] || type })}\n` +
      (details ? `${EMOJI.ARROW_RIGHT} ${i18n.t('economy.news_big_earning_details', locale, { details })}` : ''),
    )
    .setThumbnail('https://cdn.discordapp.com/emojis/money_with_wings.png');

  await postNews(client, guildId, embed);
}

/** Крупный перевод */
export async function newsTransfer(
  client: Client,
  guildId: string,
  senderId: string,
  receiverId: string,
  amount: number,
  tax: number,
  locale: string,
): Promise<void> {
  if (amount < NEWS_TRANSFER_THRESHOLD || amount <= 0) return;

  const taxPercent = amount > 0 ? Math.round(tax / amount * 100) : 0;

  const embed = new BublikEmbed()
    .setColor(0x3498db)
    .setTitle(`${EMOJI.TRANSFER} ${i18n.t('economy.news_transfer_title', locale)}`)
    .setDescription(
      `${i18n.t('economy.news_transfer_text', locale, { sender: `<@${senderId}>`, amount: fmt(amount), receiver: `<@${receiverId}>` })}\n\n` +
      `${EMOJI.ARROW_RIGHT} ${i18n.t('economy.news_transfer_tax', locale, { tax: fmt(tax), percent: taxPercent })}\n` +
      `${EMOJI.ARROW_RIGHT} ${i18n.t('economy.news_transfer_received', locale, { amount: fmt(amount - tax) })}`,
    );

  await postNews(client, guildId, embed);
}

/** Рекордный стрик */
export async function newsStreak(
  client: Client,
  guildId: string,
  userId: string,
  streak: number,
  locale: string,
): Promise<void> {
  if (streak < NEWS_STREAK_THRESHOLD) return;

  // Эмоджи в зависимости от стрика
  let icon: string = EMOJI.STREAK;
  if (streak >= 30) icon = EMOJI.CROWN;
  else if (streak >= 14) icon = EMOJI.STAR;

  const embed = new BublikEmbed()
    .setColor(0xe74c3c)
    .setTitle(`${icon} ${i18n.t('economy.news_streak_title', locale)}`)
    .setDescription(
      `${i18n.t('economy.news_streak_text', locale, { user: `<@${userId}>`, streak })}\n\n` +
      `${EMOJI.STREAK} ${i18n.t('economy.news_streak_description', locale)}`,
    );

  await postNews(client, guildId, embed);
}

/** Достижение milestone баланса */
export async function newsMilestone(
  client: Client,
  guildId: string,
  userId: string,
  totalBalance: number,
  locale: string,
): Promise<void> {
  // Проверяем, достиг ли какого-то milestone
  const milestone = NEWS_BALANCE_MILESTONES.find(
    (m) => totalBalance >= m && totalBalance - m < m * 0.1, // достигнут в пределах 10%
  );

  if (!milestone) return;

  const milestoneStr = milestone >= 1_000_000
    ? `${(milestone / 1_000_000).toFixed(0)}M`
    : `${(milestone / 1_000).toFixed(0)}K`;

  const embed = new BublikEmbed()
    .setColor(0xf39c12)
    .setTitle(`${EMOJI.CROWN} ${i18n.t('economy.news_milestone_title', locale, { milestone: `${CURRENCY}${milestoneStr}` })}`)
    .setDescription(
      `${i18n.t('economy.news_milestone_text', locale, { user: `<@${userId}>`, amount: fmt(milestone) })}\n\n` +
      `${EMOJI.STAR} ${i18n.t('economy.news_milestone_balance', locale, { amount: fmt(totalBalance) })}`,
    );

  await postNews(client, guildId, embed);
}

/** Crime-джекпот (максимальная награда) */
export async function newsCrimeJackpot(
  client: Client,
  guildId: string,
  userId: string,
  amount: number,
  scenario: string,
  locale: string,
): Promise<void> {
  if (amount < NEWS_EARN_THRESHOLD) return;

  const embed = new BublikEmbed()
    .setColor(0x9b59b6)
    .setTitle(`${EMOJI.CRIME} ${i18n.t('economy.news_crime_jackpot_title', locale)}`)
    .setDescription(
      `${i18n.t('economy.news_crime_jackpot_text', locale, { user: `<@${userId}>`, amount: fmt(amount) })}\n\n` +
      `${EMOJI.ARROW_RIGHT} *${scenario}*`,
    );

  await postNews(client, guildId, embed);
}

/** Крупный выигрыш в казино */
export async function newsCasinoWin(
  client: Client,
  guildId: string,
  userId: string,
  game: string,
  bet: number,
  winAmount: number,
  _locale: string,
): Promise<void> {
  if (winAmount < NEWS_EARN_THRESHOLD) return;

  const gameNames: Record<string, string> = {
    coinflip:  `${EMOJI.COIN} Монетка`,
    slots:     `${EMOJI.SLOTS} Слоты`,
    dice:      `${EMOJI.DICE} Кости`,
    blackjack: `${EMOJI.CARDS} Блэкджек`,
  };

  const embed = new BublikEmbed()
    .setColor(0xf39c12)
    .setTitle(`${EMOJI.SLOTS} Джекпот в казино!`)
    .setDescription(
      `<@${userId}> выиграл **${fmt(winAmount)}** в казино!\n\n` +
      `${EMOJI.ARROW_RIGHT} **Игра:** ${gameNames[game] || game}\n` +
      `${EMOJI.ARROW_RIGHT} **Ставка:** ${fmt(bet)} → **Выигрыш:** ${fmt(winAmount)}`,
    );

  await postNews(client, guildId, embed);
}

/** Успешное ограбление */
export async function newsRobSuccess(
  client: Client,
  guildId: string,
  robberId: string,
  victimId: string,
  amount: number,
  locale: string,
): Promise<void> {
  if (amount < NEWS_EARN_THRESHOLD) return;

  const isBig = amount >= 10_000;
  const phraseKey = isBig ? 'economy.news.rob_big_steal' : 'economy.news.rob_success';
  const titleKey = isBig ? 'economy.news.rob_big_steal_title' : 'economy.news.rob_success_title';

  const embed = new BublikEmbed()
    .setColor(isBig ? 0xc0392b : 0xe74c3c)
    .setTitle(`${EMOJI.NEWS} ${i18n.t(titleKey, locale)}`)
    .setDescription(
      pickPhrase(phraseKey, locale, {
        robber: robberId === 'Неизвестный в маске' ? robberId : `<@${robberId}>`,
        victim: `<@${victimId}>`,
        amount: fmt(amount),
      }),
    );

  await postNews(client, guildId, embed);
}

/** Успешный налёт на банк (heist) */
export async function newsHeistSuccess(
  client: Client,
  guildId: string,
  memberIds: string[],
  victimId: string,
  amount: number,
  locale: string,
): Promise<void> {
  if (amount < NEWS_EARN_THRESHOLD) return;

  const members = memberIds.map((id) => `<@${id}>`).join(', ');
  const isBig = amount >= 10_000;
  const phraseKey = isBig ? 'economy.news.heist_big_steal' : 'economy.news.heist_success';
  const titleKey = isBig ? 'economy.news.heist_big_steal_title' : 'economy.news.heist_success_title';

  const embed = new BublikEmbed()
    .setColor(isBig ? 0x8e44ad : 0x9b59b6)
    .setTitle(`${EMOJI.NEWS} ${i18n.t(titleKey, locale)}`)
    .setDescription(
      pickPhrase(phraseKey, locale, {
        members,
        victim: `<@${victimId}>`,
        amount: fmt(amount),
        count: memberIds.length,
      }),
    );

  await postNews(client, guildId, embed);
}

/** Поимка преступника */
export async function newsCapture(
  client: Client,
  guildId: string,
  hunterId: string,
  robberId: string,
  reward: number,
  locale: string,
): Promise<void> {
  if (reward < NEWS_EARN_THRESHOLD) return;

  const embed = new BublikEmbed()
    .setColor(0x3498db)
    .setTitle(`${EMOJI.NEWS} ${i18n.t('economy.news.capture_title', locale)}`)
    .setDescription(
      pickPhrase('economy.news.capture', locale, {
        hunter: `<@${hunterId}>`,
        robber: `<@${robberId}>`,
        amount: fmt(reward),
      }),
    );

  await postNews(client, guildId, embed);
}

/** Выигрыш прогрессивного джекпота в слотах */
export async function newsSlotsProgressiveJackpot(
  client: Client,
  guildId: string,
  userId: string,
  winAmount: number,
  _locale: string,
): Promise<void> {
  const embed = new BublikEmbed()
    .setColor(0xf1c40f) // Золотой
    .setTitle(`${EMOJI.SLOTS} 🚨 СОРВАН ПРОГРЕССИВНЫЙ ДЖЕКПОТ!`)
    .setDescription(
      `🎉 <@${userId}> сорвал **прогрессивный Джекпот** в слотах!\n\n` +
      `💰 **Сумма выигрыша:** **${fmt(winAmount)}** шекелей!\n` +
      `🔥 Следующий джекпот начинает расти!`
    )
    .setThumbnail('https://cdn.discordapp.com/emojis/money_with_wings.png')
    .setFooter({ text: 'Испытай свою удачу: /slots bet' });

  await postNews(client, guildId, embed);
}
