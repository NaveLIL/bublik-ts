import { Events, Interaction, Guild, Client, CloseEvent } from 'discord.js';
import type { BublikClient } from '../bot';
import { logger } from './Logger';
import { errorReporter, ErrorSeverity, ErrorCategory } from './ErrorReporter';

const log = logger.child('Events');

/**
 * Регистрация ядровых event'ов бота.
 * Модульные event'ы обрабатываются через ModuleLoader.
 */
export function registerCoreEvents(client: BublikClient): void {
  // ── Ready ─────────────────────────────────
  client.once(Events.ClientReady, async (readyClient: Client<true>) => {
    log.info(`Бот ${readyClient.user.tag} запущен! Гильдий: ${readyClient.guilds.cache.size}`);

    // Синхронизируем команды
    try {
      await client.commandRegistry.syncGlobalCommands();
      await client.commandRegistry.syncGuildCommands();
    } catch (err) {
      errorReporter.discordError(err, 'Ошибка синхронизации команд при запуске');
    }
  });

  // ── Interaction ───────────────────────────
  client.on(Events.InteractionCreate, async (interaction: Interaction) => {
    try {
      if (interaction.isChatInputCommand()) {
        await client.commandRegistry.handleCommand(interaction);
      } else if (interaction.isAutocomplete()) {
        await client.commandRegistry.handleAutocomplete(interaction);
      }
      // Кнопки, селекты и модалы обрабатываются через модули
    } catch (err) {
      log.error('Необработанная ошибка в InteractionCreate', err as Error);
      errorReporter.report({
        error: err,
        severity: ErrorSeverity.Medium,
        category: ErrorCategory.Event,
        source: 'InteractionCreate',
        userId: interaction.user?.id,
        guildId: interaction.guildId ?? undefined,
      });
    }
  });

  // ── Новая гильдия — регистрируем guild-команды ─
  client.on(Events.GuildCreate, async (guild: Guild) => {
    log.info(`Добавлен в гильдию: ${guild.name} (${guild.id})`);
    try {
      await client.commandRegistry.syncGuildCommands(guild.id);
    } catch (err) {
      errorReporter.discordError(err, `Ошибка синхронизации для гильдии ${guild.name} (${guild.id})`);
    }
  });

  // ── Удаление из гильдии ────────────────────
  client.on(Events.GuildDelete, (guild: Guild) => {
    log.info(`Удалён из гильдии: ${guild.name} (${guild.id})`);
  });

  // ── Ошибки и предупреждения ────────────────
  client.on(Events.Error, (error: Error) => {
    log.error('Discord.js ошибка', error);
    errorReporter.discordError(error, 'Discord.js Events.Error');
  });

  client.on(Events.Warn, (info: string) => {
    log.warn(`Discord.js предупреждение: ${info}`);
  });

  // ── Debug (только в dev) ───────────────────
  if (client.isDev) {
    client.on(Events.Debug, (info: string) => {
      // Фильтруем слишком шумные сообщения
      if (info.includes('Heartbeat')) return;
      log.debug(`Discord.js: ${info}`);
    });
  }

  // ── Shard events ───────────────────────────
  client.on(Events.ShardReady, (id: number) => {
    log.info(`Shard ${id} готов`);
  });

  client.on(Events.ShardDisconnect, (_event: CloseEvent, id: number) => {
    log.warn(`Shard ${id} отключён`);
    errorReporter.report({
      error: new Error(`Shard ${id} disconnected`),
      severity: ErrorSeverity.High,
      category: ErrorCategory.Discord,
      source: `Shard:${id}`,
      context: 'Shard отключён — ожидаем переподключение',
    });
  });

  client.on(Events.ShardReconnecting, (id: number) => {
    log.info(`Shard ${id} переподключается…`);
  });

  client.on(Events.ShardError, (error: Error, id: number) => {
    log.error(`Shard ${id} ошибка`, error);
    errorReporter.report({
      error,
      severity: ErrorSeverity.High,
      category: ErrorCategory.Discord,
      source: `Shard:${id}`,
      context: 'Ошибка shard',
    });
  });
}
