// ═══════════════════════════════════════════════
//  Модуль: Economy — Экономика (шекели ₪)
//
//  Фаза 1:
//  • Кошелёк + Банк (лимит по PB-тиру)
//  • Заработок: /daily, /weekly, /work, /crime, /beg
//  • Голосовой пассивный доход (10-мин тикер)
//  • Переводы (/pay) с налогом
//  • Банк: /deposit, /withdraw с комиссией
//  • Лидерборд: /leaderboard
//  • Новостной канал (embed-ы о событиях)
//  • Anti-abuse: Redis-лок, Prisma-транзакции,
//    AFK-detection, min-presence, cooldowns через DateTime
//
//  Фаза 2:
//  • Казино: /coinflip, /slots, /dice, /blackjack
//  • Магазин ролей: /shop (list, buy, add, remove)
//  • Ограбления: /rob
//  • PB-роли: /economy roles
// ═══════════════════════════════════════════════

import { VoiceState } from 'discord.js';
import type { BublikClient } from '../../bot';
import { BublikModule } from '../../types';
import { logger } from '../../core/Logger';
import { drainScheduledTasksByPrefix } from '../../core/SchedulerManager';

import { handleVoiceUpdate, startVoiceTicker, stopVoiceTicker } from './voice-tracker';
import { startShopExpiryTicker, stopShopExpiryTicker } from './shop-expiry';
import { startAutoLeaderboard, stopAutoLeaderboard } from './auto-leaderboard';
import { startHeistScheduler, stopHeistScheduler, HEIST_BTN, handleJoinButton, handleCancelButton, handleStartButton } from './heist-engine';
import { startWantedScheduler, stopWantedScheduler } from './wanted';
import { startDeferredWantedScheduler, stopDeferredWantedScheduler } from './deferred-wanted';
import { startEconomyMaintenance, stopEconomyMaintenance } from './maintenance';
import { startMarketRecovery, stopMarketRecovery } from './market-recovery';
import { startCraftRecovery, stopCraftRecovery } from './craft-recovery';
import { ECO_SEP } from './constants';
import { activateEconomyCollectors, stopAllEconomyCollectors } from './collector-lifecycle';

import economyCommand from './commands/economy';
import { balanceCommand, depositCommand, withdrawCommand, payCommand } from './commands/balance';
import { dailyCommand, weeklyCommand, workCommand, crimeCommand, begCommand } from './commands/earn';
import leaderboardCommand from './commands/leaderboard';
import coinflipCommand from './commands/coinflip';
import slotsCommand from './commands/slots';
import diceCommand from './commands/dice';
import blackjackCommand from './commands/blackjack';
import robCommand from './commands/rob';
import shopCommand from './commands/shop';
import heistCommand from './commands/heist';
import wantedCommand from './commands/wanted';
import captureCommand from './commands/capture';
import launderCommand from './commands/launder';
import friskCommand from './commands/frisk';
import marketCommand, {
  MARKET_BTN,
  handleApproveButton,
  handleRejectButton,
  handleApproveModalSubmit,
  handleRejectModalSubmit,
} from './commands/market';
import { startRaidScheduler, stopRaidScheduler, handleRaidInteraction, handleRaidSabotageSelect } from './raid';
import raidCommand from './commands/raid';
import governmentCommand from './commands/government';
import inventoryCommand from './commands/inventory';
import craftCommand, {
  CRAFT_BTN,
  handleCraftApproveButton,
  handleCraftRejectButton,
  handleCraftRejectModalSubmit,
} from './commands/craft';
import blackMarketCommand, {
  BM_PREFIX,
  handleBmBuySelect,
  handleBmConfirmBuy,
  handleBmDealResponse,
  handleBmRaidChoice,
  startBlackMarketRecovery,
  stopBlackMarketRecovery,
} from './commands/blackmarket';

const log = logger.child('Module:economy');
const ECONOMY_TASK_PREFIX = 'economy:';
let runtimeGeneration = 0;
let readyClient: BublikClient | null = null;
let readyListener: (() => void) | null = null;

function detachReadyListener(): void {
  if (readyClient && readyListener) readyClient.off('ready', readyListener);
  readyClient = null;
  readyListener = null;
}

function startEconomyRuntime(client: BublikClient): void {
  startVoiceTicker(client);
  startShopExpiryTicker(client);
  startAutoLeaderboard(client);
  startHeistScheduler(client);
  startWantedScheduler();
  startDeferredWantedScheduler();
  startEconomyMaintenance();
  startMarketRecovery(client);
  startCraftRecovery(client);
  startBlackMarketRecovery(client);
  startRaidScheduler(client);
}

async function stopEconomyRuntime(): Promise<void> {
  const voiceStop = stopVoiceTicker();
  stopShopExpiryTicker();
  stopAutoLeaderboard();
  stopHeistScheduler();
  stopWantedScheduler();
  stopDeferredWantedScheduler();
  stopEconomyMaintenance();
  stopMarketRecovery();
  stopCraftRecovery();
  stopBlackMarketRecovery();
  stopRaidScheduler();
  await voiceStop;
}

const economyModule: BublikModule = {
  name: 'economy',
  descriptionKey: 'modules.economy.description',
  version: '2.0.0',
  author: 'NaveLIL',

  commands: [
    // Админка
    economyCommand,
    // Баланс
    balanceCommand,
    depositCommand,
    withdrawCommand,
    payCommand,
    // Заработок
    dailyCommand,
    weeklyCommand,
    workCommand,
    crimeCommand,
    begCommand,
    // Лидерборд
    leaderboardCommand,
    // Казино
    coinflipCommand,
    slotsCommand,
    diceCommand,
    blackjackCommand,
    // PvP
    robCommand,
    // Магазин
    shopCommand,
    // Heist + Wanted
    heistCommand,
    wantedCommand,
    captureCommand,
    friskCommand,
    // Грязные деньги
    launderCommand,
    // Маркетплейс игроков
    marketCommand,
    // Штурм сейфа
    raidCommand,
    // Мэрия / Казна
    governmentCommand,
    // Инвентарь
    inventoryCommand,
    // Крафт
    craftCommand,
    // Черный рынок
    blackMarketCommand,
  ],

  events: [
    {
      event: 'voiceStateUpdate',
      async execute(oldState: VoiceState, newState: VoiceState) {
        try {
          await handleVoiceUpdate(oldState, newState);
        } catch (err) {
          log.error('Economy voiceStateUpdate error', err);
        }
      },
    },
    {
      event: 'interactionCreate',
      async execute(interaction: any) {
        try {
          if (!interaction?.isButton?.()) return;
          const customId: string = interaction.customId || '';
          if (!customId.startsWith(`${HEIST_BTN}${ECO_SEP}`)) return;

          const parts = customId.split(ECO_SEP);
          // eco:heist:<action>:<heistId>
          const action = parts[2];
          const heistId = parts[3];
          if (!heistId) return;

          if (action === 'join') await handleJoinButton(interaction, heistId);
          else if (action === 'cancel') await handleCancelButton(interaction, heistId);
          else if (action === 'start') await handleStartButton(interaction, heistId);
        } catch (err) {
          log.error('Economy heist button error', err);
        }
      },
    },
    {
      event: 'interactionCreate',
      async execute(interaction: any) {
        try {
          const customId: string = interaction?.customId ?? '';
          if (!customId.startsWith(`${MARKET_BTN}${ECO_SEP}`)) return;

          // eco:market:<action>:<requestId>
          const parts = customId.split(ECO_SEP);
          const action = parts[2];
          const reqId = parts[3];
          if (!reqId) return;

          if (interaction.isButton?.()) {
            if (action === 'approve') await handleApproveButton(interaction, reqId);
            else if (action === 'reject') await handleRejectButton(interaction, reqId);
          } else if (interaction.isModalSubmit?.()) {
            const client = interaction.client;
            if (action === 'approve_form') await handleApproveModalSubmit(interaction, reqId, client);
            else if (action === 'reject_form') await handleRejectModalSubmit(interaction, reqId, client);
          }
        } catch (err) {
          log.error('Economy market interaction error', err);
        }
      },
    },
    {
      event: 'interactionCreate',
      async execute(interaction: any) {
        try {
          const customId: string = interaction?.customId ?? '';
          if (!customId.startsWith(`${CRAFT_BTN}:`)) return;

          // eco:craft:<action>:<requestId>
          const parts = customId.split(':');
          const action = parts[2];
          const reqId = parts[3];
          if (!reqId) return;

          if (interaction.isButton?.()) {
            if (action === 'approve') await handleCraftApproveButton(interaction, reqId);
            else if (action === 'reject') await handleCraftRejectButton(interaction, reqId);
          } else if (interaction.isModalSubmit?.()) {
            if (action === 'reject_form') await handleCraftRejectModalSubmit(interaction, reqId);
          }
        } catch (err) {
          log.error('Economy craft interaction error', err);
        }
      },
    },
    {
      event: 'interactionCreate',
      async execute(interaction: any) {
        try {
          if (interaction.isStringSelectMenu() && interaction.customId === 'bm_buy_select') {
            await handleBmBuySelect(interaction);
            return;
          }

          const customId: string = interaction?.customId ?? '';
          if (!customId.startsWith(`${BM_PREFIX}:`)) return;

          // eco:bm:<action>:<arg1>:<arg2>:<arg3>
          const parts = customId.split(':');
          const action = parts[2];

          if (action === 'confirm_buy') {
            // eco:bm:confirm_buy:<actionType>:<buyerId>:<listingId>:<price>
            const actionType = parts[3];
            if (actionType === 'cancel') {
              await handleBmConfirmBuy(interaction, 'cancel', '', '', '');
            } else {
              const buyerId = parts[4];
              const listingId = parts[5];
              const price = parts[6];
              await handleBmConfirmBuy(interaction, 'normal', buyerId, listingId, price);
            }
          } else if (action === 'deal') {
            // eco:bm:deal:<action>:<buyerOrCopId>:<listingId>:<price>
            const dealAction = parts[3];
            const buyerOrCopId = parts[4];
            const listingId = parts[5];
            const price = parts[6];
            if ((dealAction === 'accept' || dealAction === 'reject') && buyerOrCopId && listingId) {
              await handleBmDealResponse(interaction, dealAction, buyerOrCopId, listingId, price);
            }
          } else if (action === 'raid_choice') {
            // eco:bm:raid_choice:<role>:<choice>:<listingId>
            const role = parts[3];
            const choice = parts[4];
            const listingId = parts[5];
            await handleBmRaidChoice(interaction, role as any, choice, listingId);
          } else if (action === 'list') {
            // eco:bm:list:<page>
            const page = parseInt(parts[3] || '1', 10);
            const { handleBmListPagination } = await import('./commands/blackmarket');
            await handleBmListPagination(interaction, page);
          }
        } catch (err) {
          log.error('Economy blackmarket interaction error', err);
        }
      },
    },
    {
      event: 'interactionCreate',
      async execute(interaction: any) {
        try {
          if (interaction.isButton?.()) {
            const customId: string = interaction.customId || '';
            if (customId.startsWith('raid:')) {
              await handleRaidInteraction(interaction);
            }
          } else if (interaction.isUserSelectMenu?.()) {
            const customId: string = interaction.customId || '';
            if (customId.startsWith('raid:sabotage_select:')) {
              await handleRaidSabotageSelect(interaction);
            }
          }
        } catch (err) {
          log.error('Economy raid interaction error', err);
        }
      },
    },
    {
      event: 'interactionCreate',
      async execute(interaction: any) {
        try {
          if (!interaction.isButton?.()) return;
          const customId: string = interaction.customId || '';
          if (!customId.startsWith('eco:shop:list:')) return;

          const parts = customId.split(':');
          const page = parseInt(parts[3] || '1', 10);
          const { handleShopListPagination } = await import('./commands/shop');
          await handleShopListPagination(interaction, page);
        } catch (err) {
          log.error('Economy shop list pagination button error', err);
        }
      },
    },
    {
      event: 'interactionCreate',
      async execute(interaction: any) {
        try {
          if (!interaction.isStringSelectMenu?.()) return;
          const customId: string = interaction.customId || '';
          if (customId !== 'eco:shop:buy_select') return;

          const value = interaction.values[0];
          const { handleShopBuySelect } = await import('./commands/shop');
          await handleShopBuySelect(interaction, value);
        } catch (err) {
          log.error('Economy shop buy select interaction error', err);
        }
      },
    },
  ],

  async onLoad(client: BublikClient): Promise<void> {
    detachReadyListener();
    const generation = ++runtimeGeneration;
    activateEconomyCollectors();

    const boot = (): void => {
      detachReadyListener();
      if (generation !== runtimeGeneration) return;
      startEconomyRuntime(client);
    };

    if (client.isReady()) {
      boot();
    } else {
      readyClient = client;
      readyListener = boot;
      client.once('ready', boot);
    }
    log.info('Модуль экономики v2.0.0 загружен ✓');
  },

  async onUnload(_client: BublikClient): Promise<void> {
    runtimeGeneration++;
    detachReadyListener();
    stopAllEconomyCollectors();
    await stopEconomyRuntime();
    // Deliberately unbounded: ModuleLoader owns the public timeout and keeps
    // this legacy generation quarantined until every old economy tick settles.
    await drainScheduledTasksByPrefix(ECONOMY_TASK_PREFIX);
    // A settling recovery pass can have populated module-owned timeout maps or
    // installed a non-immediate dynamic task. Cancel that late state as well.
    await stopEconomyRuntime();
    await drainScheduledTasksByPrefix(ECONOMY_TASK_PREFIX);
    log.info('Модуль экономики выгружен');
  },
};

export default economyModule;
