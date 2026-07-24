// ═══════════════════════════════════════════════
//  Wanted-decay scheduler — раз в час сбивает по
//  одной звезде у тех, кому пришёл срок.
// ═══════════════════════════════════════════════

import { logger } from '../../core/Logger';
import { scheduleTask, unscheduleTask } from '../../core/SchedulerManager';
import { isGuildAllowed } from '../../core/Whitelist';
import { decayWantedStars } from './database';
import { getDatabase } from '../../core/Database';
import { WANTED_DEFAULTS } from './constants';

const log = logger.child('Economy:WantedDecay');
const TASK = 'economy:wantedDecay';
const INTERVAL = 60 * 60 * 1_000; // 1 час

export function startWantedScheduler(): void {
  scheduleTask(TASK, INTERVAL, async () => {
    try {
      const cfgs = await getDatabase().economyConfig.findMany({
        where: { enabled: true, wantedEnabled: true },
        select: { guildId: true, wantedDecayMs: true },
      });

      let totalRemoved = 0;
      for (const cfg of cfgs) {
        if (!isGuildAllowed(cfg.guildId)) continue;
        const decayMs = Number(cfg.wantedDecayMs ?? WANTED_DEFAULTS.decayMs);
        totalRemoved += await decayWantedStars(decayMs, cfg.guildId);
      }

      if (totalRemoved > 0) log.info(`Сбито ${totalRemoved} звёзд розыска`);
    } catch (err) {
      log.error('Ошибка wanted-decay scheduler', { error: String(err) });
    }
  }, { exclusive: true });
  log.info('Wanted-decay scheduler запущен (раз в час)');
}

export function stopWantedScheduler(): void {
  unscheduleTask(TASK);
}
