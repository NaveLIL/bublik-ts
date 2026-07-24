import { createHash } from 'node:crypto';
import type { GuildMember } from 'discord.js';
import { getRedis } from '../../core/Redis';
import { logger } from '../../core/Logger';
import type { MemberRoleLock } from '../../core/MemberRoleLock';
import { fetchSafeAutomaticRole } from '../../core/RolePolicy';

const log = logger.child('RegBattle:VoiceSession');

const SESSION_PREFIX = 'rb:voice:session';
const PLAYED_ORIGIN_PREFIX = 'rb:voice:played-origin';
const QUARANTINE_PREFIX = 'rb:voice:quarantine';

export type PbSessionSource = 'ping' | 'played' | 'team' | 'invite' | 'commander' | 'none';
export type PbChannelKind = 'master' | 'reserve' | 'regular' | 'team' | 'air';
export type PbSessionStatus = 'active' | 'ending';

/**
 * Persistent provenance for a role rotation.  A session is written before any
 * Discord role is changed, so a restart can always finish (or undo) the exact
 * rotation that was started.
 */
interface PbVoiceSessionBase {
  guildId: string;
  userId: string;
  joinedAt: number;
  source: PbSessionSource;
  status: PbSessionStatus;
  currentChannelId: string;
  currentChannelKind: PbChannelKind;
  squadId: string | null;
  squadVoiceId: string | null;
  teamId: string | null;
  /** Roles removed at entry and safe to restore on a short session. */
  returnRoleIds: string[];
  /** Exact role whose possession/member record made the entry eligible. */
  eligibilityRoleId: string | null;
  /** Main squad voice used by an explicit Teams voice invite. */
  inviteSquadVoiceId: string | null;
  inSquadRoleId: string | null;
  pingRoleId: string | null;
  playedTodayRoleId: string | null;
  playedMinMinutes: number;
  /** Daily-reset roles inherited when entry consumed an existing played role. */
  playedResetRoleIds: string[];
  endedAt?: number;
  awardPlayed?: boolean;
}

/**
 * Sessions written before role provenance was explicit. They are accepted
 * only so recovery can unwind their Discord mutations; they may never award a
 * new played role.
 */
export interface LegacyPbVoiceSession extends PbVoiceSessionBase {
  version: 1;
}

/** A current session with explicit proof of the ping/played roles consumed. */
export interface CurrentPbVoiceSession extends PbVoiceSessionBase {
  version: 2;
  hadPingRole: boolean;
  hadPlayedRole: boolean;
}

export type PbVoiceSession = LegacyPbVoiceSession | CurrentPbVoiceSession;

export interface PbPlayedOrigin {
  version: 1;
  guildId: string;
  userId: string;
  source: Exclude<PbSessionSource, 'none'>;
  /** Roles which should exist again after the daily played-role reset. */
  resetRoleIds: string[];
  createdAt: number;
}

export interface SessionEndPlan {
  removeRoleIds: string[];
  addRoleIds: string[];
  shouldMarkPlayed: boolean;
}

export interface PbSessionDestination {
  teamId: string | null;
  squadVoiceId: string | null;
}

/** Only ping/played provenance may start role rotation; voice access is separate. */
export function hasPbRoleProvenance(hasPingRole: boolean, hasPlayedRole: boolean): boolean {
  return hasPingRole || hasPlayedRole;
}

function sessionKey(guildId: string, userId: string): string {
  return `${SESSION_PREFIX}:${guildId}:${userId}`;
}

function playedOriginKey(guildId: string, userId: string): string {
  return `${PLAYED_ORIGIN_PREFIX}:${guildId}:${userId}`;
}

function quarantineKey(sourceKey: string, raw: string): string {
  const digest = createHash('sha256').update(sourceKey).update('\0').update(raw).digest('hex');
  return `${QUARANTINE_PREFIX}:${digest}`;
}

function quarantineMarkerKey(sourceKey: string): string {
  const digest = createHash('sha256').update(sourceKey).digest('hex');
  return `${QUARANTINE_PREFIX}:marker:${digest}`;
}

async function quarantineRedisValue(sourceKey: string, raw: string): Promise<boolean> {
  const value = JSON.stringify({
    version: 1,
    sourceKey,
    raw,
    quarantinedAt: Date.now(),
  });
  const moved = await getRedis().eval(
    'if redis.call("get", KEYS[1]) == ARGV[1] then redis.call("set", KEYS[2], ARGV[2]); redis.call("set", KEYS[3], KEYS[1]); redis.call("del", KEYS[1]); return 1 else return 0 end',
    3,
    sourceKey,
    quarantineKey(sourceKey, raw),
    quarantineMarkerKey(sourceKey),
    raw,
    value,
  );
  return Number(moved) === 1;
}

export async function hasPbVoiceStateQuarantine(guildId: string, userId: string): Promise<boolean> {
  const markers = await getRedis().mget(
    quarantineMarkerKey(sessionKey(guildId, userId)),
    quarantineMarkerKey(playedOriginKey(guildId, userId)),
  );
  return markers.some(Boolean);
}

function unique(ids: Array<string | null | undefined>): string[] {
  return [...new Set(ids.filter((id): id is string => Boolean(id)))];
}

function isSession(value: unknown): value is PbVoiceSession {
  if (!value || typeof value !== 'object') return false;
  const s = value as Partial<PbVoiceSession> & {
    version?: unknown;
    hadPingRole?: unknown;
    hadPlayedRole?: unknown;
  };
  const validVersion = s.version === 1 || (
    s.version === 2 &&
    typeof s.hadPingRole === 'boolean' &&
    typeof s.hadPlayedRole === 'boolean' &&
    (s.hadPingRole || s.hadPlayedRole)
  );
  return validVersion &&
    typeof s.guildId === 'string' &&
    typeof s.userId === 'string' &&
    typeof s.joinedAt === 'number' &&
    typeof s.currentChannelId === 'string' &&
    Array.isArray(s.returnRoleIds) &&
    ['ping', 'played', 'team', 'invite', 'commander', 'none'].includes(String(s.source)) &&
    ['active', 'ending'].includes(String(s.status));
}

function isPlayedOrigin(value: unknown): value is PbPlayedOrigin {
  if (!value || typeof value !== 'object') return false;
  const p = value as Partial<PbPlayedOrigin>;
  return p.version === 1 &&
    typeof p.guildId === 'string' &&
    typeof p.userId === 'string' &&
    Array.isArray(p.resetRoleIds);
}

async function scanKeys(pattern: string): Promise<string[]> {
  const redis = getRedis();
  const keys: string[] = [];
  let cursor = '0';
  do {
    const [next, page] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
    cursor = next;
    keys.push(...page);
  } while (cursor !== '0');
  return keys;
}

export async function getVoiceSession(guildId: string, userId: string): Promise<PbVoiceSession | null> {
  const key = sessionKey(guildId, userId);
  for (let attempt = 0; attempt < 2; attempt++) {
    const raw = await getRedis().get(key);
    if (!raw) return null;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (isSession(parsed) && parsed.guildId === guildId && parsed.userId === userId) {
        return parsed;
      }
    } catch {
      // Invalid state is atomically quarantined below.
    }
    if (await quarantineRedisValue(key, raw)) {
      log.warn(`Повреждённая PB-сессия ${guildId}:${userId} перемещена в quarantine`);
      return null;
    }
  }
  log.warn(`PB-сессия ${guildId}:${userId} менялась во время quarantine; обработка отложена`);
  return null;
}

export async function saveVoiceSession(
  session: PbVoiceSession,
  lock?: MemberRoleLock,
): Promise<void> {
  if (session.source === 'none') {
    throw new Error('PB session with source=none is not eligible and cannot be persisted');
  }
  const key = sessionKey(session.guildId, session.userId);
  const value = JSON.stringify(session);
  if (lock) await lock.setRedisValue(key, value);
  else await getRedis().set(key, value);
}

export async function deleteVoiceSession(
  guildId: string,
  userId: string,
  lock?: MemberRoleLock,
): Promise<void> {
  const key = sessionKey(guildId, userId);
  if (lock) await lock.deleteRedisKey(key);
  else await getRedis().del(key);
}

export async function deleteVoiceSessionState(
  guildId: string,
  userId: string,
  lock?: MemberRoleLock,
): Promise<void> {
  const keys = [sessionKey(guildId, userId), playedOriginKey(guildId, userId)];
  if (lock) await lock.deleteRedisKeys(keys);
  else await getRedis().del(...keys);
}

export async function listGuildVoiceSessions(guildId: string): Promise<PbVoiceSession[]> {
  const keys = await scanKeys(`${SESSION_PREFIX}:${guildId}:*`);
  if (keys.length === 0) return [];
  const values = await getRedis().mget(...keys);
  const sessions: PbVoiceSession[] = [];
  const invalidEntries: Array<{ key: string; raw: string }> = [];
  for (let i = 0; i < values.length; i++) {
    const raw = values[i];
    if (!raw) continue;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (isSession(parsed) && parsed.guildId === guildId) {
        sessions.push(parsed);
      } else {
        invalidEntries.push({ key: keys[i], raw });
      }
    } catch {
      invalidEntries.push({ key: keys[i], raw });
    }
  }
  await Promise.all(invalidEntries.map(({ key, raw }) => quarantineRedisValue(key, raw)));
  return sessions;
}

export async function getPlayedOrigin(guildId: string, userId: string): Promise<PbPlayedOrigin | null> {
  const key = playedOriginKey(guildId, userId);
  for (let attempt = 0; attempt < 2; attempt++) {
    const raw = await getRedis().get(key);
    if (!raw) return null;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (isPlayedOrigin(parsed) && parsed.guildId === guildId && parsed.userId === userId) {
        return parsed;
      }
    } catch {
      // Invalid state is atomically quarantined below.
    }
    if (await quarantineRedisValue(key, raw)) return null;
  }
  return null;
}

export async function savePlayedOrigin(
  origin: PbPlayedOrigin,
  lock?: MemberRoleLock,
): Promise<void> {
  const key = playedOriginKey(origin.guildId, origin.userId);
  const value = JSON.stringify(origin);
  if (lock) await lock.setRedisValue(key, value);
  else await getRedis().set(key, value);
}

export async function deletePlayedOrigin(
  guildId: string,
  userId: string,
  lock?: MemberRoleLock,
): Promise<void> {
  const key = playedOriginKey(guildId, userId);
  if (lock) await lock.deleteRedisKey(key);
  else await getRedis().del(key);
}

/**
 * Pure end-state policy.  Long sessions convert only an authorised source to
 * playedToday. Team eligibility is always restored; an invite never returns a
 * team role because it can never place one into returnRoleIds.
 */
export function buildSessionEndPlan(
  session: PbVoiceSession,
  inSquadRoleId: string | null,
  pingRoleId: string | null,
  playedTodayRoleId: string | null,
  awardPlayed: boolean,
): SessionEndPlan {
  const add = new Set(buildSafeReturnRoleIds(session, pingRoleId, playedTodayRoleId));
  let shouldMarkPlayed = false;

  // V1 did not record whether a ping/played role was actually present. It is
  // therefore cleanup-only even if its timer would otherwise qualify.
  const hasVerifiedProvenance = session.version === 2 &&
    hasPbRoleProvenance(session.hadPingRole, session.hadPlayedRole);
  if (awardPlayed && hasVerifiedProvenance && playedTodayRoleId) {
    add.delete(playedTodayRoleId);
    if (pingRoleId) add.delete(pingRoleId);
    add.add(playedTodayRoleId);
    shouldMarkPlayed = session.source !== 'played';
  }

  // A team source always returns only roles proven at entry. In particular,
  // invited guests cannot acquire the team role here.
  return {
    removeRoleIds: unique([inSquadRoleId]),
    addRoleIds: unique([...add]),
    shouldMarkPlayed,
  };
}

/**
 * Return only roles whose possession is proven by the stored session shape.
 * Legacy invite/commander sessions carry no such proof and restore nothing;
 * legacy source/eligibility pairs can restore only their exact source role.
 */
export function buildSafeReturnRoleIds(
  session: PbVoiceSession,
  pingRoleId: string | null,
  playedTodayRoleId: string | null,
): string[] {
  const recorded = new Set(session.returnRoleIds);
  if (session.version === 1) {
    if (
      session.source === 'ping' &&
      pingRoleId &&
      session.eligibilityRoleId === pingRoleId &&
      recorded.has(pingRoleId)
    ) return [pingRoleId];
    if (
      session.source === 'played' &&
      playedTodayRoleId &&
      session.eligibilityRoleId === playedTodayRoleId &&
      recorded.has(playedTodayRoleId)
    ) return [playedTodayRoleId];
    if (
      session.source === 'team' &&
      session.eligibilityRoleId &&
      recorded.has(session.eligibilityRoleId)
    ) return [session.eligibilityRoleId];
    return [];
  }

  const proven = new Set<string>();
  if (session.hadPingRole && pingRoleId) proven.add(pingRoleId);
  if (session.hadPlayedRole && playedTodayRoleId) proven.add(playedTodayRoleId);
  if (session.source === 'team' && session.eligibilityRoleId) {
    proven.add(session.eligibilityRoleId);
  }
  return unique(session.returnRoleIds.filter((roleId) => proven.has(roleId)));
}

/** Roles to restore when the daily playedToday role is removed. */
export function buildPlayedResetRoleIds(origin: PbPlayedOrigin | null): string[] {
  return origin ? unique(origin.resetRoleIds) : [];
}

/**
 * Roles to restore after playedToday expires. A ping source returns ping; team,
 * invite and commander sources already had their permanent/temporary state
 * restored at session end and must not be promoted to ping.
 */
export function buildPlayedOrigin(session: PbVoiceSession, pingRoleId: string | null): PbPlayedOrigin {
  const resetRoleIds = unique([
    ...(session.playedResetRoleIds ?? []),
    session.version === 2 && session.hadPingRole && pingRoleId && session.returnRoleIds.includes(pingRoleId)
      ? pingRoleId
      : null,
  ]);
  return {
    version: 1,
    guildId: session.guildId,
    userId: session.userId,
    source: session.source as Exclude<PbSessionSource, 'none'>,
    resetRoleIds,
    createdAt: Date.now(),
  };
}

/**
 * Freeze a session while vacation owns the member's roles. Time spent before
 * the leave event must never turn into a stale played-today award days later.
 * Proven ping provenance is retained (including a ping inherited through the
 * prior played-role reset origin), while played-today itself is discarded.
 */
export function suppressSessionForVacation(
  session: PbVoiceSession,
  freezeAt = Date.now(),
): PbVoiceSession {
  const endedAt = session.endedAt ?? Math.max(session.joinedAt, freezeAt);
  if (session.version === 1) {
    return {
      ...session,
      status: 'ending',
      endedAt,
      awardPlayed: false,
      returnRoleIds: session.returnRoleIds.filter(
        (roleId) => roleId !== session.playedTodayRoleId,
      ),
    };
  }
  const pingRoleId = session.pingRoleId;
  const inheritedPing = Boolean(
    pingRoleId && session.playedResetRoleIds.includes(pingRoleId),
  );
  const returnRoleIds = session.returnRoleIds.filter((roleId) => roleId !== session.playedTodayRoleId);
  if (pingRoleId && (session.hadPingRole || inheritedPing)) returnRoleIds.push(pingRoleId);
  return {
    ...session,
    status: 'ending',
    endedAt,
    awardPlayed: false,
    hadPingRole: session.hadPingRole || inheritedPing,
    returnRoleIds: unique(returnRoleIds),
  };
}

/** Main <-> air moves keep the exact squad invite; leaving the squad removes it. */
export function shouldCleanupInviteOnTransition(
  oldSquadVoiceId: string | null,
  newSquadVoiceId: string | null,
): boolean {
  return Boolean(oldSquadVoiceId && oldSquadVoiceId !== newSquadVoiceId);
}

/**
 * Decide whether provenance may survive a move without a fresh eligibility
 * check. Private team voices only accept the exact team session or an invite
 * bound to that squad; a generic ping/played session can never be carried in.
 */
export function canCarrySessionTo(
  session: PbVoiceSession,
  destination: PbSessionDestination,
): boolean {
  if (destination.teamId) {
    if (session.source === 'team') return session.teamId === destination.teamId;
    if (session.source === 'invite') {
      return Boolean(
        destination.squadVoiceId &&
        destination.squadVoiceId === session.inviteSquadVoiceId,
      );
    }
    return false;
  }
  if (session.source === 'invite') {
    return Boolean(
      destination.squadVoiceId &&
      destination.squadVoiceId === session.inviteSquadVoiceId,
    );
  }
  return true;
}

async function mutateRole(
  member: GuildMember,
  roleId: string,
  operation: 'add' | 'remove',
  reason: string,
  lock?: MemberRoleLock,
  assertCurrentVoice?: () => void,
): Promise<boolean> {
  assertCurrentVoice?.();
  await lock?.assertOwned();
  assertCurrentVoice?.();
  const hasRole = member.roles.cache.has(roleId);
  if ((operation === 'add' && hasRole) || (operation === 'remove' && !hasRole)) {
    await lock?.assertOwned();
    assertCurrentVoice?.();
    return true;
  }

  let role: Awaited<ReturnType<typeof fetchSafeAutomaticRole>> | undefined;
  if (operation === 'add') {
    try {
      role = await fetchSafeAutomaticRole(member.guild, roleId);
    } catch (error) {
      log.error(`Не удалось подготовить выдачу PB-роли ${roleId} у ${member.user.tag}`, {
        error: String(error),
      });
      return false;
    }
  }

  // Lease/voice assertions deliberately escape to the transition state
  // machine. The persisted session then remains available for recovery.
  await lock?.assertOwned();
  assertCurrentVoice?.();
  try {
    if (operation === 'add') {
      await member.roles.add(role!, reason);
    } else {
      await member.roles.remove(roleId, reason);
    }
  } catch (error) {
    log.error(`Не удалось ${operation === 'add' ? 'выдать' : 'снять'} PB-роль ${roleId} у ${member.user.tag}`, {
      error: String(error),
    });
    return false;
  }
  await lock?.assertOwned();
  assertCurrentVoice?.();
  return true;
}

/** Apply an already-persisted and therefore authorised session. */
export async function applySessionRoles(
  member: GuildMember,
  session: PbVoiceSession,
  inSquadRoleId: string | null,
  lock?: MemberRoleLock,
  assertCurrentVoice?: () => void,
): Promise<boolean> {
  // v1 records predate explicit ping/played provenance. They are accepted by
  // the parser only so reconciliation can safely finish them; replaying one
  // must never remove or grant roles.
  if (
    session.version !== 2 ||
    session.source === 'none' ||
    session.guildId !== member.guild.id ||
    session.userId !== member.id
  ) {
    return false;
  }
  for (const roleId of session.returnRoleIds) {
    if (!(await mutateRole(
      member,
      roleId,
      'remove',
      'RegBattle: вход в PB (persistent session)',
      lock,
      assertCurrentVoice,
    ))) return false;
  }
  if (inSquadRoleId) {
    if (!(await mutateRole(
      member,
      inSquadRoleId,
      'add',
      'RegBattle: подтверждённая PB-сессия',
      lock,
      assertCurrentVoice,
    ))) return false;
  }
  return true;
}

/** Build the exact set of roles observed before a team PB session starts. */
export function buildTeamSessionReturnRoleIds(
  teamRoleId: string,
  hadTeamRole: boolean,
  playedTodayRoleId: string | null,
  hadPlayedRole: boolean,
  pingRoleId: string | null,
  hadPingRole: boolean,
): string[] {
  return unique([
    hadTeamRole ? teamRoleId : null,
    hadPlayedRole ? playedTodayRoleId : null,
    hadPingRole ? pingRoleId : null,
  ]);
}

/** Finish an authorised session. The caller deletes it only when this succeeds. */
export async function applySessionEndRoles(
  member: GuildMember,
  plan: SessionEndPlan,
  lock?: MemberRoleLock,
  assertCurrentVoice?: () => void,
): Promise<boolean> {
  for (const roleId of plan.removeRoleIds) {
    if (!(await mutateRole(
      member,
      roleId,
      'remove',
      'RegBattle: завершение PB-сессии',
      lock,
      assertCurrentVoice,
    ))) return false;
  }
  for (const roleId of plan.addRoleIds) {
    if (!(await mutateRole(
      member,
      roleId,
      'add',
      'RegBattle: восстановление proven PB-роли',
      lock,
      assertCurrentVoice,
    ))) return false;
  }
  return true;
}
