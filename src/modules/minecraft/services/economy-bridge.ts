import { GuildMember } from 'discord.js';
import { getDatabase } from '../../../core/Database';
import {
  getMinecraftAccountByDiscordId,
  getMinecraftShopItemById,
  MinecraftShopItemData,
} from '../database';
import { executeRconCommand } from './rcon-service';
import { logger } from '../../../core/Logger';

const log = logger.child('Minecraft:EconomyBridge');

export interface PurchaseResult {
  success: boolean;
  item?: MinecraftShopItemData;
  newBalance?: number;
  currentWallet?: number;
  reason?: string;
}

export async function purchaseMinecraftShopItem(
  guildId: string,
  member: GuildMember,
  itemId: string
): Promise<PurchaseResult> {
  const account = await getMinecraftAccountByDiscordId(guildId, member.id);
  if (!account || !account.isLinked) {
    return { success: false, reason: 'NOT_LINKED' };
  }

  const item = await getMinecraftShopItemById(itemId);
  if (!item || !item.isActive) {
    return { success: false, reason: 'ITEM_NOT_FOUND' };
  }

  const db = getDatabase();

  try {
    const result = await db.$transaction(async (tx) => {
      const profile = await tx.economyProfile.findUnique({
        where: { guildId_userId: { guildId, userId: member.id } },
      });

      if (!profile || profile.wallet < item.priceShekels) {
        return { success: false, reason: 'INSUFFICIENT_FUNDS', currentWallet: profile?.wallet ?? 0 };
      }

      const updatedProfile = await tx.economyProfile.update({
        where: { guildId_userId: { guildId, userId: member.id } },
        data: { wallet: { decrement: item.priceShekels } },
      });

      await tx.economyTransaction.create({
        data: {
          guildId,
          userId: member.id,
          type: 'minecraft_shop_purchase',
          amount: -item.priceShekels,
          balance: updatedProfile.wallet,
          profileId: updatedProfile.id,
          targetId: item.id,
          details: `Покупка в Minecraft: ${item.name} (${account.minecraftUsername})`,
        },
      });

      return { success: true, newBalance: updatedProfile.wallet };
    });

    if (!result.success) {
      return { success: false, reason: result.reason, item, currentWallet: result.currentWallet };
    }

    // Execute delivery RCON command
    const formattedCommand = item.rconCommand.replace(/{username}/g, account.minecraftUsername);
    await executeRconCommand(formattedCommand);

    // Send in-game notification
    const announceMsg = `tellraw ${account.minecraftUsername} {"text":"[EREZCRAFT] 🎉 Вам доставлена покупка из Discord: ${item.name}!","color":"green"}`;
    await executeRconCommand(announceMsg).catch(() => {});

    log.info(`Игрок ${account.minecraftUsername} (${member.id}) купил "${item.name}" за ${item.priceShekels} ₪`);

    return {
      success: true,
      item,
      newBalance: result.newBalance,
    };
  } catch (err) {
    log.error(`Ошибка при обработке покупки товара ${itemId}`, err as Error);
    return { success: false, reason: 'SYSTEM_ERROR' };
  }
}
