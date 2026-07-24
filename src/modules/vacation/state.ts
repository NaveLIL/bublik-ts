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
