// ═══════════════════════════════════════════════
//  Teams — CRUD с Redis-кэшированием
// ═══════════════════════════════════════════════

import { getDatabase } from '../../core/Database';
import { getRedis } from '../../core/Redis';
import { isTeamOperationalStatus } from './constants';
import { randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';

const CACHE_PREFIX = 'tm:cfg';
const CACHE_TTL = 600; // 10 минут
const TEAM_MEMBER_KICK_SCOPE = 'team_member_kick';
const TEAM_INVITE_ACCEPT_SCOPE = 'team_invite_accept';
const TEAM_APPLICATION_REVIEW_SCOPE = 'team_application_review';
const TEAM_CLAIM_LEASE_MS = 5 * 60_000;

function inviteAcceptClaimKey(inviteId: string): string {
  return `teams:invite-accept:${inviteId}`;
}

function applicationReviewClaimKey(applicationId: string): string {
  return `teams:application-review:${applicationId}`;
}

function claimMetadata(token: string, extra: Prisma.InputJsonObject = {}): Prisma.InputJsonObject {
  return { version: 1, token, ...extra };
}

function metadataToken(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null;
  const token = (metadata as Record<string, unknown>).token;
  return typeof token === 'string' && token.length > 0 ? token : null;
}

function metadataBoolean(metadata: unknown, key: string): boolean | null {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null;
  const value = (metadata as Record<string, unknown>)[key];
  return typeof value === 'boolean' ? value : null;
}

async function transactionOwnsClaim(
  tx: Prisma.TransactionClient,
  key: string,
  scope: string,
  token: string,
): Promise<boolean> {
  const claim = await tx.operationClaim.findUnique({ where: { key } });
  return claim?.scope === scope && metadataToken(claim.metadata) === token;
}

export interface PendingTeamMemberKick {
  key: string;
  guildId: string;
  userId: string;
  teamId: string;
  roleId: string;
  teamName: string;
}

export function parsePendingTeamMemberKick(claim: {
  key: string;
  guildId: string | null;
  userId: string | null;
  metadata: unknown;
}): PendingTeamMemberKick | null {
  if (!claim.guildId || !claim.userId || !claim.metadata || typeof claim.metadata !== 'object' || Array.isArray(claim.metadata)) {
    return null;
  }
  const metadata = claim.metadata as Record<string, unknown>;
  if (
    typeof metadata.teamId !== 'string' ||
    typeof metadata.roleId !== 'string' ||
    typeof metadata.teamName !== 'string'
  ) return null;
  return {
    key: claim.key,
    guildId: claim.guildId,
    userId: claim.userId,
    teamId: metadata.teamId,
    roleId: metadata.roleId,
    teamName: metadata.teamName,
  };
}

// ═══════════════════════════════════════════════
//  TeamConfig
// ═══════════════════════════════════════════════

export async function getConfig(guildId: string) {
  const r = getRedis();
  const cached = await r.get(`${CACHE_PREFIX}:${guildId}`);
  if (cached) return JSON.parse(cached);

  const config = await getDatabase().teamConfig.findUnique({ where: { guildId } });
  if (config) {
    await r.setex(`${CACHE_PREFIX}:${guildId}`, CACHE_TTL, JSON.stringify(config));
  }
  return config;
}

export async function upsertConfig(guildId: string, data: Record<string, any>) {
  const config = await getDatabase().teamConfig.upsert({
    where: { guildId },
    create: { guildId, ...data },
    update: data,
  });
  await getRedis().setex(`${CACHE_PREFIX}:${guildId}`, CACHE_TTL, JSON.stringify(config));
  return config;
}

export async function invalidateConfigCache(guildId: string) {
  await getRedis().del(`${CACHE_PREFIX}:${guildId}`);
}

// ═══════════════════════════════════════════════
//  Team
// ═══════════════════════════════════════════════

/**
 * Create the durable team-creation saga before touching Discord. The temporary
 * role id is replaced after Discord confirms role creation; the application is
 * born in the same transaction so a crash cannot strand a forming membership
 * without a review record.
 */
export async function createPendingTeamWithLeaderApplication(data: {
  guildId: string;
  name: string;
  pendingRoleId: string;
  leaderId: string;
  configId: string;
  applicationChannelId: string;
}) {
  return getDatabase().$transaction(async tx => {
    const team = await tx.team.create({
      data: {
        guildId: data.guildId,
        name: data.name,
        roleId: data.pendingRoleId,
        leaderId: data.leaderId,
        configId: data.configId,
        status: 'forming',
        members: {
          create: { guildId: data.guildId, userId: data.leaderId },
        },
      },
      include: { members: true, config: true },
    });
    const application = await tx.teamApplication.create({
      data: {
        teamId: team.id,
        channelId: data.applicationChannelId,
        activeKey: team.id,
      },
    });
    return { team, application };
  });
}

export async function attachCreatedTeamRole(
  teamId: string,
  pendingRoleId: string,
  roleId: string,
): Promise<boolean> {
  const result = await getDatabase().team.updateMany({
    where: { id: teamId, status: 'forming', roleId: pendingRoleId },
    data: { roleId },
  });
  return result.count === 1;
}

export async function getTeam(teamId: string) {
  return getDatabase().team.findUnique({
    where: { id: teamId },
    include: { members: true, config: true },
  });
}

export async function getTeamByRole(roleId: string) {
  return getDatabase().team.findUnique({
    where: { roleId },
    include: { members: true, config: true },
  });
}

export async function getTeamByName(guildId: string, name: string) {
  return getDatabase().team.findUnique({
    where: { guildId_name: { guildId, name } },
    include: { members: true },
  });
}

export async function getGuildTeams(guildId: string, statuses?: string[]) {
  return getDatabase().team.findMany({
    where: {
      guildId,
      ...(statuses ? { status: { in: statuses } } : {}),
    },
    include: { members: true },
    orderBy: { createdAt: 'asc' },
  });
}

export async function transitionTeamStatus(
  teamId: string,
  expectedStatuses: readonly string[],
  status: string,
  data: Record<string, any> = {},
): Promise<boolean> {
  const result = await getDatabase().team.updateMany({
    where: { id: teamId, status: { in: [...expectedStatuses] } },
    data: { ...data, status },
  });
  return result.count === 1;
}

export async function reserveTeamDisband(teamId: string): Promise<string | null> {
  return getDatabase().$transaction(async tx => {
    await tx.$queryRaw`SELECT "id" FROM "teams" WHERE "id" = ${teamId} FOR UPDATE`;
    const team = await tx.team.findUnique({ where: { id: teamId } });
    if (!team) return null;
    if (team.status === 'deleting') return team.status;
    if (!['forming', 'active', 'disbanding'].includes(team.status)) return null;
    const activeSession = await tx.teamSession.findFirst({
      where: { teamId, endedAt: null },
      select: { id: true },
    });
    if (activeSession) return null;
    await tx.team.update({ where: { id: teamId }, data: { status: 'deleting' } });
    return team.status;
  });
}

export async function transferLeadership(
  teamId: string,
  guildId: string,
  expectedLeaderId: string,
  newLeaderId: string,
): Promise<boolean> {
  return getDatabase().$transaction(async tx => {
    await tx.$queryRaw`SELECT "id" FROM "teams" WHERE "id" = ${teamId} FOR UPDATE`;
    const team = await tx.team.findUnique({ where: { id: teamId } });
    if (!team || team.guildId !== guildId || team.leaderId !== expectedLeaderId || !isTeamOperationalStatus(team.status)) {
      return false;
    }

    const member = await tx.teamMember.findFirst({
      where: { teamId, guildId, userId: newLeaderId },
      select: { id: true },
    });
    if (!member) return false;

    const changed = await tx.team.updateMany({
      where: { id: teamId, guildId, leaderId: expectedLeaderId },
      data: { leaderId: newLeaderId },
    });
    return changed.count === 1;
  });
}

export async function finalizeTeamDisband(teamId: string): Promise<boolean> {
  return getDatabase().$transaction(async tx => {
    const changed = await tx.team.updateMany({
      where: { id: teamId, status: 'deleting' },
      data: { status: 'disbanded', disbandWarningAt: null },
    });
    if (changed.count !== 1) return false;
    await tx.teamMember.deleteMany({ where: { teamId } });
    await tx.teamInvite.updateMany({ where: { teamId, status: { in: ['pending', 'accepting'] } }, data: { status: 'expired' } });
    await tx.teamApplication.updateMany({
      where: { teamId, activeKey: { not: null } },
      data: {
        status: 'rejected',
        activeKey: null,
        reviewerId: null,
        reviewedAt: new Date(),
        processingAt: null,
      },
    });
    await tx.teamPoll.updateMany({
      where: { teamId, status: 'active' },
      data: { status: 'closed', activeKey: null, closedAt: new Date() },
    });
    return true;
  });
}

export async function cleanupDisbandedTeamRelations(teamId: string): Promise<void> {
  await getDatabase().$transaction(async tx => {
    const team = await tx.team.findUnique({ where: { id: teamId }, select: { status: true } });
    if (team?.status !== 'disbanded') throw new Error('Refusing to clean relations of a non-disbanded team');
    await tx.teamMember.deleteMany({ where: { teamId } });
    await tx.teamInvite.updateMany({ where: { teamId, status: { in: ['pending', 'accepting'] } }, data: { status: 'expired' } });
    await tx.teamPoll.updateMany({
      where: { teamId, status: 'active' },
      data: { status: 'closed', activeKey: null, closedAt: new Date() },
    });
  });
}

// ═══════════════════════════════════════════════
//  TeamMember
// ═══════════════════════════════════════════════

export async function removeMemberByLeader(
  teamId: string,
  userId: string,
  guildId: string,
  expectedLeaderId: string,
): Promise<boolean> {
  return getDatabase().$transaction(async tx => {
    await tx.$queryRaw`SELECT "id" FROM "teams" WHERE "id" = ${teamId} FOR UPDATE`;
    const team = await tx.team.findUnique({ where: { id: teamId } });
    if (
      !team || team.guildId !== guildId || team.leaderId !== expectedLeaderId ||
      userId === team.leaderId || !isTeamOperationalStatus(team.status)
    ) return false;
    const removed = await tx.teamMember.deleteMany({ where: { teamId, userId, guildId } });
    return removed.count === 1;
  });
}

/** Persist the kick intent before removing the Discord role. */
export async function claimMemberKick(
  teamId: string,
  userId: string,
  guildId: string,
  expectedLeaderId: string,
): Promise<PendingTeamMemberKick | null> {
  return getDatabase().$transaction(async tx => {
    await tx.$queryRaw`SELECT "id" FROM "teams" WHERE "id" = ${teamId} FOR UPDATE`;
    const team = await tx.team.findUnique({ where: { id: teamId } });
    if (
      !team || team.guildId !== guildId || team.leaderId !== expectedLeaderId ||
      userId === team.leaderId || !isTeamOperationalStatus(team.status)
    ) return null;
    const membership = await tx.teamMember.findFirst({
      where: { teamId, userId, guildId },
      select: { id: true },
    });
    if (!membership) return null;

    const key = `team-member-kick:${membership.id}`;
    const inserted = await tx.operationClaim.createMany({
      data: [{
        key,
        scope: TEAM_MEMBER_KICK_SCOPE,
        guildId,
        userId,
        metadata: { teamId, roleId: team.roleId, teamName: team.name, expectedLeaderId },
      }],
      skipDuplicates: true,
    });
    if (inserted.count !== 1) return null;
    return { key, guildId, userId, teamId, roleId: team.roleId, teamName: team.name };
  });
}

/** Delete membership and its durable kick intent in one commit. */
export async function finalizeClaimedMemberKick(claim: PendingTeamMemberKick): Promise<boolean> {
  return getDatabase().$transaction(async tx => {
    const pending = await tx.operationClaim.findFirst({
      where: {
        key: claim.key,
        scope: TEAM_MEMBER_KICK_SCOPE,
        guildId: claim.guildId,
        userId: claim.userId,
      },
      select: { key: true },
    });
    if (!pending) return false;
    await tx.teamMember.deleteMany({
      where: { teamId: claim.teamId, guildId: claim.guildId, userId: claim.userId },
    });
    await tx.operationClaim.delete({ where: { key: claim.key } });
    return true;
  });
}

export async function getStalePendingMemberKicks(cutoff: Date): Promise<PendingTeamMemberKick[]> {
  const rows = await getDatabase().operationClaim.findMany({
    where: { scope: TEAM_MEMBER_KICK_SCOPE, createdAt: { lte: cutoff } },
    orderBy: { createdAt: 'asc' },
    take: 100,
  });
  return rows.map(parsePendingTeamMemberKick).filter((row): row is PendingTeamMemberKick => row !== null);
}

export async function getMemberTeam(userId: string, guildId: string) {
  const membership = await getDatabase().teamMember.findUnique({
    where: { guildId_userId: { guildId, userId } },
    include: { team: { include: { members: true, config: true } } },
  });
  return membership?.team ?? null;
}

/** Explicitly named guild-scoped lookup used by PB role rotation. */
export async function getMemberTeamInGuild(userId: string, guildId: string) {
  return getMemberTeam(userId, guildId);
}

export async function isMemberOfTeam(userId: string, teamId: string, guildId: string): Promise<boolean> {
  const count = await getDatabase().teamMember.count({ where: { userId, teamId, guildId } });
  return count > 0;
}

export async function getTeamMembers(teamId: string) {
  return getDatabase().teamMember.findMany({
    where: { teamId },
    orderBy: { joinedAt: 'asc' },
  });
}

export async function getMemberCount(teamId: string): Promise<number> {
  return getDatabase().teamMember.count({ where: { teamId } });
}

// ═══════════════════════════════════════════════
//  TeamInvite
// ═══════════════════════════════════════════════

export async function createInvite(data: {
  teamId: string;
  userId: string;
  expiresAt: Date;
  messageId?: string;
}) {
  return getDatabase().teamInvite.upsert({
    where: { teamId_userId: { teamId: data.teamId, userId: data.userId } },
    create: data,
    update: { status: 'pending', expiresAt: data.expiresAt, messageId: data.messageId ?? null, processingAt: null },
  });
}

export async function setInviteMessage(
  teamId: string,
  userId: string,
  messageId: string,
): Promise<boolean> {
  const result = await getDatabase().teamInvite.updateMany({
    where: { teamId, userId, status: 'pending', messageId: null },
    data: { messageId },
  });
  if (result.count === 1) return true;
  const current = await getDatabase().teamInvite.findUnique({
    where: { teamId_userId: { teamId, userId } },
    select: { messageId: true },
  });
  return current?.messageId === messageId;
}

export async function createInviteByLeader(
  data: { teamId: string; userId: string; expiresAt: Date; messageId?: string },
  guildId: string,
  expectedLeaderId: string,
  maxTeamSize: number,
): Promise<boolean> {
  return getDatabase().$transaction(async tx => {
    await tx.$queryRaw`SELECT "id" FROM "teams" WHERE "id" = ${data.teamId} FOR UPDATE`;
    const team = await tx.team.findUnique({ where: { id: data.teamId } });
    if (
      !team || team.guildId !== guildId || team.leaderId !== expectedLeaderId ||
      !isTeamOperationalStatus(team.status)
    ) return false;

    const [count, existing] = await Promise.all([
      tx.teamMember.count({ where: { teamId: data.teamId } }),
      tx.teamMember.findUnique({ where: { guildId_userId: { guildId, userId: data.userId } }, select: { id: true } }),
    ]);
    if (count >= maxTeamSize || existing) return false;

    await tx.teamInvite.upsert({
      where: { teamId_userId: { teamId: data.teamId, userId: data.userId } },
      create: data,
      update: { status: 'pending', expiresAt: data.expiresAt, messageId: data.messageId ?? null, processingAt: null },
    });
    return true;
  });
}

export async function getInvite(teamId: string, userId: string) {
  return getDatabase().teamInvite.findUnique({
    where: { teamId_userId: { teamId, userId } },
    include: { team: true },
  });
}

export async function getPendingInvites(teamId: string) {
  return getDatabase().teamInvite.findMany({
    where: { teamId, status: 'pending' },
  });
}

export async function getPendingInvitesWithoutMessage() {
  return getDatabase().teamInvite.findMany({
    where: { status: 'pending', messageId: null, expiresAt: { gt: new Date() } },
    include: { team: true },
    take: 100,
  });
}

export async function transitionInvite(
  teamId: string,
  userId: string,
  expectedStatus: string,
  status: string,
): Promise<boolean> {
  const result = await getDatabase().teamInvite.updateMany({
    where: { teamId, userId, status: expectedStatus },
    data: { status, processingAt: status === 'accepting' ? new Date() : null },
  });
  return result.count === 1;
}

export async function claimPendingInvite(teamId: string, userId: string, now = new Date()) {
  return getDatabase().$transaction(async tx => {
    const result = await tx.teamInvite.updateMany({
      where: { teamId, userId, status: 'pending', expiresAt: { gt: now } },
      data: { status: 'accepting', processingAt: now },
    });
    if (result.count !== 1) return null;
    const invite = await tx.teamInvite.findUnique({
      where: { teamId_userId: { teamId, userId } },
      include: { team: true },
    });
    if (!invite) throw new Error('Claimed invite disappeared');
    const token = randomUUID();
    const key = inviteAcceptClaimKey(invite.id);
    await tx.operationClaim.deleteMany({ where: { key } });
    await tx.operationClaim.create({
      data: {
        key,
        scope: TEAM_INVITE_ACCEPT_SCOPE,
        guildId: invite.team.guildId,
        userId,
        metadata: claimMetadata(token, { roleWasPresent: null }),
        expiresAt: new Date(now.getTime() + TEAM_CLAIM_LEASE_MS),
      },
    });
    return { invite, token };
  });
}

export async function setInviteAcceptRoleBaseline(
  inviteId: string,
  token: string,
  roleWasPresent: boolean,
): Promise<boolean> {
  const key = inviteAcceptClaimKey(inviteId);
  try {
    const updated = await getDatabase().operationClaim.updateMany({
      where: {
        key,
        scope: TEAM_INVITE_ACCEPT_SCOPE,
        metadata: { path: ['token'], equals: token },
      },
      data: { metadata: claimMetadata(token, { roleWasPresent }) },
    });
    return updated.count === 1;
  } catch (error) {
    const current = await getDatabase().operationClaim.findUnique({ where: { key } }).catch(() => null);
    if (
      current?.scope === TEAM_INVITE_ACCEPT_SCOPE &&
      metadataToken(current.metadata) === token &&
      metadataBoolean(current.metadata, 'roleWasPresent') === roleWasPresent
    ) return true;
    throw error;
  }
}

export async function setApplicationReviewRoleBaseline(
  applicationId: string,
  token: string,
  wasMentionable: boolean,
): Promise<boolean> {
  const key = applicationReviewClaimKey(applicationId);
  try {
    const updated = await getDatabase().operationClaim.updateMany({
      where: {
        key,
        scope: TEAM_APPLICATION_REVIEW_SCOPE,
        metadata: { path: ['token'], equals: token },
      },
      data: { metadata: claimMetadata(token, { wasMentionable }) },
    });
    return updated.count === 1;
  } catch (error) {
    const current = await getDatabase().operationClaim.findUnique({ where: { key } }).catch(() => null);
    if (
      current?.scope === TEAM_APPLICATION_REVIEW_SCOPE &&
      metadataToken(current.metadata) === token &&
      metadataBoolean(current.metadata, 'wasMentionable') === wasMentionable
    ) return true;
    throw error;
  }
}

export async function isApplicationReviewClaimOwned(
  applicationId: string,
  token: string,
): Promise<boolean> {
  const claim = await getDatabase().operationClaim.findUnique({
    where: { key: applicationReviewClaimKey(applicationId) },
  });
  return claim?.scope === TEAM_APPLICATION_REVIEW_SCOPE && metadataToken(claim.metadata) === token;
}

export async function commitClaimedInvite(
  teamId: string,
  userId: string,
  guildId: string,
  maxTeamSize: number,
  token: string,
): Promise<boolean> {
  return getDatabase().$transaction(async tx => {
    const lockedRows = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "team_invites"
      WHERE "teamId" = ${teamId} AND "userId" = ${userId}
      FOR UPDATE
    `;
    if (lockedRows.length !== 1) return false;
    const invite = await tx.teamInvite.findUnique({
      where: { teamId_userId: { teamId, userId } },
      include: { team: true },
    });
    if (
      !invite || invite.status !== 'accepting' || invite.team.guildId !== guildId ||
      !isTeamOperationalStatus(invite.team.status) ||
      !await transactionOwnsClaim(
        tx,
        inviteAcceptClaimKey(invite.id),
        TEAM_INVITE_ACCEPT_SCOPE,
        token,
      )
    ) {
      return false;
    }

    await tx.$queryRaw`SELECT "id" FROM "teams" WHERE "id" = ${teamId} FOR UPDATE`;

    const [memberCount, existingMembership] = await Promise.all([
      tx.teamMember.count({ where: { teamId } }),
      tx.teamMember.findUnique({ where: { guildId_userId: { guildId, userId } }, select: { id: true } }),
    ]);
    if (memberCount >= maxTeamSize || existingMembership) return false;

    await tx.teamMember.create({ data: { teamId, guildId, userId } });
    const updated = await tx.teamInvite.updateMany({
      where: { teamId, userId, status: 'accepting' },
      data: { status: 'accepted', processingAt: null },
    });
    if (updated.count !== 1) throw new Error('Invite claim was lost while committing membership');
    await tx.operationClaim.deleteMany({
      where: {
        key: inviteAcceptClaimKey(invite.id),
        scope: TEAM_INVITE_ACCEPT_SCOPE,
        metadata: { path: ['token'], equals: token },
      },
    });
    return true;
  });
}

export async function isInviteAcceptClaimOwned(inviteId: string, token: string): Promise<boolean> {
  const claim = await getDatabase().operationClaim.findUnique({
    where: { key: inviteAcceptClaimKey(inviteId) },
  });
  return claim?.scope === TEAM_INVITE_ACCEPT_SCOPE && metadataToken(claim.metadata) === token;
}

export async function releaseClaimedInvite(
  inviteId: string,
  token: string,
  status: 'pending' | 'expired',
): Promise<boolean> {
  return getDatabase().$transaction(async tx => {
    await tx.$queryRaw`SELECT "id" FROM "team_invites" WHERE "id" = ${inviteId} FOR UPDATE`;
    if (!await transactionOwnsClaim(tx, inviteAcceptClaimKey(inviteId), TEAM_INVITE_ACCEPT_SCOPE, token)) {
      return false;
    }
    const changed = await tx.teamInvite.updateMany({
      where: { id: inviteId, status: 'accepting' },
      data: { status, processingAt: null },
    });
    if (changed.count !== 1) return false;
    await tx.operationClaim.deleteMany({
      where: {
        key: inviteAcceptClaimKey(inviteId),
        metadata: { path: ['token'], equals: token },
      },
    });
    return true;
  });
}

export async function getExpiredInvites() {
  return getDatabase().teamInvite.findMany({
    where: {
      status: 'pending',
      expiresAt: { lte: new Date() },
    },
    include: { team: true },
  });
}

export async function getStaleInviteClaims(cutoff: Date) {
  return getDatabase().teamInvite.findMany({
    where: { status: 'accepting', processingAt: { lte: cutoff } },
    include: { team: true },
  });
}

export async function claimStaleInviteRecovery(
  inviteId: string,
  cutoff: Date,
  now = new Date(),
) {
  return getDatabase().$transaction(async tx => {
    await tx.$queryRaw`SELECT "id" FROM "team_invites" WHERE "id" = ${inviteId} FOR UPDATE`;
    const invite = await tx.teamInvite.findFirst({
      where: { id: inviteId, status: 'accepting', processingAt: { lte: cutoff } },
      include: { team: true },
    });
    if (!invite) return null;
    const previousClaim = await tx.operationClaim.findUnique({
      where: { key: inviteAcceptClaimKey(invite.id) },
    });
    const roleWasPresent = metadataBoolean(previousClaim?.metadata, 'roleWasPresent');
    const token = randomUUID();
    const key = inviteAcceptClaimKey(invite.id);
    await tx.operationClaim.deleteMany({ where: { key } });
    await tx.operationClaim.create({
      data: {
        key,
        scope: TEAM_INVITE_ACCEPT_SCOPE,
        guildId: invite.team.guildId,
        userId: invite.userId,
        metadata: claimMetadata(token, { roleWasPresent }),
        expiresAt: new Date(now.getTime() + TEAM_CLAIM_LEASE_MS),
      },
    });
    await tx.teamInvite.update({ where: { id: invite.id }, data: { processingAt: now } });
    return { invite, token, roleWasPresent };
  });
}

export async function getUserPendingInvite(userId: string) {
  return getDatabase().teamInvite.findFirst({
    where: { userId, status: 'pending' },
    include: { team: true },
  });
}

// ═══════════════════════════════════════════════
//  TeamApplication
// ═══════════════════════════════════════════════

export async function createApplication(data: {
  teamId: string;
  messageId?: string;
  channelId?: string;
}) {
  return getDatabase().teamApplication.create({
    data: { ...data, activeKey: data.teamId },
    include: { team: { include: { members: true } } },
  });
}

export async function claimApplicationReview(
  applicationId: string,
  reviewerId: string,
  action: 'approve' | 'reject',
) {
  return getDatabase().$transaction(async tx => {
    const reviewingStatus = `reviewing_${action}`;
    const now = new Date();
    const result = await tx.teamApplication.updateMany({
      where: { id: applicationId, activeKey: { not: null }, status: 'pending' },
      data: { status: reviewingStatus, reviewerId, processingAt: now },
    });
    if (result.count !== 1) return null;
    const application = await tx.teamApplication.findUnique({
      where: { id: applicationId },
      include: { team: { include: { members: true, config: true } } },
    });
    if (!application) throw new Error('Claimed team application disappeared');
    const token = randomUUID();
    const key = applicationReviewClaimKey(application.id);
    await tx.operationClaim.deleteMany({ where: { key } });
    await tx.operationClaim.create({
      data: {
        key,
        scope: TEAM_APPLICATION_REVIEW_SCOPE,
        guildId: application.team.guildId,
        userId: reviewerId,
        metadata: claimMetadata(token, { wasMentionable: null }),
        expiresAt: new Date(now.getTime() + TEAM_CLAIM_LEASE_MS),
      },
    });
    return { application, token };
  });
}

export async function releaseApplicationReview(
  applicationId: string,
  reviewingStatus: string,
  reviewerId: string,
  token: string,
): Promise<boolean> {
  return getDatabase().$transaction(async tx => {
    await tx.$queryRaw`SELECT "id" FROM "team_applications" WHERE "id" = ${applicationId} FOR UPDATE`;
    if (!await transactionOwnsClaim(
      tx,
      applicationReviewClaimKey(applicationId),
      TEAM_APPLICATION_REVIEW_SCOPE,
      token,
    )) return false;
    const changed = await tx.teamApplication.updateMany({
      where: { id: applicationId, status: reviewingStatus, reviewerId },
      data: { status: 'pending', reviewerId: null, reviewedAt: null, processingAt: null },
    });
    if (changed.count !== 1) return false;
    await tx.operationClaim.deleteMany({
      where: {
        key: applicationReviewClaimKey(applicationId),
        metadata: { path: ['token'], equals: token },
      },
    });
    return true;
  });
}

export async function approveClaimedApplication(
  applicationId: string,
  teamId: string,
  reviewerId: string,
  minSize: number,
  token: string,
): Promise<boolean> {
  return getDatabase().$transaction(async tx => {
    await tx.$queryRaw`SELECT "id" FROM "team_applications" WHERE "id" = ${applicationId} FOR UPDATE`;
    if (!await transactionOwnsClaim(
      tx,
      applicationReviewClaimKey(applicationId),
      TEAM_APPLICATION_REVIEW_SCOPE,
      token,
    )) return false;
    await tx.$queryRaw`SELECT "id" FROM "teams" WHERE "id" = ${teamId} FOR UPDATE`;
    const memberCount = await tx.teamMember.count({ where: { teamId } });
    if (memberCount < minSize) return false;

    const app = await tx.teamApplication.updateMany({
      where: { id: applicationId, teamId, status: 'reviewing_approve', reviewerId },
      data: { status: 'approved', activeKey: null, reviewedAt: new Date(), processingAt: null },
    });
    if (app.count !== 1) return false;

    const team = await tx.team.updateMany({
      where: { id: teamId, status: 'forming' },
      data: { status: 'active', disbandWarningAt: null },
    });
    if (team.count !== 1) throw new Error('Team state changed while approving application');
    await tx.operationClaim.deleteMany({
      where: {
        key: applicationReviewClaimKey(applicationId),
        metadata: { path: ['token'], equals: token },
      },
    });
    return true;
  });
}

export async function rejectClaimedApplication(
  applicationId: string,
  teamId: string,
  reviewerId: string,
  token: string,
): Promise<boolean> {
  return getDatabase().$transaction(async tx => {
    await tx.$queryRaw`SELECT "id" FROM "team_applications" WHERE "id" = ${applicationId} FOR UPDATE`;
    if (!await transactionOwnsClaim(
      tx,
      applicationReviewClaimKey(applicationId),
      TEAM_APPLICATION_REVIEW_SCOPE,
      token,
    )) return false;
    await tx.$queryRaw`SELECT "id" FROM "teams" WHERE "id" = ${teamId} FOR UPDATE`;
    const app = await tx.teamApplication.updateMany({
      where: { id: applicationId, teamId, status: 'reviewing_reject', reviewerId },
      data: { status: 'rejected', activeKey: null, reviewedAt: new Date(), processingAt: null },
    });
    if (app.count !== 1) return false;
    const team = await tx.team.updateMany({
      where: { id: teamId, status: 'forming' },
      data: { status: 'disbanded' },
    });
    if (team.count !== 1) throw new Error('Team state changed while rejecting application');
    await tx.operationClaim.deleteMany({
      where: {
        key: applicationReviewClaimKey(applicationId),
        metadata: { path: ['token'], equals: token },
      },
    });
    return true;
  });
}

export async function getStaleApplicationReviews(cutoff: Date) {
  return getDatabase().teamApplication.findMany({
    where: {
      status: { in: ['reviewing_approve', 'reviewing_reject'] },
      processingAt: { lte: cutoff },
      activeKey: { not: null },
    },
    include: { team: true },
  });
}

export async function claimStaleApplicationReviewRecovery(
  applicationId: string,
  cutoff: Date,
  now = new Date(),
) {
  return getDatabase().$transaction(async tx => {
    await tx.$queryRaw`SELECT "id" FROM "team_applications" WHERE "id" = ${applicationId} FOR UPDATE`;
    const application = await tx.teamApplication.findFirst({
      where: {
        id: applicationId,
        status: { in: ['reviewing_approve', 'reviewing_reject'] },
        processingAt: { lte: cutoff },
        activeKey: { not: null },
      },
      include: { team: true },
    });
    if (!application) return null;
    const previousClaim = await tx.operationClaim.findUnique({
      where: { key: applicationReviewClaimKey(application.id) },
    });
    const wasMentionable = metadataBoolean(previousClaim?.metadata, 'wasMentionable');
    const token = randomUUID();
    const key = applicationReviewClaimKey(application.id);
    await tx.operationClaim.deleteMany({ where: { key } });
    await tx.operationClaim.create({
      data: {
        key,
        scope: TEAM_APPLICATION_REVIEW_SCOPE,
        guildId: application.team.guildId,
        userId: application.reviewerId,
        metadata: claimMetadata(token, { wasMentionable }),
        expiresAt: new Date(now.getTime() + TEAM_CLAIM_LEASE_MS),
      },
    });
    await tx.teamApplication.update({ where: { id: application.id }, data: { processingAt: now } });
    return { application, token, wasMentionable };
  });
}

export async function getApplication(applicationId: string) {
  return getDatabase().teamApplication.findUnique({
    where: { id: applicationId },
    include: { team: { include: { members: true, config: true } } },
  });
}

export async function getPendingApplication(teamId: string) {
  return getDatabase().teamApplication.findFirst({
    where: { teamId, status: 'pending' },
    include: { team: true },
  });
}

export async function getPendingApplicationRoleAudits() {
  return getDatabase().teamApplication.findMany({
    where: { status: 'pending', activeKey: { not: null }, team: { status: 'forming' } },
    include: { team: true },
    take: 100,
  });
}

export async function getStaleUnlinkedApplications(cutoff: Date) {
  return getDatabase().teamApplication.findMany({
    where: { status: 'pending', activeKey: { not: null }, messageId: null, createdAt: { lte: cutoff } },
    include: { team: { include: { config: true, members: true } } },
  });
}

/**
 * Atomically turn an unlinked creation into a durable cleanup job. Locking
 * both rows prevents a concurrent creator/recovery worker from linking the
 * application after cleanup has started.
 */
export async function claimPendingTeamCreationCleanup(
  applicationId: string,
  teamId: string,
  cleanupMessageId: string | null = null,
  createdBefore?: Date,
): Promise<boolean> {
  return getDatabase().$transaction(async tx => {
    await tx.$queryRaw`SELECT "id" FROM "teams" WHERE "id" = ${teamId} FOR UPDATE`;
    await tx.$queryRaw`SELECT "id" FROM "team_applications" WHERE "id" = ${applicationId} FOR UPDATE`;
    const [team, application] = await Promise.all([
      tx.team.findUnique({ where: { id: teamId }, select: { id: true, status: true } }),
      tx.teamApplication.findUnique({
        where: { id: applicationId },
        select: { id: true, teamId: true, status: true, activeKey: true, messageId: true, createdAt: true },
      }),
    ]);

    if (
      team?.status === 'creation_cleanup' &&
      application?.teamId === teamId &&
      application.status === 'creation_cleanup'
    ) {
      if (cleanupMessageId && !application.messageId) {
        await tx.teamApplication.update({ where: { id: applicationId }, data: { messageId: cleanupMessageId } });
      }
      return true;
    }

    if (
      !team || !application || application.teamId !== teamId ||
      team.status !== 'forming' || application.status !== 'pending' ||
      application.activeKey !== teamId || application.messageId !== null ||
      (createdBefore && application.createdAt > createdBefore)
    ) return false;

    await tx.team.update({ where: { id: teamId }, data: { status: 'creation_cleanup' } });
    await tx.teamApplication.update({
      where: { id: applicationId },
      data: {
        status: 'creation_cleanup',
        processingAt: new Date(),
        ...(cleanupMessageId ? { messageId: cleanupMessageId } : {}),
      },
    });
    return true;
  });
}

export async function getPendingTeamCreationCleanups() {
  return getDatabase().teamApplication.findMany({
    where: { status: 'creation_cleanup' },
    include: { team: { include: { config: true, members: true } } },
    orderBy: { createdAt: 'asc' },
    take: 100,
  });
}

/** Delete the durable tracker only after Discord cleanup was confirmed. */
export async function finalizePendingTeamCreationCleanup(
  applicationId: string,
  teamId: string,
): Promise<boolean> {
  return getDatabase().$transaction(async tx => {
    await tx.$queryRaw`SELECT "id" FROM "teams" WHERE "id" = ${teamId} FOR UPDATE`;
    const application = await tx.teamApplication.findUnique({
      where: { id: applicationId },
      select: { teamId: true, status: true },
    });
    const team = await tx.team.findUnique({ where: { id: teamId }, select: { status: true } });
    if (
      !application || application.teamId !== teamId || application.status !== 'creation_cleanup' ||
      team?.status !== 'creation_cleanup'
    ) return false;
    await tx.team.delete({ where: { id: teamId } });
    return true;
  });
}

export async function setApplicationMessage(applicationId: string, messageId: string): Promise<boolean> {
  const result = await getDatabase().teamApplication.updateMany({
    where: { id: applicationId, status: 'pending', activeKey: { not: null }, messageId: null },
    data: { messageId },
  });
  return result.count === 1;
}

// ═══════════════════════════════════════════════
//  TeamSession
// ═══════════════════════════════════════════════

export async function createSession(data: {
  teamId: string;
  guildId: string;
  squadNumber?: number;
  squadVoiceId?: string;
}) {
  return getDatabase().$transaction(async tx => {
    await tx.$queryRaw`SELECT "id" FROM "teams" WHERE "id" = ${data.teamId} FOR UPDATE`;
    const team = await tx.team.findUnique({ where: { id: data.teamId } });
    if (!team || team.guildId !== data.guildId || team.status !== 'active') {
      throw new Error('Cannot start a PB session for a missing or inactive team');
    }
    const existing = await tx.teamSession.findFirst({ where: { teamId: data.teamId, endedAt: null } });
    if (existing) {
      if (existing.squadVoiceId === data.squadVoiceId) return existing;
      throw new Error('Team already has an active PB session in another squad');
    }
    return tx.teamSession.create({ data });
  });
}

export async function getSession(sessionId: string) {
  return getDatabase().teamSession.findUnique({
    where: { id: sessionId },
    include: { team: true },
  });
}

export async function getActiveSession(teamId: string) {
  return getDatabase().teamSession.findFirst({
    where: { teamId, endedAt: null },
    orderBy: { startedAt: 'desc' },
  });
}

export async function getActiveSessionBySquad(guildId: string, squadNumber: number) {
  return getDatabase().teamSession.findFirst({
    where: { guildId, squadNumber, endedAt: null },
    orderBy: { startedAt: 'desc' },
    include: { team: { include: { members: true, config: true } } },
  });
}

export async function getActiveSessionByVoice(squadVoiceId: string) {
  return getDatabase().teamSession.findFirst({
    where: { squadVoiceId, endedAt: null },
    include: { team: { include: { members: true, config: true } } },
  });
}

export async function endSession(sessionId: string) {
  return getDatabase().teamSession.update({
    where: { id: sessionId },
    data: { endedAt: new Date() },
  });
}

export async function submitReportOnce(data: {
  sessionId: string;
  reporterId: string;
  reportedPR: number;
  reportedPlace: number;
  season: number;
  year: number;
  now: Date;
  timeoutMs: number;
}) {
  return getDatabase().$transaction(async tx => {
    await tx.$queryRaw`SELECT "id" FROM "team_sessions" WHERE "id" = ${data.sessionId} FOR UPDATE`;
    const session = await tx.teamSession.findUnique({
      where: { id: data.sessionId },
      include: { team: true },
    });
    if (
      !session || session.reportedAt || !session.endedAt ||
      session.team.leaderId !== data.reporterId ||
      data.now.getTime() > session.endedAt.getTime() + data.timeoutMs
    ) return null;

    const changed = await tx.teamSession.updateMany({
      where: { id: data.sessionId, reportedAt: null },
      data: {
        reportedById: data.reporterId,
        reportedPR: data.reportedPR,
        reportedPlace: data.reportedPlace,
        reportedAt: data.now,
      },
    });
    if (changed.count !== 1) return null;

    await tx.teamSeason.upsert({
      where: { teamId_season_year: { teamId: session.teamId, season: data.season, year: data.year } },
      create: {
        teamId: session.teamId,
        season: data.season,
        year: data.year,
        totalPR: data.reportedPR,
        totalSessions: 1,
        totalPlace: data.reportedPlace,
        bestPlace: data.reportedPlace,
      },
      update: {
        totalPR: { increment: data.reportedPR },
        totalSessions: { increment: 1 },
        totalPlace: { increment: data.reportedPlace },
      },
    });
    await tx.$executeRaw`
      UPDATE "team_seasons"
      SET "bestPlace" = LEAST("bestPlace", ${data.reportedPlace})
      WHERE "teamId" = ${session.teamId} AND "season" = ${data.season} AND "year" = ${data.year}
    `;

    return tx.teamSession.findUnique({
      where: { id: data.sessionId },
      include: { team: true },
    });
  });
}

export async function claimReportReminder(sessionId: string): Promise<boolean> {
  const result = await getDatabase().teamSession.updateMany({
    where: { id: sessionId, reportedAt: null, reportReminderAt: null },
    data: { reportReminderAt: new Date() },
  });
  return result.count === 1;
}

export async function releaseReportReminder(sessionId: string): Promise<void> {
  await getDatabase().teamSession.updateMany({
    where: { id: sessionId, reportedAt: null, reportReminderAt: { not: null } },
    data: { reportReminderAt: null },
  });
}

export async function getUnreportedSessions(guildId: string, olderThanH: number) {
  const cutoff = new Date(Date.now() - olderThanH * 3_600_000);
  return getDatabase().teamSession.findMany({
    where: {
      guildId,
      endedAt: { not: null, lte: cutoff },
      reportedAt: null,
    },
    include: { team: true },
  });
}

export async function getTeamSessions(teamId: string, seasonStart: Date, seasonEnd: Date) {
  return getDatabase().teamSession.findMany({
    where: {
      teamId,
      startedAt: { gte: seasonStart },
      endedAt: { lte: seasonEnd },
      reportedAt: { not: null },
    },
    orderBy: { startedAt: 'desc' },
  });
}

// ═══════════════════════════════════════════════
//  TeamSeason (статистика)
// ═══════════════════════════════════════════════

export async function upsertSeason(teamId: string, season: number, year: number, data: {
  totalPR?: number;
  totalSessions?: number;
  totalPlace?: number;
  bestPlace?: number;
  attendance?: number;
}) {
  return getDatabase().teamSeason.upsert({
    where: { teamId_season_year: { teamId, season, year } },
    create: { teamId, season, year, ...data },
    update: data,
  });
}

export async function getSeason(teamId: string, season: number, year: number) {
  return getDatabase().teamSeason.findUnique({
    where: { teamId_season_year: { teamId, season, year } },
  });
}

export async function getGuildSeasonStats(guildId: string, season: number, year: number) {
  return getDatabase().teamSeason.findMany({
    where: {
      season,
      year,
      team: { guildId, status: { not: 'disbanded' } },
    },
    include: { team: true },
    orderBy: [
      { totalPR: 'desc' },
      { bestPlace: 'asc' },
    ],
  });
}

// ═══════════════════════════════════════════════
//  TeamPoll
// ═══════════════════════════════════════════════

export async function createPoll(data: {
  teamId: string;
  messageId?: string;
  channelId?: string;
  type?: string;
  scheduledAt?: Date;
  dedupKey?: string;
}) {
  return getDatabase().teamPoll.create({
    data: { ...data, activeKey: data.teamId },
    include: { team: true, votes: true },
  });
}

export async function deleteUnpublishedPoll(pollId: string): Promise<boolean> {
  const result = await getDatabase().teamPoll.deleteMany({
    where: { id: pollId, status: 'active', messageId: null },
  });
  return result.count === 1;
}

export async function getStaleUnpublishedPolls(cutoff: Date) {
  return getDatabase().teamPoll.findMany({
    where: { status: 'active', messageId: null, createdAt: { lte: cutoff } },
    include: { team: { include: { config: true } }, votes: true },
  });
}

export async function getPoll(pollId: string) {
  return getDatabase().teamPoll.findUnique({
    where: { id: pollId },
    include: { team: true, votes: true },
  });
}

export async function getActivePoll(teamId: string) {
  return getDatabase().teamPoll.findUnique({
    where: { activeKey: teamId },
    include: { team: true, votes: true },
  });
}

export async function setPollMessage(pollId: string, channelId: string, messageId: string) {
  return getDatabase().teamPoll.update({
    where: { id: pollId },
    data: { channelId, messageId },
    include: { team: true, votes: true },
  });
}

export async function upsertPollVoteIfActive(
  pollId: string,
  userId: string,
  vote: 'yes' | 'no',
  readyTime: string | null,
) {
  return getDatabase().$transaction(async tx => {
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "team_polls" WHERE "id" = ${pollId} AND "status" = 'active' FOR UPDATE
    `;
    if (rows.length !== 1) return null;

    await tx.teamPollVote.upsert({
      where: { pollId_userId: { pollId, userId } },
      create: { pollId, userId, vote, readyTime: vote === 'yes' ? readyTime : null },
      update: { vote, readyTime: vote === 'yes' ? readyTime : null },
    });
    return tx.teamPoll.findUnique({
      where: { id: pollId },
      include: { team: true, votes: { orderBy: { createdAt: 'asc' } } },
    });
  });
}

export async function closePoll(pollId: string) {
  return getDatabase().$transaction(async tx => {
    await tx.$queryRaw`SELECT "id" FROM "team_polls" WHERE "id" = ${pollId} FOR UPDATE`;
    const poll = await tx.teamPoll.findUnique({ where: { id: pollId } });
    if (!poll) return { changed: false, poll: null };
    if (poll.status !== 'active') {
      const current = await tx.teamPoll.findUnique({
        where: { id: pollId },
        include: { team: true, votes: { orderBy: { createdAt: 'asc' } } },
      });
      return { changed: false, poll: current };
    }

    await tx.teamPoll.update({
      where: { id: pollId },
      data: { status: 'closed', activeKey: null, closedAt: new Date() },
    });
    const closed = await tx.teamPoll.findUnique({
      where: { id: pollId },
      include: { team: true, votes: { orderBy: { createdAt: 'asc' } } },
    });
    return { changed: true, poll: closed };
  });
}

export async function claimPollNotification(pollId: string, key: string): Promise<boolean> {
  return getDatabase().$transaction(async tx => {
    await tx.$queryRaw`SELECT "id" FROM "team_polls" WHERE "id" = ${pollId} FOR UPDATE`;
    const poll = await tx.teamPoll.findUnique({ where: { id: pollId }, select: { notifiedKeys: true } });
    if (!poll || poll.notifiedKeys.includes(key)) return false;
    await tx.teamPoll.update({
      where: { id: pollId },
      data: { notifiedKeys: { push: key } },
    });
    return true;
  });
}

export async function releasePollNotification(pollId: string, key: string): Promise<void> {
  await getDatabase().$transaction(async tx => {
    await tx.$queryRaw`SELECT "id" FROM "team_polls" WHERE "id" = ${pollId} FOR UPDATE`;
    const poll = await tx.teamPoll.findUnique({ where: { id: pollId }, select: { notifiedKeys: true } });
    if (!poll?.notifiedKeys.includes(key)) return;
    await tx.teamPoll.update({
      where: { id: pollId },
      data: { notifiedKeys: { set: poll.notifiedKeys.filter(existing => existing !== key) } },
    });
  });
}

export async function markPollUiClosed(pollId: string): Promise<void> {
  await getDatabase().teamPoll.updateMany({
    where: { id: pollId, status: 'closed', uiClosedAt: null },
    data: { uiClosedAt: new Date() },
  });
}

export async function getExpiredActivePolls(cutoff: Date) {
  return getDatabase().teamPoll.findMany({
    where: { status: 'active', createdAt: { lte: cutoff } },
    include: { team: true, votes: { orderBy: { createdAt: 'asc' } } },
  });
}

export async function getPollsPendingUiClosure() {
  return getDatabase().teamPoll.findMany({
    where: { status: 'closed', uiClosedAt: null, messageId: { not: null }, channelId: { not: null } },
    include: { team: true, votes: { orderBy: { createdAt: 'asc' } } },
  });
}

export async function getActivePolls(guildId: string) {
  return getDatabase().teamPoll.findMany({
    where: {
      status: 'active',
      team: { guildId },
    },
    include: { team: true, votes: true },
  });
}

// ═══════════════════════════════════════════════
//  Teams по расформированию
// ═══════════════════════════════════════════════

export async function getDisbandingTeams() {
  return getDatabase().team.findMany({
    where: {
      status: 'disbanding',
      disbandWarningAt: { not: null },
    },
    include: { members: true, config: true },
  });
}

export async function getDeletingTeams() {
  return getDatabase().team.findMany({
    where: { status: 'deleting' },
    include: { members: true, config: true },
  });
}

export async function getDisbandedTeamsWithMembers() {
  return getDatabase().team.findMany({
    where: { status: 'disbanded', members: { some: {} } },
    select: { id: true, guildId: true, roleId: true, name: true },
  });
}

export async function getFormingTeams() {
  return getDatabase().team.findMany({
    where: { status: 'forming' },
    include: { members: true, config: true, applications: { where: { status: 'pending' } } },
  });
}
