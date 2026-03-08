// ═══════════════════════════════════════════════
//  Модуль: TempVoice — Временные голосовые каналы
//
//  Функционал:
//  • Join-to-Create: зайди в генератор → получи личный канал
//  • Панель управления в текстовом чате VC (3 страницы)
//  • Уровни доступа: Owner, Moderator, Booster, Trusted, Normal, Blocked
//  • Lock / Hide / Rename / Limit / Bitrate / Region
//  • Trust / Block / Kick / Transfer / Invite / Claim
//  • Сохранение настроек пользователя
//  • Auto-delete пустых каналов, очистка неактивных
// ═══════════════════════════════════════════════

import {
  VoiceState,
  Interaction,
  ButtonInteraction,
  ModalSubmitInteraction,
} from 'discord.js';
import type { BublikClient } from '../../bot';
import { BublikModule } from '../../types';
import { logger } from '../../core/Logger';

import { handleVoiceStateUpdate, restoreChannels, startCleanupTimer, stopCleanupTimer } from './lifecycle';
import { handleTempVoiceButton, handleRenameModal, handleLimitModal } from './handlers';
import { stopRateLimitCleanup } from './utils';
import { TV_PREFIX } from './constants';

import voiceCommand from './commands/voice';

const log = logger.child('Module:tempvoice');

const tempvoiceModule: BublikModule = {
  name: 'tempvoice',
  descriptionKey: 'modules.tempvoice.description',
  version: '1.0.0',
  author: 'NaveL',

  commands: [voiceCommand],

  events: [
    // ── Создание / удаление каналов ──────────
    {
      event: 'voiceStateUpdate',
      async execute(oldState: VoiceState, newState: VoiceState) {
        // client передаётся через замыкание в onLoad
        const client = newState.client as BublikClient;
        await handleVoiceStateUpdate(oldState, newState, client);
      },
    },

    // ── Кнопки панели управления ─────────────
    {
      event: 'interactionCreate',
      async execute(interaction: Interaction) {
        // Кнопки
        if (interaction.isButton() && interaction.customId.startsWith(TV_PREFIX + ':')) {
          await handleTempVoiceButton(interaction as ButtonInteraction, interaction.client as BublikClient);
          return;
        }

        // Модальные окна (rename, limit)
        if (interaction.isModalSubmit() && interaction.customId.startsWith(TV_PREFIX + ':modal:')) {
          const modalType = interaction.customId.split(':')[2];
          switch (modalType) {
            case 'rename':
              await handleRenameModal(interaction as ModalSubmitInteraction);
              break;
            case 'limit':
              await handleLimitModal(interaction as ModalSubmitInteraction);
              break;
          }
        }
      },
    },
  ],

  async onLoad(client: BublikClient): Promise<void> {
    // Восстановить каналы при загрузке модуля
    // Ждём когда бот будет ready (каналы могут загружаться до ready)
    if (client.isReady()) {
      await restoreChannels(client);
      startCleanupTimer(client);
    } else {
      client.once('ready', async () => {
        await restoreChannels(client);
        startCleanupTimer(client);
      });
    }

    log.info('Модуль временных голосовых каналов загружен ✓');
  },

  async onUnload(client: BublikClient): Promise<void> {
    stopCleanupTimer();
    stopRateLimitCleanup();
    log.info('Модуль временных голосовых каналов выгружен');
  },
};

export default tempvoiceModule;
