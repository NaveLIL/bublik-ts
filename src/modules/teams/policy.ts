import { ApplicationStatus, MAX_TEAM_SIZE, PollStatus, TeamStatus } from './constants';

export interface ApplicationReviewerContext {
  isAdministrator: boolean;
  canManageGuild: boolean;
  roleIds: Iterable<string>;
}

/**
 * An empty configured role list is deliberately fail-closed for ordinary
 * members. Guild administrators and members with ManageGuild always retain an
 * emergency review path.
 */
export function canReviewApplication(
  reviewer: ApplicationReviewerContext,
  configuredRoleIds: readonly string[],
): boolean {
  if (reviewer.isAdministrator || reviewer.canManageGuild) return true;
  if (configuredRoleIds.length === 0) return false;

  const roles = new Set(reviewer.roleIds);
  return configuredRoleIds.some(roleId => roles.has(roleId));
}

export function isValidConfiguredTeamSize(minSize: number): boolean {
  return Number.isInteger(minSize) && minSize >= 2 && minSize <= MAX_TEAM_SIZE;
}

export function getMemberSelectLimits(minSize: number): { min: number; max: number } {
  if (!isValidConfiguredTeamSize(minSize)) {
    throw new RangeError(`Team minSize must be between 2 and ${MAX_TEAM_SIZE}`);
  }
  return { min: minSize - 1, max: MAX_TEAM_SIZE - 1 };
}

export function canCastPollVote(status: string, isGuildTeamMember: boolean): boolean {
  return status === PollStatus.ACTIVE && isGuildTeamMember;
}

export interface TeamCreationLinkSnapshot {
  messageId: string | null;
  status: string;
  team: { status: string };
}

/** A failed link CAS is never authority to delete state another worker advanced. */
export function mustPreserveCreationAfterFailedMessageLink(
  snapshot: TeamCreationLinkSnapshot | null,
): boolean {
  return snapshot === null ||
    snapshot.messageId !== null ||
    snapshot.status !== ApplicationStatus.PENDING ||
    snapshot.team.status !== TeamStatus.FORMING;
}

export function normalizeReadyTime(raw: string | null | undefined): string | null {
  const value = raw?.trim();
  if (!value) return null;

  const match = value.match(/^(\d{1,2})[:.·]?(\d{2})$/);
  if (!match) return null;

  const hours = Number.parseInt(match[1], 10);
  const minutes = Number.parseInt(match[2], 10);
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;

  return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}`;
}

export interface PollVoteProjectionInput {
  userId: string;
  vote: string;
  readyTime: string | null;
}

export interface PollVoteProjection {
  yesUserIds: string[];
  noUserIds: string[];
  voteTimes: Record<string, string | null>;
}

export interface LegacyPollProjection {
  yesUserIds: readonly string[];
  noUserIds: readonly string[];
  voteTimes: Readonly<Record<string, string | null>>;
}

export function projectPollVotes(
  votes: readonly PollVoteProjectionInput[],
  legacy: LegacyPollProjection = { yesUserIds: [], noUserIds: [], voteTimes: {} },
): PollVoteProjection {
  const yes = new Set(legacy.yesUserIds);
  const no = new Set(legacy.noUserIds);
  const voteTimes: Record<string, string | null> = { ...legacy.voteTimes };

  for (const vote of votes) {
    yes.delete(vote.userId);
    no.delete(vote.userId);
    delete voteTimes[vote.userId];
    if (vote.vote === 'yes') {
      yes.add(vote.userId);
      voteTimes[vote.userId] = vote.readyTime;
    } else if (vote.vote === 'no') {
      no.add(vote.userId);
    }
  }

  return { yesUserIds: [...yes], noUserIds: [...no], voteTimes };
}

/** Works with both classic Discord action rows and Components V2 trees. */
export function componentTreeContainsCustomId(value: unknown, customId: string): boolean {
  if (!value || typeof value !== 'object') return false;
  const component = value as { customId?: unknown; components?: unknown };
  if (component.customId === customId) return true;
  if (!Array.isArray(component.components)) return false;
  const children = component.components as unknown[];
  return children.some(child => componentTreeContainsCustomId(child, customId));
}
