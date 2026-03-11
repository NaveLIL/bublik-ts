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
import { getEcoConfig } from './database';
import {
  EMOJI,
  CURRENCY,
  NEWS_EARN_THRESHOLD,
  NEWS_TRANSFER_THRESHOLD,
  NEWS_STREAK_THRESHOLD,
  NEWS_BALANCE_MILESTONES,
} from './constants';
import { fmt } from './profile';

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
  details?: string,
): Promise<void> {
  if (amount < NEWS_EARN_THRESHOLD) return;

  const typeNames: Record<string, string> = {
    earn_daily: `${EMOJI.DAILY} Дейли`,
    earn_weekly: `${EMOJI.WEEKLY} Недельный бонус`,
    earn_work: `${EMOJI.WORK} Работа`,
    earn_crime: `${EMOJI.CRIME} Преступление`,
    earn_voice: `${EMOJI.VOICE} Голосовой заработок`,
  };

  const embed = new BublikEmbed()
    .setColor(0x2ecc71)
    .setTitle(`${EMOJI.NEWS} Крупный заработок!`)
    .setDescription(
      `<@${userId}> заработал **${fmt(amount)}** шекелей!\n\n` +
      `${EMOJI.ARROW_RIGHT} **Тип:** ${typeNames[type] || type}\n` +
      (details ? `${EMOJI.ARROW_RIGHT} **Детали:** ${details}` : ''),
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
): Promise<void> {
  if (amount < NEWS_TRANSFER_THRESHOLD || amount <= 0) return;

  const taxPercent = amount > 0 ? Math.round(tax / amount * 100) : 0;

  const embed = new BublikEmbed()
    .setColor(0x3498db)
    .setTitle(`${EMOJI.TRANSFER} Крупный перевод!`)
    .setDescription(
      `<@${senderId}> перевёл **${fmt(amount)}** шекелей → <@${receiverId}>\n\n` +
      `${EMOJI.ARROW_RIGHT} **Налог:** ${fmt(tax)} (${taxPercent}%)\n` +
      `${EMOJI.ARROW_RIGHT} **Получено:** ${fmt(amount - tax)}`,
    );

  await postNews(client, guildId, embed);
}

/** Рекордный стрик */
export async function newsStreak(
  client: Client,
  guildId: string,
  userId: string,
  streak: number,
): Promise<void> {
  if (streak < NEWS_STREAK_THRESHOLD) return;

  // Эмоджи в зависимости от стрика
  let icon: string = EMOJI.STREAK;
  if (streak >= 30) icon = EMOJI.CROWN;
  else if (streak >= 14) icon = EMOJI.STAR;

  const embed = new BublikEmbed()
    .setColor(0xe74c3c)
    .setTitle(`${icon} Стрик-рекорд!`)
    .setDescription(
      `<@${userId}> набрал **${streak}-дневный** стрик дейли!\n\n` +
      `${EMOJI.STREAK} Непрерывная серия ежедневных наград — впечатляюще!`,
    );

  await postNews(client, guildId, embed);
}

/** Достижение milestone баланса */
export async function newsMilestone(
  client: Client,
  guildId: string,
  userId: string,
  totalBalance: number,
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
    .setTitle(`${EMOJI.CROWN} Milestone: ${CURRENCY}${milestoneStr}!`)
    .setDescription(
      `<@${userId}> достиг отметки **${fmt(milestone)}** шекелей!\n\n` +
      `${EMOJI.STAR} Общий баланс: **${fmt(totalBalance)}**`,
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
): Promise<void> {
  if (amount < NEWS_EARN_THRESHOLD) return;

  const embed = new BublikEmbed()
    .setColor(0x9b59b6)
    .setTitle(`${EMOJI.CRIME} Криминальный джекпот!`)
    .setDescription(
      `<@${userId}> сорвал куш в **${fmt(amount)}** шекелей!\n\n` +
      `${EMOJI.ARROW_RIGHT} *${scenario}*`,
    );

  await postNews(client, guildId, embed);
}
