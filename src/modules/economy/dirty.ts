// ═══════════════════════════════════════════════
//  Dirty-money expiry scheduler — раз в 10 минут
//  чистит профили, у которых dirtyClearAt истёк.
// ═══════════════════════════════════════════════

import { logger } from '../../core/Logger';
import { scheduleTask, unscheduleTask } from '../../core/SchedulerManager';
import { expireDirtyMoney } from './database';

const log = logger.child('Economy:DirtyDecay');
const TASK = 'economy:dirtyExpire';
const INTERVAL = 10 * 60 * 1_000; // 10 минут

export function startDirtyScheduler(): void {
  scheduleTask(TASK, INTERVAL, async () => {
    try {
      const cleared = await expireDirtyMoney();
      if (cleared > 0) log.info(`Очищено грязных балансов: ${cleared}`);
    } catch (err) {
      log.error('Ошибка dirty-expire scheduler', { error: String(err) });
    }
  }, { exclusive: true });
  log.info('Dirty-expire scheduler запущен (раз в 10 минут)');
}

export function stopDirtyScheduler(): void {
  unscheduleTask(TASK);
}
