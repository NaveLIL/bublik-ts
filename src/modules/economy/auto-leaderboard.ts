// ═══════════════════════════════════════════════
//  Economy — Авто-лидерборд
//
//  Обновляет embed лидерборда в настроенном канале
//  каждый час. Редактирует одно сообщение (не спамит).
// ═══════════════════════════════════════════════

import { TextChannel } from 'discord.js';
import type { BublikClient } from '../../bot';
import { logger } from '../../core/Logger';
import { scheduleTask, unscheduleTask } from '../../core/SchedulerManager';
import { getGuildLocale } from '../../core/GuildConfig';
import { isGuildAllowed } from '../../core/Whitelist';
import { getEcoConfig, upsertEcoConfig, getLeaderboard } from './database';
import { buildLeaderboardEmbed } from './embeds';

const log = logger.child('Economy:AutoLeaderboard');
const TASK_NAME = 'economy:autoLeaderboard';
const UPDATE_INTERVAL_MS = 60 * 60 * 1_000; // 1 час

let _client: BublikClient | null = null;

async function updateLeaderboards(): Promise<void> {
  if (!_client) return;
  log.info('Запуск обновления авто-лидербордов…');

  for (const [guildId, guild] of _client.guilds.cache) {
    try {
      if (!isGuildAllowed(guildId)) continue;
      const config = await getEcoConfig(guildId);
      if (!config?.enabled || !config.leaderboardChannelId) continue;

      const channel = await _client.channels.fetch(config.leaderboardChannelId).catch(() => null);
      if (!channel || !(channel instanceof TextChannel)) {
        log.warn(`[${guildId}] Канал лидерборда не найден: ${config.leaderboardChannelId}`);
        continue;
      }

      const locale = await getGuildLocale(guildId);
      const profiles = await getLeaderboard(guildId, 10);

      const embed = buildLeaderboardEmbed(
        guild.name,
        profiles,
        0,    // page 0
        1,    // total 1
        locale,
      );

      // Пытаемся отредактировать существующее сообщение
      if (config.leaderboardMessageId) {
        try {
          const msg = await channel.messages.fetch(config.leaderboardMessageId);
          await msg.edit({ embeds: [embed] });
          log.info(`[${guildId}] Авто-лидерборд обновлён в #${channel.name}`);
          continue; // Успешно обновили
        } catch {
          log.info(`[${guildId}] Старое сообщение не найдено — создаём новое`);
          // Сообщение удалено или недоступно — отправим новое
        }
      }

      // Отправляем новое сообщение и сохраняем ID
      const sent = await channel.send({ embeds: [embed] });
      await upsertEcoConfig(guildId, { leaderboardMessageId: sent.id });

      log.info(`[${guildId}] Авто-лидерборд отправлен в #${channel.name}`);
    } catch (err) {
      log.error(`[${guildId}] Ошибка обновления авто-лидерборда`, err);
    }
  }
}

export function startAutoLeaderboard(client: BublikClient): void {
  _client = client;
  scheduleTask(TASK_NAME, UPDATE_INTERVAL_MS, updateLeaderboards, { exclusive: true, immediate: true });
  log.info('Авто-лидерборд запущен (интервал: 1ч)');
}

export function stopAutoLeaderboard(): void {
  unscheduleTask(TASK_NAME);
  _client = null;
}
