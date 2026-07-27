export const LIVE_REPRIMAND_STATUSES = [
  'granting',
  'active',
  'appeal_creating',
  'appealing',
  'annulling',
  'appeal_resolving',
  'expiring',
  'pending_cleanup',
] as const;

export const TRANSITIONAL_REPRIMAND_STATUSES = [
  'granting',
  'grant_cleanup',
  'appeal_creating',
  'annulling',
  'appeal_resolving',
] as const;

/** Discord confirms that a guild member no longer exists with API code 10007. */
export function isUnknownMemberError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const code = (error as { code?: unknown }).code;
  return code === 10007 || code === '10007';
}

/** Discord confirms that a channel no longer exists with API code 10003. */
export function isUnknownChannelError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const code = (error as { code?: unknown }).code;
  return code === 10003 || code === '10003';
}

export function isUnknownMessageError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const code = (error as { code?: unknown }).code;
  return code === 10008 || code === '10008';
}

/**
 * Date whose daily reset is due in Moscow. Before today's configured hour the
 * previous day's reset is still the latest due job, which provides catch-up
 * after downtime spanning the scheduled hour.
 */
export function getDuePlayedResetDate(now: Date, resetHour: number): string {
  const moscowNow = new Date(now.getTime() + 3 * 60 * 60_000);
  const hour = moscowNow.getUTCHours();
  if (hour < resetHour) moscowNow.setUTCDate(moscowNow.getUTCDate() - 1);
  return moscowNow.toISOString().slice(0, 10);
}

export function getPrismaErrorCode(error: unknown): string | null {
  if (!error || typeof error !== 'object') return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : null;
}

export interface PbCoreRoleIds {
  pingRoleId?: string | null;
  inSquadRoleId?: string | null;
  playedTodayRoleId?: string | null;
}

/** A disciplinary role must never alias a PB capability or vacation marker. */
export function reprimandTypeRoleConflictsWithProtectedRole(
  roleId: string,
  coreRoles: PbCoreRoleIds,
  vacationRoleId: string | null,
): boolean {
  return roleId === vacationRoleId || [
    coreRoles.pingRoleId,
    coreRoles.inSquadRoleId,
    coreRoles.playedTodayRoleId,
  ].some((protectedRoleId) => Boolean(protectedRoleId) && roleId === protectedRoleId);
}

/** Daily provenance is retained untouched until vacation role suppression ends. */
export function playedResetDisposition(
  roleMutationSuppressed: boolean,
): 'apply' | 'defer' {
  return roleMutationSuppressed ? 'defer' : 'apply';
}

export function isCommanderAuthorized(
  configuredRoleIds: unknown,
  memberRoleIds: ReadonlySet<string>,
  canManageGuild: boolean,
): boolean {
  if (canManageGuild) return true;
  if (!Array.isArray(configuredRoleIds) || configuredRoleIds.length === 0) return false;
  return configuredRoleIds.some((roleId) =>
    typeof roleId === 'string' && memberRoleIds.has(roleId));
}

/** Private team squads never fall back to a generic commander capability. */
export function mayUsePbCommanderFallback(
  isPrivateTeamSquad: boolean,
  isSquadOwner: boolean,
  configuredRoleIds: unknown,
  memberRoleIds: ReadonlySet<string>,
): boolean {
  if (isPrivateTeamSquad) return false;
  if (isSquadOwner) return true;
  if (!Array.isArray(configuredRoleIds) || configuredRoleIds.length === 0) return false;
  return configuredRoleIds.some((roleId) =>
    typeof roleId === 'string' && memberRoleIds.has(roleId));
}

/** Production always observes the PB creation window. */
export function canBypassSquadCreationWindow(
  userId: string,
  isDev: boolean,
  ownerId: string | null,
): boolean {
  return isDev && Boolean(ownerId) && userId === ownerId;
}

/** Half-open [start, end) daily window; end before start wraps across midnight. */
export function isMinuteInHalfOpenDailyWindow(
  minuteOfDay: number,
  startMinute: number,
  endMinute: number,
): boolean {
  if (
    !Number.isInteger(minuteOfDay) || !Number.isInteger(startMinute) || !Number.isInteger(endMinute) ||
    minuteOfDay < 0 || minuteOfDay >= 24 * 60 ||
    startMinute < 0 || startMinute >= 24 * 60 ||
    endMinute < 0 || endMinute >= 24 * 60 ||
    startMinute === endMinute
  ) return false;
  return startMinute < endMinute
    ? minuteOfDay >= startMinute && minuteOfDay < endMinute
    : minuteOfDay >= startMinute || minuteOfDay < endMinute;
}

/** EU evening plus NA morning preparation windows, expressed in Moscow time. */
export function canCreatePbSquadAtMskMinute(minuteOfDay: number): boolean {
  return isMinuteInHalfOpenDailyWindow(minuteOfDay, 16 * 60 + 30, 60) ||
    isMinuteInHalfOpenDailyWindow(minuteOfDay, 3 * 60 + 30, 10 * 60);
}
