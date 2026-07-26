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
  buildMinecraftPurchaseFailureText,
} from './embeds';
import { purchaseMinecraftShopItem } from './services/economy-bridge';
import type { Client } from 'discord.js';
import { isMinecraftGuildEnabled } from './constants';

let shopInteractionListener: ((...args: unknown[]) => void) | null = null;
let shopInteractionClient: Client | null = null;

const minecraftModule: BublikModule = {
  name: 'minecraft',
  descriptionKey: 'modules.minecraft.description',
  version: '1.0.0',
  author: 'NaveLIL',

  commands: [mcCommand],

  async onLoad(client) {
    if (shopInteractionClient && shopInteractionListener) {
      shopInteractionClient.off(
        Events.InteractionCreate,
        shopInteractionListener as Parameters<typeof shopInteractionClient.off>[1]
      );
    }
    shopInteractionClient = null;
    shopInteractionListener = null;

    client.logger.child('Module:minecraft').info('Модуль Minecraft (EREZCRAFT) загружен');
    await startMinecraftStatusTracker(client);
    await startChatBridge(client);

    shopInteractionListener = async (...args: unknown[]) => {
      const interaction = args[0] as any;
      if (!interaction || !interaction.isStringSelectMenu?.()) return;

      const { customId, guildId, member, user, values } = interaction;
      if (!guildId || !member) return;
      if (!isMinecraftGuildEnabled(guildId)) return;

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
          await interaction
            .editReply({ content: buildMinecraftPurchaseFailureText(result) })
            .catch(() => {});
          return;
        }

        const account = await getMinecraftAccountByDiscordId(guildId, user.id);
        const embed = buildMinecraftPurchaseReceiptEmbed(result.item!, account!.minecraftUsername, result.newBalance!);
        await interaction.editReply({ embeds: [embed] }).catch(() => {});
        return;
      }
    };

    client.on(Events.InteractionCreate, shopInteractionListener as Parameters<typeof client.on>[1]);
    shopInteractionClient = client;
  },

  async onUnload(client) {
    client.logger.child('Module:minecraft').info('Модуль Minecraft (EREZCRAFT) выгружен');
    if (shopInteractionClient && shopInteractionListener) {
      shopInteractionClient.off(
        Events.InteractionCreate,
        shopInteractionListener as Parameters<typeof shopInteractionClient.off>[1]
      );
    }
    shopInteractionClient = null;
    shopInteractionListener = null;
    stopMinecraftStatusTracker();
    stopChatBridge();
  },
};

export default minecraftModule;
