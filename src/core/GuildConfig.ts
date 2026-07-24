import { getDatabase } from './Database';
import { cacheGet, cacheSet, cacheDel } from './Redis';
import { logger } from './Logger';
import { Config } from '../config';

const log = logger.child('GuildConfig');

// ── Типы ─────────────────────────────────────
export interface GuildConfig {
  guildId: string;
  locale: string;
  welcomeChannelId: string | null;
  ticketChannelId: string | null;
  autoRoleId: string | null;
  recruitRoleId: string | null;
  memberRoleId: string | null;
}

export class WelcomeRoleInvariantError extends Error {
  constructor() {
    super('Welcome auto, member and recruit roles must be distinct');
    this.name = 'WelcomeRoleInvariantError';
  }
}

export function areGuildWelcomeRoleIdsDistinct(
  roleIds: readonly (string | null | undefined)[],
): boolean {
  const configured = roleIds.filter((roleId): roleId is string => Boolean(roleId));
  return new Set(configured).size === configured.length;
}

function assertWelcomeRoleInvariant(config: Pick<
  GuildConfig,
  'autoRoleId' | 'memberRoleId' | 'recruitRoleId'
>): void {
  if (!areGuildWelcomeRoleIdsDistinct([
    config.autoRoleId,
    config.memberRoleId,
    config.recruitRoleId,
  ])) {
    throw new WelcomeRoleInvariantError();
  }
}

async function lockGuildConfigRow(
  transaction: Pick<ReturnType<typeof getDatabase>, '$executeRaw'>,
  guildId: string,
): Promise<void> {
  // Role configuration is edited rarely, so a transaction-scoped advisory
  // lock is a cheap cross-process fence for partial updates from several shards.
  // pg_advisory_xact_lock returns PostgreSQL void. $queryRaw tries to
  // deserialize that value and Prisma rejects it before the transaction can
  // continue; $executeRaw executes the lock without decoding a result set.
  await transaction.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'guild-config:' + guildId}))`;
}

const CACHE_PREFIX = 'guildcfg:';
const CACHE_TTL = 600; // 10 минут — баланс между свежестью и нагрузкой
const LEGACY_WELCOME_BOOTSTRAP_KEY = 'guild-config:legacy-welcome-env:v1';
const cacheRevisions = new Map<string, number>();
const pendingWrites = new Map<string, Promise<unknown>>();
/** Guilds whose PostgreSQL value may be newer than the Redis cache. */
const dirtyGuilds = new Set<string>();

// ── Значения по умолчанию ────────────────────
const DEFAULTS: Omit<GuildConfig, 'guildId'> = {
  locale: Config.defaultLocale,
  welcomeChannelId: null,
  ticketChannelId: null,
  autoRoleId: null,
  recruitRoleId: null,
  memberRoleId: null,
};

function mapGuildConfigRow(row: {
  guildId: string;
  locale: string;
  welcomeChannelId: string | null;
  ticketChannelId: string | null;
  autoRoleId: string | null;
  recruitRoleId: string | null;
  memberRoleId: string | null;
}): GuildConfig {
  return {
    guildId: row.guildId,
    locale: row.locale || Config.defaultLocale,
    welcomeChannelId: row.welcomeChannelId,
    ticketChannelId: row.ticketChannelId,
    autoRoleId: row.autoRoleId,
    recruitRoleId: row.recruitRoleId,
    memberRoleId: row.memberRoleId,
  };
}

export interface LegacyWelcomeTargetOptions {
  explicitGuildId: string | null;
  devGuildId: string | null;
  allowedGuildIds: readonly string[];
}

export function resolveLegacyWelcomeGuildId(options: LegacyWelcomeTargetOptions): string {
  if (options.explicitGuildId) return options.explicitGuildId;
  const candidates = new Set([
    options.devGuildId,
    ...options.allowedGuildIds,
  ].filter((guildId): guildId is string => Boolean(guildId)));

  if (candidates.size === 1) return [...candidates][0];
  if (candidates.size === 0) {
    throw new Error(
      'Legacy welcome ENV is configured, but its guild is unknown. Set WELCOME_LEGACY_GUILD_ID.',
    );
  }
  throw new Error(
    'Legacy welcome ENV is ambiguous across multiple guilds. Set WELCOME_LEGACY_GUILD_ID explicitly.',
  );
}

/**
 * Import the former global welcome ENV exactly once. The claim and the
 * fill-only-null update share one transaction, so a crash can safely retry and
 * a later ENV change can never overwrite the per-guild database authority.
 */
export async function initLegacyWelcomeConfig(): Promise<void> {
  const legacy = {
    welcomeChannelId: Config.welcomeChannelId,
    ticketChannelId: Config.ticketChannelId,
    autoRoleId: Config.autoRoleId,
    recruitRoleId: Config.recruitRoleId,
  };
  if (!Object.values(legacy).some(Boolean)) return;

  const guildId = resolveLegacyWelcomeGuildId({
    explicitGuildId: Config.welcomeLegacyGuildId,
    devGuildId: Config.devGuildId,
    allowedGuildIds: Config.allowedGuilds,
  });
  const db = getDatabase();
  const imported = await db.$transaction(async (tx) => {
    await lockGuildConfigRow(tx, guildId);
    const claim = await tx.operationClaim.createMany({
      data: [{
        key: LEGACY_WELCOME_BOOTSTRAP_KEY,
        scope: 'guild_config_legacy_welcome',
        guildId,
        metadata: { guildId, configuredFields: Object.keys(legacy).filter((key) => Boolean(legacy[key as keyof typeof legacy])) },
      }],
      skipDuplicates: true,
    });
    if (claim.count !== 1) return false;

    const current = await tx.guildSettings.findUnique({ where: { guildId } });
    const fillOnlyNull = {
      ...(legacy.welcomeChannelId && current?.welcomeChannelId == null
        ? { welcomeChannelId: legacy.welcomeChannelId }
        : {}),
      ...(legacy.ticketChannelId && current?.ticketChannelId == null
        ? { ticketChannelId: legacy.ticketChannelId }
        : {}),
      ...(legacy.autoRoleId && current?.autoRoleId == null
        ? { autoRoleId: legacy.autoRoleId }
        : {}),
      ...(legacy.recruitRoleId && current?.recruitRoleId == null
        ? { recruitRoleId: legacy.recruitRoleId }
        : {}),
    };

    assertWelcomeRoleInvariant({
      autoRoleId: (fillOnlyNull.autoRoleId as string | undefined) ?? current?.autoRoleId ?? null,
      memberRoleId: current?.memberRoleId ?? null,
      recruitRoleId: (fillOnlyNull.recruitRoleId as string | undefined) ?? current?.recruitRoleId ?? null,
    });

    if (current) {
      if (Object.keys(fillOnlyNull).length > 0) {
        await tx.guildSettings.update({ where: { guildId }, data: fillOnlyNull });
      }
    } else {
      await tx.guildSettings.create({
        data: { guildId, ...DEFAULTS, ...fillOnlyNull },
      });
    }
    return true;
  });

  if (!imported) return;
  dirtyGuilds.add(guildId);
  try {
    await cacheDel(`${CACHE_PREFIX}${guildId}`);
    dirtyGuilds.delete(guildId);
  } catch {
    // Keep bypassing Redis until a later DB read successfully refreshes it.
  }
  log.info(`Legacy welcome ENV imported once for guild ${guildId}`);
}

// ═══════════════════════════════════════════════
//  Получение конфига (Redis → DB → defaults)
// ═══════════════════════════════════════════════

/**
 * Получить конфигурацию гильдии. Порядок:
 * 1. Redis-кэш (быстро)
 * 2. PostgreSQL
 * 3. Создаётся запись с дефолтами, если нет
 *
 * Результат всегда !== null.
 */
export async function getGuildConfig(guildId: string): Promise<GuildConfig> {
  const cacheKey = `${CACHE_PREFIX}${guildId}`;

  // Never read through a write that is already queued for this guild.
  const pendingWrite = pendingWrites.get(guildId);
  if (pendingWrite) await pendingWrite.catch(() => {});
  const revision = cacheRevisions.get(guildId) ?? 0;

  // 1. Кэш
  if (!dirtyGuilds.has(guildId)) {
    try {
      const cached = await cacheGet<GuildConfig>(cacheKey);
      if (cached && (cacheRevisions.get(guildId) ?? 0) === revision) {
        return { ...cached, locale: cached.locale || Config.defaultLocale };
      }
    } catch {
      // Redis недоступен — продолжаем из БД
    }
  }

  // 2. БД
  const db = getDatabase();
  const row = await db.guildSettings.upsert({
    where: { guildId },
    create: { guildId, ...DEFAULTS },
    update: {},
  });

  const config = mapGuildConfigRow(row);

  // 3. Кэш
  try {
    // A concurrent update must not be overwritten by this older cache-aside read.
    if ((cacheRevisions.get(guildId) ?? 0) === revision) {
      await cacheSet(cacheKey, config, CACHE_TTL);
      if ((cacheRevisions.get(guildId) ?? 0) === revision) {
        dirtyGuilds.delete(guildId);
      } else {
        // A newer write raced this cache fill; bypass the possibly older value.
        dirtyGuilds.add(guildId);
      }
    }
  } catch {
    dirtyGuilds.add(guildId);
  }

  return config;
}

/**
 * Security-sensitive automation must bypass Redis. This read observes the
 * latest committed PostgreSQL role/channel authority across every bot process.
 */
export async function getGuildConfigFresh(guildId: string): Promise<GuildConfig> {
  const pendingWrite = pendingWrites.get(guildId);
  if (pendingWrite) await pendingWrite.catch(() => {});
  const row = await getDatabase().guildSettings.upsert({
    where: { guildId },
    create: { guildId, ...DEFAULTS },
    update: {},
  });
  return mapGuildConfigRow(row);
}

// ═══════════════════════════════════════════════
//  Обновление конфига (DB + invalidate cache)
// ═══════════════════════════════════════════════

/**
 * Обновить одно или несколько полей конфигурации гильдии.
 * Создаёт запись если её нет (upsert).
 */
export async function updateGuildConfig(
  guildId: string,
  data: Partial<Omit<GuildConfig, 'guildId'>>,
): Promise<GuildConfig> {
  return queueGuildWrite(guildId, async () => {
    const db = getDatabase();
    const sanitized = { ...data };
    if (sanitized.locale !== undefined && !sanitized.locale.trim()) {
      sanitized.locale = Config.defaultLocale;
    }
    const touchesWelcomeRoles =
      sanitized.autoRoleId !== undefined ||
      sanitized.memberRoleId !== undefined ||
      sanitized.recruitRoleId !== undefined;

    dirtyGuilds.add(guildId);
    const row = await db.$transaction(async (tx) => {
      if (touchesWelcomeRoles) await lockGuildConfigRow(tx, guildId);
      const current = touchesWelcomeRoles
        ? await tx.guildSettings.findUnique({ where: { guildId } })
        : null;
      if (touchesWelcomeRoles) {
        assertWelcomeRoleInvariant({
          autoRoleId: sanitized.autoRoleId !== undefined
            ? sanitized.autoRoleId ?? null
            : current?.autoRoleId ?? null,
          memberRoleId: sanitized.memberRoleId !== undefined
            ? sanitized.memberRoleId ?? null
            : current?.memberRoleId ?? null,
          recruitRoleId: sanitized.recruitRoleId !== undefined
            ? sanitized.recruitRoleId ?? null
            : current?.recruitRoleId ?? null,
        });
      }
      return tx.guildSettings.upsert({
        where: { guildId },
        create: { guildId, locale: Config.defaultLocale, ...sanitized },
        update: sanitized,
      });
    });

    const config = mapGuildConfigRow(row);

    try {
      if (touchesWelcomeRoles) {
        // All cross-process role writers finish with deletion, so a slower
        // writer can never overwrite Redis with an older but valid snapshot.
        await cacheDel(`${CACHE_PREFIX}${guildId}`);
      } else {
        await cacheSet(`${CACHE_PREFIX}${guildId}`, config, CACHE_TTL);
      }
      dirtyGuilds.delete(guildId);
    } catch {
      // Redis недоступен — запись в БД всё равно авторитетна.
    }

    log.info(`GuildSettings обновлён для ${guildId}: ${JSON.stringify(sanitized)}`);
    return config;
  });
}

/**
 * Инвалидировать кэш конфига (после ручных изменений в БД и т.п.)
 */
export async function invalidateGuildConfig(guildId: string): Promise<void> {
  await queueGuildWrite(guildId, async () => {
    dirtyGuilds.add(guildId);
    try {
      await cacheDel(`${CACHE_PREFIX}${guildId}`);
      dirtyGuilds.delete(guildId);
    } catch {
      // Ignore
    }
  });
}

/**
 * Быстро получить язык гильдии (для i18n).
 * Fallback: DEFAULT_LOCALE
 */
export async function getGuildLocale(guildId: string | null | undefined): Promise<string> {
  if (!guildId) return Config.defaultLocale;
  try {
    const cfg = await getGuildConfig(guildId);
    return cfg.locale || Config.defaultLocale;
  } catch {
    return Config.defaultLocale;
  }
}

function queueGuildWrite<T>(guildId: string, operation: () => Promise<T>): Promise<T> {
  const previous = pendingWrites.get(guildId);
  cacheRevisions.set(guildId, (cacheRevisions.get(guildId) ?? 0) + 1);

  const current = (async () => {
    if (previous) await previous.catch(() => {});
    return operation();
  })();
  pendingWrites.set(guildId, current);

  void current.finally(() => {
    cacheRevisions.set(guildId, (cacheRevisions.get(guildId) ?? 0) + 1);
    if (pendingWrites.get(guildId) === current) pendingWrites.delete(guildId);
  }).catch(() => {});
  return current;
}
