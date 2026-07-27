import { Events, Interaction, Guild, Client, CloseEvent, TextChannel } from 'discord.js';
import type { BublikClient } from '../bot';
import { logger } from './Logger';
import {
  enforceInteractionWhitelist,
  getWhitelistState,
  initWhitelist,
  isGuildAllowed,
  WhitelistState,
} from './Whitelist';
import {
  invalidateAllCompleteGuildMembers,
  invalidateCompleteGuildMembers,
} from './GuildMemberSnapshot';

const log = logger.child('Events');

/**
 * Покинуть гильдию, отправив прощальное сообщение в системный канал.
 */
export async function leaveUnauthorizedGuild(guild: Guild): Promise<void> {
  log.warn(`Гильдия ${guild.name} (${guild.id}) не в whitelist — покидаю`);

  try {
    // Пытаемся отправить сообщение, чтобы владелец сервера понял почему бот ушёл
    const me = guild.members.me;
    const channel = guild.systemChannel ?? (me
      ? guild.channels.cache.find(
        (c) => c.isTextBased() && c.permissionsFor(me)?.has('SendMessages'),
      )
      : null);

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

  try {
    await guild.leave();
    log.info(`Покинул неавторизованную гильдию: ${guild.name} (${guild.id})`);
  } catch (err) {
    log.error(`Не удалось покинуть неавторизованную гильдию: ${guild.name} (${guild.id})`, err as Error);
  }
}

/**
 * Регистрация ядровых event'ов бота.
 * Модульные event'ы обрабатываются через ModuleLoader.
 */
export function registerCoreEvents(client: BublikClient): void {
  // ── Ready ─────────────────────────────────
  client.once(Events.ClientReady, async (readyClient: Client<true>) => {
    invalidateAllCompleteGuildMembers();
    log.info(`Бот ${readyClient.user.tag} запущен! Гильдий: ${readyClient.guilds.cache.size}`);

    // Проверяем все текущие гильдии — покидаем неразрешённые
    try {
      if (getWhitelistState() !== WhitelistState.Ready) await initWhitelist();
      const unauthorized = [...readyClient.guilds.cache.values()].filter(
        (guild) => !isGuildAllowed(guild.id),
      );
      // Hide unauthorised guilds synchronously before other async ready
      // listeners/schedulers get a chance to iterate the client cache.
      for (const guild of unauthorized) readyClient.guilds.cache.delete(guild.id);
      for (const guild of unauthorized) {
        await leaveUnauthorizedGuild(guild);
      }

      // Синхронизируем оба scope; REST-ошибки не скрываются.
      await client.commandRegistry.syncAllCommands();
    } catch (err) {
      log.error('Ошибка в обработчике ready', err as Error);
    }
  });

  // ── Interaction ───────────────────────────
  client.on(Events.InteractionCreate, async (interaction: Interaction) => {
    try {
      if (!await enforceInteractionWhitelist(interaction)) return;

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
    invalidateCompleteGuildMembers(guild.id);
    log.info(`Добавлен в гильдию: ${guild.name} (${guild.id})`);

    try {
      if (getWhitelistState() !== WhitelistState.Ready) {
        await initWhitelist(true);
      }
      if (!isGuildAllowed(guild.id)) {
        await leaveUnauthorizedGuild(guild);
        return;
      }

      await client.commandRegistry.syncGuildCommands(guild.id);
    } catch (err) {
      log.error(`Ошибка обработки GuildCreate для ${guild.id}`, err as Error);
    }
  });

  // ── Удаление из гильдии ────────────────────
  client.on(Events.GuildDelete, (guild: Guild) => {
    invalidateCompleteGuildMembers(guild.id);
    log.info(`Удалён из гильдии: ${guild.name} (${guild.id})`);
  });

  // ── Ошибки и предупреждения ────────────────
  client.on(Events.GuildUnavailable, (guild: Guild) => {
    invalidateCompleteGuildMembers(guild.id);
  });

  client.on(Events.GuildAvailable, (guild: Guild) => {
    invalidateCompleteGuildMembers(guild.id);
  });

  client.on(Events.Invalidated, () => {
    invalidateAllCompleteGuildMembers();
  });

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
    invalidateAllCompleteGuildMembers();
    log.warn(`Shard ${id} отключён`);
  });

  client.on(Events.ShardReconnecting, (id: number) => {
    invalidateAllCompleteGuildMembers();
    log.info(`Shard ${id} переподключается…`);
  });

  client.on(Events.ShardError, (error: Error, id: number) => {
    log.error(`Shard ${id} ошибка`, error);
  });
}
