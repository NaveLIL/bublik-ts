import { VacationStatus, NsType } from './constants';

export const VACATION_OPEN_STATUSES = [
  VacationStatus.Pending,
  VacationStatus.Activating,
  VacationStatus.Active,
  VacationStatus.Restoring,
] as const;

export function vacationActiveKey(guildId: string, userId: string): string {
  return `${guildId}:${userId}`;
}

/**
 * Shield and troll both mutate the complete role set, so they share one slot.
 * The informational NS vacation has an independent slot.
 */
export function nsVacationActiveKey(guildId: string, userId: string, type: string): string {
  const scope = type === NsType.Vacation ? NsType.Vacation : 'roles';
  return `${guildId}:${userId}:${scope}`;
}

export function isNsInformationalVacation(type: string): boolean {
  return type === NsType.Vacation;
}

export function isVacationTerminalStatus(status: string): boolean {
  return status === VacationStatus.Denied
    || status === VacationStatus.Expired
    || status === VacationStatus.Completed;
}

export interface VacationRoleIntegrityPlan {
  removePingRole: boolean;
  removeVacationRole: boolean;
  ensureVacationRole: boolean;
}

export function vacationRoleConfigurationIsDistinct(
  vacationRoleId: string | null,
  pbCoreRoleIds: readonly (string | null)[],
  removeRoleIds: readonly string[] = [],
): boolean {
  if (!vacationRoleId) return true;
  if (pbCoreRoleIds.some((roleId) => roleId === vacationRoleId)) return false;
  return !removeRoleIds.includes(vacationRoleId);
}

/** Existing role holders only need a full scan when an established marker changes. */
export function vacationRoleChangeRequested(
  currentVacationRoleId: string | null,
  requestedVacationRoleId: string | null,
): boolean {
  return Boolean(
    currentVacationRoleId &&
    requestedVacationRoleId &&
    currentVacationRoleId !== requestedVacationRoleId,
  );
}

/**
 * Legacy configurations could snapshot the vacation marker as a removable
 * role. It is never valid restoration provenance: while away it is the marker,
 * and after return it must be absent. Filter it without discarding other roles.
 */
export function normalizeVacationSavedRoleIds(
  savedRoleIds: readonly string[],
  vacationRoleId: string | null,
): string[] {
  if (!vacationRoleId) return [...savedRoleIds];
  return savedRoleIds.filter((roleId) => roleId !== vacationRoleId);
}

export interface VacationRoleSnapshotPolicyInput {
  currentRoleIds: Iterable<string>;
  configuredRemoveRoleIds: readonly string[];
  pingRoleId: string | null;
  vacationRoleId: string | null;
  hasProvenPbPingProvenance: boolean;
}

interface PbPingRoleProvenance {
  version: number;
  hadPingRole?: boolean;
  pingRoleId: string | null;
  returnRoleIds: readonly string[];
  playedResetRoleIds: readonly string[];
}

/**
 * A voice session may prove only the exact ping role it consumed. This keeps a
 * stale session from granting a newly configured ping role during vacation.
 */
export function hasExactPbPingRoleProvenance(
  session: PbPingRoleProvenance | null,
  currentPingRoleId: string | null,
): boolean {
  if (!session || session.version !== 2 || !currentPingRoleId) return false;
  const directlyConsumed = session.hadPingRole === true
    && session.pingRoleId === currentPingRoleId
    && session.returnRoleIds.includes(currentPingRoleId);
  const inheritedFromPlayedReset = session.playedResetRoleIds.includes(currentPingRoleId);
  return directlyConsumed || inheritedFromPlayedReset;
}

/**
 * Seal only roles held at the authoritative fresh activation read. The sole
 * exception is a PB ping role whose temporary absence is proven by the durable
 * active voice session. Roles granted later during leave are never provenance.
 */
export function buildVacationRoleSnapshot(
  input: VacationRoleSnapshotPolicyInput,
): string[] {
  const currentRoleIds = new Set(input.currentRoleIds);
  const savedRoleIds = selectVacationSavedRoles(
    currentRoleIds,
    input.configuredRemoveRoleIds,
    input.pingRoleId,
  );
  if (
    input.pingRoleId &&
    input.hasProvenPbPingProvenance &&
    !savedRoleIds.includes(input.pingRoleId)
  ) {
    savedRoleIds.push(input.pingRoleId);
  }
  return normalizeVacationSavedRoleIds(savedRoleIds, input.vacationRoleId);
}

/**
 * Active leave suppresses a currently-held ping role even when it was granted
 * after the immutable snapshot. Only sealed saved roles are restored later.
 */
export function buildVacationSuppressedRoleIds(
  sealedSavedRoleIds: readonly string[],
  currentRoleIds: Iterable<string>,
  configuredRemoveRoleIds: readonly string[],
  pingRoleId: string | null,
  vacationRoleId: string | null,
): string[] {
  const current = new Set(currentRoleIds);
  const suppressed = new Set(
    normalizeVacationSavedRoleIds(sealedSavedRoleIds, vacationRoleId),
  );
  for (const roleId of configuredRemoveRoleIds) {
    if (current.has(roleId)) suppressed.add(roleId);
  }
  if (pingRoleId && current.has(pingRoleId)) suppressed.add(pingRoleId);
  if (vacationRoleId) suppressed.delete(vacationRoleId);
  return [...suppressed];
}

/**
 * Enforce the fail-closed activation boundary. The vacation marker is proof
 * that all mutually-exclusive roles were removed, so it must be the second
 * phase and is never attempted after a suppression failure.
 */
export async function runVacationActivationRolePhases(
  suppressRoles: () => Promise<void>,
  addVacationMarker: () => Promise<void>,
): Promise<void> {
  await suppressRoles();
  await addVacationMarker();
}

/**
 * Enforce the fail-closed restoration boundary. A saved role can include the
 * manually assigned PB ping role, so no saved role is granted while Discord
 * may still have the vacation marker.
 */
export async function runVacationRestoreRolePhases(
  suppressUnprovenRoles: () => Promise<void>,
  removeVacationMarker: () => Promise<void>,
  restoreSavedRoles: () => Promise<void>,
): Promise<void> {
  await suppressUnprovenRoles();
  await removeVacationMarker();
  await restoreSavedRoles();
}

/**
 * PostgreSQL vacation state wins every role conflict. Active leave keeps the
 * vacation marker and suppresses PB eligibility; otherwise a stale vacation
 * marker is removed without taking away a valid PB ping role.
 */
export function planVacationRoleIntegrity(
  hasLiveVacation: boolean,
  hasPingRole: boolean,
  hasVacationRole: boolean,
): VacationRoleIntegrityPlan {
  return hasLiveVacation
    ? {
      removePingRole: hasPingRole,
      removeVacationRole: false,
      ensureVacationRole: !hasVacationRole,
    }
    : {
      removePingRole: false,
      removeVacationRole: hasVacationRole,
      ensureVacationRole: false,
    };
}

export function isNsTerminalStatus(status: string): boolean {
  return status === 'completed';
}

const VACATION_TRANSITIONS: Readonly<Record<string, ReadonlySet<string>>> = {
  [VacationStatus.Pending]: new Set([
    VacationStatus.Activating,
    VacationStatus.Denied,
    VacationStatus.Expired,
  ]),
  [VacationStatus.Activating]: new Set([
    VacationStatus.Activating,
    VacationStatus.Active,
    VacationStatus.Restoring,
    VacationStatus.Denied,
  ]),
  [VacationStatus.Active]: new Set([VacationStatus.Restoring]),
  [VacationStatus.Restoring]: new Set([
    VacationStatus.Restoring,
    VacationStatus.Active,
    VacationStatus.Completed,
  ]),
};

export function isVacationTransitionAllowed(from: string, to: string): boolean {
  return VACATION_TRANSITIONS[from]?.has(to) ?? false;
}

const NS_TRANSITIONS: Readonly<Record<string, ReadonlySet<string>>> = {
  activating: new Set(['activating', 'active', 'restoring', 'completed']),
  active: new Set(['restoring', 'completed']),
  restoring: new Set(['restoring', 'active', 'completed']),
};

export function isNsTransitionAllowed(from: string, to: string): boolean {
  return NS_TRANSITIONS[from]?.has(to) ?? false;
}

export function canReviewVacation(
  reviewerRoleIds: readonly string[],
  memberRoleIds: ReadonlySet<string>,
  hasManageGuild: boolean,
): boolean {
  if (hasManageGuild) return true;
  return reviewerRoleIds.length > 0
    && reviewerRoleIds.some((roleId) => memberRoleIds.has(roleId));
}

export function selectSavedRoles(
  memberRoleIds: Iterable<string>,
  configuredRoleIds: ReadonlySet<string>,
  excludedRoleIds: ReadonlySet<string> = new Set(),
): string[] {
  const selected = new Set<string>();
  for (const roleId of memberRoleIds) {
    if (configuredRoleIds.has(roleId) && !excludedRoleIds.has(roleId)) {
      selected.add(roleId);
    }
  }
  return [...selected];
}

/** Current PB ping role is always part of a new regular vacation snapshot. */
export function selectVacationSavedRoles(
  memberRoleIds: Iterable<string>,
  configuredRemoveRoleIds: readonly string[],
  currentPbPingRoleId: string | null,
): string[] {
  const managedRoleIds = new Set(configuredRemoveRoleIds);
  if (currentPbPingRoleId) managedRoleIds.add(currentPbPingRoleId);
  return selectSavedRoles(memberRoleIds, managedRoleIds);
}
