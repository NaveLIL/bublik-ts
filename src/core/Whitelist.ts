import type { Interaction } from 'discord.js';
import { getDatabase } from './Database';
import { Config } from '../config';
import { logger } from './Logger';
import { normalizeError } from './Safety';

const log = logger.child('Whitelist');
const allowedSet = new Set<string>();
const ENV_BOOTSTRAP_CLAIM = 'whitelist:env-bootstrap:v1';

export enum WhitelistState {
  Uninitialized = 'uninitialized',
  Loading = 'loading',
  Ready = 'ready',
  Failed = 'failed',
}

let state = WhitelistState.Uninitialized;
let initialization: Promise<void> | null = null;

/** Load the whitelist once. Any load failure is propagated and remains fail-closed. */
export function initWhitelist(force = false): Promise<void> {
  if (!force && state === WhitelistState.Ready) return Promise.resolve();
  if (initialization) return initialization;

  state = WhitelistState.Loading;
  allowedSet.clear();
  initialization = (async () => {
    try {
      const db = getDatabase();
      const { list, seeded } = await db.$transaction(async (tx) => {
        let persisted = await tx.allowedGuild.findMany();
        const bootstrap = await tx.operationClaim.createMany({
          data: [{
            key: ENV_BOOTSTRAP_CLAIM,
            scope: 'whitelist_env_bootstrap',
            metadata: { configuredGuildIds: Config.allowedGuilds },
          }],
          skipDuplicates: true,
        });

        let didSeed = false;
        if (bootstrap.count === 1 && persisted.length === 0 && Config.allowedGuilds.length > 0) {
          await tx.allowedGuild.createMany({
            data: Config.allowedGuilds.map((guildId) => ({ guildId })),
            skipDuplicates: true,
          });
          didSeed = true;
        }

        // Re-read even when another process won the bootstrap claim while this
        // transaction was waiting on its unique key.
        persisted = await tx.allowedGuild.findMany();

        return { list: persisted, seeded: didSeed };
      });

      if (seeded) {
        log.info('База данных вайтлиста пуста. Однократный бутстрап из ALLOWED_GUILDS выполнен.');
      }

      for (const entry of list) allowedSet.add(entry.guildId);
      state = WhitelistState.Ready;

      if (allowedSet.size === 0) {
        log.warn('Вайтлист пуст: fail-closed, ни один сервер не разрешён');
      } else {
        log.info(`Вайтлист инициализирован. Загружено серверов: ${allowedSet.size}`);
      }
    } catch (err) {
      allowedSet.clear();
      state = WhitelistState.Failed;
      const error = normalizeError(err);
      log.error('Ошибка инициализации вайтлиста; доступ закрыт', error);
      throw error;
    } finally {
      initialization = null;
    }
  })();

  return initialization;
}

export function getWhitelistState(): WhitelistState {
  return state;
}

/** Empty, loading, uninitialized and failed states are deliberately denied. */
export function isGuildAllowed(guildId: string): boolean {
  return state === WhitelistState.Ready && allowedSet.has(guildId);
}

/** Lightweight guard used by independently invoked module listeners. */
export function isInteractionAllowed(interaction: unknown): boolean {
  if (!interaction || typeof interaction !== 'object') return false;
  const guildId = (interaction as { guildId?: unknown }).guildId;
  // Discord explicitly reports `null` for DM interactions. They have no guild
  // authority to check here; the receiving handler must validate the durable
  // invite/report record before acting. Missing/unknown payload shapes remain
  // denied so this does not turn malformed events into an allow path.
  if (guildId === null) return true;
  return typeof guildId === 'string' && isGuildAllowed(guildId);
}

/** Extract a guild id from the common discord.js event payload shapes. */
export function getEventGuildId(args: readonly unknown[]): string | null {
  for (const value of args) {
    if (!value || typeof value !== 'object') continue;
    const candidate = value as {
      guildId?: unknown;
      guild?: { id?: unknown };
      id?: unknown;
      members?: unknown;
      channels?: unknown;
    };
    if (typeof candidate.guildId === 'string') return candidate.guildId;
    if (typeof candidate.guild?.id === 'string') return candidate.guild.id;
    // GuildCreate/GuildDelete pass the Guild itself rather than an object with
    // guild/guildId. Requiring both managers avoids mistaking a User/Role id.
    if (
      typeof candidate.id === 'string' &&
      candidate.members !== undefined &&
      candidate.channels !== undefined
    ) return candidate.id;
  }
  return null;
}

/** Central guard for every independently invoked module event listener. */
export function isModuleEventAllowed(event: string, args: readonly unknown[]): boolean {
  if (event === 'interactionCreate') return isInteractionAllowed(args[0]);
  const guildId = getEventGuildId(args);
  return guildId === null || isGuildAllowed(guildId);
}

/**
 * User-facing guard for the core interaction listener. DMs are passed through so
 * command handling can return its more specific "server only" response.
 */
export async function enforceInteractionWhitelist(interaction: Interaction): Promise<boolean> {
  if (!interaction.guildId) return true;
  if (isGuildAllowed(interaction.guildId)) return true;

  if (interaction.isAutocomplete()) {
    await interaction.respond([]).catch(() => {});
    return false;
  }

  if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
    const unavailable = state !== WhitelistState.Ready;
    await interaction.reply({
      content: unavailable
        ? '⛔ Бот временно недоступен: проверка доступа не завершена.'
        : '⛔ Этот сервер не авторизован для работы с ботом.',
      ephemeral: true,
    }).catch(() => {});
  }
  return false;
}

export async function addAllowedGuild(guildId: string): Promise<boolean> {
  try {
    const db = getDatabase();
    await db.allowedGuild.upsert({ where: { guildId }, create: { guildId }, update: {} });
    if (state === WhitelistState.Ready) allowedSet.add(guildId);
    log.info(`Сервер ${guildId} добавлен в вайтлист`);
    return true;
  } catch (err) {
    log.error(`Ошибка добавления ${guildId} в вайтлист`, err);
    return false;
  }
}

export async function removeAllowedGuild(guildId: string): Promise<boolean> {
  try {
    const db = getDatabase();
    await db.allowedGuild.deleteMany({ where: { guildId } });
    allowedSet.delete(guildId);
    log.info(`Сервер ${guildId} удалён из вайтлиста`);
    return true;
  } catch (err) {
    log.error(`Ошибка удаления ${guildId} из вайтлиста`, err);
    return false;
  }
}

export function getAllowedGuildsList(): string[] {
  return Array.from(allowedSet).sort();
}
