// ═══════════════════════════════════════════════
//  Teams — Embed-билдеры
// ═══════════════════════════════════════════════

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  UserSelectMenuBuilder,
} from 'discord.js';
import { BublikEmbed } from '../../core/EmbedBuilder';
import { i18n } from '../../core/I18n';
import { TM_PREFIX, TM_SEP, getSeasonLabel } from './constants';
import { getMemberSelectLimits } from './policy';

// ═══════════════════════════════════════════════
//  Быстрые хелперы
// ═══════════════════════════════════════════════

export function tmSuccess(text: string): BublikEmbed {
  return new BublikEmbed().setDescription(`✅ ${text}`).setColor(0x57f287);
}

export function tmError(text: string): BublikEmbed {
  return new BublikEmbed().setDescription(`❌ ${text}`).setColor(0xed4245);
}

export function tmWarn(text: string): BublikEmbed {
  return new BublikEmbed().setDescription(`⚠️ ${text}`).setColor(0xfee75c);
}

export function tmInfo(text: string): BublikEmbed {
  return new BublikEmbed().setDescription(text).setColor(0x5865f2);
}

// ═══════════════════════════════════════════════
//  Создание команды — выбор участников
// ═══════════════════════════════════════════════

export function buildMemberSelectRow(teamId: string, minSize: number): ActionRowBuilder<UserSelectMenuBuilder> {
  const limits = getMemberSelectLimits(minSize);
  const select = new UserSelectMenuBuilder()
    .setCustomId(`${TM_PREFIX}${TM_SEP}sel${TM_SEP}members${TM_SEP}${teamId}`)
    .setPlaceholder(i18n.t('teams.select_members_placeholder', 'ru'))
    .setMinValues(limits.min) // Лидер уже в команде
    .setMaxValues(limits.max);
  return new ActionRowBuilder<UserSelectMenuBuilder>().addComponents(select);
}

// ═══════════════════════════════════════════════
//  Название команды — модальное окно (customId)
// ═══════════════════════════════════════════════

export const TEAM_NAME_MODAL_ID = `${TM_PREFIX}${TM_SEP}modal${TM_SEP}name`;

// ═══════════════════════════════════════════════
//  Инвайт в ЛС
// ═══════════════════════════════════════════════

export function buildInviteEmbed(
  teamName: string,
  leaderTag: string,
  guildName: string,
  memberCount: number,
): BublikEmbed {
  return new BublikEmbed()
    .setTitle('📩 Приглашение в команду')
    .setDescription(
      `Вас пригласили в команду **${teamName}**!\n\n` +
      `👑 Лидер: **${leaderTag}**\n` +
      `🏠 Сервер: **${guildName}**\n` +
      `👥 Участников: **${memberCount}**`,
    )
    .setColor(0x5865f2);
}

export function buildInviteButtons(teamId: string, userId: string): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`${TM_PREFIX}${TM_SEP}invite${TM_SEP}accept${TM_SEP}${teamId}${TM_SEP}${userId}`)
      .setLabel(i18n.t('teams.btn_accept', 'ru'))
      .setStyle(ButtonStyle.Success)
      .setEmoji('✅'),
    new ButtonBuilder()
      .setCustomId(`${TM_PREFIX}${TM_SEP}invite${TM_SEP}decline${TM_SEP}${teamId}${TM_SEP}${userId}`)
      .setLabel(i18n.t('teams.btn_decline', 'ru'))
      .setStyle(ButtonStyle.Danger)
      .setEmoji('❌'),
  );
}

// ═══════════════════════════════════════════════
//  Заявка в канал одобрений
// ═══════════════════════════════════════════════

export function buildApplicationEmbed(
  teamName: string,
  leaderTag: string,
  leaderId: string,
  members: { userId: string }[],
  pendingInvites: number,
  minSize: number,
): BublikEmbed {
  const memberList = members.map((m, i) => `${i + 1}. <@${m.userId}>`).join('\n');
  const status = members.length >= minSize ? '✅ Состав укомплектован' : `⏳ Ожидание (${members.length}/${minSize})`;

  return new BublikEmbed()
    .setTitle(`📋 Заявка на создание команды «${teamName}»`)
    .setDescription(
      `👑 Лидер: <@${leaderId}>\n` +
      `📊 Статус: ${status}\n` +
      `📨 Ожидают ответа: **${pendingInvites}**\n\n` +
      `**Состав (${members.length}):**\n${memberList || '—'}`,
    )
    .setColor(members.length >= minSize ? 0x57f287 : 0xfee75c);
}

export function buildApplicationButtons(applicationId: string): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`${TM_PREFIX}${TM_SEP}app${TM_SEP}approve${TM_SEP}${applicationId}`)
      .setLabel(i18n.t('teams.btn_approve', 'ru'))
      .setStyle(ButtonStyle.Success)
      .setEmoji('✅'),
    new ButtonBuilder()
      .setCustomId(`${TM_PREFIX}${TM_SEP}app${TM_SEP}reject${TM_SEP}${applicationId}`)
      .setLabel(i18n.t('teams.btn_reject', 'ru'))
      .setStyle(ButtonStyle.Danger)
      .setEmoji('❌'),
  );
}

// ═══════════════════════════════════════════════
//  Панель управления командой (лидер)
// ═══════════════════════════════════════════════

export function buildTeamInfoEmbed(
  teamName: string,
  leaderId: string,
  roleId: string,
  status: string,
  memberCount: number,
  members: { userId: string }[],
  seasonStats?: { totalPR: number; totalSessions: number; bestPlace: number } | null,
): BublikEmbed {
  const statusLabels: Record<string, string> = {
    forming: '🔧 Формирование',
    active: '✅ Активна',
    disbanding: '⚠️ Расформирование',
    disbanded: '❌ Расформирована',
  };

  const memberList = members.slice(0, 20).map((m, i) => `${i + 1}. <@${m.userId}>`).join('\n');
  const extra = members.length > 20 ? `\n... и ещё ${members.length - 20}` : '';

  const embed = new BublikEmbed()
    .setTitle(`🏴 Команда «${teamName}»`)
    .setDescription(
      `👑 Лидер: <@${leaderId}>\n` +
      `🏷️ Роль: <@&${roleId}>\n` +
      `📊 Статус: ${statusLabels[status] ?? status}\n` +
      `👥 Участников: **${memberCount}**`,
    )
    .setColor(status === 'active' ? 0x57f287 : status === 'disbanding' ? 0xfee75c : 0x5865f2);

  embed.addFields({ name: 'Состав', value: memberList + extra || '—', inline: false });

  if (seasonStats && seasonStats.totalSessions > 0) {
    const avgPR = Math.round(seasonStats.totalPR / seasonStats.totalSessions);
    embed.addFields({
      name: '📈 Сезон',
      value:
        `ПР: **${seasonStats.totalPR.toLocaleString('ru')}** (сред. ${avgPR.toLocaleString('ru')})\n` +
        `Сессий: **${seasonStats.totalSessions}**\n` +
        `Лучшее место: **#${seasonStats.bestPlace}**`,
      inline: false,
    });
  }

  return embed;
}

export function buildTeamManageButtons(teamId: string): ActionRowBuilder<ButtonBuilder>[] {
  const row1 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`${TM_PREFIX}${TM_SEP}manage${TM_SEP}invite${TM_SEP}${teamId}`)
      .setLabel('Пригласить')
      .setStyle(ButtonStyle.Primary)
      .setEmoji('📨'),
    new ButtonBuilder()
      .setCustomId(`${TM_PREFIX}${TM_SEP}manage${TM_SEP}kick${TM_SEP}${teamId}`)
      .setLabel('Исключить')
      .setStyle(ButtonStyle.Danger)
      .setEmoji('👢'),
    new ButtonBuilder()
      .setCustomId(`${TM_PREFIX}${TM_SEP}manage${TM_SEP}transfer${TM_SEP}${teamId}`)
      .setLabel('Передать лидерство')
      .setStyle(ButtonStyle.Secondary)
      .setEmoji('👑'),
  );

  const row2 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`${TM_PREFIX}${TM_SEP}manage${TM_SEP}poll${TM_SEP}${teamId}`)
      .setLabel('Опрос на ПБ')
      .setStyle(ButtonStyle.Primary)
      .setEmoji('📊'),
    new ButtonBuilder()
      .setCustomId(`${TM_PREFIX}${TM_SEP}manage${TM_SEP}disband${TM_SEP}${teamId}`)
      .setLabel('Расформировать')
      .setStyle(ButtonStyle.Danger)
      .setEmoji('💣'),
  );

  return [row1, row2];
}

// ═══════════════════════════════════════════════
//  Опрос
// ═══════════════════════════════════════════════

/** voteTimes: Record<userId, timeString | null> */
export function buildPollEmbed(
  teamName: string,
  scheduledTime: string | null,
  yesUsers: string[],
  noUsers: string[],
  voteTimes: Record<string, string | null>,
): BublikEmbed {
  const noList = noUsers.length > 0 ? noUsers.map(id => `<@${id}>`).join(', ') : '—';
  const timeStr = scheduledTime ? `\n🕐 Время: **${scheduledTime} МСК**` : '';

  // Группировка "Да" по времени
  const timeGroups = new Map<string, string[]>(); // time → userIds
  const noTimeGroup: string[] = []; // без указания времени

  for (const userId of yesUsers) {
    const t = voteTimes[userId];
    if (t) {
      const bucket = timeGroups.get(t) ?? [];
      bucket.push(userId);
      timeGroups.set(t, bucket);
    } else {
      noTimeGroup.push(userId);
    }
  }

  // Сортировка по времени
  const sortedTimes = [...timeGroups.entries()].sort(([a], [b]) => a.localeCompare(b));

  let yesBlock = '';
  if (sortedTimes.length > 0 || noTimeGroup.length > 0) {
    for (const [time, users] of sortedTimes) {
      const ready = users.length >= 8 ? ' 🔔' : '';
      yesBlock += `\n🕐 **${time}** — ${users.map(id => `<@${id}>`).join(', ')} (${users.length})${ready}`;
    }
    if (noTimeGroup.length > 0) {
      yesBlock += `\n⏰ **Без времени** — ${noTimeGroup.map(id => `<@${id}>`).join(', ')} (${noTimeGroup.length})`;
    }
  } else {
    yesBlock = '\n—';
  }

  // Подсветка: максимум на одном слоте
  const maxSlot = sortedTimes.reduce((max, [, users]) => Math.max(max, users.length), 0);
  const totalYes = yesUsers.length;

  return new BublikEmbed()
    .setTitle(`📊 Сбор на ПБ — «${teamName}»`)
    .setDescription(
      `Идём сегодня на полковые бои?${timeStr}\n\n` +
      `✅ **Готовы (${totalYes}):**${yesBlock}\n\n` +
      `❌ **Не смогу (${noUsers.length}):** ${noList}`,
    )
    .setColor(maxSlot >= 8 || totalYes >= 8 ? 0x57f287 : 0x5865f2);
}

export function buildPollButtons(pollId: string): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`${TM_PREFIX}${TM_SEP}poll${TM_SEP}yes${TM_SEP}${pollId}`)
      .setLabel('Иду!')
      .setStyle(ButtonStyle.Success)
      .setEmoji('✅'),
    new ButtonBuilder()
      .setCustomId(`${TM_PREFIX}${TM_SEP}poll${TM_SEP}no${TM_SEP}${pollId}`)
      .setLabel('Не смогу')
      .setStyle(ButtonStyle.Danger)
      .setEmoji('❌'),
    new ButtonBuilder()
      .setCustomId(`${TM_PREFIX}${TM_SEP}poll${TM_SEP}close${TM_SEP}${pollId}`)
      .setLabel('Завершить')
      .setStyle(ButtonStyle.Secondary)
      .setEmoji('🔒'),
  );
}

export const POLL_VOTE_MODAL_ID = `${TM_PREFIX}${TM_SEP}modal${TM_SEP}pollvote`;

// ═══════════════════════════════════════════════
//  Отчёт (DM)
// ═══════════════════════════════════════════════

export function buildReportRequestEmbed(
  teamName: string,
  squadNumber: number | null,
): BublikEmbed {
  return new BublikEmbed()
    .setTitle('📝 Отчёт после ПБ')
    .setDescription(
      `Сессия команды **${teamName}**${squadNumber ? ` (Отряд #${squadNumber})` : ''} завершена!\n\n` +
      'Пожалуйста, заполните краткий отчёт о результатах.',
    )
    .setColor(0xff6600);
}

export function buildReportButton(sessionId: string): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`${TM_PREFIX}${TM_SEP}report${TM_SEP}fill${TM_SEP}${sessionId}`)
      .setLabel('Заполнить отчёт')
      .setStyle(ButtonStyle.Primary)
      .setEmoji('📝'),
  );
}

export const REPORT_MODAL_ID = `${TM_PREFIX}${TM_SEP}modal${TM_SEP}report`;

// ═══════════════════════════════════════════════
//  Отчёт (канал)
// ═══════════════════════════════════════════════

export function buildReportChannelEmbed(
  teamName: string,
  reporterTag: string,
  reportedPR: number,
  reportedPlace: number,
  sessionDuration: string,
): BublikEmbed {
  return new BublikEmbed()
    .setTitle(`📊 Отчёт — «${teamName}»`)
    .setDescription(
      `📝 Заполнил: **${reporterTag}**\n\n` +
      `🏆 Полковой рейтинг: **${reportedPR.toLocaleString('ru')}**\n` +
      `📍 Место полка: **#${reportedPlace}**\n` +
      `⏱️ Длительность: **${sessionDuration}**`,
    )
    .setColor(0x57f287);
}

// ═══════════════════════════════════════════════
//  Лидерборд
// ═══════════════════════════════════════════════

export function buildLeaderboardEmbed(
  season: number,
  year: number,
  teams: {
    name: string;
    totalPR: number;
    totalSessions: number;
    bestPlace: number;
    totalPlace: number;
    attendance: number;
  }[],
): BublikEmbed {
  const medals = ['🥇', '🥈', '🥉'];
  const seasonLabel = getSeasonLabel(season);

  let desc = '';
  for (let i = 0; i < teams.length; i++) {
    const t = teams[i];
    const medal = medals[i] ?? `**${i + 1}.**`;
    const avgPR = t.totalSessions > 0 ? Math.round(t.totalPR / t.totalSessions) : 0;
    const avgPlace = t.totalSessions > 0 ? Math.round(t.totalPlace / t.totalSessions) : 0;

    desc +=
      `${medal} **${t.name}**\n` +
      `┗ ПР: **${t.totalPR.toLocaleString('ru')}** (сред. ${avgPR.toLocaleString('ru')}) • ` +
      `Место: **#${t.bestPlace}** (сред. #${avgPlace}) • ` +
      `Сессий: **${t.totalSessions}**\n\n`;
  }

  return new BublikEmbed()
    .setTitle(`🏆 Рейтинг команд — ${seasonLabel} ${year}`)
    .setDescription(desc || 'Нет данных за этот сезон.')
    .setColor(0xffd700);
}

export function buildLeaderboardSeasonSelect(
  currentSeason: number,
  currentYear: number,
): ActionRowBuilder<StringSelectMenuBuilder> {
  const options: { label: string; value: string; default?: boolean }[] = [];

  // Текущий + 5 прошлых сезонов
  let s = currentSeason;
  let y = currentYear;
  for (let i = 0; i < 6; i++) {
    options.push({
      label: `${getSeasonLabel(s)} ${y}`,
      value: `${s}:${y}`,
      default: i === 0,
    });
    s--;
    if (s < 1) {
      s = 6;
      y--;
    }
  }

  const select = new StringSelectMenuBuilder()
    .setCustomId(`${TM_PREFIX}${TM_SEP}sel${TM_SEP}season`)
    .setPlaceholder('Выберите сезон')
    .addOptions(options);

  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);
}

// ═══════════════════════════════════════════════
//  Инвайт в войс ПБ (панель отряда)
// ═══════════════════════════════════════════════

export function buildVoiceInviteEmbed(
  teamName: string,
  inviterTag: string,
  guildName: string,
  channelName: string,
): BublikEmbed {
  return new BublikEmbed()
    .setTitle('🔊 Приглашение в голосовой канал')
    .setDescription(
      `Вас пригласили в войс **${channelName}** команды **${teamName}**!\n\n` +
      `👤 Пригласил: **${inviterTag}**\n` +
      `🏠 Сервер: **${guildName}**`,
    )
    .setColor(0x5865f2);
}

export function buildVoiceInviteButton(squadId: string, userId: string): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`${TM_PREFIX}${TM_SEP}vinvite${TM_SEP}join${TM_SEP}${squadId}${TM_SEP}${userId}`)
      .setLabel('Присоединиться')
      .setStyle(ButtonStyle.Success)
      .setEmoji('🔊'),
  );
}

// ═══════════════════════════════════════════════
//  Кнопка "Пригласить в войс" для панели отряда
// ═══════════════════════════════════════════════

export function buildSquadInviteButton(squadId: string): ButtonBuilder {
  return new ButtonBuilder()
    .setCustomId(`${TM_PREFIX}${TM_SEP}squad${TM_SEP}invite${TM_SEP}${squadId}`)
    .setLabel('Пригласить')
    .setStyle(ButtonStyle.Primary)
    .setEmoji('📨');
}

// ═══════════════════════════════════════════════
//  Опрос — модальное окно время
// ═══════════════════════════════════════════════

export const POLL_TIME_MODAL_ID = `${TM_PREFIX}${TM_SEP}modal${TM_SEP}polltime`;
