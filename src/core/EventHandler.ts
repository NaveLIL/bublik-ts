import { Events, Interaction, Guild, Client, CloseEvent, TextChannel } from 'discord.js';
import type { BublikClient } from '../bot';
import { Config } from '../config';
import { logger } from './Logger';

const log = logger.child('Events');

/**
 * Проверяет, разрешена ли гильдия.
 * Если ALLOWED_GUILDS пуст — разрешены все.
 */
function isGuildAllowed(guildId: string): boolean {
  if (Config.allowedGuilds.length === 0) return true;
  return Config.allowedGuilds.includes(guildId);
}

/**
 * Покинуть гильдию, отправив прощальное сообщение в системный канал.
 */
async function leaveUnauthorizedGuild(guild: Guild): Promise<void> {
  log.warn(`Гильдия ${guild.name} (${guild.id}) не в whitelist — покидаю`);

  try {
    // Пытаемся отправить сообщение, чтобы владелец сервера понял почему бот ушёл
    const channel = guild.systemChannel ?? guild.channels.cache.find(
      (c) => c.isTextBased() && c.permissionsFor(guild.members.me!)?.has('SendMessages'),
    );

    if (channel && channel.isTextBased()) {
      await (channel as TextChannel).send({
        content:
          '⛔ **Этот бот является приватным и работает только на авторизованных серверах.**\n' +
          'Для получения доступа свяжитесь с владельцем бота.\n\n' +
          '*Бот покидает этот сервер.*',
      }).catch(() => {});
    }
  } catch {
    // Если не получилось — не страшно, главное уйти
  }

  await guild.leave();
  log.info(`Покинул неавторизованную гильдию: ${guild.name} (${guild.id})`);
}

/**
 * Регистрация ядровых event'ов бота.
 * Модульные event'ы обрабатываются через ModuleLoader.
 */
export function registerCoreEvents(client: BublikClient): void {
  // ── Ready ─────────────────────────────────
  client.once(Events.ClientReady, async (readyClient: Client<true>) => {
    log.info(`Бот ${readyClient.user.tag} запущен! Гильдий: ${readyClient.guilds.cache.size}`);

    // Проверяем все текущие гильдии — покидаем неразрешённые
    if (Config.allowedGuilds.length > 0) {
      for (const [, guild] of readyClient.guilds.cache) {
        if (!isGuildAllowed(guild.id)) {
          await leaveUnauthorizedGuild(guild);
        }
      }
    }

    // Синхронизируем команды
    await client.commandRegistry.syncGlobalCommands();
    await client.commandRegistry.syncGuildCommands();
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
      log.error('Ошибка обработки interaction', err as Error);
    }
  });

  // ── Новая гильдия — проверяем whitelist ────
  client.on(Events.GuildCreate, async (guild: Guild) => {
    log.info(`Добавлен в гильдию: ${guild.name} (${guild.id})`);

    if (!isGuildAllowed(guild.id)) {
      await leaveUnauthorizedGuild(guild);
      return;
    }

    await client.commandRegistry.syncGuildCommands(guild.id);
  });

  // ── Удаление из гильдии ────────────────────
  client.on(Events.GuildDelete, (guild: Guild) => {
    log.info(`Удалён из гильдии: ${guild.name} (${guild.id})`);
  });

  // ── Ошибки и предупреждения ────────────────
  client.on(Events.Error, (error: Error) => {
    log.error('Discord.js ошибка', error);
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
  });

  client.on(Events.ShardReconnecting, (id: number) => {
    log.info(`Shard ${id} переподключается…`);
  });

  client.on(Events.ShardError, (error: Error, id: number) => {
    log.error(`Shard ${id} ошибка`, error);
  });
}
