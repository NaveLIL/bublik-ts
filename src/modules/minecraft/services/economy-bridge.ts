import { Prisma } from '@prisma/client';
import { GuildMember } from 'discord.js';
import { getDatabase } from '../../../core/Database';
import {
  getMinecraftAccountByDiscordId,
  getMinecraftShopItemById,
  isSafeMinecraftShopPrice,
  MinecraftAccountData,
  MinecraftShopItemData,
} from '../database';
import { executeRconCommand } from './rcon-service';
import { logger } from '../../../core/Logger';
import { validateShopCommandTemplate } from './shop-command-policy';

const log = logger.child('Minecraft:EconomyBridge');

const PURCHASE_PENDING = 'minecraft_shop_purchase_pending';
const PURCHASE_COMPLETED = 'minecraft_shop_purchase';
const PURCHASE_FAILED = 'minecraft_shop_purchase_failed';
const PURCHASE_PARTIAL = 'minecraft_shop_purchase_partial';
const PURCHASE_REFUND = 'minecraft_shop_purchase_refund';
const MAX_AUDIT_DETAILS_LENGTH = 1_000;
const DATABASE_RETRY_ATTEMPTS = 3;

interface EconomyProfileRecord {
  id: string;
  wallet: number;
}

interface EconomyTransactionRecord {
  id: string;
  balance: number;
  type: string;
}

interface PurchaseTransactionClient {
  economyProfile: {
    findUnique(args: unknown): Promise<EconomyProfileRecord | null>;
    update(args: unknown): Promise<EconomyProfileRecord>;
    updateMany(args: unknown): Promise<{ count: number }>;
  };
  economyTransaction: {
    create(args: unknown): Promise<EconomyTransactionRecord>;
    findFirst(args: unknown): Promise<EconomyTransactionRecord | null>;
    updateMany(args: unknown): Promise<{ count: number }>;
  };
}

interface PurchaseDatabase extends PurchaseTransactionClient {
  $transaction<T>(
    operation: (tx: PurchaseTransactionClient) => Promise<T>,
    options?: { isolationLevel: Prisma.TransactionIsolationLevel }
  ): Promise<T>;
}

interface RconResult {
  success: boolean;
  response?: string;
  error?: string;
}

export interface MinecraftPurchaseDependencies {
  getAccount(
    guildId: string,
    discordId: string
  ): Promise<MinecraftAccountData | null>;
  getShopItem(
    guildId: string,
    itemId: string
  ): Promise<MinecraftShopItemData | null>;
  getDb(): PurchaseDatabase;
  executeCommand(command: string): Promise<RconResult>;
}

const defaultDependencies: MinecraftPurchaseDependencies = {
  getAccount: getMinecraftAccountByDiscordId,
  getShopItem: getMinecraftShopItemById,
  getDb: () => getDatabase() as unknown as PurchaseDatabase,
  executeCommand: executeRconCommand,
};

export interface PurchaseResult {
  success: boolean;
  item?: MinecraftShopItemData;
  newBalance?: number;
  currentWallet?: number;
  reason?: string;
}

type DebitResult =
  | {
    success: true;
    newBalance: number;
    profileId: string;
    purchaseTransactionId: string;
  }
  | {
    success: false;
    reason: 'INSUFFICIENT_FUNDS';
    currentWallet: number;
  };

interface RefundRequest {
  guildId: string;
  userId: string;
  profileId: string;
  purchaseTransactionId: string;
  priceShekels: number;
  details: string;
}

function truncateAuditDetails(details: string): string {
  return details.slice(0, MAX_AUDIT_DETAILS_LENGTH);
}

function getPrismaErrorCode(error: unknown): string | null {
  if (!error || typeof error !== 'object' || !('code' in error)) return null;
  return typeof error.code === 'string' ? error.code : null;
}

async function runSerializableWithRetry<T>(
  db: PurchaseDatabase,
  operation: (tx: PurchaseTransactionClient) => Promise<T>
): Promise<T> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= DATABASE_RETRY_ATTEMPTS; attempt++) {
    try {
      return await db.$transaction(operation, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      });
    } catch (error) {
      lastError = error;
      if (attempt === DATABASE_RETRY_ATTEMPTS || getPrismaErrorCode(error) !== 'P2034') {
        throw error;
      }
    }
  }

  throw lastError;
}

async function debitWallet(
  db: PurchaseDatabase,
  guildId: string,
  userId: string,
  item: MinecraftShopItemData,
  minecraftUsername: string
): Promise<DebitResult> {
  return db.$transaction(async (tx): Promise<DebitResult> => {
    const profile = await tx.economyProfile.findUnique({
      where: { guildId_userId: { guildId, userId } },
      select: { id: true, wallet: true },
    });

    if (!profile) {
      return { success: false, reason: 'INSUFFICIENT_FUNDS', currentWallet: 0 };
    }

    // The balance predicate is part of the UPDATE itself. Two concurrent
    // purchases therefore cannot both spend the same wallet snapshot.
    const debit = await tx.economyProfile.updateMany({
      where: {
        id: profile.id,
        guildId,
        userId,
        wallet: { gte: item.priceShekels },
      },
      data: { wallet: { decrement: item.priceShekels } },
    });

    if (debit.count !== 1) {
      const current = await tx.economyProfile.findUnique({
        where: { guildId_userId: { guildId, userId } },
        select: { id: true, wallet: true },
      });
      return {
        success: false,
        reason: 'INSUFFICIENT_FUNDS',
        currentWallet: current?.wallet ?? 0,
      };
    }

    const updatedProfile = await tx.economyProfile.findUnique({
      where: { guildId_userId: { guildId, userId } },
      select: { id: true, wallet: true },
    });
    if (!updatedProfile) {
      throw new Error('Economy profile disappeared after Minecraft shop debit');
    }

    const purchaseAudit = await tx.economyTransaction.create({
      data: {
        guildId,
        userId,
        type: PURCHASE_PENDING,
        amount: -item.priceShekels,
        balance: updatedProfile.wallet,
        profileId: updatedProfile.id,
        targetId: item.id,
        details: truncateAuditDetails(
          `Minecraft purchase pending delivery: ${item.name} (${minecraftUsername})`
        ),
      },
    });

    return {
      success: true,
      newBalance: updatedProfile.wallet,
      profileId: updatedProfile.id,
      purchaseTransactionId: purchaseAudit.id,
    };
  });
}

/**
 * Refund is deliberately idempotent. If a database response is lost after a
 * successful commit, retrying observes the refund audit and does not credit the
 * wallet twice.
 */
async function compensateFailedDelivery(
  db: PurchaseDatabase,
  request: RefundRequest
): Promise<number> {
  return runSerializableWithRetry(db, async (tx) => {
    const existingRefund = await tx.economyTransaction.findFirst({
      where: {
        guildId: request.guildId,
        userId: request.userId,
        type: PURCHASE_REFUND,
        targetId: request.purchaseTransactionId,
      },
      select: { id: true, balance: true, type: true },
    });
    if (existingRefund) return existingRefund.balance;

    // Claim the pending audit in the same serializable transaction as the
    // credit. A completed purchase can never be refunded by this path.
    const claimed = await tx.economyTransaction.updateMany({
      where: {
        id: request.purchaseTransactionId,
        guildId: request.guildId,
        userId: request.userId,
        profileId: request.profileId,
        type: PURCHASE_PENDING,
      },
      data: {
        type: PURCHASE_FAILED,
        details: truncateAuditDetails(request.details),
      },
    });
    if (claimed.count !== 1) {
      throw new Error(
        `Minecraft purchase ${request.purchaseTransactionId} is not pending and cannot be refunded`
      );
    }

    const restoredProfile = await tx.economyProfile.update({
      where: {
        guildId_userId: {
          guildId: request.guildId,
          userId: request.userId,
        },
      },
      data: { wallet: { increment: request.priceShekels } },
      select: { id: true, wallet: true },
    });

    await tx.economyTransaction.create({
      data: {
        guildId: request.guildId,
        userId: request.userId,
        type: PURCHASE_REFUND,
        amount: request.priceShekels,
        balance: restoredProfile.wallet,
        profileId: request.profileId,
        targetId: request.purchaseTransactionId,
        details: truncateAuditDetails(
          `Automatic refund for failed Minecraft delivery: ${request.details}`
        ),
      },
    });

    return restoredProfile.wallet;
  });
}

async function markPurchaseDelivered(
  db: PurchaseDatabase,
  purchaseTransactionId: string,
  details: string
): Promise<void> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= DATABASE_RETRY_ATTEMPTS; attempt++) {
    try {
      const result = await db.economyTransaction.updateMany({
        where: { id: purchaseTransactionId, type: PURCHASE_PENDING },
        data: {
          type: PURCHASE_COMPLETED,
          details: truncateAuditDetails(details),
        },
      });
      if (result.count !== 1) {
        throw new Error(`Minecraft purchase ${purchaseTransactionId} was not pending`);
      }
      return;
    } catch (error) {
      lastError = error;
    }
  }

  // Delivery is already complete, so never tell the user it failed and invite
  // a duplicate purchase. The pending audit makes reconciliation possible.
  log.error(
    `Не удалось завершить аудит доставленной Minecraft-покупки ${purchaseTransactionId}`,
    lastError
  );
}

async function markPurchasePartiallyDelivered(
  db: PurchaseDatabase,
  purchaseTransactionId: string,
  details: string
): Promise<void> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= DATABASE_RETRY_ATTEMPTS; attempt++) {
    try {
      const result = await db.economyTransaction.updateMany({
        where: { id: purchaseTransactionId, type: PURCHASE_PENDING },
        data: {
          type: PURCHASE_PARTIAL,
          details: truncateAuditDetails(details),
        },
      });
      if (result.count !== 1) {
        throw new Error(`Minecraft purchase ${purchaseTransactionId} was not pending`);
      }
      return;
    } catch (error) {
      lastError = error;
    }
  }

  log.error(
    `КРИТИЧЕСКАЯ ОШИБКА: частичная Minecraft-покупка ${purchaseTransactionId} требует сверки аудита`,
    lastError,
    { deliveryError: details }
  );
}

function deliveryFailureDetails(
  item: MinecraftShopItemData,
  commandIndex: number,
  error: string
): string {
  return `Delivery failed for "${item.name}" at command ${commandIndex + 1}: ${error}`;
}

export async function purchaseMinecraftShopItem(
  guildId: string,
  member: GuildMember,
  itemId: string,
  dependencyOverrides: Partial<MinecraftPurchaseDependencies> = {}
): Promise<PurchaseResult> {
  const dependencies = { ...defaultDependencies, ...dependencyOverrides };
  const account = await dependencies.getAccount(guildId, member.id);
  if (!account || !account.isLinked) {
    return { success: false, reason: 'NOT_LINKED' };
  }

  const item = await dependencies.getShopItem(guildId, itemId);
  if (!item || !item.isActive) {
    return { success: false, reason: 'ITEM_NOT_FOUND' };
  }
  if (!isSafeMinecraftShopPrice(item.priceShekels)) {
    log.error(`Отклонена Minecraft-покупка товара ${item.id} с небезопасной ценой`);
    return { success: false, reason: 'INVALID_PRICE', item };
  }

  const commandPolicy = validateShopCommandTemplate(item.rconCommand);
  if (!commandPolicy.ok) {
    log.error(
      `Отклонена Minecraft-покупка товара ${item.id} с небезопасной командой доставки`,
      { policyReason: commandPolicy.reason }
    );
    return { success: false, reason: 'INVALID_DELIVERY', item };
  }
  const commands = commandPolicy.commands;

  const db = dependencies.getDb();
  let debit: DebitResult;

  try {
    debit = await debitWallet(db, guildId, member.id, item, account.minecraftUsername);
  } catch (error) {
    log.error(`Ошибка резервирования средств для Minecraft-товара ${itemId}`, error);
    return { success: false, reason: 'SYSTEM_ERROR', item };
  }

  if (!debit.success) {
    return {
      success: false,
      reason: debit.reason,
      item,
      currentWallet: debit.currentWallet,
    };
  }

  let failedDelivery: { commandIndex: number; error: string } | null = null;

  for (let commandIndex = 0; commandIndex < commands.length; commandIndex++) {
    const formattedCommand = commands[commandIndex].replace(
      /{username}/g,
      account.minecraftUsername
    );

    try {
      const result = await dependencies.executeCommand(formattedCommand);
      if (!result.success) {
        failedDelivery = {
          commandIndex,
          error: result.error ?? result.response ?? 'RCON returned an unsuccessful result',
        };
        break;
      }
    } catch (error) {
      failedDelivery = {
        commandIndex,
        error: error instanceof Error ? error.message : String(error),
      };
      break;
    }
  }

  if (failedDelivery) {
    const details = deliveryFailureDetails(
      item,
      failedDelivery.commandIndex,
      failedDelivery.error
    );

    // Some bundles contain several independent `give` commands. Refunding
    // after at least one successful command would let a player keep delivered
    // items for free. Preserve the charge and a durable reconciliation marker.
    if (failedDelivery.commandIndex > 0) {
      await markPurchasePartiallyDelivered(
        db,
        debit.purchaseTransactionId,
        `${details}; delivered commands: ${failedDelivery.commandIndex}/${commands.length}`
      );
      log.error(
        `Minecraft-покупка ${debit.purchaseTransactionId} доставлена частично и требует ручной сверки`,
        new Error(details)
      );
      return {
        success: false,
        reason: 'DELIVERY_PARTIAL',
        item,
        currentWallet: debit.newBalance,
      };
    }

    try {
      const restoredBalance = await compensateFailedDelivery(db, {
        guildId,
        userId: member.id,
        profileId: debit.profileId,
        purchaseTransactionId: debit.purchaseTransactionId,
        priceShekels: item.priceShekels,
        details,
      });
      log.error(
        `Minecraft-доставка товара ${item.id} не удалась; средства возвращены`,
        new Error(details)
      );
      return {
        success: false,
        reason: 'DELIVERY_FAILED',
        item,
        currentWallet: restoredBalance,
      };
    } catch (refundError) {
      log.error(
        `КРИТИЧЕСКАЯ ОШИБКА: возврат Minecraft-покупки ${debit.purchaseTransactionId} требует восстановления`,
        refundError,
        { deliveryError: details }
      );
      return {
        success: false,
        reason: 'REFUND_PENDING',
        item,
        currentWallet: debit.newBalance,
      };
    }
  }

  await markPurchaseDelivered(
    db,
    debit.purchaseTransactionId,
    `Minecraft purchase delivered: ${item.name} (${account.minecraftUsername})`
  );

  const announcePayload = JSON.stringify({
    text: `[EREZCRAFT] Вам доставлена покупка из Discord: ${item.name}!`,
    color: 'green',
  });
  const announceResult = await dependencies
    .executeCommand(`tellraw ${account.minecraftUsername} ${announcePayload}`)
    .catch((error: unknown) => ({
      success: false,
      error: error instanceof Error ? error.message : String(error),
    }));
  if (!announceResult.success) {
    log.warn(
      `Покупка ${debit.purchaseTransactionId} доставлена, но уведомление в игре не отправлено`,
      { rconError: announceResult.error }
    );
  }

  log.info(
    `Игрок ${account.minecraftUsername} (${member.id}) купил "${item.name}" за ${item.priceShekels} ₪`
  );

  return {
    success: true,
    item,
    newBalance: debit.newBalance,
  };
}
