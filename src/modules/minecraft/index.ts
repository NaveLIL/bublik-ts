import { BublikModule } from '../../types';
import mcCommand from './commands/mc';
import { startMinecraftStatusTracker, stopMinecraftStatusTracker } from './services/status-tracker';
import { startChatBridge, stopChatBridge } from './services/chat-bridge';
import { Events } from 'discord.js';
import { getDatabase } from '../../core/Database';
import { getMinecraftShopItems, getMinecraftAccountByDiscordId } from './database';
import {
  buildMinecraftShopEmbed,
  buildMinecraftShopComponents,
  buildMinecraftPurchaseReceiptEmbed,
} from './embeds';
import { purchaseMinecraftShopItem } from './services/economy-bridge';

let shopInteractionListener: ((...args: unknown[]) => void) | null = null;

const minecraftModule: BublikModule = {
  name: 'minecraft',
  descriptionKey: 'modules.minecraft.description',
  version: '1.0.0',
  author: 'NaveL',

  commands: [mcCommand],

  async onLoad(client) {
    client.logger.child('Module:minecraft').info('Модуль Minecraft (EREZCRAFT) загружен');
    await startMinecraftStatusTracker(client);
    await startChatBridge(client);

    shopInteractionListener = async (...args: unknown[]) => {
      const interaction = args[0] as any;
      if (!interaction || !interaction.isStringSelectMenu?.()) return;

      const { customId, guildId, member, user, values } = interaction;
      if (!guildId || !member) return;

      if (customId === 'mc_shop_category') {
        const category = values[0];
        await interaction.deferUpdate().catch(() => {});

        const db = getDatabase();
        const profile = await db.economyProfile.findUnique({
          where: { guildId_userId: { guildId, userId: user.id } },
        });
        const userWallet = profile?.wallet ?? 0;
        const items = await getMinecraftShopItems(guildId);

        const embed = buildMinecraftShopEmbed(items, userWallet, category);
        const components = buildMinecraftShopComponents(items, category);

        await interaction.editReply({ embeds: [embed], components }).catch(() => {});
        return;
      }

      if (customId === 'mc_shop_buy_select') {
        const itemId = values[0];
        if (itemId === 'none') return;

        await interaction.deferReply({ flags: 64 }).catch(() => {});

        const result = await purchaseMinecraftShopItem(guildId, member, itemId);

        if (!result.success) {
          let msg = '❌ Ошибка при покупке предмета.';
          if (result.reason === 'NOT_LINKED') {
            msg = '⚠️ Ваш Discord не привязан к Minecraft! Сначала привяжите аккаунт командой `/mc link username:<ник>`.';
          } else if (result.reason === 'ITEM_NOT_FOUND') {
            msg = '❌ Товар не найден или временно недоступен.';
          } else if (result.reason === 'INSUFFICIENT_FUNDS') {
            msg = `❌ Недостаточно Шекелей! Стоимость товара: **${result.item?.priceShekels.toLocaleString()}** ₪, ваш баланс: **${(result.currentWallet ?? 0).toLocaleString()}** ₪.`;
          }
          await interaction.editReply({ content: msg }).catch(() => {});
          return;
        }

        const account = await getMinecraftAccountByDiscordId(guildId, user.id);
        const embed = buildMinecraftPurchaseReceiptEmbed(result.item!, account!.minecraftUsername, result.newBalance!);
        await interaction.editReply({ embeds: [embed] }).catch(() => {});
        return;
      }
    };

    client.on(Events.InteractionCreate, shopInteractionListener as Parameters<typeof client.on>[1]);
  },

  async onUnload(client) {
    client.logger.child('Module:minecraft').info('Модуль Minecraft (EREZCRAFT) выгружен');
    stopMinecraftStatusTracker();
    stopChatBridge();
  },
};

export default minecraftModule;
