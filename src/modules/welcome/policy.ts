import { createHash } from 'node:crypto';
import { PermissionsBitField, type Role } from 'discord.js';
import { areGuildWelcomeRoleIdsDistinct } from '../../core/GuildConfig';

export const WELCOME_ROLE_REPAIR_BUDGET = 5;
export const WELCOME_REMINDER_ATTEMPT_BUDGET = 10;

const DANGEROUS_AUTOMATION_PERMISSIONS = new PermissionsBitField([
  PermissionsBitField.Flags.Administrator,
  PermissionsBitField.Flags.ManageGuild,
  PermissionsBitField.Flags.ManageRoles,
  PermissionsBitField.Flags.ManageChannels,
  PermissionsBitField.Flags.ManageWebhooks,
  PermissionsBitField.Flags.KickMembers,
  PermissionsBitField.Flags.BanMembers,
  PermissionsBitField.Flags.ModerateMembers,
  PermissionsBitField.Flags.MentionEveryone,
]);

export function hasDangerousWelcomeRolePermissions(
  role: Pick<Role, 'permissions'>,
): boolean {
  return role.permissions.any(DANGEROUS_AUTOMATION_PERMISSIONS);
}

export function hasTicketPanelMemberAccess(
  permissions: Pick<PermissionsBitField, 'has'> | null | undefined,
): boolean {
  return Boolean(permissions?.has([
    PermissionsBitField.Flags.ViewChannel,
    PermissionsBitField.Flags.ReadMessageHistory,
  ]));
}

export function areWelcomeRoleIdsDistinct(roleIds: readonly (string | null | undefined)[]): boolean {
  return areGuildWelcomeRoleIdsDistinct(roleIds);
}

/** A safe legacy repair candidate has no role other than @everyone. */
export function isAutoRoleRepairCandidate(
  guildId: string,
  roleIds: Iterable<string>,
  autoRoleId: string,
  memberRoleId: string | null,
): boolean {
  const roles = new Set(roleIds);
  if (roles.has(autoRoleId) || (memberRoleId && roles.has(memberRoleId))) return false;
  for (const roleId of roles) {
    if (roleId !== guildId) return false;
  }
  return true;
}

/** Remind only users who have not progressed beyond the optional auto-role. */
export function isWelcomeReminderCandidate(
  guildId: string,
  roleIds: Iterable<string>,
  autoRoleId: string | null,
  memberRoleId: string | null,
  recruitRoleId: string | null,
): boolean {
  const roles = new Set(roleIds);
  if (memberRoleId && roles.has(memberRoleId)) return false;
  if (recruitRoleId && roles.has(recruitRoleId)) return false;
  for (const roleId of roles) {
    if (roleId !== guildId && roleId !== autoRoleId) return false;
  }
  return true;
}

export function needsAutoRoleRemoval(
  roleIds: Iterable<string>,
  autoRoleId: string | null,
  memberRoleId: string | null,
): boolean {
  if (!autoRoleId || !memberRoleId || autoRoleId === memberRoleId) return false;
  const roles = new Set(roleIds);
  return roles.has(autoRoleId) && roles.has(memberRoleId);
}

export function membershipGeneration(joinedTimestamp: number | null | undefined): string {
  return joinedTimestamp === null || joinedTimestamp === undefined
    ? 'unknown'
    : String(Math.trunc(joinedTimestamp));
}

export function isAuthoritativeMembershipGeneration(
  generation: string | null | undefined,
): generation is string {
  return Boolean(generation && generation !== 'unknown');
}

export type WelcomePostDispatchMutationStatus = 'mutated' | 'rejected' | 'expired';

/**
 * The shared final fence for every durable Welcome role mutation.
 *
 * The dispatch CAS must already have completed. We then force-load all Discord
 * and policy state, validate the exact mutation predicate, and finally check
 * lock ownership, exact claim revision, lock ownership again, abort and
 * dispatch age in that order immediately before the REST call. Fence failures
 * are deliberately allowed to escape; the durable claim is the retry mechanism.
 */
export async function runWelcomePostDispatchRoleMutation<TIntent, TState>(input: {
  intent: TIntent;
  dispatchedAt: number | null;
  maxDispatchAgeMs: number;
  signal?: AbortSignal;
  loadAuthoritativeState(intent: TIntent): Promise<TState>;
  mutationAllowed(state: TState, intent: TIntent): boolean;
  assertLockOwned(): Promise<void>;
  assertIntentCurrent(intent: TIntent): Promise<void>;
  mutate(state: TState, intent: TIntent): Promise<void>;
  now?: () => number;
}): Promise<WelcomePostDispatchMutationStatus> {
  if (input.dispatchedAt === null || !Number.isFinite(input.dispatchedAt)) {
    throw new Error('Welcome role mutation requires a durable dispatch timestamp');
  }
  const now = input.now ?? Date.now;
  const isExpired = () => {
    const current = now();
    return current < input.dispatchedAt! ||
      current >= input.dispatchedAt! + input.maxDispatchAgeMs;
  };
  const state = await input.loadAuthoritativeState(input.intent);
  if (!input.mutationAllowed(state, input.intent)) return 'rejected';
  await input.assertLockOwned();
  await input.assertIntentCurrent(input.intent);
  await input.assertLockOwned();
  throwIfWelcomeAborted(input.signal);
  if (isExpired()) return 'expired';
  await input.mutate(state, input.intent);
  return 'mutated';
}

/** Discord nonces accept at most 25 characters. */
export function welcomeMessageNonce(scope: string, ...parts: readonly string[]): string {
  return createHash('sha256')
    .update([scope, ...parts].join('\u0000'))
    .digest('hex')
    .slice(0, 25);
}

export function throwIfWelcomeAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  const error = new Error('Welcome module operation aborted');
  error.name = 'AbortError';
  throw error;
}

export function shouldReleaseUnsentReminderClaim(
  claimToken: string | null,
  sendBegan: boolean,
): boolean {
  return claimToken !== null && !sendBegan;
}

export function ownsReminderClaim(persistedValue: string | null, token: string): boolean {
  return persistedValue === token;
}

export interface WelcomeRoleGrantProgress {
  preexisting: boolean | null;
  addBegan: boolean;
}

/**
 * The compensation phase must run only after the original role lock callback
 * has returned or thrown, allowing it to acquire an independent fresh lease.
 */
export async function runWelcomeRoleGrantSaga(
  progress: WelcomeRoleGrantProgress,
  grantUnderOriginalLock: () => Promise<boolean>,
  reconcileUnderNewLock: () => Promise<boolean>,
): Promise<boolean> {
  try {
    const granted = await grantUnderOriginalLock();
    if (!progress.addBegan || progress.preexisting) return granted;
    return reconcileUnderNewLock();
  } catch (error) {
    if (!progress.addBegan || progress.preexisting) throw error;
    return reconcileUnderNewLock();
  }
}

/** Resolve only after the post-send authority check has also succeeded. */
export async function runValidatedTicketHandoffAttempt<T>(
  loadFreshContext: () => Promise<T>,
  send: (context: T) => Promise<void>,
): Promise<void> {
  const context = await loadFreshContext();
  await send(context);
  await loadFreshContext();
}
