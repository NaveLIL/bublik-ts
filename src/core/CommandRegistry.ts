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
import { getGuildLocale } from './GuildConfig';
import { isGuildAllowed } from './Whitelist';

const log = logger.child('CommandRegistry');

export const DEFAULT_COMMAND_SYNC_MAX_ATTEMPTS = 8;
export const DEFAULT_COMMAND_SYNC_DEADLINE_MS = 30_000;

export interface CommandRegistryOptions {
  convergenceMaxAttempts?: number;
  convergenceDeadlineMs?: number;
}

export class CommandSyncConvergenceError extends Error {
  constructor(
    readonly attempts: number,
    readonly initialRevision: number,
    readonly currentRevision: number,
  ) {
    super(
      `Command registry did not converge after ${attempts} attempts ` +
      `(revision ${initialRevision} -> ${currentRevision})`,
    );
    this.name = 'CommandSyncConvergenceError';
  }
}

function positiveInteger(
  value: number | undefined,
  fallback: number,
  option: string,
  minimum = 1,
): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < minimum) {
    throw new Error(`${option} must be a safe integer greater than or equal to ${minimum}`);
  }
  return resolved;
}

interface RegisteredCommand {
  command: BublikCommand;
  moduleName: string;
  isActive: () => boolean;
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
  private registryRevision = 0;
  private syncTail: Promise<void> = Promise.resolve();
  private readonly convergenceMaxAttempts: number;
  private readonly convergenceDeadlineMs: number;

  constructor(client: BublikClient, options: CommandRegistryOptions = {}) {
    this.client = client;
    this.rest = new REST({ version: '10' }).setToken(Config.token);
    this.convergenceMaxAttempts = positiveInteger(
      options.convergenceMaxAttempts,
      DEFAULT_COMMAND_SYNC_MAX_ATTEMPTS,
      'convergenceMaxAttempts',
      2,
    );
    this.convergenceDeadlineMs = positiveInteger(
      options.convergenceDeadlineMs,
      DEFAULT_COMMAND_SYNC_DEADLINE_MS,
      'convergenceDeadlineMs',
    );
  }

  // ── Регистрация / Удаление ─────────────────

  register(
    command: BublikCommand,
    moduleName: string,
    isActive: () => boolean = () => true,
  ): void {
    const name = command.data.name;

    const existing = this.commands.get(name);
    if (existing) {
      throw new Error(
        `Команда "/${name}" уже зарегистрирована модулем "${existing.moduleName}"`,
      );
    }

    this.commands.set(name, { command, moduleName, isActive });
    this.registryRevision++;
    log.debug(`Команда "/${name}" зарегистрирована (${command.scope}, модуль: ${moduleName})`);
  }

  unregister(name: string, moduleName?: string): void {
    const existing = this.commands.get(name);
    if (!existing || (moduleName && existing.moduleName !== moduleName)) return;
    this.commands.delete(name);
    this.cooldowns.delete(name);
    this.registryRevision++;
    log.debug(`Команда "/${name}" удалена из реестра`);
  }

  private prepareCommandData(command: BublikCommand) {
    const data = command.data;
    if (typeof (data as any).setIntegrationTypes === 'function') {
      (data as any).setIntegrationTypes(0); // ApplicationIntegrationType.GuildInstall
    }
    if (typeof (data as any).setContexts === 'function') {
      (data as any).setContexts(0); // InteractionContextType.Guild
    }
    return data.toJSON();
  }

  // ── Синхронизация с Discord API ────────────

  /** Зарегистрировать глобальные команды (вызывается один раз при старте) */
  async syncGlobalCommands(): Promise<void> {
    return this.enqueueSync(() => this.convergeCurrentSnapshot(
      () => this.publishGlobalCommands(),
    ));
  }

  private async publishGlobalCommands(): Promise<void> {
    const globalCmds = this.commands.filter((r) => r.command.scope === CommandScope.Global);
    // In development all commands live in one guild for instant updates. An
    // explicit empty PUT is important: returning early leaves stale commands.
    const body = Config.devGuildId
      ? []
      : globalCmds.map((r) => this.prepareCommandData(r.command));

    log.info(`Синхронизация ${body.length} глобальных команд…`);
    await this.rest.put(Routes.applicationCommands(Config.clientId), { body });
    log.info(`✓ Глобальные команды синхронизированы (${body.length})`);
  }

  /** Зарегистрировать гильдийные команды */
  async syncGuildCommands(guildId?: string): Promise<void> {
    return this.enqueueSync(() => this.convergeCurrentSnapshot(
      () => this.publishGuildCommands(guildId),
    ));
  }

  private async publishGuildCommands(guildId?: string): Promise<void> {
    const guildCmds = Config.devGuildId
      ? this.commands
      : this.commands.filter((r) => r.command.scope === CommandScope.Guild);

    const body = guildCmds.map((r) => this.prepareCommandData(r.command));

    if (Config.devGuildId) {
      // Ignore GuildCreate notifications for unrelated guilds in development.
      if (guildId && guildId !== Config.devGuildId) return;
      guildId = Config.devGuildId;
    }

    // Если указана конкретная гильдия — синхронизируем только туда
    if (guildId) {
      await this.rest.put(
        Routes.applicationGuildCommands(Config.clientId, guildId),
        { body },
      );
      log.info(`✓ Guild-команды → ${guildId} (${body.length})`);
      return;
    }

    // Без guildId — синхронизируем для всех гильдий с ограничением конкуренции
    const guildIds = [...this.client.guilds.cache.keys()].filter(isGuildAllowed);
    const CONCURRENCY = 3;
    const failures: Error[] = [];

    for (let i = 0; i < guildIds.length; i += CONCURRENCY) {
      const chunk = guildIds.slice(i, i + CONCURRENCY);
      const results = await Promise.allSettled(
        chunk.map((id) => this.rest.put(
          Routes.applicationGuildCommands(Config.clientId, id),
          { body },
        )),
      );

      results.forEach((res, idx) => {
        if (res.status === 'rejected') {
          log.error(`Ошибка синхронизации guild-команд для ${chunk[idx]}`, res.reason);
          failures.push(res.reason instanceof Error ? res.reason : new Error(String(res.reason)));
        }
      });
    }

    if (failures.length > 0) {
      throw new AggregateError(failures, `Не удалось синхронизировать команды для ${failures.length} гильдий`);
    }
    log.info(`✓ Guild-команды синхронизированы для ${guildIds.length} гильдий (${body.length} команд)`);
  }

  /** Synchronize both scopes; callers must see and handle REST failures. */
  async syncAllCommands(): Promise<void> {
    return this.enqueueSync(() => this.convergeCurrentSnapshot(async () => {
      await this.publishGlobalCommands();
      await this.publishGuildCommands();
    }));
  }

  /**
   * REST bulk replacement has no compare-and-swap primitive. A single queue
   * prevents an older PUT from completing after a newer one, while the
   * revision loop repairs any snapshot that became stale during its request.
   * One retry also resolves an ambiguous current-revision REST failure. The
   * retry budget is checked between PUTs: an in-flight request is never
   * abandoned because it could otherwise complete after the next queued PUT.
   */
  private async convergeCurrentSnapshot(publish: () => Promise<void>): Promise<void> {
    const initialRevision = this.registryRevision;
    const startedAt = Date.now();
    let attempts = 0;
    let retriedAmbiguousRevision: number | null = null;

    while (attempts < this.convergenceMaxAttempts) {
      const revision = this.registryRevision;
      attempts++;
      try {
        await publish();
      } catch (error) {
        if (revision !== this.registryRevision) {
          retriedAmbiguousRevision = null;
          if (this.hasConvergenceBudget(attempts, startedAt)) continue;
          throw new CommandSyncConvergenceError(
            attempts,
            initialRevision,
            this.registryRevision,
          );
        }
        if (retriedAmbiguousRevision !== revision) {
          retriedAmbiguousRevision = revision;
          if (this.hasConvergenceBudget(attempts, startedAt)) continue;
        }
        throw error;
      }

      if (revision === this.registryRevision) return;
      retriedAmbiguousRevision = null;
      if (!this.hasConvergenceBudget(attempts, startedAt)) {
        throw new CommandSyncConvergenceError(
          attempts,
          initialRevision,
          this.registryRevision,
        );
      }
    }

    throw new CommandSyncConvergenceError(
      attempts,
      initialRevision,
      this.registryRevision,
    );
  }

  private hasConvergenceBudget(attempts: number, startedAt: number): boolean {
    return attempts < this.convergenceMaxAttempts &&
      Date.now() - startedAt < this.convergenceDeadlineMs;
  }

  private enqueueSync(operation: () => Promise<void>): Promise<void> {
    const result = this.syncTail.then(operation, operation);
    this.syncTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  // ── Обработка interaction ──────────────────

  async handleCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!interaction.guildId || !interaction.guild) {
      try {
        await interaction.reply({
          content: '⛔ Команды бота можно использовать только на серверах, куда добавлен бот.',
          ephemeral: true,
        });
      } catch { /* ignore */ }
      return;
    }

    if (!isGuildAllowed(interaction.guildId)) {
      await interaction.reply({
        content: '⛔ Этот сервер не авторизован для работы с ботом.',
        ephemeral: true,
      }).catch(() => {});
      return;
    }

    const registered = this.commands.get(interaction.commandName);

    if (!registered) {
      log.warn(`Неизвестная команда: /${interaction.commandName}`);
      return;
    }

    const { command } = registered;

    // Проверка ownerOnly
    if (command.ownerOnly && interaction.user.id !== Config.ownerId) {
      try {
        await interaction.reply({
          content: '⛔ Эта команда доступна только владельцу бота.',
          ephemeral: true,
        });
      } catch { /* interaction may have expired */ }
      return;
    }

    // Проверка кулдауна
    const locale = await getGuildLocale(interaction.guildId);
    // Locale resolution is asynchronous, so the captured command may belong
    // to a generation that was unloaded while the lookup was pending.
    if (!registered.isActive()) return;

    if (command.cooldown && command.cooldown > 0) {
      const now = Date.now();
      const key = interaction.commandName;
      const userId = interaction.user.id;

      if (!this.cooldowns.has(key)) {
        this.cooldowns.set(key, new Collection());
      }

      const timestamps = this.cooldowns.get(key)!;
      const cooldownMs = command.cooldown * 1000;

      for (const [uid, ts] of timestamps) {
        if (now - ts >= cooldownMs) {
          timestamps.delete(uid);
        }
      }

      if (timestamps.has(userId)) {
        const expiration = timestamps.get(userId)! + cooldownMs;

        if (now < expiration) {
          const remaining = ((expiration - now) / 1000).toFixed(1);
          try {
            await interaction.reply({
              content: `⏳ ${i18n.t('errors.cooldown', locale, { remaining })}`,
              ephemeral: true,
            });
          } catch { /* interaction may have expired */ }
          return;
        }

        timestamps.delete(userId);
      }

      timestamps.set(userId, now);
    }

    // Выполнение
    try {
      await command.execute(interaction, this.client);
    } catch (err) {
      log.error(`Ошибка выполнения /${interaction.commandName}`, err);

      const reply = {
        content: `❌ ${i18n.t('errors.generic', locale)}`,
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
    if (!interaction.guildId || !interaction.guild) return;
    if (!isGuildAllowed(interaction.guildId)) {
      await interaction.respond([]).catch(() => {});
      return;
    }

    const registered = this.commands.get(interaction.commandName);

    if (!registered?.command.autocomplete) return;
    if (!registered.isActive()) return;

    try {
      await registered.command.autocomplete(interaction, this.client);
    } catch (err) {
      log.error(`Ошибка autocomplete /${interaction.commandName}`, err);
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
