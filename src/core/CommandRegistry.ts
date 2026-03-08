import {
  REST,
  Routes,
  Collection,
  ChatInputCommandInteraction,
  AutocompleteInteraction,
} from 'discord.js';
import { Config } from '../config';
import { logger } from './Logger';
import { BublikCommand, CommandScope } from '../types';
import type { BublikClient } from '../bot';
import { i18n } from './I18n';
import { errorReporter } from './ErrorReporter';
import { BublikEmbed } from './EmbedBuilder';

const log = logger.child('CommandRegistry');

interface RegisteredCommand {
  command: BublikCommand;
  moduleName: string;
}

/**
 * Реестр slash-команд.
 * - Глобальные команды регистрируются один раз через REST API
 * - Гильдийные команды регистрируются для каждой гильдии
 * - Кулдауны отслеживаются здесь
 */
export class CommandRegistry {
  private commands = new Collection<string, RegisteredCommand>();
  private cooldowns = new Collection<string, Collection<string, number>>();
  private client: BublikClient;
  private rest: REST;

  constructor(client: BublikClient) {
    this.client = client;
    this.rest = new REST({ version: '10' }).setToken(Config.token);
  }

  // ── Регистрация / Удаление ─────────────────

  register(command: BublikCommand, moduleName: string): void {
    const name = command.data.name;

    if (this.commands.has(name)) {
      log.warn(`Команда "/${name}" уже зарегистрирована — перезаписываем`);
    }

    this.commands.set(name, { command, moduleName });
    log.debug(`Команда "/${name}" зарегистрирована (${command.scope}, модуль: ${moduleName})`);
  }

  unregister(name: string): void {
    this.commands.delete(name);
    this.cooldowns.delete(name);
    log.debug(`Команда "/${name}" удалена из реестра`);
  }

  // ── Синхронизация с Discord API ────────────

  /** Зарегистрировать глобальные команды (вызывается один раз при старте) */
  async syncGlobalCommands(): Promise<void> {
    const globalCmds = this.commands.filter((r) => r.command.scope === CommandScope.Global);

    if (globalCmds.size === 0) {
      log.info('Глобальных команд нет');
      return;
    }

    const body = globalCmds.map((r) => r.command.data.toJSON());

    try {
      log.info(`Синхронизация ${body.length} глобальных команд…`);
      await this.rest.put(Routes.applicationCommands(Config.clientId), { body });
      log.info(`✓ Глобальные команды синхронизированы (${body.length})`);
    } catch (err) {
      log.error('Ошибка синхронизации глобальных команд', err);
    }
  }

  /** Зарегистрировать гильдийные команды */
  async syncGuildCommands(guildId?: string): Promise<void> {
    const guildCmds = this.commands.filter((r) => r.command.scope === CommandScope.Guild);

    if (guildCmds.size === 0) return;

    const body = guildCmds.map((r) => r.command.data.toJSON());

    // Если указан DEV_GUILD_ID — регистрируем только туда
    if (Config.devGuildId) {
      try {
        await this.rest.put(
          Routes.applicationGuildCommands(Config.clientId, Config.devGuildId),
          { body },
        );
        log.info(`✓ Guild-команды → dev-гильдия ${Config.devGuildId} (${body.length})`);
      } catch (err) {
        log.error('Ошибка синхронизации guild-команд (dev)', err);
      }
      return;
    }

    // В проде — для конкретной гильдии или для всех
    if (guildId) {
      try {
        await this.rest.put(
          Routes.applicationGuildCommands(Config.clientId, guildId),
          { body },
        );
        log.debug(`Guild-команды → ${guildId} (${body.length})`);
      } catch (err) {
        log.error(`Ошибка синхронизации guild-команд для ${guildId}`, err);
      }
    } else {
      // Для всех текущих гильдий — параллельно через Promise.allSettled
      const guilds = this.client.guilds.cache;
      const results = await Promise.allSettled(
        guilds.map((_guild, id) =>
          this.rest.put(
            Routes.applicationGuildCommands(Config.clientId, id),
            { body },
          ),
        ),
      );

      const failed = results.filter((r) => r.status === 'rejected');
      if (failed.length > 0) {
        for (const f of failed) {
          log.error('Ошибка синхронизации guild-команд', (f as PromiseRejectedResult).reason);
        }
      }
      log.info(`✓ Guild-команды синхронизированы для ${guilds.size} гильдий (${body.length} команд, ошибок: ${failed.length})`);
    }
  }

  // ── Обработка interaction ──────────────────

  async handleCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    const registered = this.commands.get(interaction.commandName);

    if (!registered) {
      log.warn(`Неизвестная команда: /${interaction.commandName}`);
      return;
    }

    const { command } = registered;

    // Проверка кулдауна
    const locale = interaction.locale.startsWith('ru') ? 'ru' : 'en';

    if (command.cooldown && command.cooldown > 0) {
      const now = Date.now();
      const key = interaction.commandName;
      const userId = interaction.user.id;

      if (!this.cooldowns.has(key)) {
        this.cooldowns.set(key, new Collection());
      }

      const timestamps = this.cooldowns.get(key)!;
      const cooldownMs = command.cooldown * 1000;

      if (timestamps.has(userId)) {
        const expiration = timestamps.get(userId)! + cooldownMs;

        if (now < expiration) {
          const remaining = ((expiration - now) / 1000).toFixed(1);
          await interaction.reply({
            content: `⏳ ${i18n.t('errors.cooldown', locale, { remaining })}`,
            ephemeral: true,
          });
          return;
        }
      }

      timestamps.set(userId, now);
      setTimeout(() => timestamps.delete(userId), cooldownMs);
    }

    // Выполнение
    try {
      await command.execute(interaction, this.client);
    } catch (err) {
      log.error(`Ошибка выполнения /${interaction.commandName}`, err);

      // Отправляем в ErrorReporter с полным контекстом
      errorReporter.commandError(err, interaction);

      // Показываем пользователю красивый отчёт об ошибке
      const errorObj = err instanceof Error ? err : new Error(String(err));
      const errorEmbed = new BublikEmbed()
        .error()
        .setTitle(`❌ ${i18n.t('errors.command_error.title', locale)}`)
        .setDescription(i18n.t('errors.command_error.description', locale))
        .addFields(
          {
            name: i18n.t('errors.command_error.command', locale),
            value: `\`/${interaction.commandName}\``,
            inline: true,
          },
          {
            name: i18n.t('errors.command_error.error_type', locale),
            value: `\`${errorObj.name}\``,
            inline: true,
          },
          {
            name: i18n.t('errors.command_error.details', locale),
            value: `\`\`\`\n${errorObj.message.slice(0, 300)}\n\`\`\``,
            inline: false,
          },
        );

      const reply = {
        embeds: [errorEmbed],
        ephemeral: true,
      };

      if (interaction.replied || interaction.deferred) {
        await interaction.followUp(reply).catch(() => {});
      } else {
        await interaction.reply(reply).catch(() => {});
      }
    }
  }

  async handleAutocomplete(interaction: AutocompleteInteraction): Promise<void> {
    const registered = this.commands.get(interaction.commandName);

    if (!registered?.command.autocomplete) return;

    try {
      await registered.command.autocomplete(interaction, this.client);
    } catch (err) {
      log.error(`Ошибка autocomplete /${interaction.commandName}`, err);
      errorReporter.commandError(err, interaction as any, interaction.commandName);
      // Autocomplete не может отправить ephemeral — просто пустой список
      await interaction.respond([]).catch(() => {});
    }
  }

  // ── Геттеры ────────────────────────────────

  getCommand(name: string): RegisteredCommand | undefined {
    return this.commands.get(name);
  }

  getAllCommands(): Collection<string, RegisteredCommand> {
    return this.commands;
  }

  getCommandsByModule(moduleName: string): RegisteredCommand[] {
    return this.commands.filter((r) => r.moduleName === moduleName).map((r) => r);
  }

  getCommandsByCategory(category: string): RegisteredCommand[] {
    return this.commands.filter((r) => r.command.category === category).map((r) => r);
  }
}
