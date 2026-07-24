import { randomUUID } from 'node:crypto';
import type { Guild, MessageEditOptions } from 'discord.js';
import type { BublikClient } from '../../bot';
import { getRedis } from '../../core/Redis';
import { logger } from '../../core/Logger';
import { isGuildAllowed } from '../../core/Whitelist';
import { scheduleTask, unscheduleTask, waitForPromiseWithin } from '../../core/SchedulerManager';
import { getGuildLocale } from '../../core/GuildConfig';
import { buildOrdersEndedEmbed } from './embeds';
import { isUnknownChannelError, isUnknownMemberError, isUnknownMessageError } from './safety';
import { hasDiscordErrorCode } from '../../utils/helpers';

const log = logger.child('RegBattle:OrdersMutes');
const RECORD_PREFIX = 'rb:orders-mute';
const LOCK_PREFIX = 'rb:orders-mute:lock';
const RECOVERY_INTERVAL_MS = 10_000;
const CLEANUP_LOCK_TTL_MS = 60_000;
const CLEANUP_LOCK_RENEW_MS = 20_000;
const timers = new Map<string, ReturnType<typeof setTimeout>>();
const inFlightMutations = new Set<Promise<unknown>>();
const inFlightHandlers = new Set<Promise<unknown>>();
const inFlightRecoveryWork = new Set<Promise<unknown>>();

export class OrdersMuteRuntimeFence {
  private generation = 0;

  begin(): () => boolean {
    const captured = ++this.generation;
    return () => captured === this.generation;
  }

  capture(): () => boolean {
    const captured = this.generation;
    return () => captured === this.generation;
  }

  invalidate(): void {
    this.generation++;
  }
}

const runtimeFence = new OrdersMuteRuntimeFence();

export function beginOrdersMuteRuntime(): void {
  runtimeFence.begin();
}

export interface OrdersMuteRecord {
  version: 1;
  status: 'muting' | 'active' | 'cleaning';
  guildId: string;
  squadId: string;
  ownerId: string;
  userIds: string[];
  createdAt: number;
  expiresAt: number;
  notificationChannelId: string | null;
  notificationMessageId: string | null;
  cleanupToken: string | null;
}

export interface OrdersMuteCasStore {
  read(key: string): Promise<string | null>;
  compareSet(key: string, expected: string, next: string): Promise<boolean>;
  compareDelete(key: string, expected: string): Promise<boolean>;
}

export interface OrdersMuteCleanupLeaseStore {
  acquire(key: string, token: string, ttlMs: number): Promise<boolean>;
  readToken(key: string): Promise<string | null>;
  renew(key: string, token: string, ttlMs: number): Promise<boolean>;
  release(key: string, token: string): Promise<void>;
}

export interface OrdersMuteCleanupLeaseTiming {
  ttlMs: number;
  renewMs: number;
}

export type OrdersMuteCleanupLeaseResult<T> =
  | { acquired: false }
  | { acquired: true; value: T };

const DEFAULT_CLEANUP_LEASE_TIMING: OrdersMuteCleanupLeaseTiming = {
  ttlMs: CLEANUP_LOCK_TTL_MS,
  renewMs: CLEANUP_LOCK_RENEW_MS,
};

export class OrdersMuteCleanupLeaseLostError extends Error {
  constructor(label: string, options?: ErrorOptions) {
    super(`${label} lease was lost`, options);
    this.name = 'OrdersMuteCleanupLeaseLostError';
  }
}

class OrdersMuteRuntimeObsoleteError extends Error {
  constructor() {
    super('Orders mute runtime generation is obsolete');
    this.name = 'OrdersMuteRuntimeObsoleteError';
  }
}

export interface OrdersMuteCleanupClaim {
  record: OrdersMuteRecord;
  raw: string;
}

/**
 * A renewable exact-token lease. Every external mutation must call the
 * provided predicate immediately before and after its request. A failed renew
 * is treated as ownership loss even if a later read happens to succeed.
 */
export async function withOrdersMuteCleanupLease<T>(
  store: OrdersMuteCleanupLeaseStore,
  key: string,
  task: (assertOwned: () => Promise<void>, token: string) => Promise<T>,
  timing: Partial<OrdersMuteCleanupLeaseTiming> = {},
): Promise<OrdersMuteCleanupLeaseResult<T>> {
  const resolvedTiming = { ...DEFAULT_CLEANUP_LEASE_TIMING, ...timing };
  if (
    !Number.isFinite(resolvedTiming.ttlMs) || resolvedTiming.ttlMs <= 0 ||
    !Number.isFinite(resolvedTiming.renewMs) || resolvedTiming.renewMs <= 0 ||
    resolvedTiming.renewMs >= resolvedTiming.ttlMs
  ) {
    throw new Error('Orders mute cleanup lease timing is invalid');
  }
  const token = randomUUID();
  if (!await store.acquire(key, token, resolvedTiming.ttlMs)) return { acquired: false };

  let lost = false;
  let renewInFlight = false;
  const label = `Orders mute cleanup ${key}`;
  const renewTimer = setInterval(() => {
    if (renewInFlight || lost) return;
    renewInFlight = true;
    void store.renew(key, token, resolvedTiming.ttlMs)
      .then((renewed) => { if (!renewed) lost = true; })
      .catch(() => { lost = true; })
      .finally(() => { renewInFlight = false; });
  }, resolvedTiming.renewMs);
  renewTimer.unref?.();

  const assertOwned = async (): Promise<void> => {
    if (lost) throw new OrdersMuteCleanupLeaseLostError(label);
    let currentToken: string | null;
    try {
      currentToken = await store.readToken(key);
    } catch (error) {
      lost = true;
      throw new OrdersMuteCleanupLeaseLostError(label, { cause: error });
    }
    if (lost || currentToken !== token) {
      lost = true;
      throw new OrdersMuteCleanupLeaseLostError(label);
    }
  };

  try {
    await assertOwned();
    return { acquired: true, value: await task(assertOwned, token) };
  } finally {
    clearInterval(renewTimer);
    await store.release(key, token).catch((error: unknown) =>
      log.warn(`${label} lease was not released`, { error: String(error) }));
  }
}

/** Retry once under a fresh lease after any failure past the durable claim. */
export async function runOrdersMuteCleanupWithImmediateRepair<T>(
  attempt: (markRepairable: () => void) => Promise<T>,
  repair: () => Promise<T>,
): Promise<T> {
  let repairable = false;
  try {
    return await attempt(() => { repairable = true; });
  } catch (error) {
    if (!repairable) throw error;
    try {
      return await repair();
    } catch (repairError) {
      throw new AggregateError(
        [error, repairError],
        'Orders mute cleanup and immediate repair both failed',
      );
    }
  }
}

export function selectOrdersMuteCandidateIds(
  members: ReadonlyArray<{ id: string; serverMute: boolean | null }>,
): string[] {
  return [...new Set(members.filter((member) => member.serverMute === false).map((member) => member.id))];
}

function recordKey(guildId: string, squadId: string): string {
  return `${RECORD_PREFIX}:${guildId}:${squadId}`;
}

function lockKey(guildId: string, squadId: string): string {
  return `${LOCK_PREFIX}:${guildId}:${squadId}`;
}

export function parseOrdersMuteRecord(value: unknown): OrdersMuteRecord | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Partial<OrdersMuteRecord>;
  if (
    record.version !== 1 ||
    !['muting', 'active', 'cleaning'].includes(String(record.status)) ||
    typeof record.guildId !== 'string' ||
    typeof record.squadId !== 'string' ||
    typeof record.ownerId !== 'string' ||
    !Array.isArray(record.userIds) ||
    !record.userIds.every((id) => typeof id === 'string') ||
    typeof record.createdAt !== 'number' || !Number.isFinite(record.createdAt) ||
    typeof record.expiresAt !== 'number' || !Number.isFinite(record.expiresAt) ||
    record.expiresAt < record.createdAt ||
    !(typeof record.notificationChannelId === 'string' || record.notificationChannelId === null) ||
    !(typeof record.notificationMessageId === 'string' || record.notificationMessageId === null) ||
    !(
      typeof record.cleanupToken === 'string' ||
      record.cleanupToken === null ||
      record.cleanupToken === undefined
    ) ||
    (record.status === 'cleaning' && !record.cleanupToken) ||
    (record.status !== 'cleaning' && Boolean(record.cleanupToken))
  ) return null;
  return {
    ...record,
    userIds: [...new Set(record.userIds)],
    cleanupToken: record.cleanupToken ?? null,
  } as OrdersMuteRecord;
}

function parseRawRecord(raw: string | null): OrdersMuteRecord | null {
  if (!raw) return null;
  try {
    return parseOrdersMuteRecord(JSON.parse(raw));
  } catch {
    return null;
  }
}

function redisOrdersMuteCasStore(
  ownership?: { leaseKey: string; leaseToken: string },
): OrdersMuteCasStore {
  const redis = getRedis();
  return {
    read: (key) => redis.get(key),
    async compareSet(key, expected, next) {
      const changed = ownership
        ? await redis.eval(
          'if redis.call("get", KEYS[1]) == ARGV[1] and redis.call("get", KEYS[2]) == ARGV[2] then redis.call("set", KEYS[1], ARGV[3]); return 1 else return 0 end',
          2,
          key,
          ownership.leaseKey,
          expected,
          ownership.leaseToken,
          next,
        )
        : await redis.eval(
          'if redis.call("get", KEYS[1]) == ARGV[1] then redis.call("set", KEYS[1], ARGV[2]); return 1 else return 0 end',
          1,
          key,
          expected,
          next,
        );
      return Number(changed) === 1;
    },
    async compareDelete(key, expected) {
      const deleted = ownership
        ? await redis.eval(
          'if redis.call("get", KEYS[1]) == ARGV[1] and redis.call("get", KEYS[2]) == ARGV[2] then return redis.call("del", KEYS[1]) else return 0 end',
          2,
          key,
          ownership.leaseKey,
          expected,
          ownership.leaseToken,
        )
        : await redis.eval(
          'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end',
          1,
          key,
          expected,
        );
      return Number(deleted) === 1;
    },
  };
}

/**
 * Atomically fences cleanup by replacing the exact active snapshot with a
 * tokenised `cleaning` row. NX writers cannot publish a replacement until the
 * matching cleanup either deletes this row or a later recovery resumes it.
 */
export async function claimExactOrdersMuteCleanup(
  store: OrdersMuteCasStore,
  key: string,
  expectedRaw: string,
  force: boolean,
  now: number,
  cleanupToken = randomUUID(),
  isCurrent: () => boolean = () => true,
): Promise<OrdersMuteCleanupClaim | null> {
  if (!isCurrent()) return null;
  const currentRaw = await store.read(key);
  if (!isCurrent()) return null;
  if (!currentRaw || currentRaw !== expectedRaw) return null;
  const current = parseRawRecord(currentRaw);
  if (!current) return null;
  if (current.status === 'cleaning') return { record: current, raw: currentRaw };
  if (!force && current.expiresAt > now) return null;

  const cleaning: OrdersMuteRecord = {
    ...current,
    status: 'cleaning',
    cleanupToken,
  };
  const cleaningRaw = JSON.stringify(cleaning);
  if (!isCurrent()) return null;
  if (!await store.compareSet(key, currentRaw, cleaningRaw)) return null;
  return { record: cleaning, raw: cleaningRaw };
}

export async function deleteExactOrdersMuteCleanup(
  store: OrdersMuteCasStore,
  key: string,
  claimRaw: string,
): Promise<boolean> {
  return store.compareDelete(key, claimRaw);
}

async function scanRecordKeys(): Promise<string[]> {
  const redis = getRedis();
  const keys: string[] = [];
  let cursor = '0';
  do {
    const [next, page] = await redis.scan(cursor, 'MATCH', `${RECORD_PREFIX}:*`, 'COUNT', 100);
    cursor = next;
    keys.push(...page.filter((key) => !key.startsWith(`${LOCK_PREFIX}:`)));
  } while (cursor !== '0');
  return keys;
}

export async function claimOrdersMute(record: OrdersMuteRecord): Promise<boolean> {
  const parsed = parseOrdersMuteRecord(record);
  if (!parsed || parsed.status !== 'muting' || parsed.cleanupToken || record.userIds.length === 0) {
    return false;
  }
  const claimed = await getRedis().set(
    recordKey(record.guildId, record.squadId),
    JSON.stringify(record),
    'NX',
  );
  return claimed === 'OK';
}

export async function updateOrdersMuteRecord(
  record: OrdersMuteRecord,
  update: Partial<Pick<
    OrdersMuteRecord,
    'status' | 'expiresAt' | 'userIds' | 'notificationChannelId' | 'notificationMessageId'
  >>,
): Promise<OrdersMuteRecord> {
  if (record.status === 'cleaning') {
    throw new Error('Orders mute cleanup record is immutable');
  }
  const next: OrdersMuteRecord = {
    ...record,
    ...update,
    userIds: [...new Set(update.userIds ?? record.userIds)],
  };
  const replaced = await getRedis().eval(
    'if redis.call("get", KEYS[1]) == ARGV[1] then redis.call("set", KEYS[1], ARGV[2]); return 1 else return 0 end',
    1,
    recordKey(record.guildId, record.squadId),
    JSON.stringify(record),
    JSON.stringify(next),
  );
  if (Number(replaced) !== 1) throw new Error('Orders mute record changed concurrently');
  return next;
}

/** Graceful unload waits for Discord mute requests before forcing unmute. */
export async function trackOrdersMuteMutation<T>(task: () => Promise<T>): Promise<T> {
  const promise = task();
  inFlightMutations.add(promise);
  try {
    return await promise;
  } finally {
    inFlightMutations.delete(promise);
  }
}

export function captureOrdersMuteRuntime(): () => boolean {
  return runtimeFence.capture();
}

export async function trackOrdersMuteHandler<T>(task: () => Promise<T>): Promise<T> {
  const promise = task();
  inFlightHandlers.add(promise);
  try {
    return await promise;
  } finally {
    inFlightHandlers.delete(promise);
  }
}

async function trackOrdersRecoveryWork<T>(task: () => Promise<T>): Promise<T> {
  const promise = task();
  inFlightRecoveryWork.add(promise);
  try {
    return await promise;
  } finally {
    inFlightRecoveryWork.delete(promise);
  }
}

function redisOrdersMuteCleanupLeaseStore(): OrdersMuteCleanupLeaseStore {
  const redis = getRedis();
  return {
    async acquire(key, token, ttlMs) {
      return await redis.set(key, token, 'PX', ttlMs, 'NX') === 'OK';
    },
    readToken: (key) => redis.get(key),
    async renew(key, token, ttlMs) {
      const renewed = await redis.eval(
        'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("pexpire", KEYS[1], ARGV[2]) else return 0 end',
        1,
        key,
        token,
        String(ttlMs),
      );
      return Number(renewed) === 1;
    },
    async release(key, token) {
      await redis.eval(
        'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end',
        1,
        key,
        token,
      );
    },
  };
}

export function isOrdersMuteTargetAuthoritativelyGone(error: unknown): boolean {
  return isUnknownMemberError(error) ||
    hasDiscordErrorCode(error, 10065) || // Unknown Voice State: member is not connected.
    hasDiscordErrorCode(error, 40032); // Target User Is Not Connected To Voice.
}

/**
 * Force-fetch the current voice state and always issue an idempotent unmute.
 * A cached `serverMute=false` is not evidence after an outcome-ambiguous mute.
 */
export async function unmuteClaimedOrdersMember(
  guild: Guild,
  userId: string,
  assertOwned: () => Promise<void> = async () => undefined,
  markDiscordMutation: () => void = () => undefined,
): Promise<void> {
  await assertOwned();
  let voiceState;
  try {
    voiceState = await guild.voiceStates.fetch(userId, { force: true });
  } catch (error) {
    if (isOrdersMuteTargetAuthoritativelyGone(error)) return;
    throw error;
  }

  await assertOwned();
  markDiscordMutation();
  try {
    await voiceState.setMute(
      false,
      'ПБ: завершение/восстановление распоряжений',
    );
  } catch (error) {
    // Check ownership after an outcome-ambiguous REST rejection before
    // classifying a concurrent disconnect as authoritative completion.
    await assertOwned();
    if (isOrdersMuteTargetAuthoritativelyGone(error)) return;
    throw error;
  }
  await assertOwned();
}

type OrdersEndedPayloadFactory = (guildId: string) => Promise<MessageEditOptions>;

const buildDefaultOrdersEndedPayload: OrdersEndedPayloadFactory = async (guildId) => {
  const locale = await getGuildLocale(guildId);
  return { embeds: [buildOrdersEndedEmbed(locale)] };
};

/** Returns false on transient/ambiguous failures so the cleaning row is retried. */
export async function updateOrdersMuteNotification(
  guild: Guild,
  record: OrdersMuteRecord,
  assertOwned: () => Promise<void> = async () => undefined,
  markDiscordMutation: () => void = () => undefined,
  payloadFactory: OrdersEndedPayloadFactory = buildDefaultOrdersEndedPayload,
): Promise<boolean> {
  if (!record.notificationChannelId || !record.notificationMessageId) return true;

  let channel;
  try {
    channel = guild.channels.cache.get(record.notificationChannelId) ??
      await guild.channels.fetch(record.notificationChannelId);
  } catch (error) {
    if (isUnknownChannelError(error)) return true;
    log.warn(`Orders notification ${record.guildId}:${record.squadId} не обновлено`, {
      error: String(error),
    });
    return false;
  }
  if (!channel?.isTextBased()) return true;

  let message;
  try {
    message = await channel.messages.fetch(record.notificationMessageId);
  } catch (error) {
    if (isUnknownChannelError(error) || isUnknownMessageError(error)) return true;
    log.warn(`Orders notification ${record.guildId}:${record.squadId} не обновлено`, {
      error: String(error),
    });
    return false;
  }

  let payload: MessageEditOptions;
  try {
    payload = await payloadFactory(guild.id);
  } catch (error) {
    log.warn(`Orders notification ${record.guildId}:${record.squadId} не обновлено`, {
      error: String(error),
    });
    return false;
  }

  await assertOwned();
  markDiscordMutation();
  try {
    await message.edit(payload);
  } catch (error) {
    await assertOwned();
    if (isUnknownChannelError(error) || isUnknownMessageError(error)) return true;
    log.warn(`Orders notification ${record.guildId}:${record.squadId} не обновлено`, {
      error: String(error),
    });
    return false;
  }
  await assertOwned();
  return true;
}

async function completeOrdersMute(
  client: BublikClient,
  requestedRecord: OrdersMuteRecord,
  force: boolean,
  expectedRaw = JSON.stringify(requestedRecord),
  isCurrent: () => boolean = () => true,
): Promise<boolean> {
  let repairClaim: OrdersMuteCleanupClaim | null = null;

  try {
    return await runOrdersMuteCleanupWithImmediateRepair(
      async (markRepairable) => completeOrdersMuteAttempt(
        client,
        requestedRecord,
        force,
        expectedRaw,
        isCurrent,
        (claim) => {
          repairClaim = claim;
          markRepairable();
        },
      ),
      async () => repairClaim
        ? completeOrdersMuteAttempt(
          client,
          repairClaim.record,
          true,
          repairClaim.raw,
          isCurrent,
          () => undefined,
        )
        : false,
    );
  } catch (error) {
    log.warn(`Orders cleanup ${requestedRecord.guildId}:${requestedRecord.squadId} будет повторён`, {
      error: String(error),
    });
    return false;
  }
}

async function completeOrdersMuteAttempt(
  client: BublikClient,
  requestedRecord: OrdersMuteRecord,
  force: boolean,
  expectedRaw: string,
  isCurrent: () => boolean,
  onClaim: (claim: OrdersMuteCleanupClaim) => void,
): Promise<boolean> {
  if (!isCurrent()) return false;
  if (!force && requestedRecord.status !== 'cleaning' && requestedRecord.expiresAt > Date.now()) {
    return false;
  }

  const cleanupLeaseKey = lockKey(requestedRecord.guildId, requestedRecord.squadId);
  const leased = await withOrdersMuteCleanupLease(
    redisOrdersMuteCleanupLeaseStore(),
    cleanupLeaseKey,
    async (assertLeaseOwned, leaseToken) => {
      const assertOwned = async (): Promise<void> => {
        if (!isCurrent()) throw new OrdersMuteRuntimeObsoleteError();
        await assertLeaseOwned();
      };

      await assertOwned();
      const key = recordKey(requestedRecord.guildId, requestedRecord.squadId);
      const store = redisOrdersMuteCasStore({ leaseKey: cleanupLeaseKey, leaseToken });
      const claim = await claimExactOrdersMuteCleanup(
        store,
        key,
        expectedRaw,
        force,
        Date.now(),
        randomUUID(),
        isCurrent,
      );
      if (!claim) return false;
      onClaim(claim);
      await assertOwned();

      const current = claim.record;
      if (!isGuildAllowed(current.guildId)) return false;
      const guild = client.guilds.cache.get(current.guildId);
      if (!guild) return false;

      const unmuteErrors: unknown[] = [];
      for (const userId of current.userIds) {
        try {
          await unmuteClaimedOrdersMember(guild, userId, assertOwned);
        } catch (error) {
          if (
            error instanceof OrdersMuteCleanupLeaseLostError ||
            error instanceof OrdersMuteRuntimeObsoleteError
          ) throw error;
          unmuteErrors.push(error);
          log.warn(`Orders unmute ${current.guildId}:${userId} будет повторён`, {
            error: String(error),
          });
        }
      }
      if (unmuteErrors.length > 0) {
        throw new AggregateError(unmuteErrors, `Orders unmute ${current.guildId}:${current.squadId} incomplete`);
      }

      if (!await updateOrdersMuteNotification(guild, current, assertOwned)) return false;
      await assertOwned();
      if (!await deleteExactOrdersMuteCleanup(store, key, claim.raw)) {
        // Turn an ownership-CAS rejection into immediate convergence. A benign
        // record change while we still own the lease simply remains retryable.
        await assertOwned();
        return false;
      }

      const timer = timers.get(key);
      if (timer) clearTimeout(timer);
      timers.delete(key);
      return true;
    },
  );
  return leased.acquired ? leased.value : false;
}

export function scheduleOrdersMuteRecovery(
  record: OrdersMuteRecord,
  client: BublikClient,
  isCurrent: () => boolean,
  expectedRaw = JSON.stringify(record),
): boolean {
  if (!isCurrent()) return false;
  const key = recordKey(record.guildId, record.squadId);
  const old = timers.get(key);
  if (old) clearTimeout(old);
  const delay = Math.max(0, record.expiresAt - Date.now());
  const timer = setTimeout(() => {
    timers.delete(key);
    if (!isCurrent()) return;
    void trackOrdersRecoveryWork(() =>
      completeOrdersMute(client, record, false, expectedRaw, isCurrent)).catch((error: unknown) =>
      log.warn(`Orders timer ${record.guildId}:${record.squadId} будет повторён`, { error: String(error) }));
  }, delay);
  timers.set(key, timer);
  return true;
}

export async function recoverOrdersMutes(
  client: BublikClient,
  force = false,
  isCurrent: () => boolean = () => true,
): Promise<void> {
  if (!isCurrent()) return;
  const keys = await scanRecordKeys();
  if (!isCurrent()) return;
  for (const key of keys) {
    if (!isCurrent()) return;
    try {
      const raw = await getRedis().get(key);
      if (!isCurrent()) return;
      const record = parseRawRecord(raw);
      if (!raw || !record) {
        log.error(`Повреждённая orders mute запись ${key} сохранена для ручного recovery`);
        continue;
      }
      if (!isGuildAllowed(record.guildId)) continue;
      if (force || record.status === 'cleaning' || record.expiresAt <= Date.now()) {
        await completeOrdersMute(client, record, force, raw, isCurrent);
      } else {
        scheduleOrdersMuteRecovery(record, client, isCurrent, raw);
      }
    } catch (error) {
      log.warn(`Orders mute recovery ${key} будет повторён`, { error: String(error) });
    }
  }
}

export function startOrdersMuteRecovery(client: BublikClient): void {
  const isCurrent = runtimeFence.capture();
  scheduleTask('regbattle:ordersMuteRecovery', RECOVERY_INTERVAL_MS, async () => {
    await trackOrdersRecoveryWork(() => recoverOrdersMutes(client, false, isCurrent));
  });
  void trackOrdersRecoveryWork(() => recoverOrdersMutes(client, false, isCurrent)).catch((error: unknown) =>
    log.error('Initial orders mute recovery failed', { error: String(error) }));
}

export async function stopOrdersMuteRecovery(
  client: BublikClient,
  timeoutMs = 15_000,
): Promise<boolean> {
  const isShutdownCurrent = runtimeFence.begin();
  unscheduleTask('regbattle:ordersMuteRecovery');
  for (const timer of timers.values()) clearTimeout(timer);
  timers.clear();
  const deadline = Date.now() + timeoutMs;
  if (!await waitForPromiseWithin(
    Promise.allSettled([...inFlightHandlers, ...inFlightMutations, ...inFlightRecoveryWork]),
    Math.max(0, deadline - Date.now()),
  )) {
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
    runtimeFence.invalidate();
    log.warn(`Таймаут ожидания ${inFlightHandlers.size + inFlightMutations.size + inFlightRecoveryWork.size} orders mute operation`);
    return false;
  }

  // A handler may have scheduled a timer just before its final await settled.
  for (const timer of timers.values()) clearTimeout(timer);
  timers.clear();
  const recovery = trackOrdersRecoveryWork(() =>
    recoverOrdersMutes(client, true, isShutdownCurrent));
  // A timed-out recovery remains observed even though unload continues.
  void recovery.catch((error: unknown) =>
    log.warn('Финальный orders mute recovery завершился ошибкой', { error: String(error) }));
  if (!await waitForPromiseWithin(recovery, Math.max(0, deadline - Date.now()))) {
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
    runtimeFence.invalidate();
    log.warn('Таймаут финального orders mute recovery');
    return false;
  }
  try {
    await recovery;
    runtimeFence.invalidate();
    return true;
  } catch {
    runtimeFence.invalidate();
    return false;
  }
}
