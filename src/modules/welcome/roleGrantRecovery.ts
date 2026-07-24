import {
  type Client,
  type Guild,
  type GuildMember,
  PermissionsBitField,
  type Role,
} from 'discord.js';
import { getGuildConfigFresh, type GuildConfig } from '../../core/GuildConfig';
import { logger } from '../../core/Logger';
import { type MemberRoleLock, withMemberRoleLock } from '../../core/MemberRoleLock';
import { isGuildAllowed } from '../../core/Whitelist';
import { fetchGuildMemberIfPresent } from '../../utils/helpers';
import { loadUnavailableUserIds } from '../vacation/availability';
import {
  areWelcomeRoleIdsDistinct,
  hasDangerousWelcomeRolePermissions,
  isAuthoritativeMembershipGeneration,
  isAutoRoleRepairCandidate,
  membershipGeneration,
  runWelcomePostDispatchRoleMutation,
  throwIfWelcomeAborted,
} from './policy';
import {
  assertWelcomeRoleGrantIntentCurrent,
  completeWelcomeRoleGrantIntent,
  isWelcomeRoleGrantIntentPastGrace,
  isWelcomeRoleRemovalPastGrace,
  handoffWelcomeRoleGrantIntentGeneration,
  listWelcomeRoleGrantIntentClaims,
  recordWelcomeRoleGrantDispatch,
  recordWelcomeRoleRemovalDispatch,
  replaceWelcomeRoleGrantIntent,
  WELCOME_ROLE_LATE_APPLY_GRACE_MS,
  type WelcomeRoleCompensationReason,
  type WelcomeRoleGrantIntent,
  welcomeRoleGrantIntentKey,
} from './roleGrantIntent';
import { recoverWelcomeAutoRoleRemovalIntents } from './roleRemovalRecovery';
import { readWelcomeAutoRoleRemovalIntent } from './roleRemovalIntent';

const log = logger.child('Welcome:RoleGrantRecovery');
const loggedLegacyUnknownGrantIntents = new Set<string>();

export interface WelcomeRoleGrantRecoveryState {
  authorityAllowed: boolean;
  /** Whether the current authoritative membership wants this exact role. */
  currentGenerationAuthorityAllowed: boolean;
  /** Whether the current membership can receive its configured auto-role. */
  replacementAuthorityAllowed: boolean;
  generationMatches: boolean;
  currentMembershipGeneration: string | null;
  rolePresent: boolean;
  roleRemovable: boolean;
}

export type WelcomeRoleGrantRecoveryStatus =
  | 'granted'
  | 'compensated'
  | 'absent-settled'
  | 'foreign-settled'
  | 'granted-observed'
  | 'generation-retry'
  | 'pending'
  | 'fenced';

export interface WelcomeRoleGrantRecoveryResult {
  status: WelcomeRoleGrantRecoveryStatus;
  roleGranted: boolean;
}

export interface WelcomeRoleGrantRecoveryDependencies<TState extends WelcomeRoleGrantRecoveryState> {
  assertCurrent(intent: WelcomeRoleGrantIntent): Promise<void>;
  loadFreshState(intent: WelcomeRoleGrantIntent): Promise<TState>;
  recordDispatch(intent: WelcomeRoleGrantIntent): Promise<WelcomeRoleGrantIntent>;
  /**
   * Revalidate the exact Discord removal target, persist the removal dispatch,
   * and only then issue DELETE. When DELETE has an ambiguous outcome this must
   * still return the newly persisted intent so its grace window is retained.
   */
  dispatchRemoval(
    intent: WelcomeRoleGrantIntent,
    membershipGeneration: string,
    reason: WelcomeRoleCompensationReason,
  ): Promise<WelcomeRoleGrantIntent>;
  addRole(state: TState, intent: WelcomeRoleGrantIntent): Promise<void>;
  complete(intent: WelcomeRoleGrantIntent): Promise<boolean>;
}

export async function dispatchWelcomeRoleCompensationAfterPreflight<
  TState extends WelcomeRoleGrantRecoveryState,
>(
  current: WelcomeRoleGrantIntent,
  generation: string,
  reason: WelcomeRoleCompensationReason,
  dependencies: {
    loadFreshState(intent: WelcomeRoleGrantIntent): Promise<TState>;
    recordDispatch(
      intent: WelcomeRoleGrantIntent,
      generation: string,
      reason: WelcomeRoleCompensationReason,
    ): Promise<WelcomeRoleGrantIntent>;
    assertLockOwned(): Promise<void>;
    assertCurrent(intent: WelcomeRoleGrantIntent): Promise<void>;
    removeRole(state: TState, intent: WelcomeRoleGrantIntent): Promise<void>;
    signal?: AbortSignal;
    now?: () => number;
  },
): Promise<WelcomeRoleGrantIntent> {
  const fresh = await dependencies.loadFreshState(current);
  if (!fresh.rolePresent || !fresh.roleRemovable || fresh.authorityAllowed ||
      (current.kind === 'auto' && fresh.currentGenerationAuthorityAllowed) ||
      fresh.currentMembershipGeneration !== generation) return current;
  const updated = await dependencies.recordDispatch(current, generation, reason);
  await runWelcomePostDispatchRoleMutation({
    intent: updated,
    dispatchedAt: updated.removalDispatchedAt,
    maxDispatchAgeMs: WELCOME_ROLE_LATE_APPLY_GRACE_MS,
    signal: dependencies.signal,
    loadAuthoritativeState: dependencies.loadFreshState,
    mutationAllowed: (postDispatch) =>
      postDispatch.rolePresent && postDispatch.roleRemovable &&
      !postDispatch.authorityAllowed &&
      !(updated.kind === 'auto' && postDispatch.currentGenerationAuthorityAllowed) &&
      postDispatch.currentMembershipGeneration === generation,
    assertLockOwned: dependencies.assertLockOwned,
    assertIntentCurrent: dependencies.assertCurrent,
    mutate: dependencies.removeRole,
    now: dependencies.now,
  });
  return updated;
}

function sameWelcomeGrantDecisionState(
  left: WelcomeRoleGrantRecoveryState,
  right: WelcomeRoleGrantRecoveryState,
): boolean {
  return left.authorityAllowed === right.authorityAllowed &&
    left.currentGenerationAuthorityAllowed === right.currentGenerationAuthorityAllowed &&
    left.replacementAuthorityAllowed === right.replacementAuthorityAllowed &&
    left.generationMatches === right.generationMatches &&
    left.currentMembershipGeneration === right.currentMembershipGeneration &&
    left.rolePresent === right.rolePresent &&
    left.roleRemovable === right.roleRemovable;
}

/**
 * Durable reconciliation core. Every terminal branch is reached only after a
 * fresh read and token-CAS completion; thrown/transient outcomes retain intent.
 */
export async function reconcileWelcomeRoleGrantIntent<TState extends WelcomeRoleGrantRecoveryState>(
  originalIntent: WelcomeRoleGrantIntent,
  dependencies: WelcomeRoleGrantRecoveryDependencies<TState>,
  now = Date.now(),
): Promise<WelcomeRoleGrantRecoveryResult> {
  let intent = originalIntent;
  await dependencies.assertCurrent(intent);
  let state = await dependencies.loadFreshState(intent);

  const complete = async (
    status: WelcomeRoleGrantRecoveryStatus,
    roleGranted: boolean,
  ): Promise<WelcomeRoleGrantRecoveryResult> => {
    const expectedState = state;
    const terminalState = await dependencies.loadFreshState(intent);
    state = terminalState;
    if (!sameWelcomeGrantDecisionState(expectedState, terminalState)) {
      return { status: 'pending', roleGranted: false };
    }
    await dependencies.assertCurrent(intent);
    const completed = await dependencies.complete(intent);
    return completed
      ? { status, roleGranted }
      : { status: 'fenced', roleGranted: false };
  };

  const beginCompensation = async (
    reason: WelcomeRoleCompensationReason,
  ): Promise<WelcomeRoleGrantRecoveryResult> => {
    const targetGeneration = state.currentMembershipGeneration;
    // Unknown/absent membership or an unmanageable role cannot establish a
    // safe DELETE target. Retain the durable add proof for a later recovery.
    if (!targetGeneration || targetGeneration === 'unknown' || !state.roleRemovable) {
      return { status: 'pending', roleGranted: false };
    }
    await dependencies.assertCurrent(intent);
    intent = await dependencies.dispatchRemoval(intent, targetGeneration, reason);
    await dependencies.loadFreshState(intent);
    return { status: 'pending', roleGranted: false };
  };

  // Legacy rows remain readable for inspection/recovery, but an unknown
  // generation can never identify a safe Discord mutation target or transfer.
  if (!isAuthoritativeMembershipGeneration(intent.membershipGeneration)) {
    if (intent.phase === 'prepared') {
      return complete(
        state.rolePresent ? 'foreign-settled' : 'absent-settled',
        false,
      );
    }
    const pastGrace = intent.phase === 'compensating'
      ? isWelcomeRoleRemovalPastGrace(intent, now)
      : isWelcomeRoleGrantIntentPastGrace(intent, now);
    if (!pastGrace || state.currentMembershipGeneration !== null || state.rolePresent) {
      return { status: 'pending', roleGranted: false };
    }
    return complete('absent-settled', false);
  }

  if (intent.phase === 'prepared') {
    if (!state.generationMatches) {
      if (intent.kind === 'auto' &&
          (intent.policy === 'join' || intent.policy === 'repair')) {
        return { status: 'generation-retry', roleGranted: false };
      }
      return complete(
        state.rolePresent ? 'foreign-settled' : 'absent-settled',
        false,
      );
    }
    // No Discord write is permitted before the persisted dispatch transition.
    // A role that appeared meanwhile is therefore foreign and must be kept.
    if (state.rolePresent) {
      return complete('foreign-settled', state.authorityAllowed);
    }
    if (!state.authorityAllowed) {
      return complete('absent-settled', false);
    }
  }

  if (intent.phase === 'compensating') {
    const compensationTargetsCurrent = Boolean(
      state.currentMembershipGeneration &&
      state.currentMembershipGeneration === intent.compensationMembershipGeneration,
    );
    if (!compensationTargetsCurrent) {
      // Never issue a DELETE prepared for a prior membership against a newer
      // one. Wait out that DELETE's own ambiguity window before transfer/close.
      if (!isWelcomeRoleRemovalPastGrace(intent, now)) {
        return { status: 'pending', roleGranted: false };
      }
      if (intent.kind === 'auto' && state.replacementAuthorityAllowed) {
        return { status: 'generation-retry', roleGranted: false };
      }
      return complete(
        state.rolePresent ? 'foreign-settled' : 'absent-settled',
        false,
      );
    }

    if (!isWelcomeRoleRemovalPastGrace(intent, now)) {
      if (state.generationMatches && !state.authorityAllowed && state.rolePresent) {
        return beginCompensation(intent.compensationReason!);
      }
      return { status: 'pending', roleGranted: false };
    }

    if (!state.generationMatches) {
      if (state.rolePresent) {
        if (intent.kind === 'auto' && state.currentGenerationAuthorityAllowed) {
          return { status: 'generation-retry', roleGranted: false };
        }
        return beginCompensation(intent.kind === 'recruit'
          ? 'rules-generation-mismatch'
          : 'membership-generation-mismatch');
      }
      if (intent.kind === 'auto' && state.replacementAuthorityAllowed) {
        return { status: 'generation-retry', roleGranted: false };
      }
      return complete('absent-settled', false);
    }

    if (!state.authorityAllowed) {
      if (state.rolePresent) return beginCompensation(intent.compensationReason!);
      return complete('compensated', false);
    }
    if (state.rolePresent) return complete('granted', true);
    // Removal grace elapsed and authority returned. It is now safe to issue a
    // fresh add; recordDispatch below clears the compensation tombstone.
  } else if (!state.generationMatches) {
    if (intent.phase === 'dispatched' && state.rolePresent) {
      if (isWelcomeRoleGrantIntentPastGrace(intent, now)) {
        if (intent.kind === 'auto' && state.replacementAuthorityAllowed) {
          return { status: 'generation-retry', roleGranted: false };
        }
        // First observation after the ambiguity window cannot safely be
        // attributed to the old PUT; preserve it as a foreign/manual role.
        return complete('foreign-settled', false);
      }
      if (intent.kind === 'auto' && state.currentGenerationAuthorityAllowed) {
        return { status: 'pending', roleGranted: false };
      }
      // The absent-before-dispatch record is exact old-ADD provenance. Persist
      // a DELETE tombstone for the new generation before any replace/complete.
      return beginCompensation(intent.kind === 'recruit'
        ? 'rules-generation-mismatch'
        : 'membership-generation-mismatch');
    }
    if (intent.phase === 'dispatched' && !isWelcomeRoleGrantIntentPastGrace(intent, now)) {
      return { status: 'pending', roleGranted: false };
    }
    if (intent.kind === 'auto' && state.replacementAuthorityAllowed) {
      return { status: 'generation-retry', roleGranted: false };
    }
    return complete(
      state.rolePresent ? 'foreign-settled' : 'absent-settled',
      false,
    );
  }

  if (state.authorityAllowed && !state.rolePresent) {
    await dependencies.assertCurrent(intent);
    intent = await dependencies.recordDispatch(intent);
    await dependencies.assertCurrent(intent);
    await dependencies.addRole(state, intent);
    state = await dependencies.loadFreshState(intent);
    if (!state.generationMatches) {
      if (state.rolePresent &&
          (intent.kind === 'recruit' || !state.currentGenerationAuthorityAllowed)) {
        return beginCompensation(intent.kind === 'recruit'
          ? 'rules-generation-mismatch'
          : 'membership-generation-mismatch');
      }
      return { status: 'pending', roleGranted: false };
    }
  }

  if (state.authorityAllowed && state.rolePresent) {
    if (intent.phase === 'dispatched' && !isWelcomeRoleGrantIntentPastGrace(intent, now)) {
      return { status: 'granted-observed', roleGranted: true };
    }
    return complete('granted', true);
  }

  if (state.rolePresent) {
    return beginCompensation('authority-revoked');
  }

  if (state.authorityAllowed) {
    // A successful-looking add that is not visible yet remains retryable.
    return { status: 'pending', roleGranted: false };
  }
  if (!isWelcomeRoleGrantIntentPastGrace(intent, now)) {
    // A stale Discord REST request can still materialize. Keep polling the
    // durable intent throughout the grace window instead of forgetting it.
    return { status: 'pending', roleGranted: false };
  }

  return complete('absent-settled', false);
}

export async function reconcileWelcomeRoleGrantWithGenerationRetry<
  TState extends WelcomeRoleGrantRecoveryState,
>(
  intent: WelcomeRoleGrantIntent,
  dependenciesFor: (
    intent: WelcomeRoleGrantIntent,
  ) => WelcomeRoleGrantRecoveryDependencies<TState>,
  replaceGeneration: (
    intent: WelcomeRoleGrantIntent,
  ) => Promise<WelcomeRoleGrantIntent | WelcomeRoleGrantRecoveryResult>,
  now = Date.now(),
): Promise<WelcomeRoleGrantRecoveryResult> {
  const result = await reconcileWelcomeRoleGrantIntent(
    intent,
    dependenciesFor(intent),
    now,
  );
  if (result.status !== 'generation-retry') return result;
  const replacement = await replaceGeneration(intent);
  if ('status' in replacement) return replacement;
  return reconcileWelcomeRoleGrantIntent(
    replacement,
    dependenciesFor(replacement),
    now,
  );
}

interface DiscordWelcomeRoleGrantState extends WelcomeRoleGrantRecoveryState {
  member: GuildMember | null;
  role: Role | null;
  config: GuildConfig;
}

function intentPolicyAllows(
  guild: Guild,
  member: GuildMember,
  config: GuildConfig,
  intent: WelcomeRoleGrantIntent,
): boolean {
  const generation = membershipGeneration(member.joinedTimestamp);
  if (!isAuthoritativeMembershipGeneration(generation) ||
      !isAuthoritativeMembershipGeneration(intent.membershipGeneration) ||
      generation !== intent.membershipGeneration) return false;
  if (intent.policy === 'repair') {
    return isAutoRoleRepairCandidate(
      guild.id,
      [...member.roles.cache.keys()].filter((roleId) => roleId !== intent.roleId),
      intent.roleId,
      config.memberRoleId,
    );
  }
  if (config.memberRoleId && member.roles.cache.has(config.memberRoleId)) return false;
  if (intent.policy === 'join' &&
      config.recruitRoleId && member.roles.cache.has(config.recruitRoleId)) return false;
  if (intent.policy === 'removal-recovery' &&
      config.recruitRoleId && member.roles.cache.has(config.recruitRoleId)) return false;
  return true;
}

async function loadDiscordWelcomeRoleGrantState(
  guild: Guild,
  intent: WelcomeRoleGrantIntent,
  lock: MemberRoleLock,
  signal?: AbortSignal,
): Promise<DiscordWelcomeRoleGrantState> {
  throwIfWelcomeAborted(signal);
  await lock.assertOwned();
  await assertWelcomeRoleGrantIntentCurrent(intent);
  const config = await getGuildConfigFresh(guild.id);
  const unavailable = (await loadUnavailableUserIds(guild.id, [intent.userId])).has(intent.userId);
  await guild.roles.fetch(undefined, { force: true });
  const [member, botMember] = await Promise.all([
    fetchGuildMemberIfPresent(guild, intent.userId),
    guild.members.fetch({ user: guild.client.user.id, force: true }),
  ]);
  throwIfWelcomeAborted(signal);
  await lock.assertOwned();
  await assertWelcomeRoleGrantIntentCurrent(intent);

  const role = guild.roles.cache.get(intent.roleId) ?? null;
  const currentMembershipGeneration = member
    ? membershipGeneration(member.joinedTimestamp)
    : null;
  const generationMatches = Boolean(
    member && isAuthoritativeMembershipGeneration(currentMembershipGeneration) &&
    currentMembershipGeneration === intent.membershipGeneration,
  );
  const expectedRoleId = intent.kind === 'auto' ? config.autoRoleId : config.recruitRoleId;
  const canManageRole = Boolean(
    role?.editable && botMember.permissions.has(PermissionsBitField.Flags.ManageRoles),
  );
  const authorityAllowed = Boolean(
    member &&
    generationMatches &&
    expectedRoleId === intent.roleId &&
    areWelcomeRoleIdsDistinct([config.autoRoleId, config.memberRoleId, config.recruitRoleId]) &&
    !unavailable &&
    canManageRole &&
    role && !hasDangerousWelcomeRolePermissions(role) &&
    intentPolicyAllows(guild, member, config, intent),
  );
  const currentIntent = member && isAuthoritativeMembershipGeneration(currentMembershipGeneration)
    ? { ...intent, membershipGeneration: currentMembershipGeneration }
    : null;
  const currentGenerationAuthorityAllowed = Boolean(
    member && currentIntent && expectedRoleId === intent.roleId &&
    areWelcomeRoleIdsDistinct([config.autoRoleId, config.memberRoleId, config.recruitRoleId]) &&
    !unavailable && canManageRole && role && !hasDangerousWelcomeRolePermissions(role) &&
    intentPolicyAllows(guild, member, config, currentIntent),
  );
  const replacementRoleId = intent.kind === 'auto' ? config.autoRoleId : null;
  const replacementRole = replacementRoleId
    ? guild.roles.cache.get(replacementRoleId) ?? null
    : null;
  const replacementIntent = member && replacementRoleId &&
    isAuthoritativeMembershipGeneration(currentMembershipGeneration)
    ? {
      ...intent,
      roleId: replacementRoleId,
      membershipGeneration: currentMembershipGeneration,
    }
    : null;
  const replacementAuthorityAllowed = Boolean(
    intent.kind === 'auto' &&
    (intent.policy === 'join' || intent.policy === 'repair') &&
    member && replacementIntent && replacementRole?.editable &&
    botMember.permissions.has(PermissionsBitField.Flags.ManageRoles) &&
    !hasDangerousWelcomeRolePermissions(replacementRole) &&
    areWelcomeRoleIdsDistinct([config.autoRoleId, config.memberRoleId, config.recruitRoleId]) &&
    !unavailable && intentPolicyAllows(guild, member, config, replacementIntent),
  );
  return {
    authorityAllowed,
    currentGenerationAuthorityAllowed,
    replacementAuthorityAllowed,
    generationMatches,
    currentMembershipGeneration,
    rolePresent: member?.roles.cache.has(intent.roleId) ?? false,
    roleRemovable: canManageRole,
    member,
    role,
    config,
  };
}

async function replaceOldMembershipIntent(
  guild: Guild,
  intent: WelcomeRoleGrantIntent,
  lock: MemberRoleLock,
  signal?: AbortSignal,
): Promise<WelcomeRoleGrantIntent | WelcomeRoleGrantRecoveryResult> {
  throwIfWelcomeAborted(signal);
  await lock.assertOwned();
  await assertWelcomeRoleGrantIntentCurrent(intent);
  const config = await getGuildConfigFresh(guild.id);
  const unavailable = (await loadUnavailableUserIds(guild.id, [intent.userId])).has(intent.userId);
  await guild.roles.fetch(undefined, { force: true });
  const [member, botMember] = await Promise.all([
    fetchGuildMemberIfPresent(guild, intent.userId),
    guild.members.fetch({ user: guild.client.user.id, force: true }),
  ]);
  throwIfWelcomeAborted(signal);
  await lock.assertOwned();
  await assertWelcomeRoleGrantIntentCurrent(intent);

  const roleId = config.autoRoleId;
  const role = roleId ? guild.roles.cache.get(roleId) ?? null : null;
  const generation = member ? membershipGeneration(member.joinedTimestamp) : null;
  const candidate = roleId && isAuthoritativeMembershipGeneration(generation) ? {
    ...intent,
    roleId,
    membershipGeneration: generation,
  } : null;
  const eligible = Boolean(
    intent.kind === 'auto' &&
    (intent.policy === 'join' || intent.policy === 'repair') &&
    member &&
    candidate &&
    role?.editable &&
    botMember.permissions.has(PermissionsBitField.Flags.ManageRoles) &&
    !hasDangerousWelcomeRolePermissions(role) &&
    areWelcomeRoleIdsDistinct([config.autoRoleId, config.memberRoleId, config.recruitRoleId]) &&
    !unavailable &&
    intentPolicyAllows(guild, member, config, candidate),
  );

  if (!eligible || !member || !roleId ||
      !isAuthoritativeMembershipGeneration(generation)) {
    // The state used to request a generation retry changed. Keep the old proof;
    // the next reconciliation performs terminal fresh revalidation if needed.
    return { status: 'pending', roleGranted: false };
  }

  const replacementInput = {
    guildId: intent.guildId,
    userId: intent.userId,
    roleId,
    kind: 'auto',
    policy: intent.policy,
    membershipGeneration: generation,
  } as const;
  const replacement = intent.phase === 'dispatched' &&
    intent.roleId === roleId && member.roles.cache.has(roleId)
    ? await handoffWelcomeRoleGrantIntentGeneration(intent, replacementInput)
    : await replaceWelcomeRoleGrantIntent(intent, replacementInput);
  await lock.assertOwned();
  await assertWelcomeRoleGrantIntentCurrent(replacement);
  return replacement;
}

export async function settleWelcomeRoleGrantIntent(
  client: Client,
  intent: WelcomeRoleGrantIntent,
  signal?: AbortSignal,
): Promise<WelcomeRoleGrantRecoveryResult> {
  throwIfWelcomeAborted(signal);
  if (!isGuildAllowed(intent.guildId)) return { status: 'pending', roleGranted: false };
  const guild = client.guilds.cache.get(intent.guildId);
  if (!guild) return { status: 'pending', roleGranted: false };
  if (intent.kind === 'auto' &&
      await readWelcomeAutoRoleRemovalIntent(intent.guildId, intent.userId)) {
    return { status: 'pending', roleGranted: false };
  }

  return withMemberRoleLock(intent.guildId, intent.userId, async (lock) => {
    if (intent.kind === 'auto' &&
        await readWelcomeAutoRoleRemovalIntent(intent.guildId, intent.userId)) {
      return { status: 'pending', roleGranted: false };
    }
    const assertCurrent = async (current: WelcomeRoleGrantIntent) => {
      throwIfWelcomeAborted(signal);
      await lock.assertOwned();
      await assertWelcomeRoleGrantIntentCurrent(current);
      await lock.assertOwned();
    };
    const dependenciesFor = (
      _currentIntent: WelcomeRoleGrantIntent,
    ): WelcomeRoleGrantRecoveryDependencies<DiscordWelcomeRoleGrantState> => ({
        assertCurrent,
        loadFreshState: (current) =>
          loadDiscordWelcomeRoleGrantState(guild, current, lock, signal),
        recordDispatch: async (current) => {
          await assertCurrent(current);
          const updated = await recordWelcomeRoleGrantDispatch(current);
          await assertCurrent(updated);
          return updated;
        },
        dispatchRemoval: async (current, generation, reason) => {
          await assertCurrent(current);
          return dispatchWelcomeRoleCompensationAfterPreflight(current, generation, reason, {
            loadFreshState: (active) =>
              loadDiscordWelcomeRoleGrantState(guild, active, lock, signal),
            recordDispatch: (active, targetGeneration, removalReason) =>
              recordWelcomeRoleRemovalDispatch(active, targetGeneration, removalReason),
            assertLockOwned: () => lock.assertOwned(),
            assertCurrent: (active) => assertWelcomeRoleGrantIntentCurrent(active),
            removeRole: async (fresh, updated) => {
              if (!fresh.member) return;
              await fresh.member.roles.remove(
                updated.roleId,
                'Welcome role durable compensation',
              );
            },
            signal,
          });
        },
        addRole: async (_state, current) => {
          await runWelcomePostDispatchRoleMutation({
            intent: current,
            dispatchedAt: current.dispatchedAt,
            maxDispatchAgeMs: WELCOME_ROLE_LATE_APPLY_GRACE_MS,
            signal,
            loadAuthoritativeState: (active) =>
              loadDiscordWelcomeRoleGrantState(guild, active, lock, signal),
            mutationAllowed: (fresh) =>
              fresh.generationMatches && fresh.authorityAllowed &&
              !fresh.rolePresent && Boolean(fresh.member),
            assertLockOwned: () => lock.assertOwned(),
            assertIntentCurrent: (active) => assertWelcomeRoleGrantIntentCurrent(active),
            mutate: async (fresh, active) => {
              if (!fresh.member) return;
              await fresh.member.roles.add(active.roleId, 'Welcome role durable recovery');
            },
          });
        },
        complete: async (current) => {
          await assertCurrent(current);
          const completed = await completeWelcomeRoleGrantIntent(current);
          await lock.assertOwned();
          return completed;
        },
      });

    return reconcileWelcomeRoleGrantWithGenerationRetry(
      intent,
      dependenciesFor,
      (current) => replaceOldMembershipIntent(guild, current, lock, signal),
    );
  }, signal);
}

export async function recoverWelcomeRoleGrantIntents(
  client: Client,
  signal?: AbortSignal,
): Promise<void> {
  throwIfWelcomeAborted(signal);
  await recoverWelcomeAutoRoleRemovalIntents(client, signal);
  throwIfWelcomeAborted(signal);
  const guildIds = [...client.guilds.cache.keys()].filter(isGuildAllowed);
  const claims = await listWelcomeRoleGrantIntentClaims(guildIds);
  for (const claim of claims) {
    throwIfWelcomeAborted(signal);
    if (!claim.intent ||
        welcomeRoleGrantIntentKey(
          claim.intent.guildId,
          claim.intent.userId,
          claim.intent.kind,
        ) !== claim.key) {
      log.error(`Malformed welcome role grant intent ${claim.key} retained for inspection`);
      continue;
    }
    try {
      if (claim.intent.phase !== 'prepared' &&
          !isAuthoritativeMembershipGeneration(claim.intent.membershipGeneration) &&
          !loggedLegacyUnknownGrantIntents.has(claim.intent.token)) {
        loggedLegacyUnknownGrantIntents.add(claim.intent.token);
        log.warn(
          `Legacy unknown-generation grant ${claim.intent.token} retained for manual review`,
        );
      }
      const result = await settleWelcomeRoleGrantIntent(client, claim.intent, signal);
      if (result.status !== 'pending' && result.status !== 'fenced') {
        log.info(`Recovered welcome role grant ${claim.intent.token}: ${result.status}`);
      }
    } catch (error) {
      if ((error as { name?: string })?.name === 'AbortError') throw error;
      log.warn(`Welcome role grant ${claim.intent.token} retained for retry`, {
        error: String(error),
      });
    }
  }
}
