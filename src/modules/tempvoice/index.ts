// ═══════════════════════════════════════════════
//  Модуль: TempVoice — Временные голосовые каналы
//
//  Функционал:
//  • Join-to-Create: зайди в генератор → получи личный канал
//  • Панель управления в текстовом чате VC (3 страницы)
//  • Уровни доступа: Owner, Moderator, Reward, Booster, Trusted, Normal, Blocked
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
  DMChannel,
  NonThreadGuildBasedChannel,
} from 'discord.js';
import type { BublikClient } from '../../bot';
import { BublikModule } from '../../types';
import { logger } from '../../core/Logger';

import {
  handleVoiceStateUpdate,
  handleTempChannelDelete,
  restoreChannels,
  startCleanupTimer,
  stopCleanupTimer,
} from './lifecycle';
import { handleTempVoiceButton, handleRenameModal, handleLimitModal } from './handlers';
import { startRateLimitCleanup, stopRateLimitCleanup } from './utils';
import { TV_PREFIX } from './constants';
import {
  queueAllTrackedPermissionAudits,
  recoverPermissionSyncIntents,
  startPermissionSyncRecovery,
  stopPermissionSyncRecovery,
} from './permissionSync';

import voiceCommand from './commands/voice';
import { recoverTempVoiceCreationIntents } from './creationRecovery';
import { drainScheduledTasksByPrefix } from '../../core/SchedulerManager';
import { ModuleBootController } from '../../core/ModuleLifecycle';

const log = logger.child('Module:tempvoice');
const runtimeBoot = new ModuleBootController();

async function startRuntime(client: BublikClient, isCurrent: () => boolean): Promise<void> {
  if (!isCurrent()) return;
  await recoverTempVoiceCreationIntents(client).catch((error: unknown) => {
    log.warn('Начальное восстановление TempVoice creation intents будет повторено', { error: String(error) });
  });
  if (!isCurrent()) return;
  await restoreChannels(client, isCurrent);
  if (!isCurrent()) return;
  try {
    await queueAllTrackedPermissionAudits(client);
    if (!isCurrent()) return;
    await recoverPermissionSyncIntents(client);
  } catch (error) {
    // The periodic worker starts even when the first database/Discord pass is
    // temporarily unavailable, so durable intents are not stranded.
    log.warn('Начальная синхронизация прав TempVoice будет повторена', { error: String(error) });
  }
  if (!isCurrent()) return;
  startPermissionSyncRecovery(client);
  startCleanupTimer(client);
}

const tempvoiceModule: BublikModule = {
  name: 'tempvoice',
  descriptionKey: 'modules.tempvoice.description',
  version: '1.0.0',
  author: 'NaveLIL',

  commands: [voiceCommand],

  events: [
    // ── Создание / удаление каналов ──────────
    {
      event: 'voiceStateUpdate',
      async execute(oldState: VoiceState, newState: VoiceState) {
        // client передаётся через замыкание в onLoad
        const client = newState.client as BublikClient;
        try {
          await handleVoiceStateUpdate(oldState, newState, client);
        } catch (err) {
          log.error('Ошибка voiceStateUpdate в tempvoice', { error: String(err) });
        }
      },
    },
    {
      event: 'channelDelete',
      async execute(channel: DMChannel | NonThreadGuildBasedChannel) {
        try {
          await handleTempChannelDelete(channel.id);
        } catch (err) {
          log.error('Ошибка очистки удалённого tempvoice-канала', { error: String(err) });
        }
      },
    },

    // ── Кнопки панели управления ─────────────
    {
      event: 'interactionCreate',
      async execute(interaction: Interaction) {
        // Кнопки
        if (interaction.isButton() && interaction.customId.startsWith(TV_PREFIX + ':')) {
          try {
            await handleTempVoiceButton(interaction as ButtonInteraction, interaction.client as BublikClient);
          } catch (err) {
            log.error('Ошибка обработки кнопки tempvoice', { error: String(err) });
          }
          return;
        }

        // Модальные окна (rename, limit)
        if (interaction.isModalSubmit() && interaction.customId.startsWith(TV_PREFIX + ':modal:')) {
          const modalType = interaction.customId.split(':')[2];
          try {
            switch (modalType) {
              case 'rename':
                await handleRenameModal(interaction as ModalSubmitInteraction);
                break;
              case 'limit':
                await handleLimitModal(interaction as ModalSubmitInteraction);
                break;
            }
          } catch (err) {
            log.error('Ошибка обработки модального окна tempvoice', { error: String(err) });
          }
        }
      },
    },
  ],

  onLoad(client: BublikClient): void {
    // Keep runtime timers bound to the module lifecycle. Utility imports are
    // also used by recovery code and unit tests and must remain side-effect free.
    startRateLimitCleanup();
    runtimeBoot.start(
      client,
      (isCurrent) => startRuntime(client, isCurrent),
      (error: unknown) => {
        log.error('Не удалось запустить runtime TempVoice', { error: String(error) });
      },
    );

    log.info('Модуль временных голосовых каналов загружен ✓');
  },

  async onUnload(_client: BublikClient): Promise<void> {
    const bootDrain = runtimeBoot.stopAndDrain();
    stopPermissionSyncRecovery();
    stopCleanupTimer();
    stopRateLimitCleanup();
    if (!await bootDrain) {
      log.warn('Таймаут ожидания boot TempVoice; generation guard запретит поздний запуск задач');
    }
    stopPermissionSyncRecovery();
    stopCleanupTimer();
    stopRateLimitCleanup();
    await drainScheduledTasksByPrefix('tempvoice:');
    log.info('Модуль временных голосовых каналов выгружен');
  },
};

export default tempvoiceModule;
