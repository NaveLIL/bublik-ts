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

import { handleVoiceUpdate, startVoiceTicker, stopVoiceTicker, cleanupVoiceTrackers } from './voice-tracker';
import { startShopExpiryTicker, stopShopExpiryTicker } from './shop-expiry';

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

const log = logger.child('Module:economy');

const economyModule: BublikModule = {
  name: 'economy',
  descriptionKey: 'modules.economy.description',
  version: '2.0.0',
  author: 'NaveL',

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
  ],

  async onLoad(client: BublikClient): Promise<void> {
    if (client.isReady()) {
      startVoiceTicker(client);
      startShopExpiryTicker(client);
    } else {
      client.once('ready', () => {
        startVoiceTicker(client);
        startShopExpiryTicker(client);
      });
    }
    log.info('Модуль экономики v2.0.0 загружен ✓');
  },

  async onUnload(_client: BublikClient): Promise<void> {
    stopVoiceTicker();
    stopShopExpiryTicker();
    await cleanupVoiceTrackers();
    log.info('Модуль экономики выгружен');
  },
};

export default economyModule;
