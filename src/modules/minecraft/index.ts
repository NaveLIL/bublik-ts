import {
  Interaction,
  MessageFlags,
} from 'discord.js';
import {
  BublikModule,
  ModuleEventHandler,
  ModuleExecutionGuard,
} from '../../types';
import { getDatabase } from '../../core/Database';
import { logger } from '../../core/Logger';
import mcCommand from './commands/mc';
import {
  startMinecraftStatusTracker,
  stopMinecraftStatusTracker,
} from './services/status-tracker';
import {
  startChatBridge,
  stopChatBridge,
} from './services/chat-bridge';
import {
  startRconService,
  stopRconService,
} from './services/rcon-service';
import {
  getMinecraftShopItems,
  getMinecraftAccountByDiscordId,
} from './database';
import {
  buildMinecraftShopEmbed,
  buildMinecraftShopComponents,
  buildMinecraftPurchaseReceiptEmbed,
  buildMinecraftPurchaseFailureText,
} from './embeds';
import { purchaseMinecraftShopItem } from './services/economy-bridge';
import {
  isMinecraftGuildEnabled,
  isMinecraftModuleConfigured,
} from './constants';

const log = logger.child('Module:minecraft');
const SHOP_CATEGORY_ID = 'mc_shop_category';
const SHOP_BUY_ID = 'mc_shop_buy_select';

async function replyWithInternalError(interaction: any): Promise<void> {
  const payload = {
    content: '❌ Не удалось обработать действие Minecraft-магазина. Попробуйте ещё раз.',
    components: [],
  };
  if (interaction.deferred || interaction.replied) {
    await interaction.editReply(payload).catch(() => undefined);
  } else {
    await interaction.reply({
      ...payload,
      flags: MessageFlags.Ephemeral,
    }).catch(() => undefined);
  }
}

export async function handleMinecraftShopInteraction(
  interaction: Interaction,
  guard?: ModuleExecutionGuard,
): Promise<void> {
  if (!interaction.isStringSelectMenu()) return;
  if (interaction.customId !== SHOP_CATEGORY_ID && interaction.customId !== SHOP_BUY_ID) return;
  if (!interaction.inCachedGuild()) return;

  const { guildId, member, user, values } = interaction;
  if (!isMinecraftGuildEnabled(guildId)) return;
  if (guard && !guard.isCurrent()) return;

  try {
    if (interaction.customId === SHOP_CATEGORY_ID) {
      await interaction.deferUpdate();
      if (guard && !guard.isCurrent()) return;

      const db = getDatabase();
      const [profile, items] = await Promise.all([
        db.economyProfile.findUnique({
          where: { guildId_userId: { guildId, userId: user.id } },
        }),
        getMinecraftShopItems(guildId),
      ]);
      if (guard && !guard.isCurrent()) return;

      const category = values[0];
      await interaction.editReply({
        embeds: [buildMinecraftShopEmbed(items, profile?.wallet ?? 0, category)],
        components: buildMinecraftShopComponents(items, category),
      });
      return;
    }

    const itemId = values[0];
    if (!itemId || itemId === 'none') return;

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    if (guard && !guard.isCurrent()) return;

    const result = await purchaseMinecraftShopItem(guildId, member, itemId);
    if (guard && !guard.isCurrent()) return;

    if (!result.success) {
      await interaction.editReply({
        content: buildMinecraftPurchaseFailureText(result),
      });
      return;
    }

    const account = await getMinecraftAccountByDiscordId(guildId, user.id);
    if (guard && !guard.isCurrent()) return;
    if (!account || result.newBalance === undefined || !result.item) {
      log.error('Minecraft-покупка завершена, но квитанция не может быть построена', {
        guildId,
        userId: user.id,
        itemId,
      });
      await replyWithInternalError(interaction);
      return;
    }

    await interaction.editReply({
      embeds: [
        buildMinecraftPurchaseReceiptEmbed(
          result.item,
          account.minecraftUsername,
          result.newBalance,
        ),
      ],
    });
  } catch (error) {
    log.error('Ошибка обработчика Minecraft-магазина', error);
    await replyWithInternalError(interaction);
  }
}

async function stopMinecraftRuntime(): Promise<void> {
  await Promise.all([
    stopChatBridge(),
    stopMinecraftStatusTracker(),
  ]);
  await stopRconService();
}

const shopInteractionEvent: ModuleEventHandler<'interactionCreate'> = {
  event: 'interactionCreate',
  async executeGuarded(guard, interaction) {
    await handleMinecraftShopInteraction(interaction, guard);
  },
};

const minecraftModule: BublikModule = {
  name: 'minecraft',
  descriptionKey: 'modules.minecraft.description',
  version: '1.1.0',
  author: 'NaveLIL',

  commands: [mcCommand],

  events: [shopInteractionEvent],

  async onLoadGuarded(client, guard) {
    const environment = process.env;
    if (!isMinecraftModuleConfigured(environment)) {
      await stopMinecraftRuntime();
      log.warn(
        'Модуль Minecraft отключён: требуется MINECRAFT_GUILD_ID '
        + 'и полная конфигурация RCON',
      );
      return;
    }

    startRconService();
    try {
      const statusStarted = await startMinecraftStatusTracker(
        client,
        environment,
        guard.signal,
      );
      guard.assertCurrent();
      const chatStarted = await startChatBridge(client, {
        environment,
        signal: guard.signal,
      });
      guard.assertCurrent();

      if (!statusStarted || !chatStarted) {
        throw new Error('MINECRAFT_RUNTIME_START_FAILED');
      }
      log.info('Модуль Minecraft (EREZCRAFT) загружен');
    } catch (error) {
      await stopMinecraftRuntime();
      throw error;
    }
  },

  async onUnloadGuarded(_client, _guard) {
    await stopMinecraftRuntime();
    log.info('Модуль Minecraft (EREZCRAFT) выгружен');
  },
};

export default minecraftModule;
