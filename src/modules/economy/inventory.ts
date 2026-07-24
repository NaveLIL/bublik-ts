import { getDatabase } from '../../core/Database';
import { invalidateProfileCache } from './database';

export interface InventoryItemData {
  id: string;
  guildId: string;
  userId: string;
  itemKey: string;
  name: string;
  type: string;
  quantity: number;
  description: string | null;
  perks: any;
  isCustom: boolean;
  creatorId: string | null;
  createdAt: Date;
}

/**
 * Получить инвентарь игрока
 */
export async function getInventory(guildId: string, userId: string): Promise<InventoryItemData[]> {
  const db = getDatabase();
  const items = await db.economyInventoryItem.findMany({
    where: { guildId, userId },
    orderBy: { createdAt: 'asc' },
  });
  return items.map(item => ({
    ...item,
    perks: item.perks ? (typeof item.perks === 'string' ? JSON.parse(item.perks) : item.perks) : null
  }));
}

/**
 * Проверить наличие предмета в инвентаре
 */
export async function hasInventoryItem(guildId: string, userId: string, itemKey: string, minQuantity: number = 1): Promise<boolean> {
  const db = getDatabase();
  const item = await db.economyInventoryItem.findUnique({
    where: { guildId_userId_itemKey: { guildId, userId, itemKey } }
  });
  return !!item && item.quantity >= minQuantity;
}

/**
 * Добавить предмет в инвентарь (Prisma Transaction Client)
 */
export async function addInventoryItem(
  tx: any,
  guildId: string,
  userId: string,
  itemKey: string,
  name: string,
  type: string,
  quantity: number,
  perks?: any,
  description?: string,
  isCustom: boolean = false,
  creatorId?: string,
): Promise<void> {
  const existing = await tx.economyInventoryItem.findUnique({
    where: { guildId_userId_itemKey: { guildId, userId, itemKey } }
  });

  if (existing) {
    await tx.economyInventoryItem.update({
      where: { guildId_userId_itemKey: { guildId, userId, itemKey } },
      data: { quantity: { increment: quantity } }
    });
  } else {
    await tx.economyInventoryItem.create({
      data: {
        guildId,
        userId,
        itemKey,
        name,
        type,
        quantity,
        description,
        perks: perks || undefined,
        isCustom,
        creatorId
      }
    });
  }
  await invalidateProfileCache(guildId, userId);
}

/**
 * Списать (потратить) предмет из инвентаря (Prisma Transaction Client)
 */
export async function consumeInventoryItem(
  tx: any,
  guildId: string,
  userId: string,
  itemKey: string,
  quantity: number = 1
): Promise<boolean> {
  const existing = await tx.economyInventoryItem.findUnique({
    where: { guildId_userId_itemKey: { guildId, userId, itemKey } }
  });

  if (!existing || existing.quantity < quantity) {
    return false;
  }

  if (existing.quantity === quantity) {
    await tx.economyInventoryItem.delete({
      where: { guildId_userId_itemKey: { guildId, userId, itemKey } }
    });
  } else {
    await tx.economyInventoryItem.update({
      where: { guildId_userId_itemKey: { guildId, userId, itemKey } },
      data: { quantity: { decrement: quantity } }
    });
  }

  await invalidateProfileCache(guildId, userId);
  return true;
}
