// ═══════════════════════════════════════════════
//  Teams — Статистика и лидерборд
// ═══════════════════════════════════════════════

import { StringSelectMenuInteraction } from 'discord.js';
import type { BublikClient } from '../../bot';
import { logger } from '../../core/Logger';
import { isGuildAllowed } from '../../core/Whitelist';
import { scheduleTask, unscheduleTask } from '../../core/SchedulerManager';

import { getCurrentSeason, LEADERBOARD_UPDATE_MS } from './constants';
import * as db from './database';
import { buildLeaderboardEmbed, buildLeaderboardSeasonSelect, tmError } from './embeds';

const log = logger.child('Teams:Statistics');

// ═══════════════════════════════════════════════
//  Показать лидерборд (по команде или кнопке)
// ═══════════════════════════════════════════════

export async function showLeaderboard(
  guildId: string,
  season?: number,
  year?: number,
): Promise<{ embed: ReturnType<typeof buildLeaderboardEmbed>; row: ReturnType<typeof buildLeaderboardSeasonSelect> }> {
  const current = getCurrentSeason();
  const s = season ?? current.season;
  const y = year ?? current.year;

  const stats = await db.getGuildSeasonStats(guildId, s, y);

  const teams = stats.map((stat: any) => ({
    name: stat.team.name,
    totalPR: stat.totalPR,
    totalSessions: stat.totalSessions,
    bestPlace: stat.bestPlace ?? 300,
    totalPlace: stat.totalPlace ?? 0,
    attendance: stat.attendance ?? 0,
  }));

  const embed = buildLeaderboardEmbed(s, y, teams);
  const row = buildLeaderboardSeasonSelect(current.season, current.year);

  return { embed, row };
}

// ═══════════════════════════════════════════════
//  Переключатель сезона (StringSelectMenu)
// ═══════════════════════════════════════════════

export async function handleSeasonSelect(
  interaction: StringSelectMenuInteraction,
  _client: BublikClient,
): Promise<void> {
  await interaction.deferUpdate();

  const value = interaction.values[0]; // "season:year"
  const [seasonStr, yearStr] = value.split(':');
  const season = parseInt(seasonStr, 10);
  const year = parseInt(yearStr, 10);

  if (isNaN(season) || isNaN(year)) {
    await interaction.followUp({ embeds: [tmError('Ошибка парсинга сезона.')], ephemeral: true });
    return;
  }

  const guildId = interaction.guildId!;
  const { embed, row } = await showLeaderboard(guildId, season, year);

  await interaction.editReply({ embeds: [embed], components: [row] });
}

// ═══════════════════════════════════════════════
//  Автообновление лидерборда в канал
// ═══════════════════════════════════════════════

const LEADERBOARD_TASK = 'teams:leaderboard';

export function startLeaderboardUpdater(client: BublikClient): void {
  unscheduleTask(LEADERBOARD_TASK);
  scheduleTask(LEADERBOARD_TASK, LEADERBOARD_UPDATE_MS, async () => {
    await updateAllLeaderboards(client);
  }, { exclusive: true, immediate: true });
}

export function stopLeaderboardUpdater(): void {
  unscheduleTask(LEADERBOARD_TASK);
}

async function updateAllLeaderboards(client: BublikClient): Promise<void> {
  for (const [guildId, guild] of client.guilds.cache) {
    if (!isGuildAllowed(guildId)) continue;
    const config = await db.getConfig(guildId);
    if (!config?.leaderboardChannelId) continue;

    const channel = guild.channels.cache.get(config.leaderboardChannelId);
    if (!channel?.isTextBased()) continue;

    try {
      const { embed, row } = await showLeaderboard(guildId);

      if (config.leaderboardMessageId) {
        // Пытаемся обновить существующее сообщение
        const msg = await channel.messages.fetch(config.leaderboardMessageId).catch(() => null);
        if (msg) {
          await msg.edit({ embeds: [embed], components: [row] });
          log.info(`Лидерборд обновлён в гильдии ${guildId}`);
          continue;
        }
      }

      // Создаём новое сообщение лидерборда
      const newMsg = await channel.send({ embeds: [embed], components: [row] });
      await db.upsertConfig(guildId, { leaderboardMessageId: newMsg.id });
      log.info(`Лидерборд создан в гильдии ${guildId}`);
    } catch (err) {
      log.error(`Ошибка обновления лидерборда для ${guildId}`, { error: String(err) });
    }
  }
}

// ═══════════════════════════════════════════════
//  Пересчёт сезонной статистики из сессий
// ═══════════════════════════════════════════════

export async function recalculateSeasonStats(
  teamId: string,
  season: number,
  year: number,
): Promise<void> {
  // Границы сезона
  const startMonth = (season - 1) * 2; // 0-based month
  const seasonStart = new Date(year, startMonth, 1);
  const seasonEnd = new Date(year, startMonth + 2, 1);

  const sessions = await db.getTeamSessions(teamId, seasonStart, seasonEnd);

  if (sessions.length === 0) return;

  let totalPR = 0;
  let totalPlace = 0;
  let bestPlace = 300;

  for (const s of sessions) {
    if (s.reportedPR != null) totalPR += s.reportedPR;
    if (s.reportedPlace != null) {
      totalPlace += s.reportedPlace;
      if (s.reportedPlace < bestPlace) bestPlace = s.reportedPlace;
    }
  }

  await db.upsertSeason(teamId, season, year, {
    totalPR,
    totalSessions: sessions.length,
    totalPlace,
    bestPlace,
  });

  log.info(`Пересчёт статистики: team=${teamId}, сезон ${season}/${year}, сессий ${sessions.length}`);
}
