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
} from 'discord.js';
import type { BublikClient } from '../../bot';
import { BublikModule } from '../../types';
import { logger } from '../../core/Logger';

import {
  handleVoiceStateUpdate,
  restoreSquads,
  startRoleIntegrityChecker,
  stopRoleIntegrityChecker,
  startPlayedResetScheduler,
  stopPlayedResetScheduler,
  clearLifecycleState,
} from './lifecycle';

import { handleRegBattleInteraction } from './handlers';
import { startPinger, stopPinger } from './pinger';
import { startReprimandExpiryChecker, stopReprimandExpiryChecker } from './reprimandScheduler';
import {
  beginOrdersMuteRuntime,
  startOrdersMuteRecovery,
  stopOrdersMuteRecovery,
} from './ordersMutes';
import { RB_PREFIX } from './constants';
import { isTransientInteractionError } from '../../utils/helpers';
import { drainScheduledTasksByPrefix } from '../../core/SchedulerManager';
import { ModuleBootController } from '../../core/ModuleLifecycle';
import { waitForTeamsVoiceIntegration } from './teamsVoiceResolver';

import regbattleCommand from './commands/regbattle';

const log = logger.child('Module:regbattle');
const runtimeBoot = new ModuleBootController();

const regbattleModule: BublikModule = {
  name: 'regbattle',
  descriptionKey: 'modules.regbattle.description',
  version: '1.0.0',
  author: 'NaveLIL',

  commands: [regbattleCommand],

  events: [
    {
      event: 'voiceStateUpdate',
      async execute(oldState: VoiceState, newState: VoiceState) {
        const client = newState.client as BublikClient;
        try {
          await handleVoiceStateUpdate(oldState, newState, client);
        } catch (err) {
          log.error('Ошибка voiceStateUpdate в regbattle', { error: String(err) });
        }
      },
    },
    {
      event: 'interactionCreate',
      async execute(interaction: Interaction) {
        // Кнопки, селекты, юзер-селекты и модальные окна с префиксом rb:
        if (
          (interaction.isButton() || interaction.isStringSelectMenu() ||
           interaction.isUserSelectMenu() || interaction.isModalSubmit()) &&
          interaction.customId.startsWith(RB_PREFIX + ':')
        ) {
          try {
            await handleRegBattleInteraction(interaction, interaction.client as BublikClient);
          } catch (err) {
            if (isTransientInteractionError(err)) return;
            log.error('Ошибка interactionCreate в regbattle', { error: String(err) });
          }
        }
      },
    },
  ],

  onLoad(client: BublikClient): void {
    beginOrdersMuteRuntime();
    runtimeBoot.start(client, async (isCurrent) => {
      if (!isCurrent()) return;
      if (!await waitForTeamsVoiceIntegration(client, isCurrent)) {
        log.warn('Teams runtime is unavailable; PB squad recovery will remain fail-closed');
      }
      if (!isCurrent()) return;
      await restoreSquads(client, isCurrent);
      if (!isCurrent()) return;
      startPinger(client);
      startRoleIntegrityChecker(client);
      startPlayedResetScheduler(client);
      startReprimandExpiryChecker(client);
      startOrdersMuteRecovery(client);
    }, (error: unknown) =>
      log.error('Не удалось запустить runtime RegBattle', { error: String(error) }));
    log.info('Модуль полковых боёв загружен ✓');
  },

  async onUnload(client: BublikClient): Promise<void> {
    const bootDrain = runtimeBoot.stopAndDrain();
    stopPinger();
    stopRoleIntegrityChecker();
    stopPlayedResetScheduler();
    stopReprimandExpiryChecker();
    const ordersDrain = stopOrdersMuteRecovery(client);
    if (!await bootDrain) {
      log.warn('Таймаут ожидания boot RegBattle; generation guard запретит поздний запуск задач');
    }
    if (!await ordersDrain) {
      log.warn('Таймаут остановки orders mute recovery; выгрузка RegBattle продолжена');
    }
    // A boot that was already past its final generation check may have started
    // tasks synchronously; stop once more before draining active handlers.
    stopPinger();
    stopRoleIntegrityChecker();
    stopPlayedResetScheduler();
    stopReprimandExpiryChecker();
    await drainScheduledTasksByPrefix('regbattle:');
    clearLifecycleState();
    log.info('Модуль полковых боёв выгружен');
  },
};

export default regbattleModule;
