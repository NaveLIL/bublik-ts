// ═══════════════════════════════════════════════
//  Economy — Таймер снятия временных ролей
//
//  Каждые 5 минут проверяем ShopPurchase.expiresAt.
//  Истёкшие → снимаем роль, удаляем запись.
// ═══════════════════════════════════════════════

import { Client } from 'discord.js';
import { getDatabase } from '../../core/Database';
import { logger } from '../../core/Logger';
import { errorReporter } from '../../core/ErrorReporter';

const log = logger.child('Economy:ShopExpiry');

const CHECK_INTERVAL_MS = 5 * 60_000; // 5 мин
let expiryInterval: ReturnType<typeof setInterval> | null = null;

/** Запустить тикер проверки истёкших покупок */
export function startShopExpiryTicker(client: Client): void {
  if (expiryInterval) return;

  expiryInterval = setInterval(async () => {
    try {
      await checkExpiredPurchases(client);
    } catch (err) {
      log.error('Ошибка проверки истёкших покупок', err);
      errorReporter.eventError(err as Error, 'economy:shopExpiry', 'economy');
    }
  }, CHECK_INTERVAL_MS);

  log.info('Тикер истёкших покупок запущен');
}

/** Остановить тикер */
export function stopShopExpiryTicker(): void {
  if (expiryInterval) {
    clearInterval(expiryInterval);
    expiryInterval = null;
    log.info('Тикер истёкших покупок остановлен');
  }
}

/** Проверить и обработать истёкшие покупки */
async function checkExpiredPurchases(client: Client): Promise<void> {
  const db = getDatabase();
  const now = new Date();

  const expired = await db.shopPurchase.findMany({
    where: {
      expiresAt: { lte: now, not: null },
    },
    include: { item: true },
  });

  if (expired.length === 0) return;

  for (const purchase of expired) {
    try {
      const guild = client.guilds.cache.get(purchase.guildId);
      if (!guild) continue;

      const member = await guild.members.fetch(purchase.userId).catch(() => null);
      if (member && member.roles.cache.has(purchase.item.roleId)) {
        await member.roles.remove(purchase.item.roleId, 'Временная роль из магазина истекла');
        log.info(`[${purchase.guildId}] Снята роль ${purchase.item.roleId} у ${purchase.userId} (истёк срок покупки ${purchase.item.name})`);
      }

      // Удаляем запись
      await db.shopPurchase.delete({ where: { id: purchase.id } });
    } catch (err) {
      log.error(`Ошибка обработки истёкшей покупки ${purchase.id}`, err);
    }
  }
}
