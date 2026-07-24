// ═══════════════════════════════════════════════
//  Teams — Интеграция с голосовыми каналами ПБ
// ═══════════════════════════════════════════════
//
//  Логика:
//  1.) Если член команды заходит в мастер → создаётся отряд для команды:
//      — пинг идёт по РОЛИ КОМАНДЫ, а не по общей pingRole
//      — роль команды работает как "кошерная": снимается при входе, возвращается при выходе
//  2.) Приглашение в командный войс через кнопку в панели отряда
//  3.) Приглашённый извне тоже проходит ротацию ролей
//

import {
  VoiceChannel,
  ButtonInteraction,
  UserSelectMenuInteraction,
  PermissionOverwriteOptions,
  PermissionsBitField,
  OverwriteType,
  type Guild,
  ChannelType,
} from 'discord.js';
import type { BublikClient } from '../../bot';
import type { ModuleExecutionGuard } from '../../types';
import { logger } from '../../core/Logger';
import { getRedis } from '../../core/Redis';
import { isGuildAllowed } from '../../core/Whitelist';
import { scheduleTask, unscheduleTask } from '../../core/SchedulerManager';
import { hasDiscordErrorCode } from '../../utils/helpers';
import { randomUUID } from 'node:crypto';

import * as db from './database';
import { TeamStatus } from './constants';
import {
  tmSuccess,
  tmError,
  tmWarn,
  buildVoiceInviteEmbed,
  buildVoiceInviteButton,
} from './embeds';

const log = logger.child('Teams:Voice');
const VOICE_INVITE_EXPIRY_INDEX = 'tm:vinvite:expiries';
const VOICE_INVITE_LOCK_TTL_MS = 60_000;
const VOICE_INVITE_LOCK_RENEW_MS = 20_000;
const VOICE_INVITE_CLEANUP_TASK = 'teams:voiceInviteCleanup';
const TEAM_SQUAD_PRIVACY_TASK = 'teams:squadPrivacy';
const VOICE_INVITE_CLEANUP_INTERVAL_MS = 60_000;
const TEAM_SQUAD_PRIVACY_INTERVAL_MS = 10 * 60_000;
export const VOICE_INVITE_CLEAR_PERMISSIONS: PermissionOverwriteOptions = Object.freeze({
  Connect: null,
  ViewChannel: null,
});
const VOICE_INVITE_ACCESS_PERMISSIONS = [
  PermissionsBitField.Flags.ViewChannel,
  PermissionsBitField.Flags.Connect,
];

class VoiceInviteUnavailableError extends Error {
  constructor() {
    super('Voice invite is no longer active');
    this.name = 'VoiceInviteUnavailableError';
  }
}

interface VoiceInviteIntent {
  version: 2;
  token: string;
  expiresAt: number;
}

function voiceInviteKey(squadVoiceId: string, userId: string): string {
  return `tm:vinvite:${squadVoiceId}:${userId}`;
}

function voiceInviteOccupancyKey(squadVoiceId: string, userId: string): string {
  return `tm:vinvite:occupancy:${squadVoiceId}:${userId}`;
}

function parseVoiceInviteIntent(raw: string | null, fallbackExpiresAt = 0): VoiceInviteIntent | null {
  if (!raw) return null;
  if (raw === '1') return { version: 2, token: 'legacy', expiresAt: fallbackExpiresAt };
  try {
    const parsed = JSON.parse(raw) as Partial<VoiceInviteIntent>;
    if (
      parsed.version === 2 && typeof parsed.token === 'string' && parsed.token.length > 0 &&
      typeof parsed.expiresAt === 'number' && Number.isFinite(parsed.expiresAt)
    ) return parsed as VoiceInviteIntent;
  } catch {
    // Invalid state is fail-closed and left for the expiry reconciler.
  }
  return null;
}

export function shouldCleanupVoiceInviteIntent(
  raw: string | null,
  occupancyToken: string | null,
): boolean {
  const intent = parseVoiceInviteIntent(raw);
  return Boolean(intent && (intent.token === 'legacy' || intent.token === occupancyToken));
}

export interface VoiceInviteLeaseStore {
  acquire(key: string, token: string, ttlMs: number): Promise<boolean>;
  readToken(key: string): Promise<string | null>;
  renew(key: string, token: string, ttlMs: number): Promise<boolean>;
  release(key: string, token: string): Promise<void>;
}

export interface VoiceInviteLeaseOwnership {
  key: string;
  token: string;
}

interface VoiceInviteLeaseTiming {
  ttlMs: number;
  renewMs: number;
  waitTimeoutMs: number;
  retryDelayMs: number;
}

const DEFAULT_VOICE_INVITE_LEASE_TIMING: VoiceInviteLeaseTiming = {
  ttlMs: VOICE_INVITE_LOCK_TTL_MS,
  renewMs: VOICE_INVITE_LOCK_RENEW_MS,
  waitTimeoutMs: 15_000,
  retryDelayMs: 100,
};

function redisVoiceInviteLeaseStore(): VoiceInviteLeaseStore {
  const redis = getRedis();
  return {
    async acquire(key, token, ttlMs) {
      return await redis.set(key, token, 'PX', ttlMs, 'NX') === 'OK';
    },
    readToken: (key) => redis.get(key),
    async renew(key, token, ttlMs) {
      const result = await redis.eval(
        'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("pexpire", KEYS[1], ARGV[2]) else return 0 end',
        1,
        key,
        token,
        String(ttlMs),
      );
      return Number(result) === 1;
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

export interface VoiceInviteIntentWrite {
  ownership: readonly [VoiceInviteLeaseOwnership, VoiceInviteLeaseOwnership];
  intentKey: string;
  expiryIndexKey: string;
  expiryMember: string;
  ttlMs: number;
  raw: string;
  expiresAt: number;
}

export interface VoiceInviteOccupancyWrite {
  ownership: readonly [VoiceInviteLeaseOwnership, VoiceInviteLeaseOwnership];
  intentKey: string;
  expectedIntentRaw: string;
  occupancyKey: string;
  ttlSeconds: number;
  occupancyToken: string;
}

export interface VoiceInviteClearWrite {
  ownership: readonly [VoiceInviteLeaseOwnership, VoiceInviteLeaseOwnership];
  intentKey: string;
  expectedIntentRaw: string | null;
  occupancyKey: string;
  expiryIndexKey: string;
  expiryMember: string;
}

export interface VoiceInviteOccupancyClearWrite {
  ownership: readonly [VoiceInviteLeaseOwnership, VoiceInviteLeaseOwnership];
  occupancyKey: string;
  expectedOccupancyToken: string;
}

export interface VoiceInviteAtomicStore {
  persistIntentIfOwned(input: VoiceInviteIntentWrite): Promise<boolean>;
  persistOccupancyIfOwned(input: VoiceInviteOccupancyWrite): Promise<boolean>;
  clearIntentIfOwned(input: VoiceInviteClearWrite): Promise<boolean>;
  clearOccupancyIfOwned(input: VoiceInviteOccupancyClearWrite): Promise<boolean>;
}

function redisVoiceInviteAtomicStore(): VoiceInviteAtomicStore {
  const redis = getRedis();
  return {
    async persistIntentIfOwned(input) {
      const [scope, invite] = input.ownership;
      const result = await redis.eval(
        'if redis.call("get", KEYS[1]) ~= ARGV[1] or redis.call("get", KEYS[2]) ~= ARGV[2] then return 0 end; redis.call("psetex", KEYS[3], ARGV[3], ARGV[4]); redis.call("zadd", KEYS[4], ARGV[5], ARGV[6]); return 1',
        4,
        scope.key,
        invite.key,
        input.intentKey,
        input.expiryIndexKey,
        scope.token,
        invite.token,
        String(input.ttlMs),
        input.raw,
        String(input.expiresAt),
        input.expiryMember,
      );
      return Number(result) === 1;
    },
    async persistOccupancyIfOwned(input) {
      const [scope, invite] = input.ownership;
      const result = await redis.eval(
        'if redis.call("get", KEYS[1]) ~= ARGV[1] or redis.call("get", KEYS[2]) ~= ARGV[2] or redis.call("get", KEYS[3]) ~= ARGV[3] then return 0 end; redis.call("setex", KEYS[4], ARGV[4], ARGV[5]); return 1',
        4,
        scope.key,
        invite.key,
        input.intentKey,
        input.occupancyKey,
        scope.token,
        invite.token,
        input.expectedIntentRaw,
        String(input.ttlSeconds),
        input.occupancyToken,
      );
      return Number(result) === 1;
    },
    async clearIntentIfOwned(input) {
      const [scope, invite] = input.ownership;
      const common = [
        scope.key,
        invite.key,
        input.intentKey,
        input.occupancyKey,
        input.expiryIndexKey,
        scope.token,
        invite.token,
      ];
      const result = input.expectedIntentRaw !== null
        ? await redis.eval(
          'if redis.call("get", KEYS[1]) ~= ARGV[1] or redis.call("get", KEYS[2]) ~= ARGV[2] or redis.call("get", KEYS[3]) ~= ARGV[3] then return 0 end; redis.call("del", KEYS[3]); redis.call("del", KEYS[4]); redis.call("zrem", KEYS[5], ARGV[4]); return 1',
          5,
          ...common,
          input.expectedIntentRaw,
          input.expiryMember,
        )
        : await redis.eval(
          'if redis.call("get", KEYS[1]) ~= ARGV[1] or redis.call("get", KEYS[2]) ~= ARGV[2] or redis.call("exists", KEYS[3]) ~= 0 then return 0 end; redis.call("del", KEYS[4]); redis.call("zrem", KEYS[5], ARGV[3]); return 1',
          5,
          ...common,
          input.expiryMember,
        );
      return Number(result) === 1;
    },
    async clearOccupancyIfOwned(input) {
      const [scope, invite] = input.ownership;
      const result = await redis.eval(
        'if redis.call("get", KEYS[1]) ~= ARGV[1] or redis.call("get", KEYS[2]) ~= ARGV[2] or redis.call("get", KEYS[3]) ~= ARGV[3] then return 0 end; return redis.call("del", KEYS[3])',
        3,
        scope.key,
        invite.key,
        input.occupancyKey,
        scope.token,
        invite.token,
        input.expectedOccupancyToken,
      );
      return Number(result) === 1;
    },
  };
}

export async function persistVoiceInviteIntentIfOwned(
  store: VoiceInviteAtomicStore,
  input: VoiceInviteIntentWrite,
): Promise<void> {
  if (!await store.persistIntentIfOwned(input)) {
    throw new Error(`Voice invite intent lease was lost for ${input.expiryMember}`);
  }
}

export async function persistVoiceInviteOccupancyIfOwned(
  store: VoiceInviteAtomicStore,
  input: VoiceInviteOccupancyWrite,
): Promise<void> {
  if (!await store.persistOccupancyIfOwned(input)) {
    throw new Error(`Voice invite occupancy lease was lost for ${input.occupancyKey}`);
  }
}

async function withVoiceInviteLease<T>(
  store: VoiceInviteLeaseStore,
  key: string,
  label: string,
  task: (
    assertOwned: () => Promise<void>,
    ownership: VoiceInviteLeaseOwnership,
  ) => Promise<T>,
  timing: VoiceInviteLeaseTiming = DEFAULT_VOICE_INVITE_LEASE_TIMING,
): Promise<T> {
  const token = randomUUID();
  const deadline = Date.now() + timing.waitTimeoutMs;
  while (!await store.acquire(key, token, timing.ttlMs)) {
    if (Date.now() >= deadline) throw new Error(`${label} is busy`);
    await new Promise((resolve) => setTimeout(resolve, timing.retryDelayMs));
  }
  let lost = false;
  const renew = setInterval(() => {
    void store.renew(key, token, timing.ttlMs)
      .then((renewed) => { if (!renewed) lost = true; })
      .catch(() => { lost = true; });
  }, timing.renewMs);
  renew.unref?.();
  const assertOwned = async (): Promise<void> => {
    if (lost || await store.readToken(key) !== token) {
      lost = true;
      throw new Error(`${label} lock was lost`);
    }
  };
  try {
    await assertOwned();
    return await task(assertOwned, { key, token });
  } finally {
    clearInterval(renew);
    await store.release(key, token).catch(() => undefined);
  }
}

/** Exported seam for deterministic concurrency tests and alternative stores. */
export async function withVoiceInviteScopeLease<T>(
  store: VoiceInviteLeaseStore,
  scopeId: string,
  task: (
    assertOwned: () => Promise<void>,
    ownership: VoiceInviteLeaseOwnership,
  ) => Promise<T>,
  timing: Partial<VoiceInviteLeaseTiming> = {},
): Promise<T> {
  return withVoiceInviteLease(
    store,
    `tm:vinvite:scope-lock:${scopeId}`,
    `Voice invite scope ${scopeId}`,
    task,
    { ...DEFAULT_VOICE_INVITE_LEASE_TIMING, ...timing },
  );
}

/**
 * A Discord REST rejection or a lost post-mutation lease is outcome-ambiguous.
 * Re-run the whole current-state convergence under a fresh lease immediately;
 * never wait for the periodic privacy reconciler to repair guest access.
 */
export async function runVoiceInviteMutationWithImmediateRepair<T>(
  attempt: (markDiscordMutation: () => void) => Promise<T>,
  repair: () => Promise<T>,
): Promise<T> {
  let discordMutationStarted = false;
  try {
    return await attempt(() => { discordMutationStarted = true; });
  } catch (error) {
    if (!discordMutationStarted) throw error;
    try {
      return await repair();
    } catch (repairError) {
      throw new AggregateError(
        [error, repairError],
        'Voice invite permission mutation and immediate repair both failed',
      );
    }
  }
}

async function withVoiceInviteLock<T>(
  squadVoiceId: string,
  userId: string,
  task: (
    assertOwned: () => Promise<void>,
    ownership: VoiceInviteLeaseOwnership,
  ) => Promise<T>,
): Promise<T> {
  return withVoiceInviteLease(
    redisVoiceInviteLeaseStore(),
    `tm:vinvite:lock:${squadVoiceId}:${userId}`,
    `Voice invite ${squadVoiceId}:${userId}`,
    task,
  );
}

async function resolveVoiceInviteScopeId(squadVoiceId: string): Promise<string> {
  const { getSquadByAnyVoice } = await import('../regbattle/database');
  const squad = await getSquadByAnyVoice(squadVoiceId);
  return squad?.voiceChannelId ?? squadVoiceId;
}

async function withVoiceInviteScopeLock<T>(
  squadVoiceId: string,
  task: (
    scopeId: string,
    assertOwned: () => Promise<void>,
    ownership: VoiceInviteLeaseOwnership,
  ) => Promise<T>,
): Promise<T> {
  const scopeId = await resolveVoiceInviteScopeId(squadVoiceId);
  return withVoiceInviteScopeLease(
    redisVoiceInviteLeaseStore(),
    scopeId,
    (assertOwned, ownership) => task(scopeId, assertOwned, ownership),
  );
}

/** Scope lock is always acquired before the narrower user-generation lock. */
async function withVoiceInviteMutationLock<T>(
  squadVoiceId: string,
  userId: string,
  task: (
    scopeId: string,
    assertOwned: () => Promise<void>,
    ownership: readonly [VoiceInviteLeaseOwnership, VoiceInviteLeaseOwnership],
  ) => Promise<T>,
): Promise<T> {
  return withVoiceInviteScopeLock(squadVoiceId, async (scopeId, assertScopeOwned, scopeOwnership) =>
    withVoiceInviteLock(scopeId, userId, async (assertInviteOwned, inviteOwnership) => {
      const assertOwned = async (): Promise<void> => {
        await assertScopeOwned();
        await assertInviteOwned();
      };
      return task(scopeId, assertOwned, [scopeOwnership, inviteOwnership]);
    }));
}

// Маппинг: squadVoiceId → teamId (для быстрого поиска)
const squadTeamMap = new Map<string, string>();

async function loadActiveVoiceInviteUserIds(inviteScopeId: string): Promise<Set<string>> {
  try {
    const redis = getRedis();
    const entries = await redis.zrangebyscore(VOICE_INVITE_EXPIRY_INDEX, Date.now(), '+inf');
    const prefix = `${inviteScopeId}:`;
    const userIds = entries
      .filter((entry) => entry.startsWith(prefix))
      .map((entry) => entry.slice(prefix.length))
      .filter(Boolean);
    const values = await Promise.all(
      userIds.map((userId) => redis.get(`tm:vinvite:${inviteScopeId}:${userId}`)),
    );
    return new Set(userIds.filter((_userId, index) => {
      const intent = parseVoiceInviteIntent(values[index]);
      return Boolean(intent && (intent.expiresAt === 0 || intent.expiresAt > Date.now()));
    }));
  } catch (error) {
    // Privacy fails closed: an unavailable invite store may temporarily revoke
    // guest access, but must never leave inherited generic access enabled.
    log.warn(`Voice invites unavailable while hardening team squad ${inviteScopeId}`, {
      error: String(error),
    });
    return new Set();
  }
}

async function getRelatedSquadVoiceIds(squadVoiceId: string): Promise<string[]> {
  const { getSquadByAnyVoice } = await import('../regbattle/database');
  const squad = await getSquadByAnyVoice(squadVoiceId);
  if (!squad) return [squadVoiceId];
  return [...new Set([squad.voiceChannelId, squad.airChannelId].filter(Boolean) as string[])];
}

export interface TeamPermissionOverwriteSnapshot {
  id: string;
  type: OverwriteType;
  allow: bigint;
  deny: bigint;
}

export type VoiceInviteMemberCleanupAction = 'none' | 'delete' | 'edit';

/** Decide whether clearing temporary PB access can remove the whole member overwrite. */
export function getVoiceInviteMemberCleanupAction(
  overwrite: TeamPermissionOverwriteSnapshot | null | undefined,
): VoiceInviteMemberCleanupAction {
  if (!overwrite || overwrite.type !== OverwriteType.Member) return 'none';
  const remainingAllow = new PermissionsBitField(overwrite.allow)
    .remove(VOICE_INVITE_ACCESS_PERMISSIONS);
  const remainingDeny = new PermissionsBitField(overwrite.deny)
    .remove(VOICE_INVITE_ACCESS_PERMISSIONS);
  return remainingAllow.bitfield === 0n && remainingDeny.bitfield === 0n
    ? 'delete'
    : 'edit';
}

async function clearVoiceInviteMemberOverwrite(
  channel: Pick<VoiceChannel, 'permissionOverwrites'>,
  userId: string,
  reason: string,
  assertOwned: () => Promise<void>,
  markDiscordMutation: () => void,
): Promise<void> {
  await assertOwned();
  const overwrite = channel.permissionOverwrites.cache.get(userId);
  const action = getVoiceInviteMemberCleanupAction(overwrite ? {
    id: overwrite.id,
    type: overwrite.type,
    allow: overwrite.allow.bitfield,
    deny: overwrite.deny.bitfield,
  } : null);
  if (action === 'none') return;

  markDiscordMutation();
  if (action === 'delete') {
    await channel.permissionOverwrites.delete(userId, reason);
  } else {
    await channel.permissionOverwrites.edit(
      userId,
      VOICE_INVITE_CLEAR_PERMISSIONS,
      { reason, type: OverwriteType.Member },
    );
  }
  await assertOwned();
}

/** Pure canonicalizer used by runtime reconciliation and policy tests. */
export function buildPrivateTeamSquadOverwrites(
  current: readonly TeamPermissionOverwriteSnapshot[],
  guildId: string,
  ownerId: string,
  teamRoleId: string,
  botId: string,
  inviteUserIds: ReadonlySet<string>,
): TeamPermissionOverwriteSnapshot[] {
  if (teamRoleId === guildId) {
    throw new Error('The @everyone role cannot be used as a private team role');
  }
  const accessBits = VOICE_INVITE_ACCESS_PERMISSIONS;
  const overwrites = new Map<string, TeamPermissionOverwriteSnapshot>();

  for (const overwrite of current) {
    const allow = new PermissionsBitField(overwrite.allow);
    const deny = new PermissionsBitField(overwrite.deny);
    const exactRole = overwrite.type === OverwriteType.Role && overwrite.id === teamRoleId;
    const exactMember = overwrite.type === OverwriteType.Member && (
      overwrite.id === ownerId || overwrite.id === botId || inviteUserIds.has(overwrite.id)
    );
    if (exactRole || exactMember) {
      deny.remove(accessBits);
      allow.add(accessBits);
    } else if (overwrite.type === OverwriteType.Member) {
      // A member-level deny is evaluated after role overwrites by Discord and
      // would lock a legitimate team-role holder out. Unrelated member entries
      // therefore carry no View/Connect opinion; @everyone is the default deny.
      allow.remove(accessBits);
      deny.remove(accessBits);
      if (allow.bitfield === 0n && deny.bitfield === 0n) continue;
    } else {
      allow.remove(accessBits);
      deny.add(accessBits);
    }
    overwrites.set(`${overwrite.type}:${overwrite.id}`, {
      id: overwrite.id,
      type: overwrite.type,
      allow: allow.bitfield,
      deny: deny.bitfield,
    });
  }

  const grantExactAccess = (id: string, type: OverwriteType): void => {
    const key = `${type}:${id}`;
    const existing = overwrites.get(key);
    const allow = new PermissionsBitField(existing?.allow ?? 0n).add(accessBits);
    const deny = new PermissionsBitField(existing?.deny ?? 0n).remove(accessBits);
    overwrites.set(key, { id, type, allow: allow.bitfield, deny: deny.bitfield });
  };

  // Always materialise the privacy boundary even if the master channel did
  // not have an explicit @everyone overwrite. Members with Administrator can
  // bypass channel overwrites by Discord design and are a trusted boundary.
  const everyoneKey = `${OverwriteType.Role}:${guildId}`;
  const everyone = overwrites.get(everyoneKey);
  overwrites.set(everyoneKey, {
    id: guildId,
    type: OverwriteType.Role,
    allow: new PermissionsBitField(everyone?.allow ?? 0n).remove(accessBits).bitfield,
    deny: new PermissionsBitField(everyone?.deny ?? 0n).add(accessBits).bitfield,
  });
  grantExactAccess(teamRoleId, OverwriteType.Role);
  grantExactAccess(ownerId, OverwriteType.Member);
  grantExactAccess(botId, OverwriteType.Member);
  for (const userId of inviteUserIds) grantExactAccess(userId, OverwriteType.Member);
  return [...overwrites.values()];
}

/** Order-independent equality check used to avoid no-op Discord bulk writes. */
export function areTeamPermissionOverwritesEquivalent(
  current: readonly TeamPermissionOverwriteSnapshot[],
  desired: readonly TeamPermissionOverwriteSnapshot[],
): boolean {
  if (current.length !== desired.length) return false;
  const desiredByKey = new Map(
    desired.map((overwrite) => [`${overwrite.type}:${overwrite.id}`, overwrite] as const),
  );
  if (desiredByKey.size !== desired.length) return false;
  return current.every((overwrite) => {
    const expected = desiredByKey.get(`${overwrite.type}:${overwrite.id}`);
    return Boolean(
      expected && expected.allow === overwrite.allow && expected.deny === overwrite.deny,
    );
  });
}

/**
 * Canonical privacy boundary for team PB squads. Inherited master-channel
 * access is retained for unrelated permissions but can never retain generic
 * View/Connect access. Redis is read before Discord so an outage fails closed
 * without replacing a known-good permission set.
 */
export async function enforcePrivateTeamSquadPermissions(
  channel: VoiceChannel,
  ownerId: string,
  teamRoleId: string,
  isCurrent: () => boolean = () => true,
): Promise<void> {
  await runVoiceInviteMutationWithImmediateRepair(
    (markDiscordMutation) => enforcePrivateTeamSquadPermissionsAttempt(
      channel,
      ownerId,
      teamRoleId,
      isCurrent,
      markDiscordMutation,
    ),
    async () => {
      const refreshed = await channel.guild.channels.fetch(channel.id, { force: true });
      if (!refreshed?.isVoiceBased()) {
        throw new Error(`Private squad voice ${channel.id} is unavailable during repair`);
      }
      await enforcePrivateTeamSquadPermissionsAttempt(
        refreshed as VoiceChannel,
        ownerId,
        teamRoleId,
        () => true,
        () => undefined,
      );
    },
  );
}

async function enforcePrivateTeamSquadPermissionsAttempt(
  channel: VoiceChannel,
  ownerId: string,
  teamRoleId: string,
  isCurrent: () => boolean,
  markDiscordMutation: () => void,
): Promise<void> {
  if (!isCurrent()) throw new Error('Teams privacy runtime generation is obsolete');
  const botId = channel.client.user.id;
  const teamRole = await channel.guild.roles.fetch(teamRoleId, { force: true });
  if (!isCurrent()) throw new Error('Teams privacy runtime generation is obsolete');
  if (!teamRole || teamRole.guild.id !== channel.guild.id) {
    throw new Error(`Team role ${teamRoleId} is unavailable for private squad ${channel.id}`);
  }
  await withVoiceInviteScopeLock(channel.id, async (scopeId, assertOwned) => {
    const assertCurrentOwned = async (): Promise<void> => {
      if (!isCurrent()) throw new Error('Teams privacy runtime generation is obsolete');
      await assertOwned();
    };
    // Snapshot and whole-channel canonical write share the same scope lock as
    // invite/cleanup edits. A stale reconciliation can therefore neither
    // resurrect a removed invite nor erase a newly-created generation.
    const inviteUserIds = await loadActiveVoiceInviteUserIds(scopeId);
    await assertCurrentOwned();
    const currentOverwrites = [...channel.permissionOverwrites.cache.values()].map((overwrite) => ({
        id: overwrite.id,
        type: overwrite.type,
        allow: overwrite.allow.bitfield,
        deny: overwrite.deny.bitfield,
      }));
    const overwrites = buildPrivateTeamSquadOverwrites(
      currentOverwrites,
      channel.guild.id,
      ownerId,
      teamRoleId,
      botId,
      inviteUserIds,
    );

    if (areTeamPermissionOverwritesEquivalent(currentOverwrites, overwrites)) return;

    await assertCurrentOwned();
    markDiscordMutation();
    await channel.permissionOverwrites.set(
      overwrites,
      'Teams: enforce private PB squad permissions',
    );
    await assertCurrentOwned();
  });
}

export interface TeamSquadContext {
  teamId: string;
  teamRoleId: string;
  teamName: string;
}

// ═══════════════════════════════════════════════
//  Определить: является ли создатель отряда членом команды
// ═══════════════════════════════════════════════

/**
 * Вызывается из regbattle.lifecycle после создания отряда.
 * Если владелец — в команде, привязываем отряд к команде
 * и запускаем командную сессию.
 */
export async function onSquadCreated(
  squadVoiceId: string,
  ownerId: string,
  guildId: string,
  squadNumber: number,
): Promise<{
  isTeamSquad: boolean;
  teamRoleId?: string;
  teamId?: string;
}> {
  const team = await db.getMemberTeamInGuild(ownerId, guildId);
  if (!team || team.guildId !== guildId || team.status !== TeamStatus.ACTIVE) {
    return { isTeamSquad: false };
  }

  // Создать командную сессию
  await db.createSession({
    teamId: team.id,
    guildId,
    squadNumber,
    squadVoiceId,
  });

  // Publish the in-memory association only after the durable session commit.
  squadTeamMap.set(squadVoiceId, team.id);

  log.info(`Отряд #${squadNumber} привязан к команде «${team.name}» (войс ${squadVoiceId})`);

  return {
    isTeamSquad: true,
    teamRoleId: team.roleId,
    teamId: team.id,
  };
}

/**
 * Вызывается при удалении отряда.
 * Завершает сессию команды и отправляет запрос отчёта.
 */
export async function onSquadDeleted(
  squadVoiceId: string,
  ownerId: string,
  client: BublikClient,
): Promise<void> {
  let teamId = squadTeamMap.get(squadVoiceId);
  if (!teamId) {
    const active = await db.getActiveSessionByVoice(squadVoiceId);
    teamId = active?.teamId;
  }
  if (!teamId) return;

  squadTeamMap.delete(squadVoiceId);

  const team = await db.getTeam(teamId);
  if (!team) return;

  // Завершить активную сессию
  const session = await db.getActiveSession(teamId);
  if (session) {
    await db.endSession(session.id);

    // Отправить запрос отчёта владельцу
    try {
      const { sendReportRequest } = await import('./reports');
      await sendReportRequest(client, session.id, ownerId, team.name, session.squadNumber);
    } catch (err) {
      log.error('Ошибка отправки запроса отчёта', { error: String(err) });
    }
  }

  log.info(`Сессия команды «${team.name}» завершена (войс ${squadVoiceId})`);
}

// ═══════════════════════════════════════════════
//  Проверка: командный ли это отряд
// ═══════════════════════════════════════════════

export function isTeamSquad(squadVoiceId: string): boolean {
  return squadTeamMap.has(squadVoiceId);
}

export function getTeamIdForSquad(squadVoiceId: string): string | undefined {
  return squadTeamMap.get(squadVoiceId);
}

export async function getTeamRoleForSquad(squadVoiceId: string): Promise<string | null> {
  const teamId = squadTeamMap.get(squadVoiceId);
  if (!teamId) return null;

  const team = await db.getTeam(teamId);
  return team?.roleId ?? null;
}

/**
 * Resolve a team squad from the durable TeamSession record. This removes module
 * load-order dependence on the in-memory map.
 */
export async function resolveTeamSquad(
  squadVoiceId: string,
  guildId: string,
): Promise<TeamSquadContext | null> {
  let teamId = squadTeamMap.get(squadVoiceId);
  let team = teamId ? await db.getTeam(teamId) : null;

  if (!team || team.guildId !== guildId || team.status !== TeamStatus.ACTIVE) {
    const active = await db.getActiveSessionByVoice(squadVoiceId);
    team = active?.team ?? null;
    teamId = active?.teamId;
    if (team && teamId && team.guildId === guildId && team.status === TeamStatus.ACTIVE) {
      squadTeamMap.set(squadVoiceId, teamId);
    }
  }

  if (!team || !teamId || team.guildId !== guildId || team.status !== TeamStatus.ACTIVE) return null;
  return { teamId, teamRoleId: team.roleId, teamName: team.name };
}

export async function isCurrentTeamMember(userId: string, teamId: string, guildId: string): Promise<boolean> {
  const team = await db.getMemberTeamInGuild(userId, guildId);
  return Boolean(team && team.id === teamId && team.status === TeamStatus.ACTIVE);
}

export async function getMemberTeamEligibility(userId: string, guildId: string): Promise<TeamSquadContext | null> {
  const team = await db.getMemberTeamInGuild(userId, guildId);
  if (!team || team.guildId !== guildId || team.status !== TeamStatus.ACTIVE) return null;
  return { teamId: team.id, teamRoleId: team.roleId, teamName: team.name };
}

export async function hasVoiceInvite(squadVoiceId: string, userId: string): Promise<boolean> {
  const intent = parseVoiceInviteIntent(await getRedis().get(voiceInviteKey(squadVoiceId, userId)));
  return Boolean(intent && (intent.expiresAt === 0 || intent.expiresAt > Date.now()));
}

export async function recordVoiceInviteOccupancy(
  squadVoiceId: string,
  userId: string,
): Promise<void> {
  await withVoiceInviteMutationLock(squadVoiceId, userId, async (scopeId, assertOwned, ownership) => {
    const redis = getRedis();
    const intentKey = voiceInviteKey(scopeId, userId);
    const raw = await redis.get(intentKey);
    const intent = parseVoiceInviteIntent(raw);
    if (!raw || !intent || (intent.expiresAt !== 0 && intent.expiresAt <= Date.now())) return;
    const ttlSeconds = intent.expiresAt === 0
      ? Math.max(1, await redis.ttl(intentKey))
      : Math.max(1, Math.ceil((intent.expiresAt - Date.now()) / 1000));
    await assertOwned();
    await persistVoiceInviteOccupancyIfOwned(redisVoiceInviteAtomicStore(), {
      ownership,
      intentKey,
      expectedIntentRaw: raw,
      occupancyKey: voiceInviteOccupancyKey(scopeId, userId),
      ttlSeconds,
      occupancyToken: intent.token,
    });
  });
}

async function canInviteToSquad(guildId: string, squadVoiceId: string, userId: string): Promise<boolean> {
  const { getSquadByVoice } = await import('../regbattle/database');
  const squad = await getSquadByVoice(squadVoiceId);
  if (!squad || squad.guildId !== guildId) return false;
  if (squad.ownerId === userId) return true;
  const context = await resolveTeamSquad(squad.voiceChannelId, guildId);
  if (!context) return false;
  const team = await db.getTeam(context.teamId);
  return team?.leaderId === userId;
}

// ═══════════════════════════════════════════════
//  Приглашение в войс из панели отряда
// ═══════════════════════════════════════════════

export async function handleSquadInvite(
  interaction: ButtonInteraction,
  squadId: string,
  _client: BublikClient,
): Promise<void> {
  if (!interaction.guildId || !(await canInviteToSquad(interaction.guildId, squadId, interaction.user.id))) {
    await interaction.reply({ embeds: [tmError('Приглашать в этот войс может только командир отряда.')], ephemeral: true });
    return;
  }
  await interaction.reply({
    embeds: [tmWarn('Выберите участника для приглашения в войс:')],
    components: [buildVoiceInviteSelect(squadId)],
    ephemeral: true,
  });
}

function buildVoiceInviteSelect(squadId: string) {
  const { UserSelectMenuBuilder, ActionRowBuilder } = require('discord.js');
  const select = new UserSelectMenuBuilder()
    .setCustomId(`tm:sel:vinvite_target:${squadId}`)
    .setPlaceholder('Выберите участника')
    .setMinValues(1)
    .setMaxValues(1);
  return new ActionRowBuilder().addComponents(select);
}

export async function handleSquadInviteSelect(
  interaction: UserSelectMenuInteraction,
  squadId: string,
  _client: BublikClient,
  guard?: ModuleExecutionGuard,
): Promise<void> {
  guard?.assertCurrent();
  await interaction.deferUpdate();
  if (guard && !guard.isCurrent()) return;

  const guild = interaction.guild!;
  if (!(await canInviteToSquad(guild.id, squadId, interaction.user.id))) {
    await interaction.editReply({ embeds: [tmError('Право приглашать в этот войс больше не подтверждено.')], components: [] });
    return;
  }
  if (guard && !guard.isCurrent()) return;
  const targetId = interaction.values[0];
  const target = guild.members.cache.get(targetId) || await guild.members.fetch(targetId).catch(() => null);
  if (guard && !guard.isCurrent()) return;

  if (!target || target.user.bot) {
    await interaction.editReply({ embeds: [tmError('Участник не найден.')], components: [] });
    return;
  }

  // Найти голосовой канал
  const vc = guild.channels.cache.get(squadId) as VoiceChannel | undefined;
  if (!vc) {
    await interaction.editReply({ embeds: [tmError('Голосовой канал не найден.')], components: [] });
    return;
  }

  // Persist authorisation before exposing the join button. The sorted-set entry
  // also lets a restarted bot remove an unused Discord overwrite after 24h.
  const expiresAt = Date.now() + 86_400_000;
  let permissionReady = true;
  let permissionError: unknown = null;
  let persistedScopeId: string | null = null;
  let persistedRaw: string | null = null;
  let durableIntentConfirmed = false;
  try {
    await runVoiceInviteMutationWithImmediateRepair(
      (markDiscordMutation) => withVoiceInviteMutationLock(
        squadId,
        targetId,
        async (scopeId, assertOwned, ownership) => {
          const assertCurrentOwned = async (): Promise<void> => {
            guard?.assertCurrent();
            await assertOwned();
          };
          const intent: VoiceInviteIntent = { version: 2, token: randomUUID(), expiresAt };
          const raw = JSON.stringify(intent);
          await assertCurrentOwned();
          // Capture the exact attempted generation before EVAL. Redis may have
          // committed even when the client receives a connection error.
          persistedScopeId = scopeId;
          persistedRaw = raw;
          markDiscordMutation();
          await persistVoiceInviteIntentIfOwned(redisVoiceInviteAtomicStore(), {
            ownership,
            intentKey: voiceInviteKey(scopeId, targetId),
            expiryIndexKey: VOICE_INVITE_EXPIRY_INDEX,
            expiryMember: `${scopeId}:${targetId}`,
            ttlMs: 86_400_000,
            raw,
            expiresAt,
          });
          // A durable generation now exists. Any later lease loss must repair
          // permissions from current Redis state before this handler returns.
          await assertCurrentOwned();
          for (const channelId of await getRelatedSquadVoiceIds(scopeId)) {
            const targetChannel = channelId === vc.id
              ? vc
              : await guild.channels.fetch(channelId, { force: true });
            if (!targetChannel?.isVoiceBased()) continue;
            await assertCurrentOwned();
            await targetChannel.permissionOverwrites.edit(targetId, {
              Connect: true,
              ViewChannel: true,
            } as PermissionOverwriteOptions, {
              reason: `Приглашение в войс от ${interaction.user.tag}`,
              type: OverwriteType.Member,
            });
            await assertCurrentOwned();
          }
        },
      ),
      async () => {
        if (guard && !guard.isCurrent() && persistedScopeId && persistedRaw) {
          await discardVoiceInviteIntentGeneration(
            persistedScopeId,
            targetId,
            persistedRaw,
          );
        }
        await reconcileCurrentVoiceInvitePermissionNow(squadId, targetId, guild);
      },
    );
    if (guard && !guard.isCurrent()) return;
    if (persistedScopeId) {
      const current = parseVoiceInviteIntent(
        await getRedis().get(voiceInviteKey(persistedScopeId, targetId)),
      );
      if (guard && !guard.isCurrent()) return;
      permissionReady = Boolean(
        current && (current.expiresAt === 0 || current.expiresAt > Date.now()),
      );
      durableIntentConfirmed = permissionReady;
    }
  } catch (error) {
    if (guard && !guard.isCurrent()) return;
    permissionError = error;
    permissionReady = false;
    if (persistedScopeId) {
      try {
        const current = parseVoiceInviteIntent(
          await getRedis().get(voiceInviteKey(persistedScopeId, targetId)),
        );
        durableIntentConfirmed = Boolean(
          current && (current.expiresAt === 0 || current.expiresAt > Date.now()),
        );
      } catch {
        durableIntentConfirmed = false;
      }
    }
  }
  if (guard && !guard.isCurrent()) return;
  if (!permissionReady) {
    if (!durableIntentConfirmed) {
      await interaction.editReply({
        embeds: [tmError('Не удалось надёжно сохранить приглашение. Повторите попытку.')],
        components: [],
      });
      log.warn(`Voice-инвайт ${targetId} → ${squadId} не подтверждён`, {
        error: String(permissionError),
      });
      return;
    }
    await interaction.editReply({
      embeds: [tmWarn('Приглашение сохранено. Доступ к войсу будет выдан автоматически после восстановления связи с Discord.')],
      components: [],
    });
    log.warn(`Voice-инвайт ${targetId} → ${squadId} сохранён для восстановления`, {
      error: String(permissionError),
    });
    return;
  }
  if (permissionError) {
    log.warn(`Voice-инвайт ${targetId} → ${squadId} подтверждён после неоднозначного REST-ответа`, {
      error: String(permissionError),
    });
  }

  // Отправить DM с кнопкой
  if (guard && !guard.isCurrent()) return;
  try {
    const embed = buildVoiceInviteEmbed(
      '', // будет заполнено из team name если есть
      interaction.user.tag,
      guild.name,
      vc.name,
    );
    const button = buildVoiceInviteButton(squadId, targetId);
    await target.send({ embeds: [embed], components: [button] }).catch(() => null);
  } catch { /* DMs closed */ }

  if (guard && !guard.isCurrent()) return;
  await interaction.editReply({
    embeds: [tmSuccess(`Приглашение отправлено **${target.user.tag}**!`)],
    components: [],
  });

  log.info(`Приглашение в войс: ${target.user.tag} → ${vc.name} (от ${interaction.user.tag})`);

}

export async function handleVoiceInviteJoin(
  interaction: ButtonInteraction,
  squadId: string,
  userId: string,
  client: BublikClient,
  guard?: ModuleExecutionGuard,
): Promise<void> {
  guard?.assertCurrent();
  if (interaction.user.id !== userId) {
    await interaction.reply({ embeds: [tmError('Это приглашение не для вас.')], ephemeral: true });
    return;
  }

  const invitationExists = await hasVoiceInvite(squadId, userId);
  if (guard && !guard.isCurrent()) return;
  if (!invitationExists) {
    await interaction.reply({ embeds: [tmError('Приглашение истекло или уже использовано.')], ephemeral: true });
    return;
  }

  // DM interactions carry no guildId. Resolve the durable PB squad before any
  // Discord mutation and bind this legacy custom id to its authorised guild.
  const { getSquadByVoice } = await import('../regbattle/database');
  const squad = await getSquadByVoice(squadId);
  if (guard && !guard.isCurrent()) return;
  if (!squad || !isGuildAllowed(squad.guildId)) {
    await interaction.reply({ embeds: [tmError('Сервер этого приглашения больше не авторизован.')], ephemeral: true });
    return;
  }

  await interaction.deferUpdate();
  if (guard && !guard.isCurrent()) return;

  const guild = client.guilds.cache.get(squad.guildId);
  let moveError: unknown = null;
  if (guild) {
    const vc = guild.channels.cache.get(squadId) as VoiceChannel | undefined;
    if (vc) {
      const member = guild.members.cache.get(userId) || await guild.members.fetch(userId).catch(() => null);
      if (guard && !guard.isCurrent()) return;
      if (member) {
        const previousChannelId = member.voice.channelId;
        try {
          const invitationStillActive = await runVoiceInviteMutationWithImmediateRepair(
            (markDiscordMutation) => withVoiceInviteMutationLock(
              squadId,
              userId,
              async (scopeId, assertOwned) => {
                const assertCurrentOwned = async (): Promise<void> => {
                  guard?.assertCurrent();
                  await assertOwned();
                };
                const intent = parseVoiceInviteIntent(
                  await getRedis().get(voiceInviteKey(scopeId, userId)),
                );
                await assertCurrentOwned();
                if (!intent || (intent.expiresAt !== 0 && intent.expiresAt <= Date.now())) {
                  throw new VoiceInviteUnavailableError();
                }
                // A disconnected member can accept the invite and join later.
                if (!member.voice.channelId || member.voice.channelId === vc.id) return true;
                markDiscordMutation();
                await member.voice.setChannel(vc, 'Принял приглашение в войс ПБ');
                await assertCurrentOwned();
                return true;
              },
            ),
            () => reconcileVoiceInviteMemberLocationNow(
              squadId,
              userId,
              guild,
              vc,
              previousChannelId,
            ),
          );
          if (!invitationStillActive) throw new VoiceInviteUnavailableError();
        } catch (error) {
          moveError = error;
        }
      }
    }
  }

  if (guard && !guard.isCurrent()) return;
  if (moveError instanceof VoiceInviteUnavailableError) {
    await interaction.editReply({
      embeds: [tmError('Приглашение уже отозвано или истекло.')],
      components: [],
    });
    return;
  }
  if (moveError) {
    await interaction.editReply({
      embeds: [tmWarn('Приглашение активно, но перемещение не подтверждено. Зайдите в войс вручную или повторите попытку.')],
      components: [],
    });
    log.warn(`Не удалось подтвердить перемещение по voice-инвайту ${userId} → ${squadId}`, {
      error: String(moveError),
    });
    return;
  }
  await interaction.editReply({
    embeds: [tmSuccess('Вы принимаете приглашение! Если вы не в войсе — зайдите в любой голосовой канал.')],
    components: [],
  });
}

/**
 * При выходе из войса — снять временный доступ у приглашённых
 */
export async function cleanupVoiceInvitePerms(
  squadVoiceId: string,
  userId: string,
  guild: any,
  force = false,
): Promise<void> {
  await runVoiceInviteMutationWithImmediateRepair(
    (markDiscordMutation) => cleanupVoiceInvitePermsAttempt(
      squadVoiceId,
      userId,
      guild,
      force,
      markDiscordMutation,
    ),
    () => cleanupVoiceInvitePermsAttempt(squadVoiceId, userId, guild, force, () => undefined),
  );
}

async function cleanupVoiceInvitePermsAttempt(
  squadVoiceId: string,
  userId: string,
  guild: any,
  force: boolean,
  markDiscordMutation: () => void,
): Promise<void> {
  await withVoiceInviteMutationLock(squadVoiceId, userId, async (scopeId, assertOwned, ownership) => {
    const r = getRedis();
    const key = voiceInviteKey(scopeId, userId);
    const occupancyKey = voiceInviteOccupancyKey(scopeId, userId);
    const [raw, occupancyToken] = await Promise.all([r.get(key), r.get(occupancyKey)]);
    const intent = parseVoiceInviteIntent(raw);
    if (!raw && !force) return;
    // A leave event may arrive after a fresh re-invite. Only the generation
    // captured while the member was actually in this voice may remove it.
    const activeIntent = Boolean(
      intent && (intent.expiresAt === 0 || intent.expiresAt > Date.now()),
    );
    const preserveCurrentInvite = Boolean(
      activeIntent && !shouldCleanupVoiceInviteIntent(raw, occupancyToken),
    );
    if (preserveCurrentInvite) {
      const errors: unknown[] = [];
      for (const channelId of await getRelatedSquadVoiceIds(scopeId)) {
        try {
          const vc = guild.channels.cache.get(channelId) ?? await guild.channels.fetch(channelId);
          if (vc?.isVoiceBased()) {
            await assertOwned();
            markDiscordMutation();
            await vc.permissionOverwrites.edit(userId, {
              Connect: true,
              ViewChannel: true,
            }, {
              reason: 'Teams: repair current PB voice invite generation',
              type: OverwriteType.Member,
            });
            await assertOwned();
          }
        } catch (error) {
          if (!hasDiscordErrorCode(error, 10003)) errors.push(error);
        }
      }
      if (errors.length > 0) {
        throw new AggregateError(errors, `Voice invite repair is incomplete for ${scopeId}:${userId}`);
      }
      if (occupancyToken) {
        await assertOwned();
        const occupancyCleared = await redisVoiceInviteAtomicStore().clearOccupancyIfOwned({
          ownership,
          occupancyKey,
          expectedOccupancyToken: occupancyToken,
        });
        if (!occupancyCleared) await assertOwned();
      }
      return;
    }

    const errors: unknown[] = [];
    for (const channelId of await getRelatedSquadVoiceIds(scopeId)) {
      try {
        // Deletion is safe only from an authoritative overwrite snapshot: a
        // stale cache could hide unrelated bits that must survive the cleanup.
        const vc = await guild.channels.fetch(channelId, { force: true });
        if (vc?.isVoiceBased()) {
          await clearVoiceInviteMemberOverwrite(
            vc,
            userId,
            'Приглашённый покинул войс',
            assertOwned,
            markDiscordMutation,
          );
        }
      } catch (error) {
        // Only an authoritative missing-channel response makes this channel's
        // cleanup complete. Any transient failure retains the global intent.
        if (!hasDiscordErrorCode(error, 10003)) errors.push(error);
      }
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, `Voice invite cleanup is incomplete for ${squadVoiceId}:${userId}`);
    }
    await assertOwned();
    const expiryMember = `${scopeId}:${userId}`;
    const cleared = await redisVoiceInviteAtomicStore().clearIntentIfOwned({
      ownership,
      intentKey: key,
      expectedIntentRaw: raw,
      occupancyKey,
      expiryIndexKey: VOICE_INVITE_EXPIRY_INDEX,
      expiryMember,
    });
    if (!cleared) {
      await assertOwned();
      throw new Error(`Voice invite state changed during cleanup for ${scopeId}:${userId}`);
    }
    log.debug(`Снят временный доступ: ${userId} → ${scopeId}`);
  });
}

async function reconcileCurrentVoiceInvitePermissionNow(
  squadVoiceId: string,
  userId: string,
  guild: any,
): Promise<void> {
  await withVoiceInviteMutationLock(squadVoiceId, userId, async (scopeId, assertOwned) => {
    const redis = getRedis();
    const [raw, scoreRaw] = await Promise.all([
      redis.get(voiceInviteKey(scopeId, userId)),
      redis.zscore(VOICE_INVITE_EXPIRY_INDEX, `${scopeId}:${userId}`),
    ]);
    const score = Number(scoreRaw);
    const intent = parseVoiceInviteIntent(raw, score);
    const active = Boolean(
      intent && score > Date.now() &&
      (intent.expiresAt === 0 || intent.expiresAt > Date.now()),
    );
    const errors: unknown[] = [];
    for (const channelId of await getRelatedSquadVoiceIds(scopeId)) {
      try {
        const channel = await guild.channels.fetch(channelId, { force: true });
        if (!channel?.isVoiceBased()) continue;
        if (active) {
          await assertOwned();
          await channel.permissionOverwrites.edit(userId, {
            Connect: true,
            ViewChannel: true,
          }, {
            reason: 'Teams: immediate repair after ambiguous voice-invite mutation',
            type: OverwriteType.Member,
          });
          await assertOwned();
        } else {
          await clearVoiceInviteMemberOverwrite(
            channel,
            userId,
            'Teams: immediate repair of expired voice invite',
            assertOwned,
            () => undefined,
          );
        }
      } catch (error) {
        if (!hasDiscordErrorCode(error, 10003)) errors.push(error);
      }
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, `Voice invite immediate repair failed for ${scopeId}:${userId}`);
    }
  });
}

async function discardVoiceInviteIntentGeneration(
  squadVoiceId: string,
  userId: string,
  expectedRaw: string,
): Promise<void> {
  await withVoiceInviteMutationLock(
    squadVoiceId,
    userId,
    async (scopeId, assertOwned, ownership) => {
      await assertOwned();
      await redisVoiceInviteAtomicStore().clearIntentIfOwned({
        ownership,
        intentKey: voiceInviteKey(scopeId, userId),
        expectedIntentRaw: expectedRaw,
        occupancyKey: voiceInviteOccupancyKey(scopeId, userId),
        expiryIndexKey: VOICE_INVITE_EXPIRY_INDEX,
        expiryMember: `${scopeId}:${userId}`,
      });
    },
  );
}

async function reconcileVoiceInviteMemberLocationNow(
  squadVoiceId: string,
  userId: string,
  guild: Guild,
  targetChannel: VoiceChannel,
  previousChannelId: string | null,
): Promise<boolean> {
  return withVoiceInviteMutationLock(squadVoiceId, userId, async (scopeId, assertOwned) => {
    const intent = parseVoiceInviteIntent(
      await getRedis().get(voiceInviteKey(scopeId, userId)),
    );
    const active = Boolean(
      intent && (intent.expiresAt === 0 || intent.expiresAt > Date.now()),
    );
    await assertOwned();

    let voiceState;
    try {
      voiceState = await guild.voiceStates.fetch(userId, { force: true });
    } catch (error) {
      if (
        hasDiscordErrorCode(error, 10007) ||
        hasDiscordErrorCode(error, 10065) ||
        hasDiscordErrorCode(error, 40032)
      ) return active;
      throw error;
    }
    await assertOwned();
    if (!voiceState.channelId) return active;

    if (active) {
      if (voiceState.channelId !== targetChannel.id) {
        await voiceState.setChannel(targetChannel, 'Teams: repair accepted PB voice invite');
        await assertOwned();
      }
      return true;
    }

    // Undo only a move that this ambiguous request could have caused. Someone
    // who was already in the target before clicking must never be disconnected.
    if (previousChannelId === targetChannel.id || voiceState.channelId !== targetChannel.id) return false;
    const previous = previousChannelId
      ? await guild.channels.fetch(previousChannelId, { force: true }).catch(() => null)
      : null;
    await assertOwned();
    await voiceState.setChannel(
      previous?.isVoiceBased() ? previous as VoiceChannel : null,
      'Teams: compensate revoked PB voice invite move',
    );
    await assertOwned();
    return false;
  });
}

/** Reconcile the indexed invite set. Startup includes active permissions;
 * periodic cleanup reads the complete due snapshot so failed head entries
 * cannot starve later expirations. */
async function reconcileIndexedVoiceInvites(
  client: BublikClient,
  isCurrent: () => boolean = () => true,
  includeActive: boolean,
): Promise<void> {
  if (!isCurrent()) return;
  const redis = getRedis();
  const entries = includeActive
    ? await redis.zrange(VOICE_INVITE_EXPIRY_INDEX, 0, -1)
    : await redis.zrangebyscore(
      VOICE_INVITE_EXPIRY_INDEX,
      '-inf',
      Date.now(),
    );
  for (const entry of entries) {
    if (!isCurrent()) return;
    const [squadVoiceId, userId] = entry.split(':');
    if (!squadVoiceId || !userId) {
      await redis.zrem(VOICE_INVITE_EXPIRY_INDEX, entry);
      continue;
    }
    let discordMutationStarted = false;
    let repairGuild: any = null;
    try {
      await withVoiceInviteMutationLock(squadVoiceId, userId, async (scopeId, assertOwned, ownership) => {
        if (!isCurrent()) return;
        const assertCurrentOwned = async (): Promise<void> => {
          if (!isCurrent()) throw new Error('Teams voice invite runtime generation is obsolete');
          await assertOwned();
        };
        const key = voiceInviteKey(scopeId, userId);
        const [expiresAtRaw, raw] = await Promise.all([
          redis.zscore(VOICE_INVITE_EXPIRY_INDEX, entry),
          redis.get(key),
        ]);
        const scoreExpiresAt = Number(expiresAtRaw);
        const intent = parseVoiceInviteIntent(raw, scoreExpiresAt);
        const active = Boolean(
          intent && scoreExpiresAt > Date.now() &&
          (intent.expiresAt === 0 || intent.expiresAt > Date.now()),
        );
        let allResolved = true;
        let liveChannels = 0;
        const relatedChannelIds = await getRelatedSquadVoiceIds(scopeId);
        for (const channelId of relatedChannelIds) {
          if (!isCurrent()) return;
          let channelMutationStarted = false;
          try {
            const channel = await client.channels.fetch(channelId, { force: true });
            await assertCurrentOwned();
            if (!channel) continue;
            if (!channel.isVoiceBased()) continue;
            if (!channel.guildId || !isGuildAllowed(channel.guildId)) {
              allResolved = false;
              continue;
            }
            liveChannels++;
            if (active) {
              await assertCurrentOwned();
              channelMutationStarted = true;
              discordMutationStarted = true;
              repairGuild = channel.guild;
              await channel.permissionOverwrites.edit(userId, {
                Connect: true,
                ViewChannel: true,
              }, {
                reason: 'Teams: восстановление временного доступа к PB-войсу',
                type: OverwriteType.Member,
              });
              await assertCurrentOwned();
            } else {
              await clearVoiceInviteMemberOverwrite(
                channel,
                userId,
                'Истёк срок приглашения в PB-войс',
                assertCurrentOwned,
                () => {
                  channelMutationStarted = true;
                  discordMutationStarted = true;
                  repairGuild = channel.guild;
                },
              );
            }
          } catch (error) {
            // Resolve UnknownChannel for this exact related channel and continue
            // so a missing air voice cannot hide the live main voice.
            if (channelMutationStarted && !hasDiscordErrorCode(error, 10003)) throw error;
            if (!hasDiscordErrorCode(error, 10003)) {
              allResolved = false;
              log.warn(`Voice-инвайт ${entry}: канал ${channelId} будет повторён`, {
                error: String(error),
              });
            }
          }
        }
        if (active && liveChannels > 0) return;
        if (!allResolved) return;
        await assertCurrentOwned();
        const occupancyKey = voiceInviteOccupancyKey(scopeId, userId);
        const cleared = await redisVoiceInviteAtomicStore().clearIntentIfOwned({
          ownership,
          intentKey: key,
          expectedIntentRaw: raw,
          occupancyKey,
          expiryIndexKey: VOICE_INVITE_EXPIRY_INDEX,
          expiryMember: entry,
        });
        if (!cleared) {
          await assertCurrentOwned();
          throw new Error(`Voice invite state changed during expiry cleanup for ${scopeId}:${userId}`);
        }
      });
    } catch (error) {
      if (discordMutationStarted && repairGuild) {
        try {
          await reconcileCurrentVoiceInvitePermissionNow(squadVoiceId, userId, repairGuild);
        } catch (repairError) {
          log.warn(`Немедленное восстановление voice-инвайта ${entry} не удалось`, {
            error: String(repairError),
          });
        }
      }
      log.warn(`Voice-инвайт ${entry} сохранён для повторного восстановления`, {
        error: String(error),
      });
    }
  }
}

/**
 * Remove expired invitation permissions. An ambiguous or transient Discord
 * response retains Redis state for another retry.
 */
export async function cleanupExpiredVoiceInvites(
  client: BublikClient,
  isCurrent: () => boolean = () => true,
): Promise<void> {
  await reconcileIndexedVoiceInvites(client, isCurrent, false);
}

// ═══════════════════════════════════════════════
//  Чистка состояния при выгрузке
// ═══════════════════════════════════════════════

export function clearVoiceState(): void {
  squadTeamMap.clear();
}

/** Teams owns these jobs; RegBattle must not invoke them from its 30-second
 * role-integrity loop. */
export function startVoiceIntegrationMaintenance(
  client: BublikClient,
  isCurrent: () => boolean,
): void {
  stopVoiceIntegrationMaintenance();
  scheduleTask(VOICE_INVITE_CLEANUP_TASK, VOICE_INVITE_CLEANUP_INTERVAL_MS, async () => {
    if (!isCurrent()) return;
    await cleanupExpiredVoiceInvites(client, isCurrent);
  });
  scheduleTask(TEAM_SQUAD_PRIVACY_TASK, TEAM_SQUAD_PRIVACY_INTERVAL_MS, async () => {
    if (!isCurrent()) return;
    await reconcileTeamSquadPrivacy(client, isCurrent);
  });
}

export function stopVoiceIntegrationMaintenance(): void {
  unscheduleTask(VOICE_INVITE_CLEANUP_TASK);
  unscheduleTask(TEAM_SQUAD_PRIVACY_TASK);
}

/**
 * Rebuild durable team mappings and converge the exact private permission
 * boundary. Safe to run periodically after an outcome-ambiguous REST write.
 */
export async function reconcileTeamSquadPrivacy(
  client: BublikClient,
  isCurrent: () => boolean = () => true,
): Promise<void> {
  for (const [, guild] of client.guilds.cache) {
    if (!isCurrent()) return;
    if (!isGuildAllowed(guild.id)) continue;
    const { getGuildSquads } = await import('../regbattle/database');
    const squads = await getGuildSquads(guild.id);

    for (const squad of squads) {
      if (!isCurrent()) return;
      const context = await resolveTeamSquad(squad.voiceChannelId, guild.id);
      if (context) {
        squadTeamMap.set(squad.voiceChannelId, context.teamId);
        for (const channelId of [squad.voiceChannelId, squad.airChannelId].filter(Boolean) as string[]) {
          if (!isCurrent()) return;
          try {
            const channel = await guild.channels.fetch(channelId, { force: true });
            if (!isCurrent()) return;
            if (channel?.type === ChannelType.GuildVoice) {
              await enforcePrivateTeamSquadPermissions(
                channel as VoiceChannel,
                squad.ownerId,
                context.teamRoleId,
                isCurrent,
              );
              if (!isCurrent()) return;
            }
          } catch (error) {
            if (!hasDiscordErrorCode(error, 10003)) {
              log.warn(`Не удалось восстановить приватность командного PB-войса ${channelId}`, {
                error: String(error),
              });
            }
          }
        }
        log.debug(`Восстановлен маппинг: войс ${squad.voiceChannelId} → «${context.teamName}»`);
      }
    }
  }
}

/** Восстановить маппинг при рестарте бота. */
export async function restoreSquadTeamMap(
  client: BublikClient,
  isCurrent: () => boolean = () => true,
): Promise<void> {
  await reconcileIndexedVoiceInvites(client, isCurrent, true).catch((error: unknown) =>
    log.warn('Не удалось очистить истёкшие voice-инвайты при старте', { error: String(error) }));
  if (!isCurrent()) return;
  await reconcileTeamSquadPrivacy(client, isCurrent);
}
