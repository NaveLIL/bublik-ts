// ═══════════════════════════════════════════════
//  Economy — Голосовой заработок (пассивный доход)
//
//  Начисления каждые 10 мин за присутствие в войсе.
//  Anti-AFK:
//    • мин. 2 человека в канале
//    • нельзя быть server-muted + server-deafened
//    • непрерывное присутствие ≥ 10 минут
//
//  Ставки:
//    • обычный войс: voiceRateBase ₪/ч
//    • ПБ-войс:     voiceRatePb ₪/ч
//    • + PB-множитель
// ═══════════════════════════════════════════════

import { VoiceState, Client, Guild, GuildMember, Role, VoiceChannel, StageChannel, Status } from 'discord.js';
import type { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { getRedis } from '../../core/Redis';
import { logger } from '../../core/Logger';
import { i18n } from '../../core/I18n';
import { getGuildLocale } from '../../core/GuildConfig';
import { getDatabase } from '../../core/Database';
import { successEmbed } from '../../core/EmbedBuilder';
import { invalidateProfileCache, getEcoConfig } from './database';
import { applyWalletDeltaInTransaction, claimOperationInTransaction, getPbTier } from './profile';
import {
  drainScheduledTasksByPrefix,
  scheduleTask,
  unscheduleTask,
} from '../../core/SchedulerManager';
import { isGuildAllowed } from '../../core/Whitelist';
import {
  fetchSafeAutomaticRole,
} from '../../core/RolePolicy';
import { withMemberRoleLock } from '../../core/MemberRoleLock';
import {
  REDIS_ECO_VOICE,
  VOICE_TICK_INTERVAL_MS,
  VOICE_MIN_MEMBERS,
  DEFAULTS,
  TX,
  PB_TIERS,
} from './constants';
import { newsEarning } from './news';
import { hasForbiddenEconomyRewardPermissions } from './reward-role-policy';
import { lockEconomyUserMutation } from './user-mutation-lock';
import {
  completePbTierReconciliationIntent,
  loadPbTierReconciliationSnapshot,
} from './pb-tier-reconciliation';
import {
  encodeVoiceRewardTransactionTarget,
  parseVoiceRewardTransactionTarget,
} from './voice-reward-metadata';

// Импорт ПБ-канальных ID для проверки ПБ-войсов
import {
  getAllPbChannelIds,
  getConfig as getRegbattleConfig,
} from '../regbattle/database';

const log = logger.child('Economy:voice');
const VOICE_CONFIG_REFRESH_MS = 60_000;
const VOICE_REWARD_CURSOR_SCOPE = 'voice_reward_cursor';
const VOICE_REWARD_CURSOR_VERSION = 1 as const;
const VOICE_PRESENCE_VERSION = 4 as const;
const VOICE_PRESENCE_NAMESPACE_VERSION = 'v4';
const VOICE_PRESENCE_TTL_MS = 24 * 60 * 60_000;
const PB_TOPOLOGY_RETRY_DELAYS_MS = [150, 500] as const;
const PB_TIER_SYNC_CONCURRENCY = 4;
const VOICE_RUNTIME_OWNER_ID = randomUUID();
const voiceGuildTasks = new Map<string, { name: string; intervalMs: number }>();
let voiceTickerActive = false;
let voiceTickerGeneration = 0;
let voiceReconnectClient: Client | null = null;
let voiceShardDisconnectListener: ((event: unknown, shardId: number) => void) | null = null;
let voiceShardReconnectingListener: ((shardId: number) => void) | null = null;
let voiceShardReadyListener: ((shardId: number) => void) | null = null;
let voiceShardResumeListener: ((shardId: number) => void) | null = null;
let voiceGuildUnavailableListener: ((guild: Guild) => void) | null = null;
let voiceGuildAvailableListener: ((guild: Guild) => void) | null = null;
let voiceRuntimeRedis: ReturnType<typeof getRedis> | null = null;
let voiceRedisUnavailableListener: (() => void) | null = null;
let voiceRedisReadyListener: (() => void) | null = null;

export interface VoiceRuntimeRecoveryToken {
  scope: 'redis' | 'shard' | 'guild';
  runtimeGeneration: number;
  generation: number;
  shardId?: number;
  guildId?: string;
}

export interface VoicePayoutRuntimeSnapshot {
  runtimeGeneration: number;
  shardId: number;
  shardGeneration: number;
  guildId: string | null;
  guildGeneration: number;
  redisGeneration: number;
}

/**
 * Synchronous health fence around external Discord/Redis observations. A
 * disconnect invalidates every previously captured snapshot immediately; a
 * matching reset token is the only operation allowed to reopen the fence.
 */
export class VoicePayoutRuntimeGate {
  private readonly shardGenerations = new Map<number, number>();
  private readonly blockedShards = new Set<number>();
  private readonly guildGenerations = new Map<string, number>();
  private readonly blockedGuilds = new Set<string>();
  private runtimeGeneration = 0;
  private redisGeneration = 0;
  private redisHealthy = false;

  reset(): void {
    this.runtimeGeneration += 1;
    this.shardGenerations.clear();
    this.blockedShards.clear();
    this.guildGenerations.clear();
    this.blockedGuilds.clear();
    this.redisGeneration += 1;
    this.redisHealthy = false;
  }

  blockShard(shardId: number): void {
    this.shardGenerations.set(shardId, (this.shardGenerations.get(shardId) ?? 0) + 1);
    this.blockedShards.add(shardId);
  }

  beginShardRecovery(shardId: number): VoiceRuntimeRecoveryToken {
    this.blockShard(shardId);
    return {
      scope: 'shard',
      runtimeGeneration: this.runtimeGeneration,
      shardId,
      generation: this.shardGenerations.get(shardId)!,
    };
  }

  blockGuild(guildId: string): void {
    this.guildGenerations.set(guildId, (this.guildGenerations.get(guildId) ?? 0) + 1);
    this.blockedGuilds.add(guildId);
  }

  beginGuildRecovery(guildId: string): VoiceRuntimeRecoveryToken {
    this.blockGuild(guildId);
    return {
      scope: 'guild',
      runtimeGeneration: this.runtimeGeneration,
      guildId,
      generation: this.guildGenerations.get(guildId)!,
    };
  }

  blockRedis(): void {
    this.redisGeneration += 1;
    this.redisHealthy = false;
  }

  beginRedisRecovery(): VoiceRuntimeRecoveryToken {
    this.blockRedis();
    return {
      scope: 'redis',
      runtimeGeneration: this.runtimeGeneration,
      generation: this.redisGeneration,
    };
  }

  completeRecovery(token: VoiceRuntimeRecoveryToken): boolean {
    if (!this.isRecoveryTokenCurrent(token)) return false;
    if (token.scope === 'redis') {
      this.redisHealthy = true;
      return true;
    }
    if (token.scope === 'guild') {
      if (token.guildId === undefined) return false;
      this.blockedGuilds.delete(token.guildId);
      return true;
    }
    if (token.shardId === undefined) return false;
    this.blockedShards.delete(token.shardId);
    return true;
  }

  isRecoveryTokenCurrent(token: VoiceRuntimeRecoveryToken): boolean {
    if (token.runtimeGeneration !== this.runtimeGeneration) return false;
    if (token.scope === 'redis') return token.generation === this.redisGeneration;
    if (token.scope === 'guild') {
      return token.guildId !== undefined &&
        token.generation === this.guildGenerations.get(token.guildId);
    }
    return token.shardId !== undefined &&
      token.generation === this.shardGenerations.get(token.shardId);
  }

  capture(shardId: number, guildId: string | null = null): VoicePayoutRuntimeSnapshot | null {
    if (
      !this.redisHealthy ||
      this.blockedShards.has(shardId) ||
      (guildId !== null && this.blockedGuilds.has(guildId))
    ) return null;
    return {
      runtimeGeneration: this.runtimeGeneration,
      shardId,
      shardGeneration: this.shardGenerations.get(shardId) ?? 0,
      guildId,
      guildGeneration: guildId === null ? 0 : (this.guildGenerations.get(guildId) ?? 0),
      redisGeneration: this.redisGeneration,
    };
  }

  isCurrent(snapshot: VoicePayoutRuntimeSnapshot): boolean {
    return snapshot.runtimeGeneration === this.runtimeGeneration &&
      this.redisHealthy &&
      !this.blockedShards.has(snapshot.shardId) &&
      (this.shardGenerations.get(snapshot.shardId) ?? 0) === snapshot.shardGeneration &&
      (snapshot.guildId === null || (
        !this.blockedGuilds.has(snapshot.guildId) &&
        (this.guildGenerations.get(snapshot.guildId) ?? 0) === snapshot.guildGeneration
      )) &&
      this.redisGeneration === snapshot.redisGeneration;
  }

  isRedisBlocked(): boolean {
    return !this.redisHealthy;
  }
}

export class VoicePresenceContinuityGuard {
  private readonly quarantines = new Map<string, string>();

  quarantine(key: string): string {
    const token = randomUUID();
    this.quarantines.set(key, token);
    return token;
  }

  currentToken(key: string): string | null {
    return this.quarantines.get(key) ?? null;
  }

  release(key: string, token: string): boolean {
    if (this.quarantines.get(key) !== token) return false;
    this.quarantines.delete(key);
    return true;
  }

  isQuarantined(key: string): boolean {
    return this.quarantines.has(key);
  }

  snapshot(predicate: (key: string) => boolean = () => true): Map<string, string> {
    return new Map([...this.quarantines].filter(([key]) => predicate(key)));
  }

  releaseSnapshot(snapshot: ReadonlyMap<string, string>): number {
    let released = 0;
    for (const [key, token] of snapshot) {
      if (this.release(key, token)) released += 1;
    }
    return released;
  }

  clear(): void {
    this.quarantines.clear();
  }
}

/** A serial queue whose tail can be drained before the module cache is replaced. */
export class VoiceSerializedWorkQueue {
  private tail: Promise<void> = Promise.resolve();

  enqueue(work: () => Promise<void>): Promise<void> {
    const next = this.tail.catch(() => undefined).then(work);
    this.tail = next;
    return next;
  }

  snapshot(): Promise<void> {
    return this.tail;
  }

  isCurrent(work: Promise<void>): boolean {
    return this.tail === work;
  }

  async drain(): Promise<void> {
    while (true) {
      const current = this.tail;
      await current.catch(() => undefined);
      if (this.tail === current) return;
    }
  }
}

/**
 * Coalesces synchronous recovery requests into one batch and folds requests
 * that arrive while a batch is running into the same serialized pump. A
 * failed batch stays failed until an external health signal requests a retry,
 * which prevents a tight retry loop while Redis is unavailable.
 */
export class VoiceCoalescedRecoveryPump<T> {
  private requested = false;
  private active: Promise<void> | null = null;

  constructor(
    private readonly queue: VoiceSerializedWorkQueue,
    private readonly loadBatch: () => readonly T[],
    private readonly worker: (batch: readonly T[]) => Promise<void>,
  ) {}

  request(): Promise<void> {
    this.requested = true;
    if (this.active) return this.active;

    const run = this.queue.enqueue(async () => {
      while (this.requested) {
        this.requested = false;
        const batch = this.loadBatch();
        if (batch.length === 0) continue;
        await this.worker(batch);
      }
    });
    this.active = run;
    void run.then(
      () => this.finish(run, true),
      () => this.finish(run, false),
    );
    return run;
  }

  cancelPending(): void {
    this.requested = false;
  }

  async drain(): Promise<void> {
    while (this.active) {
      const current = this.active;
      await current.catch(() => undefined);
      if (this.active === current) return;
    }
  }

  private finish(run: Promise<void>, succeeded: boolean): void {
    if (this.active !== run) return;
    this.active = null;
    if (succeeded && this.requested) void this.request().catch(() => undefined);
  }
}

export async function completeVoicePresenceTransitionAfterWrite(
  guard: VoicePresenceContinuityGuard,
  key: string,
  token: string,
  write: () => Promise<void>,
): Promise<void> {
  await write();
  guard.release(key, token);
}

const voiceRuntimeGate = new VoicePayoutRuntimeGate();
const voiceContinuityGuard = new VoicePresenceContinuityGuard();
const voicePresenceResetQueue = new VoiceSerializedWorkQueue();
const voiceTransitionTasks = new Map<string, Promise<void>>();
let pendingRedisRecoveryToken: VoiceRuntimeRecoveryToken | null = null;
const pendingShardRecoveryTokens = new Map<number, VoiceRuntimeRecoveryToken>();
const pendingGuildRecoveryTokens = new Map<string, VoiceRuntimeRecoveryToken>();
let voiceRecoveryClient: Client | null = null;
const voiceRecoveryReasons = new Set<string>();

export function normalizeVoiceIntervalMs(value: unknown): number {
  const intervalMs = Number(value);
  return Number.isSafeInteger(intervalMs) && intervalMs >= 1_000
    ? intervalMs
    : VOICE_TICK_INTERVAL_MS;
}

export function calculateVoiceTickAmount(hourlyRate: number, intervalMs: number): number {
  if (!Number.isFinite(hourlyRate) || hourlyRate <= 0) return 0;
  return Math.floor(hourlyRate * normalizeVoiceIntervalMs(intervalMs) / 3_600_000);
}

export function normalizeVoiceMinMembers(value: unknown): number {
  const minMembers = Number(value);
  return Number.isSafeInteger(minMembers) && minMembers >= 1 && minMembers <= 99
    ? minMembers
    : VOICE_MIN_MEMBERS;
}

export function hasMinimumLiveVoiceMembers(humanCount: number, configuredMinimum: unknown): boolean {
  return Number.isSafeInteger(humanCount)
    && humanCount >= normalizeVoiceMinMembers(configuredMinimum);
}

export function crossedPbTierThreshold(
  previousSeconds: number,
  currentSeconds: number,
  configuredTierCount = PB_TIERS.length,
): boolean {
  if (
    !Number.isSafeInteger(previousSeconds) ||
    !Number.isSafeInteger(currentSeconds) ||
    previousSeconds < 0 ||
    currentSeconds <= previousSeconds
  ) return false;
  const tierCount = Math.min(
    PB_TIERS.length,
    Math.max(0, Number.isSafeInteger(configuredTierCount) ? configuredTierCount : 0),
  );
  return PB_TIERS.slice(0, tierCount).some((tier) => {
    const thresholdSeconds = tier.hours * 3_600;
    return previousSeconds < thresholdSeconds && currentSeconds >= thresholdSeconds;
  });
}

export async function runVoiceTasksWithConcurrency<T>(
  values: readonly T[],
  configuredLimit: number,
  worker: (value: T, index: number) => Promise<void>,
): Promise<void> {
  if (values.length === 0) return;
  const limit = Math.min(
    values.length,
    Math.max(1, Number.isSafeInteger(configuredLimit) ? configuredLimit : 1),
  );
  let nextIndex = 0;
  await Promise.all(Array.from({ length: limit }, async () => {
    while (true) {
      const index = nextIndex++;
      if (index >= values.length) return;
      await worker(values[index], index);
    }
  }));
}

export function voiceRewardBucketKey(
  guildId: string,
  userId: string,
  intervalMs: number,
  now: number,
): string {
  const normalized = normalizeVoiceIntervalMs(intervalMs);
  const bucketStart = Math.floor(now / normalized) * normalized;
  return `economy:voice-reward:${guildId}:${userId}:${normalized}:${bucketStart}`;
}

export function voiceRewardCursorKey(guildId: string, userId: string): string {
  return `economy:voice-reward-cursor:${guildId}:${userId}`;
}

export interface VoicePresenceObservation {
  version: typeof VOICE_PRESENCE_VERSION;
  ownerId: string;
  channelId: string;
  sessionId: string;
  observedAtMs: number;
  generation: string;
}

interface VoiceAfkState {
  serverMute: boolean | null;
  serverDeaf: boolean | null;
  selfMute: boolean | null;
  selfDeaf: boolean | null;
}

interface VoicePayoutState extends VoiceAfkState {
  channelId: string | null;
  sessionId: string | null;
}

export type VoicePresenceTransitionAction = 'preserve' | 'reset' | 'delete';

export function isVoiceAfkState(state: VoiceAfkState): boolean {
  return Boolean(
    (state.serverMute && state.serverDeaf) ||
    (state.selfMute && state.selfDeaf)
  );
}

export function isVoicePayoutAfkState(
  state: VoicePayoutState,
  guildAfkChannelId: string | null,
): boolean {
  return Boolean(
    (guildAfkChannelId && state.channelId === guildAfkChannelId) ||
    isVoiceAfkState(state)
  );
}

function voiceSessionId(state: Pick<VoicePayoutState, 'sessionId'>): string | null {
  return typeof state.sessionId === 'string' && state.sessionId.length > 0
    ? state.sessionId
    : null;
}

export function voicePresenceTransitionAction(
  oldChannelId: string | null,
  newChannelId: string | null,
  oldAfk: boolean,
  newAfk: boolean,
  oldSessionId: string | null = null,
  newSessionId: string | null = null,
): VoicePresenceTransitionAction {
  if (!newChannelId || newAfk || !newSessionId) return 'delete';
  if (
    oldChannelId !== newChannelId ||
    oldAfk ||
    !oldSessionId ||
    oldSessionId !== newSessionId
  ) return 'reset';
  return 'preserve';
}

export function parseVoicePresenceObservation(value: unknown): VoicePresenceObservation | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as Partial<VoicePresenceObservation>;
  if (
    candidate.version !== VOICE_PRESENCE_VERSION ||
    typeof candidate.ownerId !== 'string' || candidate.ownerId.length < 16 ||
    typeof candidate.channelId !== 'string' || candidate.channelId.length === 0 ||
    typeof candidate.sessionId !== 'string' || candidate.sessionId.length === 0 ||
    !isNonNegativeSafeInteger(candidate.observedAtMs) ||
    typeof candidate.generation !== 'string' || candidate.generation.length < 16
  ) return null;
  return candidate as VoicePresenceObservation;
}

export function isVoicePresenceObservationEligible(
  observation: VoicePresenceObservation,
  channelId: string,
  sessionId: string,
  nowMs: number,
  intervalMs: number,
  ownerId?: string,
): boolean {
  if (
    (ownerId !== undefined && observation.ownerId !== ownerId) ||
    observation.channelId !== channelId ||
    observation.sessionId !== sessionId ||
    !isNonNegativeSafeInteger(nowMs) ||
    nowMs < observation.observedAtMs
  ) return false;
  return nowMs - observation.observedAtMs >= normalizeVoiceIntervalMs(intervalMs);
}

export interface VoiceRewardCursorMetadata {
  version: typeof VOICE_REWARD_CURSOR_VERSION;
  lastPaidAtMs: number;
  lastIntervalMs: number;
  lastChannelId: string;
  lastIsPb: boolean;
  lastAmount: number;
  lastBucketStartMs: number;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

export function parseVoiceRewardCursorMetadata(value: unknown): VoiceRewardCursorMetadata | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as Partial<VoiceRewardCursorMetadata>;
  if (
    candidate.version !== VOICE_REWARD_CURSOR_VERSION ||
    !isNonNegativeSafeInteger(candidate.lastPaidAtMs) ||
    !isNonNegativeSafeInteger(candidate.lastIntervalMs) ||
    typeof candidate.lastChannelId !== 'string' ||
    typeof candidate.lastIsPb !== 'boolean' ||
    !isNonNegativeSafeInteger(candidate.lastAmount) ||
    !isNonNegativeSafeInteger(candidate.lastBucketStartMs)
  ) return null;
  return candidate as VoiceRewardCursorMetadata;
}

/**
 * The stable cursor, not a wall-clock bucket, defines when another interval is
 * payable. A channel move resets the continuous-presence anchor through
 * eligibleSinceMs, while a restart or interval change retains lastPaidAtMs.
 */
export function isVoiceRewardCursorDue(
  cursor: VoiceRewardCursorMetadata,
  eligibleSinceMs: number,
  nowMs: number,
  intervalMs: number,
): boolean {
  const normalizedIntervalMs = normalizeVoiceIntervalMs(intervalMs);
  if (
    !isNonNegativeSafeInteger(eligibleSinceMs) ||
    !isNonNegativeSafeInteger(nowMs) ||
    nowMs < eligibleSinceMs ||
    nowMs < cursor.lastPaidAtMs
  ) return false;
  const unpaidSinceMs = Math.max(eligibleSinceMs, cursor.lastPaidAtMs);
  return nowMs - unpaidSinceMs >= normalizedIntervalMs;
}

export interface PbVoiceTopologySources {
  loadChannelIds(guildId: string): Promise<readonly string[]>;
  loadConfig(guildId: string): Promise<{ reserveChannelId?: string | null } | null>;
}

export interface PbVoiceTopologyRetryOptions {
  maxAttempts?: number;
  delaysMs?: readonly number[];
  wait?: (delayMs: number) => Promise<void>;
}

/**
 * PB topology is authoritative payout input. Source failures propagate so a
 * tick retries later instead of durably claiming the bucket at the base rate.
 */
export async function loadPbVoiceChannelIds(
  guildId: string,
  economyChannelIds: readonly string[],
  sources: PbVoiceTopologySources = {
    loadChannelIds: getAllPbChannelIds,
    loadConfig: getRegbattleConfig,
  },
): Promise<Set<string>> {
  if (!guildId) throw new Error('PB voice topology requires a guild id');
  const [regbattleChannelIds, regbattleConfig] = await Promise.all([
    sources.loadChannelIds(guildId),
    sources.loadConfig(guildId),
  ]);
  return new Set([
    ...regbattleChannelIds,
    ...(regbattleConfig?.reserveChannelId ? [regbattleConfig.reserveChannelId] : []),
    ...economyChannelIds,
  ].filter((channelId): channelId is string => typeof channelId === 'string' && channelId.length > 0));
}

/** Bounded in-cycle retries keep a transient topology outage fail-closed. */
export async function loadPbVoiceChannelIdsWithRetry(
  guildId: string,
  economyChannelIds: readonly string[],
  sources?: PbVoiceTopologySources,
  options: PbVoiceTopologyRetryOptions = {},
): Promise<Set<string>> {
  const maxAttempts = Number.isSafeInteger(options.maxAttempts)
    ? Math.min(5, Math.max(1, Number(options.maxAttempts)))
    : PB_TOPOLOGY_RETRY_DELAYS_MS.length + 1;
  const delaysMs = options.delaysMs ?? PB_TOPOLOGY_RETRY_DELAYS_MS;
  const wait = options.wait ?? ((delayMs: number) =>
    new Promise<void>((resolve) => setTimeout(resolve, delayMs)));
  let lastError: unknown;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await loadPbVoiceChannelIds(guildId, economyChannelIds, sources);
    } catch (error) {
      lastError = error;
      if (attempt + 1 >= maxAttempts) break;
      const configuredDelay = delaysMs[Math.min(attempt, Math.max(0, delaysMs.length - 1))] ?? 0;
      const delayMs = Number.isFinite(configuredDelay)
        ? Math.min(2_000, Math.max(0, Math.floor(configuredDelay)))
        : 0;
      await wait(delayMs);
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error(`PB voice topology unavailable for ${guildId}`);
}

interface LatestVoiceRewardTransaction {
  createdAt: Date;
  amount: number;
  targetId: string | null;
}

interface LockedVoiceRewardCursor {
  key: string;
  metadata: VoiceRewardCursorMetadata;
  nowMs: number;
}

function initialVoiceRewardCursor(lastPaidAtMs = 0): VoiceRewardCursorMetadata {
  return {
    version: VOICE_REWARD_CURSOR_VERSION,
    lastPaidAtMs,
    lastIntervalMs: 0,
    lastChannelId: '',
    lastIsPb: false,
    lastAmount: 0,
    lastBucketStartMs: 0,
  };
}

function voiceRewardCursorJson(metadata: VoiceRewardCursorMetadata): Prisma.InputJsonObject {
  return {
    version: metadata.version,
    lastPaidAtMs: metadata.lastPaidAtMs,
    lastIntervalMs: metadata.lastIntervalMs,
    lastChannelId: metadata.lastChannelId,
    lastIsPb: metadata.lastIsPb,
    lastAmount: metadata.lastAmount,
    lastBucketStartMs: metadata.lastBucketStartMs,
  };
}

function cursorFromVoiceRewardTransaction(
  transaction: LatestVoiceRewardTransaction,
): VoiceRewardCursorMetadata {
  const target = parseVoiceRewardTransactionTarget(transaction.targetId);
  const intervalMs = target ? target.seconds * 1_000 : 0;
  const lastPaidAtMs = transaction.createdAt.getTime();
  return {
    ...initialVoiceRewardCursor(lastPaidAtMs),
    lastIntervalMs: intervalMs,
    lastIsPb: target?.isPb ?? false,
    lastAmount: Math.max(0, transaction.amount),
    lastBucketStartMs: intervalMs > 0
      ? Math.floor(lastPaidAtMs / intervalMs) * intervalMs
      : 0,
  };
}

async function readDatabaseClockMs(tx: Prisma.TransactionClient): Promise<number> {
  const rows = await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS "now"`;
  const nowMs = rows[0]?.now?.getTime();
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
    throw new Error('Voice reward database clock is unavailable');
  }
  return nowMs;
}

async function findLatestVoiceRewardTransaction(
  tx: Prisma.TransactionClient,
  guildId: string,
  userId: string,
): Promise<LatestVoiceRewardTransaction | null> {
  return tx.economyTransaction.findFirst({
    where: { guildId, userId, type: TX.EARN_VOICE },
    select: { createdAt: true, amount: true, targetId: true },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
  });
}

/**
 * INSERT .. ON CONFLICT serializes first creation of an absent cursor; the
 * following row lock serializes every later old/new scheduler generation.
 */
async function lockVoiceRewardCursor(
  tx: Prisma.TransactionClient,
  guildId: string,
  userId: string,
): Promise<LockedVoiceRewardCursor> {
  const key = voiceRewardCursorKey(guildId, userId);
  const created = await tx.operationClaim.createMany({
    data: [{
      key,
      scope: VOICE_REWARD_CURSOR_SCOPE,
      guildId,
      userId,
      metadata: voiceRewardCursorJson(initialVoiceRewardCursor()),
      expiresAt: null,
    }],
    skipDuplicates: true,
  });
  await tx.$queryRaw`SELECT "key" FROM "operation_claims" WHERE "key" = ${key} FOR UPDATE`;
  const row = await tx.operationClaim.findUniqueOrThrow({ where: { key } });
  if (
    row.scope !== VOICE_REWARD_CURSOR_SCOPE ||
    row.guildId !== guildId ||
    row.userId !== userId
  ) {
    throw new Error(`Voice reward cursor ownership mismatch for ${guildId}:${userId}`);
  }

  const nowMs = await readDatabaseClockMs(tx);
  let metadata = parseVoiceRewardCursorMetadata(row.metadata);
  if (created.count === 1 || !metadata) {
    const latest = await findLatestVoiceRewardTransaction(tx, guildId, userId);
    // A malformed pre-existing cursor with no transaction history is held for
    // one full interval instead of risking a duplicate credit.
    metadata = latest
      ? cursorFromVoiceRewardTransaction(latest)
      : initialVoiceRewardCursor(created.count === 1 ? 0 : nowMs);
    await tx.operationClaim.update({
      where: { key },
      data: { metadata: voiceRewardCursorJson(metadata), expiresAt: null },
    });
  }

  return { key, metadata, nowMs };
}

function nextVoiceRewardCursor(
  paidAtMs: number,
  intervalMs: number,
  channelId: string,
  isPbChannel: boolean,
  amount: number,
): VoiceRewardCursorMetadata {
  const normalizedIntervalMs = normalizeVoiceIntervalMs(intervalMs);
  return {
    version: VOICE_REWARD_CURSOR_VERSION,
    lastPaidAtMs: paidAtMs,
    lastIntervalMs: normalizedIntervalMs,
    lastChannelId: channelId,
    lastIsPb: isPbChannel,
    lastAmount: amount,
    lastBucketStartMs: Math.floor(paidAtMs / normalizedIntervalMs) * normalizedIntervalMs,
  };
}

export function voicePresenceOwnedKey(ownerId: string, guildId: string, userId: string): string {
  return `${REDIS_ECO_VOICE}:${VOICE_PRESENCE_NAMESPACE_VERSION}:${ownerId}:${guildId}:${userId}`;
}

function voicePresenceKey(guildId: string, userId: string): string {
  return voicePresenceOwnedKey(VOICE_RUNTIME_OWNER_ID, guildId, userId);
}

export function parseOwnedVoicePresenceKey(
  key: string,
  ownerId: string,
): { guildId: string; userId: string } | null {
  const prefix = `${REDIS_ECO_VOICE}:${VOICE_PRESENCE_NAMESPACE_VERSION}:${ownerId}:`;
  if (!key.startsWith(prefix)) return null;
  const parts = key.slice(prefix.length).split(':');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  return { guildId: parts[0], userId: parts[1] };
}

function newVoicePresenceObservation(
  channelId: string,
  sessionId: string,
  observedAtMs = Date.now(),
): VoicePresenceObservation {
  return {
    version: VOICE_PRESENCE_VERSION,
    ownerId: VOICE_RUNTIME_OWNER_ID,
    channelId,
    sessionId,
    observedAtMs,
    generation: randomUUID(),
  };
}

function encodeVoicePresenceObservation(observation: VoicePresenceObservation): string {
  return JSON.stringify(observation);
}

async function writeVoicePresenceObservation(
  redis: ReturnType<typeof getRedis>,
  guildId: string,
  userId: string,
  channelId: string,
  sessionId: string,
  observedAtMs = Date.now(),
): Promise<VoicePresenceObservation> {
  const observation = newVoicePresenceObservation(channelId, sessionId, observedAtMs);
  await redis.psetex(
    voicePresenceKey(guildId, userId),
    VOICE_PRESENCE_TTL_MS,
    encodeVoicePresenceObservation(observation),
  );
  return observation;
}

async function replaceVoicePresenceIfUnchanged(
  redis: ReturnType<typeof getRedis>,
  key: string,
  expectedRaw: string | null,
  replacement: VoicePresenceObservation,
): Promise<boolean> {
  const replacementRaw = encodeVoicePresenceObservation(replacement);
  if (expectedRaw === null) {
    return await redis.set(
      key,
      replacementRaw,
      'PX',
      VOICE_PRESENCE_TTL_MS,
      'NX',
    ) === 'OK';
  }
  const replaced = await redis.eval(
    'if redis.call("get", KEYS[1]) ~= ARGV[1] then return 0 end; redis.call("psetex", KEYS[1], ARGV[3], ARGV[2]); return 1',
    1,
    key,
    expectedRaw,
    replacementRaw,
    String(VOICE_PRESENCE_TTL_MS),
  );
  return Number(replaced) === 1;
}

async function refreshVoicePresenceIfUnchanged(
  redis: ReturnType<typeof getRedis>,
  key: string,
  expectedRaw: string,
): Promise<boolean> {
  const refreshed = await redis.eval(
    'if redis.call("get", KEYS[1]) ~= ARGV[1] then return 0 end; return redis.call("pexpire", KEYS[1], ARGV[2])',
    1,
    key,
    expectedRaw,
    String(VOICE_PRESENCE_TTL_MS),
  );
  return Number(refreshed) === 1;
}

/** Legacy joinedAt-only values and every mismatch restart observation. */
async function readCurrentVoicePresenceObservation(
  redis: ReturnType<typeof getRedis>,
  guildId: string,
  userId: string,
  channelId: string,
  sessionId: string,
  nowMs: number,
): Promise<VoicePresenceObservation | null> {
  const key = voicePresenceKey(guildId, userId);
  const raw = await redis.get(key);
  let decoded: unknown = null;
  if (raw) {
    try {
      decoded = JSON.parse(raw);
    } catch {
      decoded = null;
    }
  }
  const observation = parseVoicePresenceObservation(decoded);
  if (
    !observation ||
    observation.ownerId !== VOICE_RUNTIME_OWNER_ID ||
    observation.channelId !== channelId ||
    observation.sessionId !== sessionId ||
    observation.observedAtMs > nowMs
  ) {
    await replaceVoicePresenceIfUnchanged(
      redis,
      key,
      raw,
      newVoicePresenceObservation(channelId, sessionId, nowMs),
    );
    return null;
  }
  return await refreshVoicePresenceIfUnchanged(redis, key, raw!)
    ? observation
    : null;
}

export async function deleteOwnedVoicePresenceObservationsForGuilds(
  redis: Pick<ReturnType<typeof getRedis>, 'scan' | 'del'>,
  ownerId: string,
  guildIds: ReadonlySet<string>,
): Promise<void> {
  if (guildIds.size === 0) return;
  let cursor = '0';
  do {
    const [nextCursor, keys] = await redis.scan(
      cursor,
      'MATCH',
      `${REDIS_ECO_VOICE}:${VOICE_PRESENCE_NAMESPACE_VERSION}:${ownerId}:*`,
      'COUNT',
      100,
    );
    cursor = nextCursor;
    const ownedAffectedKeys = keys.filter((key) => {
      const parsed = parseOwnedVoicePresenceKey(key, ownerId);
      return parsed !== null && guildIds.has(parsed.guildId);
    });
    if (ownedAffectedKeys.length > 0) await redis.del(...ownedAffectedKeys);
  } while (cursor !== '0');
}

export async function deleteAllOwnedVoicePresenceObservations(
  redis: Pick<ReturnType<typeof getRedis>, 'scan' | 'del'>,
  ownerId: string,
): Promise<number> {
  let cursor = '0';
  let totalDeleted = 0;
  do {
    const [nextCursor, keys] = await redis.scan(
      cursor,
      'MATCH',
      `${REDIS_ECO_VOICE}:${VOICE_PRESENCE_NAMESPACE_VERSION}:${ownerId}:*`,
      'COUNT',
      100,
    );
    cursor = nextCursor;
    const ownedKeys = keys.filter((key) => parseOwnedVoicePresenceKey(key, ownerId) !== null);
    if (ownedKeys.length > 0) {
      await redis.del(...ownedKeys);
      totalDeleted += ownedKeys.length;
    }
  } while (cursor !== '0');
  return totalDeleted;
}

async function resetCurrentVoicePresenceObservations(
  client: Client,
  reason: string,
  guildIds: ReadonlySet<string>,
): Promise<void> {
  const redis = getRedis();
  const quarantinesBeforeReset = voiceContinuityGuard.snapshot((key) => {
    const separator = key.indexOf(':');
    return separator > 0 && guildIds.has(key.slice(0, separator));
  });
  await deleteOwnedVoicePresenceObservationsForGuilds(
    redis,
    VOICE_RUNTIME_OWNER_ID,
    guildIds,
  );
  const observedAtMs = Date.now();
  const occupants = new Map<string, {
    guildId: string;
    userId: string;
    channelId: string;
    sessionId: string;
  }>();
  for (const [, guild] of client.guilds.cache) {
    if (!guildIds.has(guild.id) || !guild.available) continue;
    if (!isGuildAllowed(guild.id)) continue;
    for (const [, channel] of guild.channels.cache) {
      if (!channel.isVoiceBased()) continue;
      if (channel.id === guild.afkChannelId) continue;
      for (const [, member] of channel.members) {
        if (member.user.bot || isVoicePayoutAfkState(member.voice, guild.afkChannelId)) continue;
        const currentChannelId = member.voice.channelId;
        const currentSessionId = voiceSessionId(member.voice);
        if (!currentChannelId || !currentSessionId) continue;
        occupants.set(`${guild.id}:${member.id}`, {
          guildId: guild.id,
          userId: member.id,
          channelId: currentChannelId,
          sessionId: currentSessionId,
        });
      }
    }
  }

  const pipeline = redis.pipeline();
  for (const occupant of occupants.values()) {
    const observation = newVoicePresenceObservation(
      occupant.channelId,
      occupant.sessionId,
      observedAtMs,
    );
    pipeline.psetex(
      voicePresenceKey(occupant.guildId, occupant.userId),
      VOICE_PRESENCE_TTL_MS,
      encodeVoicePresenceObservation(observation),
    );
  }
  const results = await pipeline.exec();
  const firstError = results?.find(([error]) => error)?.[0];
  if (!results || firstError) {
    throw firstError ?? new Error('Voice presence reset pipeline did not complete');
  }
  const reconciledQuarantines = voiceContinuityGuard.releaseSnapshot(quarantinesBeforeReset);
  log.info(
    `Voice presence observations reset (${reason}); ` +
    `guilds=${guildIds.size}; occupants=${occupants.size}; quarantines=${reconciledQuarantines}`,
  );
}

function recoveryGuildScope(
  client: Client,
  tokens: readonly VoiceRuntimeRecoveryToken[],
): Set<string> {
  if (tokens.some((token) => token.scope === 'redis')) {
    return new Set(client.guilds.cache.keys());
  }
  const shardIds = new Set(tokens.flatMap((token) =>
    token.scope === 'shard' && token.shardId !== undefined ? [token.shardId] : []));
  const guildIds = new Set(tokens.flatMap((token) =>
    token.scope === 'guild' && token.guildId !== undefined ? [token.guildId] : []));
  for (const [, guild] of client.guilds.cache) {
    if (shardIds.has(guild.shardId)) guildIds.add(guild.id);
  }
  return guildIds;
}

export async function completeVoiceRuntimeRecoveryAfterReset(
  gate: VoicePayoutRuntimeGate,
  tokens: readonly VoiceRuntimeRecoveryToken[],
  reset: () => Promise<void>,
): Promise<VoiceRuntimeRecoveryToken[]> {
  await reset();
  return tokens.filter((token) => gate.completeRecovery(token));
}

function currentVoiceRecoveryTokens(): VoiceRuntimeRecoveryToken[] {
  const tokens: VoiceRuntimeRecoveryToken[] = [];
  if (pendingRedisRecoveryToken) {
    if (voiceRuntimeGate.isRecoveryTokenCurrent(pendingRedisRecoveryToken)) {
      tokens.push(pendingRedisRecoveryToken);
    } else {
      pendingRedisRecoveryToken = null;
    }
  }
  for (const [shardId, token] of pendingShardRecoveryTokens) {
    if (voiceRuntimeGate.isRecoveryTokenCurrent(token)) tokens.push(token);
    else pendingShardRecoveryTokens.delete(shardId);
  }
  for (const [guildId, token] of pendingGuildRecoveryTokens) {
    if (voiceRuntimeGate.isRecoveryTokenCurrent(token)) tokens.push(token);
    else pendingGuildRecoveryTokens.delete(guildId);
  }
  return tokens;
}

function clearCompletedVoiceRecoveryTokens(tokens: readonly VoiceRuntimeRecoveryToken[]): void {
  for (const token of tokens) {
    if (token.scope === 'redis' && pendingRedisRecoveryToken === token) {
      pendingRedisRecoveryToken = null;
    }
    if (
      token.scope === 'shard' &&
      token.shardId !== undefined &&
      pendingShardRecoveryTokens.get(token.shardId) === token
    ) {
      pendingShardRecoveryTokens.delete(token.shardId);
    }
    if (
      token.scope === 'guild' &&
      token.guildId !== undefined &&
      pendingGuildRecoveryTokens.get(token.guildId) === token
    ) {
      pendingGuildRecoveryTokens.delete(token.guildId);
    }
  }
}

const voiceRecoveryPump = new VoiceCoalescedRecoveryPump(
  voicePresenceResetQueue,
  currentVoiceRecoveryTokens,
  async (tokens) => {
    const client = voiceRecoveryClient;
    if (!voiceTickerActive || !client) return;
    const reasons = [...voiceRecoveryReasons];
    const reason = reasons.length === 0
      ? 'coalesced-recovery'
      : reasons.length <= 3
        ? reasons.join(',')
        : `${reasons.slice(0, 3).join(',')},+${reasons.length - 3}-more`;
    voiceRecoveryReasons.clear();
    try {
      const completed = await completeVoiceRuntimeRecoveryAfterReset(
        voiceRuntimeGate,
        tokens,
        () => resetCurrentVoicePresenceObservations(
          client,
          reason,
          recoveryGuildScope(client, tokens),
        ),
      );
      clearCompletedVoiceRecoveryTokens(completed);
    } catch (error) {
      if (tokens.some((token) => voiceRuntimeGate.isRecoveryTokenCurrent(token))) {
        voiceRuntimeGate.blockRedis();
      }
      log.error(`Voice presence reset failed (${reason}); payouts remain deferred`, error);
      throw error;
    }
  },
);

function requestVoicePresenceReset(client: Client, reason: string): void {
  voiceRecoveryClient = client;
  voiceRecoveryReasons.add(reason);
  void voiceRecoveryPump.request().catch(() => undefined);
}

function queueBlockedVoicePresenceRecovery(client: Client, reason: string): void {
  if (voiceRuntimeGate.isRedisBlocked()) {
    pendingRedisRecoveryToken = voiceRuntimeGate.beginRedisRecovery();
  }
  if (currentVoiceRecoveryTokens().length > 0) requestVoicePresenceReset(client, reason);
}

function detachVoiceReconnectListeners(): void {
  if (voiceReconnectClient) {
    if (voiceShardDisconnectListener) {
      voiceReconnectClient.off('shardDisconnect', voiceShardDisconnectListener);
    }
    if (voiceShardReconnectingListener) {
      voiceReconnectClient.off('shardReconnecting', voiceShardReconnectingListener);
    }
    if (voiceShardReadyListener) {
      voiceReconnectClient.off('shardReady', voiceShardReadyListener);
    }
    if (voiceShardResumeListener) {
      voiceReconnectClient.off('shardResume', voiceShardResumeListener);
    }
    if (voiceGuildUnavailableListener) {
      voiceReconnectClient.off('guildUnavailable', voiceGuildUnavailableListener);
    }
    if (voiceGuildAvailableListener) {
      voiceReconnectClient.off('guildAvailable', voiceGuildAvailableListener);
    }
  }
  voiceReconnectClient = null;
  voiceShardDisconnectListener = null;
  voiceShardReconnectingListener = null;
  voiceShardReadyListener = null;
  voiceShardResumeListener = null;
  voiceGuildUnavailableListener = null;
  voiceGuildAvailableListener = null;
}

function attachVoiceReconnectListeners(client: Client): void {
  detachVoiceReconnectListeners();
  voiceReconnectClient = client;
  voiceShardDisconnectListener = (_event: unknown, shardId: number) => {
    if (!voiceTickerActive) return;
    voiceRuntimeGate.blockShard(shardId);
    pendingShardRecoveryTokens.delete(shardId);
  };
  voiceShardReconnectingListener = (shardId: number) => {
    if (!voiceTickerActive) return;
    voiceRuntimeGate.blockShard(shardId);
    pendingShardRecoveryTokens.delete(shardId);
  };
  voiceShardReadyListener = (shardId: number) => {
    if (!voiceTickerActive) return;
    const token = voiceRuntimeGate.beginShardRecovery(shardId);
    pendingShardRecoveryTokens.set(shardId, token);
    requestVoicePresenceReset(client, `discord-shard-ready:${shardId}`);
  };
  voiceShardResumeListener = (shardId: number) => {
    if (!voiceTickerActive) return;
    const token = voiceRuntimeGate.beginShardRecovery(shardId);
    pendingShardRecoveryTokens.set(shardId, token);
    requestVoicePresenceReset(client, `discord-shard-resume:${shardId}`);
  };
  voiceGuildUnavailableListener = (guild: Guild) => {
    if (!voiceTickerActive) return;
    voiceRuntimeGate.blockGuild(guild.id);
    pendingGuildRecoveryTokens.delete(guild.id);
  };
  voiceGuildAvailableListener = (guild: Guild) => {
    if (!voiceTickerActive) return;
    const token = voiceRuntimeGate.beginGuildRecovery(guild.id);
    pendingGuildRecoveryTokens.set(guild.id, token);
    requestVoicePresenceReset(client, `discord-guild-available:${guild.id}`);
  };
  client.on('shardDisconnect', voiceShardDisconnectListener);
  client.on('shardReconnecting', voiceShardReconnectingListener);
  client.on('shardReady', voiceShardReadyListener);
  client.on('shardResume', voiceShardResumeListener);
  client.on('guildUnavailable', voiceGuildUnavailableListener);
  client.on('guildAvailable', voiceGuildAvailableListener);
}

function detachVoiceRedisListeners(): void {
  if (voiceRuntimeRedis) {
    if (voiceRedisUnavailableListener) {
      voiceRuntimeRedis.off('close', voiceRedisUnavailableListener);
      voiceRuntimeRedis.off('reconnecting', voiceRedisUnavailableListener);
      voiceRuntimeRedis.off('end', voiceRedisUnavailableListener);
    }
    if (voiceRedisReadyListener) voiceRuntimeRedis.off('ready', voiceRedisReadyListener);
  }
  voiceRuntimeRedis = null;
  voiceRedisUnavailableListener = null;
  voiceRedisReadyListener = null;
}

function attachVoiceRedisListeners(client: Client): void {
  detachVoiceRedisListeners();
  voiceRuntimeRedis = getRedis();
  voiceRedisUnavailableListener = () => {
    if (voiceTickerActive) voiceRuntimeGate.blockRedis();
  };
  voiceRedisReadyListener = () => {
    if (!voiceTickerActive) return;
    pendingRedisRecoveryToken = voiceRuntimeGate.beginRedisRecovery();
    requestVoicePresenceReset(client, 'redis-ready-after-reconnect');
  };
  voiceRuntimeRedis.on('close', voiceRedisUnavailableListener);
  voiceRuntimeRedis.on('reconnecting', voiceRedisUnavailableListener);
  voiceRuntimeRedis.on('end', voiceRedisUnavailableListener);
  voiceRuntimeRedis.on('ready', voiceRedisReadyListener);
}

function blockVoicePayoutsForRedisFailure(client: Client, reason: string): void {
  if (!voiceTickerActive) return;
  voiceRuntimeGate.blockRedis();
  queueBlockedVoicePresenceRecovery(client, reason);
}

export interface PbTierRoleMutationPlan {
  targetRoleId: string | null;
  targetAlreadyHeld: boolean;
  roleIdsToRemove: string[];
}

interface PbTierRoleMutationActions<TTargetRole> {
  fetchSafeTargetRole(roleId: string): Promise<TTargetRole>;
  assertLockOwned(): Promise<void>;
  addTargetRole(role: TTargetRole): Promise<void>;
  removeRole(roleId: string): Promise<void>;
}

/**
 * Apply one PB-tier transition while the caller owns the shared member-role
 * lock. A replacement is granted before old tiers are removed so a rejected
 * or transiently unavailable target role cannot strip the member's last tier.
 */
export async function executePbTierRoleMutationPlan<TTargetRole>(
  plan: PbTierRoleMutationPlan,
  actions: PbTierRoleMutationActions<TTargetRole>,
): Promise<TTargetRole | null> {
  let grantedRole: TTargetRole | null = null;
  if (plan.targetRoleId) {
    const safeTargetRole = await actions.fetchSafeTargetRole(plan.targetRoleId);
    if (!plan.targetAlreadyHeld) {
      await actions.assertLockOwned();
      await actions.addTargetRole(safeTargetRole);
      grantedRole = safeTargetRole;
    }
  }

  const roleIdsToRemove = [...new Set(
    plan.roleIdsToRemove.filter((roleId) => roleId && roleId !== plan.targetRoleId),
  )];
  for (const roleId of roleIdsToRemove) {
    await actions.assertLockOwned();
    await actions.removeRole(roleId);
  }

  return grantedRole;
}

/** Глобальный интервал тикера (управляется SchedulerManager) */

// ═══════════════════════════════════════════════
//  Voice state tracking (join/leave)
// ═══════════════════════════════════════════════

/**
 * Обработка voiceStateUpdate.
 * Записываем время входа в войс → Redis.
 * При выходе — НЕ начисляем (начисление — по тикеру).
 */
function voiceContinuityKey(guildId: string, userId: string): string {
  return `${guildId}:${userId}`;
}

async function enqueueVoicePresenceMutation(
  key: string,
  mutation: () => Promise<void>,
): Promise<void> {
  const previous = voiceTransitionTasks.get(key)?.catch(() => undefined) ?? Promise.resolve();
  const next = previous.then(mutation);
  voiceTransitionTasks.set(key, next);
  try {
    await next;
  } finally {
    if (voiceTransitionTasks.get(key) === next) voiceTransitionTasks.delete(key);
  }
}

export async function handleVoiceUpdate(oldState: VoiceState, newState: VoiceState): Promise<void> {
  if (!voiceTickerActive) return;
  const userId = newState.member?.id ?? oldState.member?.id;
  const guildId = newState.guild.id;
  const member = newState.member ?? oldState.member;
  if (!userId || !member || member.user.bot || !isGuildAllowed(guildId)) return;

  const r = getRedis();
  const guildAfkChannelId = newState.guild.afkChannelId;
  const oldSessionId = voiceSessionId(oldState);
  const newSessionId = voiceSessionId(newState);
  const action = voicePresenceTransitionAction(
    oldState.channelId,
    newState.channelId,
    isVoicePayoutAfkState(oldState, guildAfkChannelId),
    isVoicePayoutAfkState(newState, guildAfkChannelId),
    oldSessionId,
    newSessionId,
  );

  if (action === 'preserve') return;

  const continuityKey = voiceContinuityKey(guildId, userId);
  // Quarantine synchronously, before the first Redis await. If Redis never
  // records this transition, a pre-transition observation stays ineligible.
  const quarantineToken = voiceContinuityGuard.quarantine(continuityKey);
  try {
    await enqueueVoicePresenceMutation(continuityKey, () =>
      completeVoicePresenceTransitionAfterWrite(
        voiceContinuityGuard,
        continuityKey,
        quarantineToken,
        async () => {
          if (action === 'delete') {
            // Leaving, an unknown session, or either AFK form invalidates the full interval.
            await r.del(voicePresenceKey(guildId, userId));
          } else if (newState.channelId && newSessionId) {
            // Join, channel/session hop and AFK -> active start a fresh generation.
            await writeVoicePresenceObservation(
              r,
              guildId,
              userId,
              newState.channelId,
              newSessionId,
            );
          }
        },
      ));
  } catch (error) {
    blockVoicePayoutsForRedisFailure(member.client, 'retry-after-transition-write-failure');
    throw error;
  }
}

// ═══════════════════════════════════════════════
//  Периодический тикер (каждые 10 мин)
// ═══════════════════════════════════════════════

export function startVoiceTicker(client: Client): void {
  voiceTickerGeneration += 1;
  voiceTickerActive = true;
  voiceRuntimeGate.reset();
  pendingRedisRecoveryToken = null;
  pendingShardRecoveryTokens.clear();
  pendingGuildRecoveryTokens.clear();
  voiceRecoveryReasons.clear();
  voiceRecoveryClient = client;
  attachVoiceReconnectListeners(client);
  attachVoiceRedisListeners(client);
  for (const [shardId, shard] of client.ws.shards) {
    if (shard.status !== Status.Ready) voiceRuntimeGate.blockShard(shardId);
  }
  for (const [, guild] of client.guilds.cache) {
    if (!guild.available) voiceRuntimeGate.blockGuild(guild.id);
  }
  pendingRedisRecoveryToken = voiceRuntimeGate.beginRedisRecovery();
  requestVoicePresenceReset(client, 'startup');
  scheduleTask('economy:voiceTickerConfig', VOICE_CONFIG_REFRESH_MS, async () => {
    await refreshVoiceTickerSchedules(client);
  }, { exclusive: true, immediate: true });

  // Глобальная синхронизация ролей ПБ раз в час
  scheduleTask('economy:pb_tier_sync', 60 * 60 * 1000, async () => {
    await syncAllGuildsPbTiers(client);
  }, { exclusive: true, immediate: true });

  // Запустить разовую синхронизацию при старте
  log.info('Voice earnings ticker started with per-guild configured intervals');
}

/** Остановить тикер */
export async function stopVoiceTicker(): Promise<void> {
  const stoppingGeneration = voiceTickerGeneration;
  const shouldCleanupOwnerState = voiceTickerActive;
  voiceTickerActive = false;
  detachVoiceReconnectListeners();
  detachVoiceRedisListeners();
  voiceRuntimeGate.reset();
  pendingRedisRecoveryToken = null;
  pendingShardRecoveryTokens.clear();
  pendingGuildRecoveryTokens.clear();
  voiceRecoveryReasons.clear();
  voiceRecoveryPump.cancelPending();
  unscheduleTask('economy:voiceTickerConfig');
  for (const task of voiceGuildTasks.values()) unscheduleTask(task.name);
  voiceGuildTasks.clear();
  unscheduleTask('economy:pb_tier_sync');
  await Promise.all([
    drainScheduledTasksByPrefix('economy:voiceTicker'),
    drainScheduledTasksByPrefix('economy:pb_tier_sync'),
  ]);
  await voiceRecoveryPump.drain();
  await voicePresenceResetQueue.drain();
  while (voiceTransitionTasks.size > 0) {
    await Promise.allSettled([...voiceTransitionTasks.values()]);
  }
  voiceContinuityGuard.clear();
  voiceTransitionTasks.clear();
  voiceRecoveryClient = null;
  if (
    shouldCleanupOwnerState &&
    stoppingGeneration === voiceTickerGeneration &&
    !voiceTickerActive
  ) {
    await cleanupVoiceTrackers(VOICE_RUNTIME_OWNER_ID);
  }
  log.info('Тикер голосового заработка остановлен');
}

/**
 * Один тик: обходим все гильдии → все войс-каналы → начисляем.
 */
async function refreshVoiceTickerSchedules(client: Client): Promise<void> {
  if (!voiceTickerActive) return;
  const desiredGuildIds = new Set<string>();
  for (const [, guild] of client.guilds.cache) {
    if (!isGuildAllowed(guild.id)) continue;
    try {
      const config = await getEcoConfig(guild.id);
      // Unload may have started while the configuration query was in flight.
      // Do not let that stale refresh recreate a per-guild scheduled task.
      if (!voiceTickerActive) return;
      if (!config?.enabled) continue;
      const intervalMs = normalizeVoiceIntervalMs(config.voiceIntervalMs);
      desiredGuildIds.add(guild.id);
      const current = voiceGuildTasks.get(guild.id);
      if (current?.intervalMs === intervalMs) continue;
      if (current) unscheduleTask(current.name);
      const name = `economy:voiceTicker:${guild.id}`;
      voiceGuildTasks.set(guild.id, { name, intervalMs });
      scheduleTask(name, intervalMs, async () => {
        if (!voiceTickerActive || !isGuildAllowed(guild.id)) return;
        await tickVoiceEarnings(client, guild.id);
      }, { exclusive: true, immediate: true });
    } catch (error) {
      log.error(`Voice ticker configuration failed for ${guild.id}`, error);
    }
  }
  for (const [guildId, task] of voiceGuildTasks) {
    if (desiredGuildIds.has(guildId)) continue;
    unscheduleTask(task.name);
    voiceGuildTasks.delete(guildId);
  }
}

async function tickVoiceEarnings(client: Client, onlyGuildId: string): Promise<void> {
  const presenceBarrier = voicePresenceResetQueue.snapshot();
  try {
    await presenceBarrier;
  } catch (error) {
    log.error(`Voice tick deferred for ${onlyGuildId}: presence reset is unavailable`, error);
    if (voiceTickerActive && voicePresenceResetQueue.isCurrent(presenceBarrier)) {
      queueBlockedVoicePresenceRecovery(client, 'retry-after-reset-failure');
    }
    return;
  }
  const r = getRedis();
  const now = Date.now();

  for (const [, guild] of client.guilds.cache) {
    if (guild.id !== onlyGuildId) continue;
    if (!isGuildAllowed(guild.id)) continue;
    if (!guild.available) continue;
    if (!voiceRuntimeGate.capture(guild.shardId, guild.id)) continue;
    // Проверяем, включена ли экономика в гильдии
    const config = await getEcoConfig(guild.id);
    if (!config?.enabled) continue;
    const intervalMs = normalizeVoiceIntervalMs(config.voiceIntervalMs);

    const rateBase = config.voiceRateBase ?? DEFAULTS.voiceRateBase;
    const ratePb = config.voiceRatePb ?? DEFAULTS.voiceRatePb;
    const minMembers = normalizeVoiceMinMembers(config.voiceMinMembers);

    // Получаем ПБ-каналы (слияние из regbattle squads + собственных EconomyConfig)
    let pbChannelIds: Set<string>;
    try {
      pbChannelIds = await loadPbVoiceChannelIdsWithRetry(
        guild.id,
        Array.isArray(config.pbVoiceChannelIds) ? config.pbVoiceChannelIds : [],
      );
    } catch (error) {
      log.error(`Voice tick deferred for ${guild.id}: PB topology unavailable`, error);
      continue;
    }
    const pbCategoryIds = new Set<string>(config.pbVoiceCategoryIds ?? []);

    // PB-роли для множителя заработка
    const pbRoleIds: string[] = config?.pbRoleIds ?? [];

    // Обходим голосовые каналы
    for (const [, channel] of guild.channels.cache) {
      if (!channel.isVoiceBased()) continue;
      const vc = channel as VoiceChannel | StageChannel;
      if (vc.id === guild.afkChannelId) continue;

      const humans = vc.members.filter((m) => !m.user.bot);
      if (!hasMinimumLiveVoiceMembers(humans.size, minMembers)) continue;
      const eligibleMembers: Array<{
        member: GuildMember;
        observation: VoicePresenceObservation;
        runtimeSnapshot: VoicePayoutRuntimeSnapshot;
      }> = [];
      for (const member of humans.values()) {
        const runtimeSnapshot = voiceRuntimeGate.capture(guild.shardId, guild.id);
        if (!runtimeSnapshot) break;
        try {
          const observation = await getEligibleVoicePresenceObservation(
            guild.id,
            guild.afkChannelId,
            member,
            r,
            now,
            intervalMs,
            runtimeSnapshot,
          );
          if (observation) eligibleMembers.push({ member, observation, runtimeSnapshot });
        } catch (error) {
          log.error(`Voice presence read failed for ${member.id} in ${guild.id}`, error);
          blockVoicePayoutsForRedisFailure(client, 'retry-after-presence-read-failure');
          return;
        }
      }
      if (eligibleMembers.length === 0) continue;

      const isPbChannel = pbChannelIds.has(vc.id) || (vc.parentId ? pbCategoryIds.has(vc.parentId) : false);
      const hourlyRate = isPbChannel ? ratePb : rateBase;
      const tickAmount = calculateVoiceTickAmount(hourlyRate, intervalMs);

      if (tickAmount <= 0) continue;

      for (const { member, observation, runtimeSnapshot } of eligibleMembers) {
        try {
          await processVoiceMember(
            guild.id,
            member,
            tickAmount,
            isPbChannel,
            pbRoleIds,
            r,
            intervalMs,
            vc.id,
            guild.afkChannelId,
            observation,
            runtimeSnapshot,
          );
        } catch (err) {
          log.error(`Voice tick error for ${member.id} in ${guild.id}`, err);
        }
      }
    }
  }
}

/**
 * Начислить пассивный доход одному участнику.
 * Anti-AFK checks:
 *   1. Не server-muted + server-deafened одновременно
 *   2. Непрерывная channel/generation observation в Redis ≥ configured interval
 */
async function getEligibleVoicePresenceObservation(
  guildId: string,
  guildAfkChannelId: string | null,
  member: GuildMember,
  redis: ReturnType<typeof getRedis>,
  now: number,
  intervalMs: number,
  runtimeSnapshot: VoicePayoutRuntimeSnapshot,
): Promise<VoicePresenceObservation | null> {
  const voice = member.voice;
  const channelId = voice.channelId;
  const sessionId = voiceSessionId(voice);
  if (
    !member.guild.available ||
    !channelId ||
    !sessionId ||
    isVoicePayoutAfkState(voice, guildAfkChannelId) ||
    !voiceRuntimeGate.isCurrent(runtimeSnapshot)
  ) return null;

  const continuityKey = voiceContinuityKey(guildId, member.id);
  const quarantineToken = voiceContinuityGuard.currentToken(continuityKey);
  if (quarantineToken) {
    // Repair uses the current Discord state but deliberately returns ineligible:
    // the member must complete a new full interval after any unrecorded change.
    await enqueueVoicePresenceMutation(continuityKey, async () => {
      if (voiceContinuityGuard.currentToken(continuityKey) !== quarantineToken) return;
      const currentVoice = member.voice;
      const currentChannelId = currentVoice.channelId;
      const currentSessionId = voiceSessionId(currentVoice);
      if (
        !member.guild.available ||
        !currentChannelId ||
        !currentSessionId ||
        isVoicePayoutAfkState(currentVoice, guildAfkChannelId) ||
        !voiceRuntimeGate.isCurrent(runtimeSnapshot)
      ) return;
      await writeVoicePresenceObservation(
        redis,
        guildId,
        member.id,
        currentChannelId,
        currentSessionId,
        now,
      );
      voiceContinuityGuard.release(continuityKey, quarantineToken);
    });
    return null;
  }
  const observation = await readCurrentVoicePresenceObservation(
    redis,
    guildId,
    member.id,
    channelId,
    sessionId,
    now,
  );
  return observation &&
    member.guild.available &&
    voiceRuntimeGate.isCurrent(runtimeSnapshot) &&
    voiceSessionId(member.voice) === sessionId &&
    !isVoicePayoutAfkState(member.voice, guildAfkChannelId) &&
    isVoicePresenceObservationEligible(
      observation,
      channelId,
      sessionId,
      now,
      intervalMs,
      VOICE_RUNTIME_OWNER_ID,
    )
    ? observation
    : null;
}

async function processVoiceMember(
  guildId: string,
  member: GuildMember,
  baseTickAmount: number,
  isPbChannel: boolean,
  pbRoleIds: string[],
  redis: ReturnType<typeof getRedis>,
  intervalMs: number,
  channelId: string,
  guildAfkChannelId: string | null,
  expectedObservation: VoicePresenceObservation,
  runtimeSnapshot: VoicePayoutRuntimeSnapshot,
): Promise<void> {
  const userId = member.id;
  const normalizedIntervalMs = normalizeVoiceIntervalMs(intervalMs);

  const voice = member.voice;
  if (!member.guild.available || voice.channelId !== channelId) return;
  const sessionId = voiceSessionId(voice);
  if (
    !sessionId ||
    sessionId !== expectedObservation.sessionId ||
    isVoicePayoutAfkState(voice, guildAfkChannelId) ||
    !voiceRuntimeGate.isCurrent(runtimeSnapshot)
  ) return;

  const confirmationNow = Date.now();
  let confirmedObservation: VoicePresenceObservation | null;
  try {
    confirmedObservation = await readCurrentVoicePresenceObservation(
      redis,
      guildId,
      userId,
      channelId,
      sessionId,
      confirmationNow,
    );
  } catch (error) {
    blockVoicePayoutsForRedisFailure(member.client, 'retry-after-presence-confirmation-failure');
    throw error;
  }
  if (
    !confirmedObservation ||
    confirmedObservation.ownerId !== VOICE_RUNTIME_OWNER_ID ||
    confirmedObservation.generation !== expectedObservation.generation ||
    confirmedObservation.observedAtMs !== expectedObservation.observedAtMs ||
    confirmedObservation.sessionId !== sessionId ||
    !voiceRuntimeGate.isCurrent(runtimeSnapshot) ||
    !isVoicePresenceObservationEligible(
      confirmedObservation,
      channelId,
      sessionId,
      confirmationNow,
      normalizedIntervalMs,
      VOICE_RUNTIME_OWNER_ID,
    )
  ) return;
  const eligibleSinceMs = confirmedObservation.observedAtMs;

  // PB-множитель для голосового заработка
  const { multiplier } = getPbTier(member, pbRoleIds);

  const finalAmount = Math.floor(baseTickAmount * multiplier);
  if (finalAmount <= 0) return;

  const locale = await getGuildLocale(guildId);
  if (
    !member.guild.available ||
    member.voice.channelId !== channelId ||
    voiceSessionId(member.voice) !== sessionId ||
    isVoicePayoutAfkState(member.voice, guildAfkChannelId) ||
    !voiceRuntimeGate.isCurrent(runtimeSnapshot)
  ) return;
  const db = getDatabase();
  const continuityKey = voiceContinuityKey(guildId, userId);
  const assertPayoutFence = (): void => {
    if (
      !member.guild.available ||
      !voiceRuntimeGate.isCurrent(runtimeSnapshot) ||
      voiceContinuityGuard.isQuarantined(continuityKey) ||
      member.voice.channelId !== channelId ||
      voiceSessionId(member.voice) !== sessionId ||
      isVoicePayoutAfkState(member.voice, guildAfkChannelId)
    ) {
      throw new Error('voice_payout_runtime_fence_changed');
    }
  };

  const payout = await db.$transaction(async (tx) => {
    await lockEconomyUserMutation(tx, guildId, userId);
    const cursor = await lockVoiceRewardCursor(tx, guildId, userId);
    assertPayoutFence();
    if (!isVoiceRewardCursorDue(cursor.metadata, eligibleSinceMs, cursor.nowMs, normalizedIntervalMs)) {
      return null;
    }

    const bucketKey = voiceRewardBucketKey(
      guildId,
      userId,
      normalizedIntervalMs,
      cursor.nowMs,
    );
    const bucketStart = Math.floor(cursor.nowMs / normalizedIntervalMs) * normalizedIntervalMs;
    const claimed = await claimOperationInTransaction(
      tx,
      bucketKey,
      'voice_reward_bucket',
      guildId,
      userId,
      {
        channelId,
        intervalMs: normalizedIntervalMs,
        bucketStart,
        isPbChannel,
        amount: finalAmount,
        paidAtMs: cursor.nowMs,
        eligibleSinceMs,
        presenceGeneration: confirmedObservation.generation,
        presenceSessionId: confirmedObservation.sessionId,
        presenceOwnerId: confirmedObservation.ownerId,
        cursorKey: cursor.key,
      },
      new Date(bucketStart + normalizedIntervalMs * 3),
    );
    if (!claimed) return null;
    assertPayoutFence();
    let credited = await applyWalletDeltaInTransaction(
      tx,
      guildId,
      userId,
      finalAmount,
      TX.EARN_VOICE,
      isPbChannel
        ? i18n.t('economy.voice.tx_detail_pb', locale)
        : i18n.t('economy.voice.tx_detail_normal', locale),
      encodeVoiceRewardTransactionTarget(Math.floor(normalizedIntervalMs / 1_000), isPbChannel),
    );
    assertPayoutFence();
    const previousPbVoiceSeconds = credited.pbVoiceSeconds;
    if (isPbChannel) {
      credited = await tx.economyProfile.update({
        where: { id: credited.id },
        data: { pbVoiceSeconds: { increment: Math.floor(normalizedIntervalMs / 1000) } },
      });
      assertPayoutFence();
    }
    await tx.operationClaim.update({
      where: { key: cursor.key },
      data: {
        metadata: voiceRewardCursorJson(nextVoiceRewardCursor(
            cursor.nowMs,
            normalizedIntervalMs,
            channelId,
            isPbChannel,
            finalAmount,
          )),
        expiresAt: null,
      },
    });
    assertPayoutFence();
    return {
      profile: credited,
      crossedPbTier: isPbChannel && crossedPbTierThreshold(
        previousPbVoiceSeconds,
        credited.pbVoiceSeconds,
        pbRoleIds.length,
      ),
    };
  });

  if (!payout) return;
  await invalidateProfileCache(guildId, userId);

  if (payout.crossedPbTier && pbRoleIds.length > 0) {
    await syncPbTierRoles(member);
  }

  await newsEarning(
    member.client,
    guildId,
    userId,
    TX.EARN_VOICE,
    finalAmount,
    locale,
  ).catch(() => null);
}

export interface PbTierRoleSyncOptions {
  forceVerificationFetch?: boolean;
  additionalManagedRoleIds?: readonly string[];
  roleSnapshot?: ReadonlyMap<string, Role>;
}

export interface PbTierAuthoritativeState {
  pbVoiceSeconds: number;
  pbRoleIds: string[];
}

export interface ExpectedPbTierRole {
  roleId: string;
  tierIndex: number;
}

/** Role entitlement is config/hour based; Discord safety is a later grant barrier. */
export function selectExpectedPbTierRole(
  pbVoiceSeconds: number,
  pbRoleIds: readonly string[],
): ExpectedPbTierRole | null {
  const seconds = Number.isSafeInteger(pbVoiceSeconds) && pbVoiceSeconds > 0
    ? pbVoiceSeconds
    : 0;
  let expected: ExpectedPbTierRole | null = null;
  for (let tierIndex = 0; tierIndex < pbRoleIds.length && tierIndex < PB_TIERS.length; tierIndex++) {
    const roleId = pbRoleIds[tierIndex];
    if (roleId && seconds >= PB_TIERS[tierIndex].hours * 3_600) {
      expected = { roleId, tierIndex };
    }
  }
  return expected;
}

export async function loadAuthoritativePbTierStateWithFence<T>(
  assertLockOwned: () => Promise<void>,
  load: () => Promise<T>,
): Promise<T> {
  await assertLockOwned();
  const state = await load();
  await assertLockOwned();
  return state;
}

export async function loadFreshPbTierMemberWithFence<T>(
  assertLockOwned: () => Promise<void>,
  fetchMember: () => Promise<T>,
): Promise<T> {
  await assertLockOwned();
  const member = await fetchMember();
  await assertLockOwned();
  return member;
}

export interface PbTierMemberRoleSnapshot {
  userId: string;
  roleIds: Iterable<string>;
}

/** Positive profiles need promotion checks; existing role holders need cleanup even at 0h. */
export function collectPbTierSyncUserIds(
  positiveProfileUserIds: Iterable<string>,
  members: Iterable<PbTierMemberRoleSnapshot>,
  managedRoleIds: readonly string[],
): Set<string> {
  const candidates = new Set(
    [...positiveProfileUserIds].filter((userId) => typeof userId === 'string' && userId.length > 0),
  );
  const managed = new Set(managedRoleIds.filter(Boolean));
  if (managed.size === 0) return candidates;
  for (const member of members) {
    if ([...member.roleIds].some((roleId) => managed.has(roleId))) candidates.add(member.userId);
  }
  return candidates;
}

async function readAuthoritativePbTierState(
  guildId: string,
  userId: string,
): Promise<PbTierAuthoritativeState> {
  const db = getDatabase();
  const [profile, config] = await Promise.all([
    db.economyProfile.findUnique({
      where: { guildId_userId: { guildId, userId } },
      select: { pbVoiceSeconds: true },
    }),
    db.economyConfig.findUnique({
      where: { guildId },
      select: { pbRoleIds: true },
    }),
  ]);
  const pbVoiceSeconds = profile?.pbVoiceSeconds;
  return {
    pbVoiceSeconds: Number.isSafeInteger(pbVoiceSeconds) && Number(pbVoiceSeconds) > 0
      ? Number(pbVoiceSeconds)
      : 0,
    pbRoleIds: (config?.pbRoleIds ?? []).filter(Boolean),
  };
}

export async function syncPbTierRoles(
  member: GuildMember,
  options: PbTierRoleSyncOptions = {},
): Promise<void> {
  const guild = member.guild;

  const promotion = await withMemberRoleLock(guild.id, member.id, async (lock) => {
    // Rebuild the plan from authoritative member state only after acquiring the
    // same lock used by PB, vacation, Teams and TempVoice role mutations.
    const freshMember = await loadFreshPbTierMemberWithFence(
      () => lock.assertOwned(),
      () => guild.members.fetch({ user: member.id, force: true }),
    );
    let roleState = freshMember;
    const authoritative = await loadAuthoritativePbTierStateWithFence(
      () => lock.assertOwned(),
      () => readAuthoritativePbTierState(guild.id, member.id),
    );
    const pbRoleIds = authoritative.pbRoleIds;
    const hours = authoritative.pbVoiceSeconds / 3600;
    const expectedTier = selectExpectedPbTierRole(authoritative.pbVoiceSeconds, pbRoleIds);
    const tierByRole = new Map<string, { tierIndex: number; hours: number }>();
    const unsafeRoleIds: string[] = [];
    const roleSnapshot = options.roleSnapshot ?? await guild.roles.fetch();
    await lock.assertOwned();
    for (let i = 0; i < pbRoleIds.length && i < PB_TIERS.length; i++) {
      const id = pbRoleIds[i];
      const role = id ? roleSnapshot.get(id) : null;
      if (role && hasForbiddenEconomyRewardPermissions(role.permissions)) {
        unsafeRoleIds.push(role.id);
        continue;
      }
      if (id && role) {
        tierByRole.set(id, { tierIndex: i, hours: PB_TIERS[i].hours });
      }
    }

    if (unsafeRoleIds.length > 0) {
      log.warn(`PB tier configuration in ${guild.id} contains role(s) with dangerous permissions`, {
        roleIds: unsafeRoleIds,
      });
    }

    const heldUnsafeRoleIds = unsafeRoleIds.filter((roleId) =>
      freshMember.roles.cache.has(roleId));
    const memberPbRoleIds = [...tierByRole.keys()].filter((roleId) =>
      freshMember.roles.cache.has(roleId));
    const configuredRoleIds = new Set(pbRoleIds.filter(Boolean));
    const heldRetiredRoleIds = [...new Set(options.additionalManagedRoleIds ?? [])]
      .filter((roleId) => roleId && !configuredRoleIds.has(roleId))
      .filter((roleId) => freshMember.roles.cache.has(roleId));
    const heldUnsafeRetiredRoleIds = heldRetiredRoleIds.filter((roleId) => {
      const role = roleSnapshot.get(roleId);
      return role !== undefined && hasForbiddenEconomyRewardPermissions(role.permissions);
    });

    if (expectedTier && !tierByRole.has(expectedTier.roleId)) {
      // A missing/unsafe configured replacement is not equivalent to "no
      // entitlement". Preserve every safe old/configured tier, remove only
      // roles that are themselves unsafe, and surface a retryable failure so
      // the durable retired-role intent cannot be completed.
      const unsafeHeldRoleIds = [...new Set([
        ...heldUnsafeRoleIds,
        ...heldUnsafeRetiredRoleIds,
      ])];
      for (const roleId of unsafeHeldRoleIds) {
        await lock.assertOwned();
        roleState = await roleState.roles.remove(
          roleId,
          'Economy PB tiers: unsafe reward role cleanup',
        );
      }
      await lock.assertOwned();
      const verified = unsafeHeldRoleIds.length === 0
        ? roleState
        : await guild.members.fetch({ user: member.id, force: true });
      await lock.assertOwned();
      const retainedUnsafeRoleIds = unsafeHeldRoleIds.filter((roleId) =>
        verified.roles.cache.has(roleId));
      if (retainedUnsafeRoleIds.length > 0) {
        throw new Error(`Unsafe Economy PB tier roles remain: ${retainedUnsafeRoleIds.join(',')}`);
      }
      throw new Error(
        `Economy PB tier replacement ${expectedTier.roleId} is missing or has forbidden permissions`,
      );
    }

    const targetRoleId = expectedTier?.roleId ?? null;
    const targetIdx = expectedTier?.tierIndex ?? -1;

    const roleIdsToRemove = [
      ...heldUnsafeRoleIds,
      ...memberPbRoleIds.filter((roleId) => roleId !== targetRoleId),
      ...heldRetiredRoleIds,
    ];
    const targetAlreadyHeld = targetRoleId !== null
      && freshMember.roles.cache.has(targetRoleId);
    if (roleIdsToRemove.length === 0 && (targetRoleId === null || targetAlreadyHeld)) {
      return null;
    }

    const grantedRole = await executePbTierRoleMutationPlan({
      targetRoleId,
      targetAlreadyHeld,
      roleIdsToRemove,
    }, {
      fetchSafeTargetRole: async (roleId) => {
        const role = await fetchSafeAutomaticRole(guild, roleId);
        if (hasForbiddenEconomyRewardPermissions(role.permissions)) {
          throw new Error(`Economy PB tier role ${roleId} has forbidden staff permissions`);
        }
        return role;
      },
      assertLockOwned: () => lock.assertOwned(),
      addTargetRole: async (role) => {
        roleState = await roleState.roles.add(
          role,
          `Economy PB tiers: reached ${Math.floor(hours)}h`,
        );
      },
      removeRole: async (roleId) => {
        roleState = await roleState.roles.remove(
          roleId,
          targetRoleId === null
            ? 'Economy PB tiers: insufficient hours'
            : 'Economy PB tiers: tier update',
        );
      },
    });

    if (targetRoleId !== null || roleIdsToRemove.length > 0) {
      await lock.assertOwned();
      const verified = options.forceVerificationFetch === false
        ? roleState
        : await guild.members.fetch({ user: member.id, force: true });
      await lock.assertOwned();
      if (targetRoleId !== null && !verified.roles.cache.has(targetRoleId)) {
        throw new Error(`Economy PB tier role ${targetRoleId} was not confirmed`);
      }
      const retainedRoleIds = roleIdsToRemove.filter((roleId) =>
        verified.roles.cache.has(roleId));
      if (retainedRoleIds.length > 0) {
        throw new Error(`Economy PB tier role removal was not confirmed: ${retainedRoleIds.join(',')}`);
      }
    }

    return grantedRole && targetIdx >= 0
      ? { member: roleState, role: grantedRole, targetIdx, hours }
      : null;
  });

  if (!promotion) return;
  const locale = await getGuildLocale(guild.id);
  const embed = successEmbed(
    i18n.t('economy.pb_tier.promote_desc', locale, {
      role: promotion.role.name,
      hours: String(Math.floor(promotion.hours)),
      multiplier: String(PB_TIERS[promotion.targetIdx].multiplier),
    }),
  ).setTitle(`🎖️ ${i18n.t('economy.pb_tier.promote_title', locale)}`);
  const notified = await promotion.member.send({ embeds: [embed] })
    .then(() => true)
    .catch(() => false);
  if (notified) {
    log.info(`PB tier promotion DM sent to ${promotion.member.user.tag} (role: ${promotion.role.name})`);
  }
}

/** Глобальная синхронизация ролей ПБ для всех участников гильдий */
export interface PbTierGuildSyncOptions extends PbTierRoleSyncOptions {
  requireEnabled?: boolean;
}

export interface PbTierGuildSyncResult {
  checked: number;
  failed: number;
}

export async function syncGuildPbTierRoles(
  guild: Guild,
  options: PbTierGuildSyncOptions = {},
): Promise<PbTierGuildSyncResult> {
  const db = getDatabase();
  const reconciliation = await loadPbTierReconciliationSnapshot(guild.id);
  const config = reconciliation.config;
  const pendingRetiredRoleIds = reconciliation.retiredRoleIds;
  const transientManagedRoleIds = [...new Set(options.additionalManagedRoleIds ?? [])].filter(Boolean);
  if (
    (!config || (options.requireEnabled && !config.enabled)) &&
    pendingRetiredRoleIds.length === 0 &&
    transientManagedRoleIds.length === 0
  ) return { checked: 0, failed: 0 };

  const managedRoleIds = [...new Set([
    ...(config?.pbRoleIds ?? []),
    ...pendingRetiredRoleIds,
    ...transientManagedRoleIds,
  ].filter(Boolean))];
  if (managedRoleIds.length === 0) return { checked: 0, failed: 0 };

  const [profiles, fetchedMembers, roleSnapshot] = await Promise.all([
    db.economyProfile.findMany({
      where: { guildId: guild.id, pbVoiceSeconds: { gt: 0 } },
      select: { userId: true },
    }),
    guild.members.fetch(),
    guild.roles.fetch(),
  ]);
  const candidateUserIds = collectPbTierSyncUserIds(
    profiles.map((profile) => profile.userId),
    fetchedMembers.map((candidate) => ({
      userId: candidate.id,
      roleIds: candidate.roles.cache.keys(),
    })),
    managedRoleIds,
  );
  const work = [...candidateUserIds].flatMap((userId) => {
    const candidate = fetchedMembers.get(userId);
    return candidate ? [candidate] : [];
  });

  let checked = 0;
  let failed = 0;
  await runVoiceTasksWithConcurrency(
    work,
    PB_TIER_SYNC_CONCURRENCY,
    async (candidate) => {
      try {
        await syncPbTierRoles(candidate, {
          ...options,
          additionalManagedRoleIds: [
            ...pendingRetiredRoleIds,
            ...transientManagedRoleIds,
          ],
          roleSnapshot,
          forceVerificationFetch: options.forceVerificationFetch ?? false,
        });
        checked += 1;
      } catch (error) {
        failed += 1;
        log.error(`PB tier sync failed for ${candidate.id} in ${guild.id}`, error);
      }
    },
  );
  if (pendingRetiredRoleIds.length > 0 && failed === 0) {
    try {
      // A second complete fetch is the retirement commit barrier. The durable
      // intent stays until every per-member mutation succeeded and Discord no
      // longer reports a holder of any retired role.
      const verificationMembers = await guild.members.fetch();
      const retired = new Set(pendingRetiredRoleIds);
      const hasRetiredRoleHolder = verificationMembers.some((candidate) =>
        candidate.roles.cache.some((role) => retired.has(role.id)));
      if (!hasRetiredRoleHolder) {
        const completed = await completePbTierReconciliationIntent(
          guild.id,
          pendingRetiredRoleIds,
        );
        if (completed) {
          log.info(`PB tier retired-role reconciliation completed for ${guild.id}`);
        }
      }
    } catch (error) {
      failed += 1;
      log.error(`PB tier retired-role verification failed in ${guild.id}`, error);
    }
  }
  return { checked, failed };
}

export async function syncAllGuildsPbTiers(client: Client): Promise<void> {
  for (const [, guild] of client.guilds.cache) {
    try {
      if (!guild.available || !isGuildAllowed(guild.id)) continue;
      const result = await syncGuildPbTierRoles(guild, { requireEnabled: true });

      if (result.checked > 0 || result.failed > 0) {
        log.info(
          `Глобальная синхронизация ПБ-ролей для ${guild.name}: ` +
          `проверено ${result.checked}, ошибок ${result.failed}.`,
        );
      }
    } catch (err) {
      log.error(`Ошибка глобальной синхронизации ПБ-ролей для гильдии ${guild.name}`, err);
    }
  }
}

// ═══════════════════════════════════════════════
//  Cleanup: удалить все voice-трекеры при выгрузке
// ═══════════════════════════════════════════════

export async function cleanupVoiceTrackers(
  ownerId = VOICE_RUNTIME_OWNER_ID,
): Promise<void> {
  try {
    const r = getRedis();
    const totalDeleted = await deleteAllOwnedVoicePresenceObservations(r, ownerId);

    if (totalDeleted > 0) {
      log.info(`Очищено ${totalDeleted} voice-трекеров`);
    }
  } catch (err) {
    log.error('Ошибка очистки voice-трекеров', err);
  }
}
