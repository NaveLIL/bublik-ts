import { randomUUID } from 'node:crypto';
import { ChannelType, Client, VoiceChannel } from 'discord.js';
import type { Prisma } from '@prisma/client';
import { getDatabase } from '../../core/Database';
import { logger } from '../../core/Logger';
import { getRedis } from '../../core/Redis';
import { scheduleTask, unscheduleTask } from '../../core/SchedulerManager';
import { isGuildAllowed } from '../../core/Whitelist';
import { deleteChannel } from './database';
import { isUnknownChannelError } from './recovery';
import { buildPermissionOverwrites } from './utils';

const log = logger.child('TempVoice:PermissionSync');

export const PERMISSION_SYNC_SCOPE = 'tempvoice_permission_sync';
export const PERMISSION_PREPARED_LEASE_MS = 30_000;
const PERMISSION_SYNC_INTERVAL_MS = 15_000;
const PERMISSION_SYNC_TASK = 'tempvoice:permissionSync';
const PERMISSION_LOCK_TTL_MS = 60_000;
const PERMISSION_LOCK_PREFIX = 'tempvoice:permission-sync-lock';
const MUTATION_LOCK_PREFIX = 'tempvoice:permission-mutation-lock';
const MUTATION_LOCK_TTL_MS = 60_000;
const MUTATION_LOCK_RENEW_MS = 20_000;
const MUTATION_LOCK_WAIT_MS = 15_000;

export type PermissionSyncPhase = 'prepared' | 'ready';

export interface PermissionSyncIntent {
  version: 1;
  token: string;
  guildId: string;
  channelId: string;
  reason: string;
  phase: PermissionSyncPhase;
  preparedAt: number;
  readyAt: number | null;
}

export type PermissionSyncResult =
  | 'synced'
  | 'already-clean'
  | 'channel-gone'
  | 'deferred'
  | 'busy'
  | 'retry';

export interface PermissionMutationResult<T> {
  value: T;
  sync: PermissionSyncResult;
}

function intentKey(channelId: string): string {
  return `tempvoice:permission-sync:${channelId}`;
}

function lockKey(channelId: string): string {
  return `${PERMISSION_LOCK_PREFIX}:${channelId}`;
}

function mutationLockKey(scope: 'channel' | 'generator', id: string): string {
  return `${MUTATION_LOCK_PREFIX}:${scope}:${id}`;
}

interface MutationLock {
  key: string;
  token: string;
  renewalTimer: ReturnType<typeof setInterval>;
  lost: boolean;
}

function asMetadata(intent: PermissionSyncIntent): Prisma.InputJsonValue {
  return intent as unknown as Prisma.InputJsonValue;
}

/** Strict parsing keeps malformed durable work visible instead of acting on it. */
export function parsePermissionSyncIntent(value: unknown): PermissionSyncIntent | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const intent = value as Partial<PermissionSyncIntent>;
  if (
    intent.version !== 1 ||
    typeof intent.token !== 'string' || intent.token.length === 0 ||
    typeof intent.guildId !== 'string' || intent.guildId.length === 0 ||
    typeof intent.channelId !== 'string' || intent.channelId.length === 0 ||
    typeof intent.reason !== 'string' || intent.reason.length === 0 ||
    !['prepared', 'ready'].includes(String(intent.phase)) ||
    typeof intent.preparedAt !== 'number' || !Number.isFinite(intent.preparedAt) ||
    !(intent.readyAt === null || (typeof intent.readyAt === 'number' && Number.isFinite(intent.readyAt)))
  ) return null;

  if (intent.phase === 'prepared' && intent.readyAt !== null) return null;
  if (
    intent.phase === 'ready' &&
    (intent.readyAt === null || intent.readyAt < intent.preparedAt)
  ) return null;
  return intent as PermissionSyncIntent;
}

/** A live mutation owns a fresh prepared intent; crash recovery waits for its lease. */
export function isPermissionSyncDue(
  intent: PermissionSyncIntent,
  nowMs = Date.now(),
): boolean {
  return intent.phase === 'ready' || intent.preparedAt <= nowMs - PERMISSION_PREPARED_LEASE_MS;
}

export async function preparePermissionSync(
  guildId: string,
  channelId: string,
  reason: string,
): Promise<PermissionSyncIntent> {
  if (!guildId || !channelId || !reason.trim()) throw new Error('Invalid TempVoice permission sync intent');
  const intent: PermissionSyncIntent = {
    version: 1,
    token: randomUUID(),
    guildId,
    channelId,
    reason: reason.slice(0, 200),
    phase: 'prepared',
    preparedAt: Date.now(),
    readyAt: null,
  };

  await getDatabase().operationClaim.upsert({
    where: { key: intentKey(channelId) },
    create: {
      key: intentKey(channelId),
      scope: PERMISSION_SYNC_SCOPE,
      guildId,
      metadata: asMetadata(intent),
    },
    update: {
      scope: PERMISSION_SYNC_SCOPE,
      guildId,
      userId: null,
      metadata: asMetadata(intent),
      expiresAt: null,
    },
  });
  return intent;
}

export async function markPermissionSyncReady(intent: PermissionSyncIntent): Promise<boolean> {
  const ready: PermissionSyncIntent = {
    ...intent,
    phase: 'ready',
    readyAt: Date.now(),
  };
  const updated = await getDatabase().operationClaim.updateMany({
    where: {
      key: intentKey(intent.channelId),
      scope: PERMISSION_SYNC_SCOPE,
      metadata: { path: ['token'], equals: intent.token },
    },
    data: { metadata: asMetadata(ready) },
  });
  return updated.count === 1;
}

async function completePermissionSync(intent: PermissionSyncIntent): Promise<boolean> {
  const removed = await getDatabase().operationClaim.deleteMany({
    where: {
      key: intentKey(intent.channelId),
      scope: PERMISSION_SYNC_SCOPE,
      metadata: { path: ['token'], equals: intent.token },
    },
  });
  return removed.count === 1;
}

async function acquirePermissionLock(channelId: string): Promise<string | null> {
  const token = randomUUID();
  const locked = await getRedis().set(
    lockKey(channelId),
    token,
    'PX',
    PERMISSION_LOCK_TTL_MS,
    'NX',
  );
  return locked === 'OK' ? token : null;
}

async function releasePermissionLock(channelId: string, token: string): Promise<void> {
  await getRedis().eval(
    'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end',
    1,
    lockKey(channelId),
    token,
  );
}

/** Serialize the whole intent + DB mutation window, not only the Discord write. */
async function acquireMutationLock(
  scope: 'channel' | 'generator',
  id: string,
): Promise<MutationLock> {
  const key = mutationLockKey(scope, id);
  const token = randomUUID();
  const deadline = Date.now() + MUTATION_LOCK_WAIT_MS;

  while (true) {
    const locked = await getRedis().set(key, token, 'PX', MUTATION_LOCK_TTL_MS, 'NX');
    if (locked === 'OK') break;
    if (Date.now() >= deadline) {
      throw new Error(`TempVoice ${scope} ${id} is busy with another permission mutation`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  const lock: MutationLock = {
    key,
    token,
    renewalTimer: undefined as unknown as ReturnType<typeof setInterval>,
    lost: false,
  };
  const renewalTimer = setInterval(() => {
    void getRedis().eval(
      'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("pexpire", KEYS[1], ARGV[2]) else return 0 end',
      1,
      key,
      token,
      String(MUTATION_LOCK_TTL_MS),
    ).then((renewed) => {
      if (Number(renewed) !== 1) {
        lock.lost = true;
        log.warn(`TempVoice mutation lock ${key} was lost; durable CAS recovery remains active`);
      }
    }).catch((error: unknown) => {
      lock.lost = true;
      log.warn(`TempVoice mutation lock ${key} could not be renewed`, { error: String(error) });
    });
  }, MUTATION_LOCK_RENEW_MS);
  renewalTimer.unref?.();
  lock.renewalTimer = renewalTimer;
  return lock;
}

async function assertMutationLockOwned(lock: MutationLock): Promise<void> {
  if (lock.lost || await getRedis().get(lock.key) !== lock.token) {
    lock.lost = true;
    throw new Error(`TempVoice mutation lock ${lock.key} was lost`);
  }
}

async function releaseMutationLock(lock: MutationLock): Promise<void> {
  clearInterval(lock.renewalTimer);
  await getRedis().eval(
    'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end',
    1,
    lock.key,
    lock.token,
  );
}

/** Shared generator fence for create/delete/config mutations. */
export async function runGeneratorExclusive<T>(
  generatorId: string,
  task: (assertOwned: () => Promise<void>) => Promise<T>,
): Promise<T> {
  const lock = await acquireMutationLock('generator', generatorId);
  try {
    const assertOwned = () => assertMutationLockOwned(lock);
    await assertOwned();
    return await task(assertOwned);
  } finally {
    await releaseMutationLock(lock).catch((error: unknown) => {
      log.warn(`TempVoice generator lock ${lock.key} was not released`, { error: String(error) });
    });
  }
}

export function sortUniquePermissionChannelIds(channelIds: readonly string[]): string[] {
  return [...new Set(channelIds.filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

async function acquireChannelMutationLocks(
  channelIds: readonly string[],
  heldLocks: MutationLock[],
  heldChannelIds: Set<string>,
): Promise<void> {
  for (const channelId of sortUniquePermissionChannelIds(channelIds)) {
    if (heldChannelIds.has(channelId)) continue;
    const lock = await acquireMutationLock('channel', channelId);
    heldLocks.push(lock);
    heldChannelIds.add(channelId);
  }
}

async function releaseMutationLocks(locks: readonly MutationLock[]): Promise<void> {
  for (const lock of [...locks].reverse()) {
    await releaseMutationLock(lock).catch((error: unknown) => {
      log.warn(`TempVoice mutation lock ${lock.key} was not released`, { error: String(error) });
    });
  }
}

async function readCurrentIntent(channelId: string): Promise<PermissionSyncIntent | null> {
  const claim = await getDatabase().operationClaim.findUnique({
    where: { key: intentKey(channelId) },
    select: { scope: true, metadata: true },
  });
  if (!claim || claim.scope !== PERMISSION_SYNC_SCOPE) return null;
  return parsePermissionSyncIntent(claim.metadata);
}

async function removeMissingChannelState(intent: PermissionSyncIntent): Promise<PermissionSyncResult> {
  try {
    await deleteChannel(intent.channelId);
    await completePermissionSync(intent);
    log.info(`[${intent.guildId}] removed stale TempVoice state for missing channel ${intent.channelId}`);
    return 'channel-gone';
  } catch (error) {
    log.error(`Cannot clean missing TempVoice channel ${intent.channelId}; intent retained`, error);
    return 'retry';
  }
}

/** Apply one full canonical overwrite set from fresh database state. */
export async function reconcileChannelPermissions(
  client: Client,
  channelId: string,
): Promise<PermissionSyncResult> {
  let lockToken: string | null;
  try {
    lockToken = await acquirePermissionLock(channelId);
  } catch (error) {
    log.warn(`TempVoice permission lock ${channelId} is temporarily unavailable`, { error: String(error) });
    return 'retry';
  }
  if (!lockToken) return 'busy';

  try {
    const intent = await readCurrentIntent(channelId);
    if (!intent) return 'already-clean';
    if (!isPermissionSyncDue(intent)) return 'deferred';
    if (!isGuildAllowed(intent.guildId)) return 'deferred';

    const guild = client.guilds.cache.get(intent.guildId);
    if (!guild) return 'retry';

    const db = getDatabase();
    const channelData = await db.tempvoiceChannel.findUnique({ where: { id: intent.channelId } });
    if (!channelData) {
      await completePermissionSync(intent);
      return 'already-clean';
    }
    if (channelData.guildId !== intent.guildId) {
      log.error(`TempVoice permission intent ${intent.channelId} has a mismatched guild; retained for inspection`);
      return 'retry';
    }

    const generator = await db.tempvoiceGenerator.findUnique({ where: { id: channelData.generatorId } });
    if (!generator || generator.guildId !== intent.guildId) {
      log.error(`TempVoice generator ${channelData.generatorId} is unavailable for ${intent.channelId}`);
      return 'retry';
    }

    let target: VoiceChannel;
    try {
      const fetched = await guild.channels.fetch(intent.channelId, { force: true });
      if (!fetched) return 'retry';
      if (fetched.type !== ChannelType.GuildVoice) return removeMissingChannelState(intent);
      target = fetched as VoiceChannel;
    } catch (error) {
      if (isUnknownChannelError(error)) return removeMissingChannelState(intent);
      log.warn(`TempVoice permission target ${intent.channelId} is temporarily unavailable`, { error: String(error) });
      return 'retry';
    }

    // The canonical builder inherits role overwrites from the generator. A
    // transient generator lookup must not accidentally erase those permissions.
    try {
      await guild.channels.fetch(generator.channelId, { force: true });
    } catch (error) {
      if (!isUnknownChannelError(error)) {
        log.warn(`TempVoice generator channel ${generator.channelId} is temporarily unavailable`, { error: String(error) });
        return 'retry';
      }
      guild.channels.cache.delete(generator.channelId);
    }

    try {
      const overwrites = await buildPermissionOverwrites(
        channelData,
        generator,
        guild,
        client.user!.id,
      );
      await target.permissionOverwrites.set(
        overwrites,
        `TempVoice canonical permission sync: ${intent.reason}`,
      );
    } catch (error) {
      if (isUnknownChannelError(error)) return removeMissingChannelState(intent);
      log.warn(`TempVoice permissions for ${intent.channelId} will be retried`, { error: String(error) });
      return 'retry';
    }

    // Token-CAS prevents an older worker from deleting a newer mutation intent.
    if (!await completePermissionSync(intent)) {
      // The lock may have expired while Discord was slow. If a newer worker
      // already completed, leave a fresh audit so this older REST write cannot
      // become the final state.
      await queuePermissionAudit(intent.guildId, intent.channelId, 'superseded worker verification');
      return 'retry';
    }
    return 'synced';
  } catch (error) {
    log.error(`TempVoice permission reconciliation failed for ${channelId}`, error);
    return 'retry';
  } finally {
    await releasePermissionLock(channelId, lockToken).catch((error: unknown) =>
      log.warn(`TempVoice permission lock ${channelId} was not released`, { error: String(error) }));
  }
}

async function finishPreparedIntent(
  client: Client,
  intent: PermissionSyncIntent,
): Promise<PermissionSyncResult> {
  let ready = false;
  try {
    ready = await markPermissionSyncReady(intent);
  } catch (error) {
    log.error(`TempVoice permission intent ${intent.channelId} could not be marked ready`, error);
  }
  if (ready) return reconcileChannelPermissions(client, intent.channelId);

  // Another mutation may have replaced this token and already completed before
  // this DB write returned. Queueing with skipDuplicates preserves a newer live
  // intent, while recreating work when the key has already been deleted.
  try {
    await queuePermissionAudit(
      intent.guildId,
      intent.channelId,
      'ready CAS verification',
    );
    return reconcileChannelPermissions(client, intent.channelId);
  } catch (error) {
    log.error(`TempVoice permission CAS recovery failed for ${intent.channelId}`, error);
    return 'retry';
  }
}

/** Intent is committed before the supplied DB mutation and survives every crash window. */
export async function runPermissionMutation<T>(
  client: Client,
  guildId: string,
  channelId: string,
  reason: string,
  mutation: () => Promise<T>,
): Promise<PermissionMutationResult<T>> {
  if (!isGuildAllowed(guildId)) {
    throw new Error(`TempVoice permission mutation denied for guild ${guildId}`);
  }
  const mutationLock = await acquireMutationLock('channel', channelId);
  try {
    if (!isGuildAllowed(guildId)) {
      throw new Error(`TempVoice permission mutation denied for guild ${guildId}`);
    }
    const intent = await preparePermissionSync(guildId, channelId, reason);
    try {
      const value = await mutation();
      const sync = await finishPreparedIntent(client, intent);
      return { value, sync };
    } catch (error) {
      // The DB operation may have failed before or after reaching PostgreSQL. The
      // current DB row remains canonical in both cases, so syncing it is safe.
      await finishPreparedIntent(client, intent).catch(() => 'retry');
      throw error;
    }
  } finally {
    await releaseMutationLock(mutationLock).catch((error: unknown) => {
      log.warn(`TempVoice mutation lock ${mutationLock.key} was not released`, { error: String(error) });
    });
  }
}

/** Generator role changes affect every active channel derived from it. */
export async function runGeneratorPermissionMutation<T>(
  client: Client,
  guildId: string,
  generatorId: string,
  reason: string,
  mutation: () => Promise<T>,
): Promise<T> {
  if (!isGuildAllowed(guildId)) {
    throw new Error(`TempVoice generator mutation denied for guild ${guildId}`);
  }
  const generatorLock = await acquireMutationLock('generator', generatorId);
  const channelLocks: MutationLock[] = [];
  const lockedChannelIds = new Set<string>();
  try {
    if (!isGuildAllowed(guildId)) {
      throw new Error(`TempVoice generator mutation denied for guild ${guildId}`);
    }
    const channels = await getDatabase().tempvoiceChannel.findMany({
      where: { guildId, generatorId },
      select: { id: true },
    });
    const channelIds = sortUniquePermissionChannelIds(channels.map(({ id }) => id));
    await acquireChannelMutationLocks(channelIds, channelLocks, lockedChannelIds);
    const intents: PermissionSyncIntent[] = [];
    for (const id of channelIds) {
      intents.push(await preparePermissionSync(guildId, id, reason));
    }
    const preparedIds = new Set(channelIds);
    try {
      const value = await mutation();
      // A channel can be created concurrently with the generator update. Its own
      // creation sync usually sees the new generator row; this second snapshot
      // closes the remaining race without dropping existing pre-write intents.
      const currentChannels = await getDatabase().tempvoiceChannel.findMany({
        where: { guildId, generatorId },
        select: { id: true },
      });
      const currentChannelIds = sortUniquePermissionChannelIds(currentChannels.map(({ id }) => id));
      await acquireChannelMutationLocks(currentChannelIds, channelLocks, lockedChannelIds);
      for (const id of currentChannelIds) {
        if (preparedIds.has(id)) continue;
        intents.push(await preparePermissionSync(guildId, id, reason));
        preparedIds.add(id);
      }
      await Promise.all(intents.map((intent) => finishPreparedIntent(client, intent)));
      return value;
    } catch (error) {
      await Promise.all(intents.map((intent) => finishPreparedIntent(client, intent).catch(() => 'retry')));
      // If the generator DB write committed but a newly-discovered channel lock
      // could not be acquired, durable audits ensure it is reconciled after the
      // competing channel mutation releases its lock.
      try {
        const currentChannels = await getDatabase().tempvoiceChannel.findMany({
          where: { guildId, generatorId },
          select: { id: true },
        });
        for (const { id } of currentChannels) {
          await queuePermissionAudit(guildId, id, 'generator mutation failure verification');
        }
      } catch (auditError) {
        log.error(`TempVoice generator ${generatorId} audit queue failed`, auditError);
      }
      throw error;
    }
  } finally {
    await releaseMutationLocks(channelLocks);
    await releaseMutationLock(generatorLock).catch((error: unknown) => {
      log.warn(`TempVoice mutation lock ${generatorLock.key} was not released`, { error: String(error) });
    });
  }
}

/** Queue a canonical audit only when no live mutation intent already owns the key. */
export async function queuePermissionAudit(
  guildId: string,
  channelId: string,
  reason: string,
): Promise<void> {
  const now = Date.now();
  const intent: PermissionSyncIntent = {
    version: 1,
    token: randomUUID(),
    guildId,
    channelId,
    reason: reason.slice(0, 200),
    phase: 'ready',
    preparedAt: now,
    readyAt: now,
  };
  await getDatabase().operationClaim.createMany({
    data: [{
      key: intentKey(channelId),
      scope: PERMISSION_SYNC_SCOPE,
      guildId,
      metadata: asMetadata(intent),
    }],
    skipDuplicates: true,
  });
}

export async function queueAllTrackedPermissionAudits(client: Client): Promise<void> {
  const guildIds = [...client.guilds.cache.keys()].filter(isGuildAllowed);
  if (guildIds.length === 0) return;
  const channels = await getDatabase().tempvoiceChannel.findMany({
    where: { guildId: { in: guildIds } },
    select: { id: true, guildId: true },
  });
  for (const channel of channels) {
    await queuePermissionAudit(channel.guildId, channel.id, 'startup canonical audit');
  }
}

export async function recoverPermissionSyncIntents(client: Client): Promise<void> {
  const guildIds = [...client.guilds.cache.keys()].filter(isGuildAllowed);
  if (guildIds.length === 0) return;
  const claims = await getDatabase().operationClaim.findMany({
    where: {
      scope: PERMISSION_SYNC_SCOPE,
      guildId: { in: guildIds },
    },
    select: { key: true, metadata: true },
    orderBy: { createdAt: 'asc' },
  });

  for (const claim of claims) {
    const intent = parsePermissionSyncIntent(claim.metadata);
    if (!intent) {
      log.error(`Malformed TempVoice permission intent ${claim.key} retained for inspection`);
      continue;
    }
    if (!isPermissionSyncDue(intent)) continue;
    await reconcileChannelPermissions(client, intent.channelId);
  }
}

export function startPermissionSyncRecovery(client: Client): void {
  scheduleTask(PERMISSION_SYNC_TASK, PERMISSION_SYNC_INTERVAL_MS, async () => {
    await recoverPermissionSyncIntents(client);
  }, { exclusive: true, immediate: true });
}

export function stopPermissionSyncRecovery(): void {
  unscheduleTask(PERMISSION_SYNC_TASK);
}
