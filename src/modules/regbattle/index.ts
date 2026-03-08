// ═══════════════════════════════════════════════
//  Модуль: RegBattle — Полковые бои (ПБ)
//
//  Функционал:
//  • Мастер-канал: вход командира → создание отряда
//  • Панель управления (1 страница, 5 кнопок):
//    — Распоряжения (мьют 30с)
//    — Кик из войса
//    — Пинг в ЛС (DM + отчёт)
//    — Авиация (суб-канал, макс. 4 чел.)
//    — Передача прав
//  • Автоматические пинги (роли → именные → запасные)
//  • Ротация ролей (pingRole ↔ inSquadRole)
//  • Целостность ролей (периодическая проверка)
//  • Устойчивость к перезагрузке (всё в БД)
// ═══════════════════════════════════════════════

import {
  VoiceState,
  Interaction,
  ButtonInteraction,
  StringSelectMenuInteraction,
} from 'discord.js';
import type { BublikClient } from '../../bot';
import { BublikModule } from '../../types';
import { logger } from '../../core/Logger';

import {
  handleVoiceStateUpdate,
  restoreSquads,
  startRoleIntegrityChecker,
  stopRoleIntegrityChecker,
} from './lifecycle';

import { handleRegBattleInteraction } from './handlers';
import { startPinger, stopPinger } from './pinger';
import { RB_PREFIX } from './constants';

import regbattleCommand from './commands/regbattle';

const log = logger.child('Module:regbattle');

const regbattleModule: BublikModule = {
  name: 'regbattle',
  descriptionKey: 'modules.regbattle.description',
  version: '1.0.0',
  author: 'NaveL',

  commands: [regbattleCommand],

  events: [
    {
      event: 'voiceStateUpdate',
      async execute(oldState: VoiceState, newState: VoiceState) {
        const client = newState.client as BublikClient;
        await handleVoiceStateUpdate(oldState, newState, client);
      },
    },
    {
      event: 'interactionCreate',
      async execute(interaction: Interaction) {
        // Кнопки и селекты с префиксом rb:
        if (
          (interaction.isButton() || interaction.isStringSelectMenu()) &&
          interaction.customId.startsWith(RB_PREFIX + ':')
        ) {
          await handleRegBattleInteraction(interaction, interaction.client as BublikClient);
        }
      },
    },
  ],

  async onLoad(client: BublikClient): Promise<void> {
    if (client.isReady()) {
      await restoreSquads(client);
      startPinger(client);
      startRoleIntegrityChecker(client);
    } else {
      client.once('ready', async () => {
        await restoreSquads(client);
        startPinger(client);
        startRoleIntegrityChecker(client);
      });
    }
    log.info('Модуль полковых боёв загружен ✓');
  },

  async onUnload(client: BublikClient): Promise<void> {
    stopPinger();
    stopRoleIntegrityChecker();
    log.info('Модуль полковых боёв выгружен');
  },
};

export default regbattleModule;
