// ═══════════════════════════════════════════════
//  Модуль: Vacation — Система управления отпусками
//
//  Функционал:
//  • Панель с кнопками: Уйти / Вернуться / Не смогу сегодня
//  • Заявки на отпуск с одобрением/отклонением
//  • Автоматическое снятие/восстановление ролей
//  • Прайм-тайм ограничения
//  • Автоотклонение через 3ч, напоминание за 24ч
//  • Быстрый отпуск без подтверждений
//  • Админская команда (обход прайм-тайма)
//  • Database-backed шедулер (не теряет таймеры)
// ═══════════════════════════════════════════════

import { Interaction } from 'discord.js';
import type { BublikClient } from '../../bot';
import { BublikModule } from '../../types';
import { logger } from '../../core/Logger';

import { handleVacationInteraction } from './handlers';
import { startScheduler, stopScheduler } from './scheduler';
import { VAC_PREFIX } from './constants';
import { drainScheduledTasksByPrefix } from '../../core/SchedulerManager';

import vacationCommand from './commands/vacation';

const log = logger.child('Module:vacation');
const VACATION_TASK_PREFIX = 'vacation:';
let runtimeGeneration = 0;
let readyListener: (() => void) | null = null;

const vacationModule: BublikModule = {
  name: 'vacation',
  descriptionKey: 'modules.vacation.description',
  version: '1.0.0',
  author: 'NaveLIL',

  commands: [vacationCommand],

  events: [
    {
      event: 'interactionCreate',
      async execute(interaction: Interaction) {
        // Фильтрация по префиксу
        const customId =
          (interaction.isButton() && interaction.customId) ||
          (interaction.isStringSelectMenu() && interaction.customId) ||
          (interaction.isModalSubmit() && interaction.customId) ||
          '';

        if (!customId.startsWith(VAC_PREFIX + ':')) return;

        await handleVacationInteraction(interaction, interaction.client as BublikClient);
      },
    },
  ],

  async onLoad(client: BublikClient): Promise<void> {
    const generation = ++runtimeGeneration;
    const boot = (): void => {
      readyListener = null;
      if (generation !== runtimeGeneration) return;
      startScheduler(client);
    };
    if (client.isReady()) {
      boot();
    } else {
      readyListener = boot;
      client.once('ready', readyListener);
    }

    log.info('Модуль системы отпусков загружен ✓');
  },

  async onUnload(client: BublikClient): Promise<void> {
    runtimeGeneration++;
    if (readyListener) {
      client.off('ready', readyListener);
      readyListener = null;
    }
    stopScheduler();
    // Do not couple vacation reloads to unrelated modules. The unbounded
    // module-owned drain lets ModuleLoader quarantine this legacy generation.
    await drainScheduledTasksByPrefix(VACATION_TASK_PREFIX);
    log.info('Модуль системы отпусков выгружен');
  },
};

export default vacationModule;
