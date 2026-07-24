// ═══════════════════════════════════════════════
//  Модуль: Teams — Командная система ПБ
//
//  Функционал:
//  • Создание команд с инвайтами в ЛС
//  • Система одобрения заявок
//  • Управление командой (лидер): кик, инвайт, передача, расформирование
//  • Интеграция с голосовыми каналами RegBattle
//  • Опросы/сборы (ручные + автоматические)
//  • Отчёты после ПБ-сессий (PR, место)
//  • Сезонная статистика и лидерборд
// ═══════════════════════════════════════════════

import { Interaction } from 'discord.js';
import type { BublikClient } from '../../bot';
import { BublikModule } from '../../types';
import { logger } from '../../core/Logger';
import { isTransientInteractionError } from '../../utils/helpers';

import { TM_PREFIX } from './constants';
import { handleTeamInteraction } from './handlers';
import { clearPendingSelections, startInviteExpiryChecker, stopInviteExpiryChecker } from './creation';
import { startDisbandChecker, stopDisbandChecker } from './management';
import { startAutoPollChecker, stopAutoPollChecker } from './polls';
import { startReportReminderChecker, stopReportReminderChecker } from './reports';
import { startLeaderboardUpdater, stopLeaderboardUpdater } from './statistics';
import {
  clearVoiceState,
  restoreSquadTeamMap,
  startVoiceIntegrationMaintenance,
  stopVoiceIntegrationMaintenance,
} from './voiceIntegration';
import { drainScheduledTasksByPrefix } from '../../core/SchedulerManager';
import { ModuleBootController } from '../../core/ModuleLifecycle';

import teamCommand from './commands/team';

const log = logger.child('Module:teams');
const runtimeBoot = new ModuleBootController();

const teamsModule: BublikModule = {
  name: 'teams',
  descriptionKey: 'modules.teams.description',
  version: '1.0.0',
  author: 'NaveLIL',

  commands: [teamCommand],

  events: [
    {
      event: 'interactionCreate',
      async execute(interaction: Interaction) {
        // Кнопки, селекты, юзер-селекты и модальные окна с префиксом tm:
        if (
          (interaction.isButton() || interaction.isStringSelectMenu() ||
           interaction.isUserSelectMenu() || interaction.isModalSubmit()) &&
          interaction.customId.startsWith(TM_PREFIX + ':')
        ) {
          try {
            await handleTeamInteraction(interaction, interaction.client as BublikClient);
          } catch (err) {
            if (isTransientInteractionError(err)) return;
            log.error('Ошибка interactionCreate в teams', { error: String(err) });
          }
        }
      },
    },
  ],

  onLoad(client: BublikClient): void {
    runtimeBoot.start(client, async (isCurrent) => {
      if (!isCurrent()) return;
      // Independent DB checkers must not wait behind a potentially long
      // Discord/Redis voice-permission recovery pass.
      startInviteExpiryChecker(client);
      startDisbandChecker(client);
      startAutoPollChecker(client);
      startReportReminderChecker(client);
      startLeaderboardUpdater(client);
      await restoreSquadTeamMap(client, isCurrent).catch((error: unknown) =>
        log.warn('Teams voice recovery deferred to maintenance', { error: String(error) }));
      if (!isCurrent()) return;
      startVoiceIntegrationMaintenance(client, isCurrent);
    }, (error: unknown) =>
      log.error('Не удалось запустить runtime Teams', { error: String(error) }));
    log.info('Модуль команд загружен ✓');
  },

  async onUnload(_client: BublikClient): Promise<void> {
    const bootDrain = runtimeBoot.stopAndDrain();
    stopVoiceIntegrationMaintenance();
    stopInviteExpiryChecker();
    stopDisbandChecker();
    stopAutoPollChecker();
    stopReportReminderChecker();
    stopLeaderboardUpdater();
    if (!await bootDrain) {
      log.warn('Таймаут ожидания boot Teams; generation guard запретит поздний запуск задач');
    }
    stopVoiceIntegrationMaintenance();
    stopInviteExpiryChecker();
    stopDisbandChecker();
    stopAutoPollChecker();
    stopReportReminderChecker();
    stopLeaderboardUpdater();
    await drainScheduledTasksByPrefix('teams:');
    clearPendingSelections();
    clearVoiceState();
    log.info('Модуль команд выгружен');
  },
};

export default teamsModule;
