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
//  Фазы 2–4 (будущее):
//  • Казино, магазин, ограбления, рыбалка, бизнесы
// ═══════════════════════════════════════════════

import { VoiceState } from 'discord.js';
import type { BublikClient } from '../../bot';
import { BublikModule } from '../../types';
import { logger } from '../../core/Logger';

import { handleVoiceUpdate, startVoiceTicker, stopVoiceTicker, cleanupVoiceTrackers } from './voice-tracker';

import economyCommand from './commands/economy';
import { balanceCommand, depositCommand, withdrawCommand, payCommand } from './commands/balance';
import { dailyCommand, weeklyCommand, workCommand, crimeCommand, begCommand } from './commands/earn';
import leaderboardCommand from './commands/leaderboard';

const log = logger.child('Module:economy');

const economyModule: BublikModule = {
  name: 'economy',
  descriptionKey: 'modules.economy.description',
  version: '1.0.0',
  author: 'NaveL',

  commands: [
    economyCommand,
    balanceCommand,
    depositCommand,
    withdrawCommand,
    payCommand,
    dailyCommand,
    weeklyCommand,
    workCommand,
    crimeCommand,
    begCommand,
    leaderboardCommand,
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
    } else {
      client.once('ready', () => {
        startVoiceTicker(client);
      });
    }
    log.info('Модуль экономики загружен ✓');
  },

  async onUnload(_client: BublikClient): Promise<void> {
    stopVoiceTicker();
    await cleanupVoiceTrackers();
    log.info('Модуль экономики выгружен');
  },
};

export default economyModule;
