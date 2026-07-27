import type { GuildMember } from 'discord.js';
import { getDatabase } from '../../core/Database';
import {
  loadUnavailableUserIds,
} from '../vacation/availability';
import { INDIVIDUAL_ESCALATION_COOLDOWN_MS } from './constants';

export interface PbPingEligibilitySnapshot {
  guildId: string;
  excludedUserIds: ReadonlySet<string>;
  vacationRoleId: string | null;
}

export interface PbPingCandidate {
  guildId: string;
  userId: string;
  isBot: boolean;
  roleIds: ReadonlySet<string>;
  voiceChannelId: string | null;
}

export interface PbPingPolicy {
  pingRoleId: string | null;
  playedTodayRoleId: string | null;
  pbChannelIds: ReadonlySet<string>;
}

export type PbIndividualPingEligibilityReason =
  | 'eligible'
  | 'unavailable_state'
  | 'vacation'
  | 'bot'
  | 'ping_role_not_configured'
  | 'missing_ping_role'
  | 'played'
  | 'in_pb';

export interface PbMassRoleMentionPlan {
  content: string;
  allowedMentions: {
    parse: [];
    roles: [string];
    users: [];
    repliedUser: false;
  };
}

/**
 * A Discord role mention cannot exclude individual members. It is safe only
 * when the DB snapshot exists and every unavailable member was force-read and
 * confirmed not to possess the mentioned role.
 */
export function isPbMassRoleMentionSafe(
  snapshot: PbPingEligibilitySnapshot | null,
  unavailablePingRoleState: ReadonlyMap<string, boolean>,
): boolean {
  if (!snapshot) return false;
  for (const userId of snapshot.excludedUserIds) {
    if (!unavailablePingRoleState.has(userId)) return false;
    if (unavailablePingRoleState.get(userId) === true) return false;
  }
  return true;
}

/**
 * A role mention is all-or-nothing in Discord. The caller must provide the
 * complete, freshly fetched population of the configured ping role. We emit a
 * mention only when every role holder is individually eligible and every
 * durable vacation record has been reconciled with that fresh population.
 */
export function buildPbMassRoleMentionPlan(
  policy: PbPingPolicy,
  snapshot: PbPingEligibilitySnapshot | null,
  unavailablePingRoleState: ReadonlyMap<string, boolean>,
  pingRoleMembers: readonly PbPingCandidate[],
  canMentionRole: boolean,
): PbMassRoleMentionPlan | null {
  const pingRoleId = policy.pingRoleId;
  if (!pingRoleId || !canMentionRole || pingRoleMembers.length === 0) return null;
  if (!isPbMassRoleMentionSafe(snapshot, unavailablePingRoleState)) return null;
  if (!pingRoleMembers.every((candidate) =>
    isPbIndividualPingEligible(candidate, policy, snapshot))) return null;

  return {
    content: `<@&${pingRoleId}>`,
    allowedMentions: {
      parse: [],
      roles: [pingRoleId],
      users: [],
      repliedUser: false,
    },
  };
}

/** Clock-safe cooldown shared by normal and mass-mention fallback escalation. */
export function isPbIndividualEscalationReady(
  now: number,
  lastEscalationEndedAt: number,
  cooldownMs: number = INDIVIDUAL_ESCALATION_COOLDOWN_MS,
): boolean {
  if (
    !Number.isFinite(now) || !Number.isFinite(lastEscalationEndedAt) ||
    !Number.isFinite(cooldownMs) || now < 0 || lastEscalationEndedAt < 0 || cooldownMs <= 0
  ) return false;
  return now >= lastEscalationEndedAt &&
    now - lastEscalationEndedAt >= cooldownMs;
}

/**
 * Pure, fail-closed policy shared by DM and individual pings. A missing or
 * cross-guild snapshot is never interpreted as "nobody is on vacation".
 */
export function isPbIndividualPingEligible(
  candidate: PbPingCandidate,
  policy: PbPingPolicy,
  snapshot: PbPingEligibilitySnapshot | null,
): boolean {
  return classifyPbIndividualPingEligibility(candidate, policy, snapshot) === 'eligible';
}

/**
 * Returns the first reason an individual PB ping must not be sent. Keeping the
 * classification next to the send policy lets status panels explain the same
 * fail-closed decision without reimplementing it.
 */
export function classifyPbIndividualPingEligibility(
  candidate: PbPingCandidate,
  policy: PbPingPolicy,
  snapshot: PbPingEligibilitySnapshot | null,
): PbIndividualPingEligibilityReason {
  if (!snapshot || snapshot.guildId !== candidate.guildId) return 'unavailable_state';
  if (
    snapshot.excludedUserIds.has(candidate.userId) ||
    (snapshot.vacationRoleId && candidate.roleIds.has(snapshot.vacationRoleId))
  ) return 'vacation';
  if (candidate.isBot) return 'bot';
  if (!policy.pingRoleId) return 'ping_role_not_configured';
  if (!candidate.roleIds.has(policy.pingRoleId)) return 'missing_ping_role';
  if (policy.playedTodayRoleId && candidate.roleIds.has(policy.playedTodayRoleId)) return 'played';
  if (candidate.voiceChannelId && policy.pbChannelIds.has(candidate.voiceChannelId)) return 'in_pb';
  return 'eligible';
}

/** Shared fail-closed vacation predicate for pings, panels and role workflows. */
export function isPbVacationExcluded(
  candidate: PbPingCandidate,
  snapshot: PbPingEligibilitySnapshot | null,
): boolean {
  if (!snapshot || snapshot.guildId !== candidate.guildId) return true;
  if (snapshot.excludedUserIds.has(candidate.userId)) return true;
  return Boolean(snapshot.vacationRoleId && candidate.roleIds.has(snapshot.vacationRoleId));
}

export function pbPingCandidateFromMember(member: GuildMember): PbPingCandidate {
  return {
    guildId: member.guild.id,
    userId: member.id,
    isBot: member.user.bot,
    roleIds: new Set(member.roles.cache.keys()),
    voiceChannelId: member.voice.channelId,
  };
}

/**
 * Reads all authoritative vacation sources in one database transaction.
 * Database failures propagate so callers skip the preview/send rather than
 * accidentally treating an unavailable snapshot as an empty one.
 */
export async function loadPbPingEligibilitySnapshot(
  guildId: string,
  userIds?: readonly string[],
): Promise<PbPingEligibilitySnapshot> {
  if (!guildId) throw new Error('PB ping eligibility requires a guild id');
  const db = getDatabase();
  return db.$transaction(async (transaction) => {
    const [excludedUserIds, config] = await Promise.all([
      loadUnavailableUserIds(guildId, userIds, transaction),
      transaction.vacationConfig.findUnique({
        where: { guildId },
        select: { vacationRoleId: true },
      }),
    ]);
    return {
      guildId,
      excludedUserIds,
      vacationRoleId: config?.vacationRoleId ?? null,
    };
  });
}

/** Authoritative fresh guard used by PB role rotation, not only pings. */
export async function isPbRoleMutationSuppressed(member: GuildMember): Promise<boolean> {
  const freshMember = await member.guild.members.fetch({ user: member.id, force: true });
  const snapshot = await loadPbPingEligibilitySnapshot(member.guild.id, [member.id]);
  return isPbVacationExcluded(pbPingCandidateFromMember(freshMember), snapshot);
}
