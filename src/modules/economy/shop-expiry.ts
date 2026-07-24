// Economy shop role saga: deliver active purchases, remove expired roles,
// and compensate purchases whose Discord role no longer exists.

import { Client, Role } from 'discord.js';
import { getDatabase } from '../../core/Database';
import { logger } from '../../core/Logger';
import { scheduleTask, unscheduleTask } from '../../core/SchedulerManager';
import { isGuildAllowed } from '../../core/Whitelist';
import { hasDangerousAssignablePermissions } from '../../core/RolePolicy';
import { applyWalletDeltaInTransaction, claimOperationInTransaction } from './profile';
import { invalidateProfileCache } from './database';
import { invalidateUserPerks } from './perks';
import { getCleanWallet } from './safety-policy';

const log = logger.child('Economy:ShopRoleSaga');
const CHECK_INTERVAL_MS = 5 * 60_000;

interface PersistedShopCommission {
  purchaseId: string;
  buyerId: string;
  amount: number;
}

export function parsePersistedShopCommission(value: unknown): PersistedShopCommission | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const metadata = value as Record<string, unknown>;
  if (
    typeof metadata.purchaseId !== 'string'
    || typeof metadata.buyerId !== 'string'
    || !Number.isSafeInteger(metadata.amount)
    || Number(metadata.amount) < 0
  ) return null;
  return {
    purchaseId: metadata.purchaseId,
    buyerId: metadata.buyerId,
    amount: Number(metadata.amount),
  };
}

export function calculateShopCompensation(
  price: number,
  paidCommission: number,
  recoverableCommission: number,
): { reversedCommission: number; buyerRefund: number } {
  if (
    !Number.isSafeInteger(price) || price < 0
    || !Number.isSafeInteger(paidCommission) || paidCommission < 0 || paidCommission > price
    || !Number.isSafeInteger(recoverableCommission) || recoverableCommission < 0
  ) throw new Error('invalid_shop_compensation');
  const reversedCommission = Math.min(paidCommission, recoverableCommission);
  return {
    reversedCommission,
    buyerRefund: price - paidCommission + reversedCommission,
  };
}

function isUnknownRoleError(error: unknown): boolean {
  return Boolean(
    error
    && typeof error === 'object'
    && Number((error as { code?: unknown }).code) === 10_011,
  );
}

export async function payShopCommissionOnce(purchase: {
  id: string;
  guildId: string;
  userId: string;
  price: number;
  item: { name: string; sellerId: string | null; commissionPct: number };
}): Promise<boolean> {
  if (!purchase.item.sellerId || purchase.item.sellerId === purchase.userId || purchase.item.commissionPct <= 0) {
    return false;
  }
  const cut = Math.min(
    purchase.price,
    Math.max(0, Math.floor(purchase.price * purchase.item.commissionPct / 100)),
  );
  if (cut <= 0) return false;
  const db = getDatabase();
  const paid = await db.$transaction(async (tx) => {
    // Compensation uses the same row lock. Once the purchase is deleted no
    // late commission can race in after the buyer has been refunded.
    await tx.$queryRaw`SELECT "id" FROM "shop_purchases" WHERE "id" = ${purchase.id} FOR UPDATE`;
    const livePurchase = await tx.shopPurchase.findUnique({ where: { id: purchase.id } });
    if (
      !livePurchase
      || livePurchase.guildId !== purchase.guildId
      || livePurchase.userId !== purchase.userId
      || livePurchase.price !== purchase.price
    ) return false;
    const claimed = await claimOperationInTransaction(
      tx,
      `shop-commission:${purchase.id}`,
      'shop_commission',
      purchase.guildId,
      purchase.item.sellerId!,
      { purchaseId: purchase.id, buyerId: purchase.userId, amount: cut },
    );
    if (!claimed) return false;
    await applyWalletDeltaInTransaction(
      tx,
      purchase.guildId,
      purchase.item.sellerId!,
      cut,
      'market_income',
      `Комиссия с покупки ${purchase.item.name}`,
      purchase.userId,
    );
    return true;
  });
  if (paid) await invalidateProfileCache(purchase.guildId, purchase.item.sellerId);
  return paid;
}

export function startShopExpiryTicker(client: Client): void {
  scheduleTask('economy:shopExpiry', CHECK_INTERVAL_MS, async () => {
    await reconcileShopPurchases(client);
  }, { exclusive: true, immediate: true });
  log.info('Shop role saga запущена');
}

export function stopShopExpiryTicker(): void {
  unscheduleTask('economy:shopExpiry');
  log.info('Shop role saga остановлена');
}

async function compensateMissingRole(purchase: {
  id: string;
  guildId: string;
  userId: string;
  itemId: string;
  price: number;
  item: {
    id: string;
    guildId: string;
    name: string;
    maxStock: number;
    sellerId: string | null;
  };
}): Promise<boolean> {
  const db = getDatabase();
  const result = await db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "shop_purchases" WHERE "id" = ${purchase.id} FOR UPDATE`;
    const livePurchase = await tx.shopPurchase.findUnique({ where: { id: purchase.id } });
    if (
      !livePurchase
      || livePurchase.guildId !== purchase.guildId
      || livePurchase.userId !== purchase.userId
      || livePurchase.itemId !== purchase.itemId
      || livePurchase.price !== purchase.price
    ) return { compensated: false, sellerId: null };

    const commissionClaim = await tx.operationClaim.findUnique({
      where: { key: `shop-commission:${purchase.id}` },
    });
    let paidCommission = 0;
    let sellerId: string | null = null;
    if (commissionClaim) {
      const commission = parsePersistedShopCommission(commissionClaim.metadata);
      if (
        commissionClaim.scope !== 'shop_commission'
        || commissionClaim.guildId !== purchase.guildId
        || !commissionClaim.userId
        || !commission
        || commission.purchaseId !== purchase.id
        || commission.buyerId !== purchase.userId
        || commission.amount > purchase.price
      ) throw new Error('shop_commission_claim_corrupt');
      paidCommission = commission.amount;
      sellerId = commissionClaim.userId;
    }

    let recoverableCommission = 0;
    if (sellerId && paidCommission > 0) {
      const seller = await tx.economyProfile.upsert({
        where: { guildId_userId: { guildId: purchase.guildId, userId: sellerId } },
        create: { guildId: purchase.guildId, userId: sellerId },
        update: {},
      });
      await tx.$queryRaw`SELECT "id" FROM "economy_profiles" WHERE "id" = ${seller.id} FOR UPDATE`;
      const freshSeller = await tx.economyProfile.findUniqueOrThrow({ where: { id: seller.id } });
      recoverableCommission = getCleanWallet(freshSeller.wallet, freshSeller.dirtyAmount);
    }

    const compensation = calculateShopCompensation(
      purchase.price,
      paidCommission,
      recoverableCommission,
    );
    if (sellerId && compensation.reversedCommission > 0) {
      const reversalClaimed = await claimOperationInTransaction(
        tx,
        `shop-commission-reversal:${purchase.id}`,
        'shop_commission_reversal',
        purchase.guildId,
        sellerId,
        {
          purchaseId: purchase.id,
          buyerId: purchase.userId,
          paidCommission,
          reversedCommission: compensation.reversedCommission,
          buyerRefund: compensation.buyerRefund,
        },
      );
      if (!reversalClaimed) throw new Error('shop_commission_reversal_conflict');
      await applyWalletDeltaInTransaction(
        tx,
        purchase.guildId,
        sellerId,
        -compensation.reversedCommission,
        'shop_commission_reversal',
        `Commission reversal for missing role: ${purchase.item.name}`,
        purchase.userId,
        { allowDirtySpend: false },
      );
    }

    const removed = await tx.shopPurchase.deleteMany({
      where: {
        id: purchase.id,
        guildId: purchase.guildId,
        userId: purchase.userId,
        itemId: purchase.itemId,
      },
    });
    if (removed.count !== 1) throw new Error('shop_compensation_race');
    if (compensation.buyerRefund > 0) {
      await applyWalletDeltaInTransaction(
        tx,
        purchase.guildId,
        purchase.userId,
        compensation.buyerRefund,
        'shop_role_delivery_refund',
        `Refund: Discord role for ${purchase.item.name} no longer exists`,
      );
    }
    if (purchase.item.maxStock > 0) {
      await tx.shopItem.updateMany({
        where: { id: purchase.item.id, guildId: purchase.guildId },
        data: { currentStock: { increment: 1 } },
      });
    }
    return { compensated: true, sellerId };
  });
  if (result.compensated) {
    await invalidateProfileCache(purchase.guildId, purchase.userId);
    await invalidateUserPerks(purchase.guildId, purchase.userId);
    if (result.sellerId) await invalidateProfileCache(purchase.guildId, result.sellerId);
  }
  return result.compensated;
}

export async function reconcileShopPurchases(client: Client): Promise<void> {
  const db = getDatabase();
  const now = new Date();
  const guildIds = [...client.guilds.cache.keys()].filter(isGuildAllowed);
  if (guildIds.length === 0) return;
  const purchases = await db.shopPurchase.findMany({
    where: { guildId: { in: guildIds } },
    include: { item: true },
    orderBy: { createdAt: 'asc' },
  });

  for (const purchase of purchases) {
    // Explicit ownership whitelist prevents a stale/corrupt cross-guild row from
    // causing role mutations in another guild.
    if (purchase.item.guildId !== purchase.guildId) continue;
    const guild = client.guilds.cache.get(purchase.guildId);
    if (!guild || !isGuildAllowed(purchase.guildId)) continue;

    try {
      let role: Role | null = null;
      try {
        role = await guild.roles.fetch(purchase.item.roleId, { force: true });
      } catch (error) {
        if (!isUnknownRoleError(error)) throw error;
      }
      const expired = purchase.expiresAt !== null && purchase.expiresAt <= now;
      const member = await guild.members.fetch(purchase.userId).catch(() => null);

      if (expired) {
        if (role && member?.roles.cache.has(role.id)) {
          await member.roles.remove(role.id, 'Временная роль из магазина истекла');
        }
        await db.shopPurchase.deleteMany({ where: { id: purchase.id, expiresAt: { lte: now } } });
        await invalidateUserPerks(purchase.guildId, purchase.userId);
        continue;
      }

      if (!role) {
        await compensateMissingRole(purchase);
        continue;
      }
      if (hasDangerousAssignablePermissions(role.permissions)) {
        await db.shopItem.updateMany({
          where: { id: purchase.item.id, guildId: purchase.guildId },
          data: { isActive: false },
        });
        if (member?.roles.cache.has(role.id)) {
          await member.roles.remove(role.id, 'Опасные права у роли магазина; покупка отменена');
        }
        await compensateMissingRole(purchase);
        log.warn(`[${purchase.guildId}] Товар ${purchase.item.name} (${role.id}) отключён: опасные права роли`);
        continue;
      }
      if (member && !member.roles.cache.has(role.id)) {
        await member.roles.add(role.id, `Восстановление покупки ${purchase.item.name}`);
        log.info(`[${purchase.guildId}] Восстановлена роль ${role.id} для ${purchase.userId}`);
      }
      if (member) await payShopCommissionOnce(purchase);
    } catch (error) {
      // The DB row remains the retry token; no money/item state is lost.
      log.error(`Shop purchase saga ${purchase.id} failed; it will be retried`, error);
    }
  }
}
