import { type Client, type Guild, type GuildMember, PermissionsBitField, type Role } from 'discord.js';
import { getGuildConfigFresh } from '../../core/GuildConfig';
import { type MemberRoleLock, withMemberRoleLock } from '../../core/MemberRoleLock';
import { isGuildAllowed } from '../../core/Whitelist';
import { fetchGuildMemberIfPresent } from '../../utils/helpers';
import { loadUnavailableUserIds } from '../vacation/availability';
import {
  areWelcomeRoleIdsDistinct,
  hasDangerousWelcomeRolePermissions,
  isAuthoritativeMembershipGeneration,
  membershipGeneration,
  runWelcomePostDispatchRoleMutation,
  throwIfWelcomeAborted,
} from './policy';
import {
  completeWelcomeRoleGrantIntent,
  prepareWelcomeRoleGrantIntent,
  readWelcomeRoleGrantIntent,
  type WelcomeRoleGrantIntent,
  WELCOME_ROLE_LATE_APPLY_GRACE_MS,
} from './roleGrantIntent';
import {
  assertWelcomeAutoRoleRemovalCurrent,
  completeWelcomeAutoRoleRemovalIntent,
  isWelcomeAutoRoleRemovalPastGrace,
  listWelcomeAutoRoleRemovalClaims,
  prepareWelcomeAutoRoleRemovalIntent,
  readWelcomeAutoRoleRemovalIntent,
  recordWelcomeAutoRoleRemovalDispatch,
  recordWelcomeAutoRoleRegrantObserved,
  type WelcomeAutoRoleRemovalIntent,
  welcomeAutoRoleRemovalIntentKey,
} from './roleRemovalIntent';
import { logger } from '../../core/Logger';

const log = logger.child('Welcome:AutoRoleRemovalRecovery');

export interface WelcomeAutoRoleRemovalState {
  authorityAllowed: boolean;
  /** The current policy would safely authorize restoring this exact auto-role. */
  regrantAuthorityAllowed: boolean;
  generationMatches: boolean;
  currentMembershipGeneration: string | null;
  rolePresent: boolean;
  roleRemovable: boolean;
}

export type WelcomeAutoRoleRemovalStatus =
  | 'pending'
  | 'removed'
  | 'preserved'
  | 'absent-settled'
  | 'regrant-pending'
  | 'fenced';

export interface WelcomeAutoRoleRemovalResult {
  status: WelcomeAutoRoleRemovalStatus;
  roleAbsent: boolean;
}

export interface WelcomeAutoRoleRemovalDependencies<TState extends WelcomeAutoRoleRemovalState> {
  assertCurrent(intent: WelcomeAutoRoleRemovalIntent): Promise<void>;
  loadFreshState(intent: WelcomeAutoRoleRemovalIntent): Promise<TState>;
  /** Preflight, exact dispatch CAS, then the actual Discord DELETE. */
  dispatchRemoval(intent: WelcomeAutoRoleRemovalIntent): Promise<WelcomeAutoRoleRemovalIntent>;
  recordRegrantObserved(
    intent: WelcomeAutoRoleRemovalIntent,
    membershipGeneration: string,
  ): Promise<WelcomeAutoRoleRemovalIntent>;
  /** Atomically hand recovery to a durable ADD intent and retire this claim. */
  handoffRegrant(
    intent: WelcomeAutoRoleRemovalIntent,
    membershipGeneration: string,
  ): Promise<boolean>;
  complete(intent: WelcomeAutoRoleRemovalIntent): Promise<boolean>;
}

export async function dispatchWelcomeAutoRoleRemovalAfterPreflight<
  TState extends WelcomeAutoRoleRemovalState,
>(
  current: WelcomeAutoRoleRemovalIntent,
  dependencies: {
    loadFreshState(intent: WelcomeAutoRoleRemovalIntent): Promise<TState>;
    recordDispatch(intent: WelcomeAutoRoleRemovalIntent): Promise<WelcomeAutoRoleRemovalIntent>;
    assertLockOwned(): Promise<void>;
    assertCurrent(intent: WelcomeAutoRoleRemovalIntent): Promise<void>;
    removeRole(state: TState, intent: WelcomeAutoRoleRemovalIntent): Promise<void>;
    signal?: AbortSignal;
    now?: () => number;
  },
): Promise<WelcomeAutoRoleRemovalIntent> {
  const fresh = await dependencies.loadFreshState(current);
  if (!fresh.generationMatches || !fresh.authorityAllowed ||
      !fresh.rolePresent || !fresh.roleRemovable) return current;
  const updated = await dependencies.recordDispatch(current);
  await runWelcomePostDispatchRoleMutation({
    intent: updated,
    dispatchedAt: updated.removalDispatchedAt,
    maxDispatchAgeMs: WELCOME_ROLE_LATE_APPLY_GRACE_MS,
    signal: dependencies.signal,
    loadAuthoritativeState: dependencies.loadFreshState,
    mutationAllowed: (postDispatch) =>
      postDispatch.generationMatches && postDispatch.authorityAllowed &&
      postDispatch.rolePresent && postDispatch.roleRemovable,
    assertLockOwned: dependencies.assertLockOwned,
    assertIntentCurrent: dependencies.assertCurrent,
    mutate: dependencies.removeRole,
    now: dependencies.now,
  });
  return updated;
}

function sameWelcomeRemovalDecisionState(
  left: WelcomeAutoRoleRemovalState,
  right: WelcomeAutoRoleRemovalState,
): boolean {
  return left.authorityAllowed === right.authorityAllowed &&
    left.regrantAuthorityAllowed === right.regrantAuthorityAllowed &&
    left.generationMatches === right.generationMatches &&
    left.currentMembershipGeneration === right.currentMembershipGeneration &&
    left.rolePresent === right.rolePresent &&
    left.roleRemovable === right.roleRemovable;
}

function matchesWelcomeAutoRoleRegrantHandoff(
  grant: WelcomeRoleGrantIntent,
  removal: WelcomeAutoRoleRemovalIntent,
  membershipGeneration: string,
): boolean {
  return grant.phase === 'prepared' && grant.policy === 'removal-recovery' &&
    grant.kind === 'auto' && grant.guildId === removal.guildId &&
    grant.userId === removal.userId && grant.roleId === removal.roleId &&
    grant.membershipGeneration === membershipGeneration;
}

function matchesPreparedGrantRemovalTarget(
  grant: WelcomeRoleGrantIntent,
  removal: Pick<
    WelcomeAutoRoleRemovalIntent,
    'guildId' | 'userId' | 'roleId' | 'membershipGeneration'
  >,
): boolean {
  return grant.phase === 'prepared' && grant.kind === 'auto' &&
    grant.guildId === removal.guildId && grant.userId === removal.userId &&
    grant.roleId === removal.roleId &&
    grant.membershipGeneration === removal.membershipGeneration;
}

export async function commitWelcomeAutoRoleRegrantHandoff(
  current: WelcomeAutoRoleRemovalIntent,
  membershipGeneration: string,
  dependencies: {
    readGrant(): Promise<WelcomeRoleGrantIntent | null>;
    completePreparedGrant(grant: WelcomeRoleGrantIntent): Promise<void>;
    prepareGrant(): Promise<WelcomeRoleGrantIntent>;
    assertRemovalCurrent(intent: WelcomeAutoRoleRemovalIntent): Promise<void>;
    completeRemoval(intent: WelcomeAutoRoleRemovalIntent): Promise<boolean>;
  },
): Promise<boolean> {
  let activeGrant = await dependencies.readGrant();
  if (activeGrant && !matchesWelcomeAutoRoleRegrantHandoff(
    activeGrant,
    current,
    membershipGeneration,
  )) {
    if (activeGrant.phase !== 'prepared') return false;
    await dependencies.completePreparedGrant(activeGrant);
    activeGrant = null;
  }
  if (!activeGrant) {
    activeGrant = await dependencies.prepareGrant();
    if (!matchesWelcomeAutoRoleRegrantHandoff(
      activeGrant,
      current,
      membershipGeneration,
    )) return false;
  }
  await dependencies.assertRemovalCurrent(current);
  return dependencies.completeRemoval(current);
}

export async function reconcileWelcomeAutoRoleRemovalIntent<
  TState extends WelcomeAutoRoleRemovalState,
>(
  originalIntent: WelcomeAutoRoleRemovalIntent,
  dependencies: WelcomeAutoRoleRemovalDependencies<TState>,
  now = Date.now(),
): Promise<WelcomeAutoRoleRemovalResult> {
  let intent = originalIntent;
  await dependencies.assertCurrent(intent);
  let state = await dependencies.loadFreshState(intent);

  const complete = async (
    status: Exclude<WelcomeAutoRoleRemovalStatus, 'pending' | 'fenced'>,
    roleAbsent: boolean,
  ): Promise<WelcomeAutoRoleRemovalResult> => {
    const expectedState = state;
    const terminalState = await dependencies.loadFreshState(intent);
    state = terminalState;
    if (!sameWelcomeRemovalDecisionState(expectedState, terminalState)) {
      return { status: 'pending', roleAbsent: !terminalState.rolePresent };
    }
    await dependencies.assertCurrent(intent);
    return await dependencies.complete(intent)
      ? { status, roleAbsent }
      : { status: 'fenced', roleAbsent: false };
  };

  const removalPastGrace = isWelcomeAutoRoleRemovalPastGrace(intent, now);
  if (intent.phase === 'dispatched' && !removalPastGrace &&
      state.regrantAuthorityAllowed && state.rolePresent &&
      isAuthoritativeMembershipGeneration(state.currentMembershipGeneration) &&
      intent.regrant?.membershipGeneration !== state.currentMembershipGeneration) {
    await dependencies.assertCurrent(intent);
    intent = await dependencies.recordRegrantObserved(
      intent,
      state.currentMembershipGeneration,
    );
  }

  if (!state.generationMatches) {
    if (intent.phase === 'dispatched' && !removalPastGrace) {
      return { status: 'pending', roleAbsent: false };
    }
    if (state.currentMembershipGeneration === 'unknown') {
      return { status: 'pending', roleAbsent: !state.rolePresent };
    }
    if (!state.rolePresent && state.regrantAuthorityAllowed &&
        isAuthoritativeMembershipGeneration(state.currentMembershipGeneration)) {
      await dependencies.assertCurrent(intent);
      return await dependencies.handoffRegrant(intent, state.currentMembershipGeneration)
        ? { status: 'regrant-pending', roleAbsent: true }
        : { status: 'pending', roleAbsent: true };
    }
    return complete(state.rolePresent ? 'preserved' : 'absent-settled', !state.rolePresent);
  }

  // Policy authority, not ownership of the role, is the sole permission to
  // delete. If add authority returns while an old DELETE remains ambiguous,
  // remember that the role is now desired before waiting out the grace. That
  // proof lets recovery restore it if the late DELETE wins afterwards.
  if (!state.authorityAllowed) {
    if (intent.phase === 'dispatched' && !removalPastGrace) {
      return { status: 'pending', roleAbsent: false };
    }
    if (!state.rolePresent && state.regrantAuthorityAllowed &&
        isAuthoritativeMembershipGeneration(state.currentMembershipGeneration) &&
        intent.regrant?.membershipGeneration === state.currentMembershipGeneration) {
      await dependencies.assertCurrent(intent);
      return await dependencies.handoffRegrant(intent, state.currentMembershipGeneration)
        ? { status: 'regrant-pending', roleAbsent: true }
        : { status: 'pending', roleAbsent: true };
    }
    return complete(state.rolePresent ? 'preserved' : 'absent-settled', !state.rolePresent);
  }

  if (!state.rolePresent) {
    if (intent.phase === 'dispatched' && !isWelcomeAutoRoleRemovalPastGrace(intent, now)) {
      return { status: 'pending', roleAbsent: true };
    }
    return complete('removed', true);
  }
  if (!state.roleRemovable) return { status: 'pending', roleAbsent: false };

  intent = await dependencies.dispatchRemoval(intent);
  state = await dependencies.loadFreshState(intent);
  return { status: 'pending', roleAbsent: !state.rolePresent };
}

interface DiscordAutoRoleRemovalState extends WelcomeAutoRoleRemovalState {
  member: GuildMember | null;
  role: Role | null;
}

async function loadDiscordAutoRoleRemovalState(
  guild: Guild,
  intent: WelcomeAutoRoleRemovalIntent,
  lock: MemberRoleLock,
  signal?: AbortSignal,
): Promise<DiscordAutoRoleRemovalState> {
  throwIfWelcomeAborted(signal);
  await lock.assertOwned();
  await assertWelcomeAutoRoleRemovalCurrent(intent);
  const config = await getGuildConfigFresh(guild.id);
  const unavailable = (await loadUnavailableUserIds(guild.id, [intent.userId])).has(intent.userId);
  await guild.roles.fetch(undefined, { force: true });
  const [member, botMember] = await Promise.all([
    fetchGuildMemberIfPresent(guild, intent.userId),
    guild.members.fetch({ user: guild.client.user.id, force: true }),
  ]);
  throwIfWelcomeAborted(signal);
  await lock.assertOwned();
  await assertWelcomeAutoRoleRemovalCurrent(intent);

  const role = guild.roles.cache.get(intent.roleId) ?? null;
  const currentMembershipGeneration = member
    ? membershipGeneration(member.joinedTimestamp)
    : null;
  const generationMatches = Boolean(
    member && isAuthoritativeMembershipGeneration(currentMembershipGeneration) &&
    currentMembershipGeneration === intent.membershipGeneration,
  );
  const rolePresent = member?.roles.cache.has(intent.roleId) ?? false;
  const roleRemovable = Boolean(
    role?.editable && botMember.permissions.has(PermissionsBitField.Flags.ManageRoles),
  );
  const authorityAllowed = Boolean(
    member && generationMatches && config.autoRoleId === intent.roleId && config.memberRoleId &&
    areWelcomeRoleIdsDistinct([config.autoRoleId, config.memberRoleId, config.recruitRoleId]) &&
    !unavailable && roleRemovable && member.roles.cache.has(config.memberRoleId),
  );
  const regrantAuthorityAllowed = Boolean(
    member && isAuthoritativeMembershipGeneration(currentMembershipGeneration) &&
    config.autoRoleId === intent.roleId &&
    areWelcomeRoleIdsDistinct([config.autoRoleId, config.memberRoleId, config.recruitRoleId]) &&
    !unavailable && roleRemovable && role && !hasDangerousWelcomeRolePermissions(role) &&
    (!config.memberRoleId || !member.roles.cache.has(config.memberRoleId)) &&
    (!config.recruitRoleId || !member.roles.cache.has(config.recruitRoleId)),
  );
  return {
    authorityAllowed,
    regrantAuthorityAllowed,
    generationMatches,
    currentMembershipGeneration,
    rolePresent,
    roleRemovable,
    member,
    role,
  };
}

function dependenciesForDiscordRemoval(
  guild: Guild,
  lock: MemberRoleLock,
  signal: AbortSignal | undefined,
  reason: string,
): WelcomeAutoRoleRemovalDependencies<DiscordAutoRoleRemovalState> {
  const assertCurrent = async (current: WelcomeAutoRoleRemovalIntent): Promise<void> => {
    throwIfWelcomeAborted(signal);
    await lock.assertOwned();
    await assertWelcomeAutoRoleRemovalCurrent(current);
    await lock.assertOwned();
  };
  return {
    assertCurrent,
    loadFreshState: (current) => loadDiscordAutoRoleRemovalState(guild, current, lock, signal),
    dispatchRemoval: async (current) => {
      // A live add saga owns its own compensation protocol. Checking while the
      // shared member lock is held makes this stable for the following DELETE.
      const activeGrant = await readWelcomeRoleGrantIntent(current.guildId, current.userId, 'auto');
      if (activeGrant) {
        if (!matchesPreparedGrantRemovalTarget(activeGrant, current)) return current;
        // No Discord ADD can belong to a prepared-only row, so retiring it does
        // not claim or delete the role. Re-read the full removal predicate after
        // observing the grant and immediately before its exact claim CAS.
        const terminal = await loadDiscordAutoRoleRemovalState(guild, current, lock, signal);
        if (!terminal.generationMatches || !terminal.authorityAllowed ||
            !terminal.rolePresent || !terminal.roleRemovable) return current;
        await assertWelcomeAutoRoleRemovalCurrent(current);
        await completeWelcomeRoleGrantIntent(activeGrant);
        await lock.assertOwned();
      }
      return dispatchWelcomeAutoRoleRemovalAfterPreflight(current, {
        loadFreshState: (active) =>
          loadDiscordAutoRoleRemovalState(guild, active, lock, signal),
        recordDispatch: (active) => recordWelcomeAutoRoleRemovalDispatch(active),
        assertLockOwned: () => lock.assertOwned(),
        assertCurrent: (active) => assertWelcomeAutoRoleRemovalCurrent(active),
        removeRole: async (fresh, updated) => {
          if (!fresh.member) return;
          await fresh.member.roles.remove(updated.roleId, reason);
        },
        signal,
      });
    },
    recordRegrantObserved: async (current, membershipGeneration) => {
      await assertCurrent(current);
      const updated = await recordWelcomeAutoRoleRegrantObserved(
        current,
        membershipGeneration,
      );
      await assertCurrent(updated);
      return updated;
    },
    handoffRegrant: async (current, membershipGeneration) => {
      await assertCurrent(current);
      const fresh = await loadDiscordAutoRoleRemovalState(guild, current, lock, signal);
      if (fresh.rolePresent || !fresh.regrantAuthorityAllowed ||
          fresh.currentMembershipGeneration !== membershipGeneration) return false;
      return commitWelcomeAutoRoleRegrantHandoff(current, membershipGeneration, {
        readGrant: () => readWelcomeRoleGrantIntent(
          current.guildId,
          current.userId,
          'auto',
        ),
        completePreparedGrant: async (grant) => {
          const terminal = await loadDiscordAutoRoleRemovalState(guild, current, lock, signal);
          if (terminal.rolePresent || !terminal.regrantAuthorityAllowed ||
              terminal.currentMembershipGeneration !== membershipGeneration) {
            throw new Error('Welcome auto-role regrant handoff authority changed');
          }
          await completeWelcomeRoleGrantIntent(grant);
          await lock.assertOwned();
        },
        prepareGrant: async () => {
          const prepared = await prepareWelcomeRoleGrantIntent({
            guildId: current.guildId,
            userId: current.userId,
            roleId: current.roleId,
            kind: 'auto',
            policy: 'removal-recovery',
            membershipGeneration,
          });
          await lock.assertOwned();
          return prepared.intent;
        },
        assertRemovalCurrent: assertCurrent,
        completeRemoval: async (active) => {
          const terminal = await loadDiscordAutoRoleRemovalState(guild, active, lock, signal);
          if (terminal.rolePresent || !terminal.regrantAuthorityAllowed ||
              terminal.currentMembershipGeneration !== membershipGeneration) return false;
          await assertCurrent(active);
          const completed = await completeWelcomeAutoRoleRemovalIntent(active);
          await lock.assertOwned();
          return completed;
        },
      });
    },
    complete: async (current) => {
      await assertCurrent(current);
      const completed = await completeWelcomeAutoRoleRemovalIntent(current);
      await lock.assertOwned();
      return completed;
    },
  };
}

export async function settleWelcomeAutoRoleRemovalIntent(
  client: Client,
  intent: WelcomeAutoRoleRemovalIntent,
  signal?: AbortSignal,
  reason = 'Welcome auto-role durable removal recovery',
): Promise<WelcomeAutoRoleRemovalResult> {
  throwIfWelcomeAborted(signal);
  if (!isGuildAllowed(intent.guildId)) return { status: 'pending', roleAbsent: false };
  const guild = client.guilds.cache.get(intent.guildId);
  if (!guild) return { status: 'pending', roleAbsent: false };
  return withMemberRoleLock(intent.guildId, intent.userId, (lock) =>
    reconcileWelcomeAutoRoleRemovalIntent(
      intent,
      dependenciesForDiscordRemoval(guild, lock, signal, reason),
    ), signal);
}

/** Called while the shared member-role lock is already held. */
export async function prepareAndDispatchWelcomeAutoRoleRemoval(
  member: GuildMember,
  roleId: string,
  reason: string,
  lock: MemberRoleLock,
  signal?: AbortSignal,
): Promise<WelcomeAutoRoleRemovalResult> {
  throwIfWelcomeAborted(signal);
  await lock.assertOwned();
  const activeGrant = await readWelcomeRoleGrantIntent(member.guild.id, member.id, 'auto');
  if (activeGrant && activeGrant.phase !== 'prepared') {
    return { status: 'pending', roleAbsent: false };
  }

  let intent = await readWelcomeAutoRoleRemovalIntent(member.guild.id, member.id);
  if (!intent) {
    const generation = membershipGeneration(member.joinedTimestamp);
    if (generation === 'unknown') return { status: 'preserved', roleAbsent: false };
    // Validate policy authority before claiming a role that might be foreign.
    // The real persisted UUID is created only after this fail-closed preflight.
    const config = await getGuildConfigFresh(member.guild.id);
    const current = await fetchGuildMemberIfPresent(member.guild, member.id);
    const unavailable = (await loadUnavailableUserIds(member.guild.id, [member.id])).has(member.id);
    const role = await member.guild.roles.fetch(roleId, { force: true }).catch(() => null);
    const botMember = await member.guild.members.fetch({ user: member.client.user.id, force: true });
    throwIfWelcomeAborted(signal);
    await lock.assertOwned();
    if (!current || membershipGeneration(current.joinedTimestamp) !== generation ||
        config.autoRoleId !== roleId || !config.memberRoleId ||
        !areWelcomeRoleIdsDistinct([config.autoRoleId, config.memberRoleId, config.recruitRoleId]) ||
        unavailable || !current.roles.cache.has(roleId) ||
        !current.roles.cache.has(config.memberRoleId) || !role?.editable ||
        !botMember.permissions.has(PermissionsBitField.Flags.ManageRoles)) {
      return { status: 'preserved', roleAbsent: !current?.roles.cache.has(roleId) };
    }
    if (activeGrant) {
      const removalTarget = {
        guildId: member.guild.id,
        userId: member.id,
        roleId,
        membershipGeneration: generation,
      };
      if (!matchesPreparedGrantRemovalTarget(activeGrant, removalTarget)) {
        return { status: 'pending', roleAbsent: false };
      }
      // The forced member/config/vacation/role preflight above is the terminal
      // predicate for retiring this never-dispatched ADD claim. Its exact CAS is
      // deliberately adjacent so a stale claim cannot be mistaken for this one.
      await completeWelcomeRoleGrantIntent(activeGrant);
      await lock.assertOwned();
    }
    const prepared = await prepareWelcomeAutoRoleRemovalIntent({
      guildId: member.guild.id,
      userId: member.id,
      roleId,
      membershipGeneration: generation,
    });
    intent = prepared.intent;
  }

  return reconcileWelcomeAutoRoleRemovalIntent(
    intent,
    dependenciesForDiscordRemoval(member.guild, lock, signal, reason),
  );
}

export async function recoverWelcomeAutoRoleRemovalIntents(
  client: Client,
  signal?: AbortSignal,
): Promise<void> {
  throwIfWelcomeAborted(signal);
  const guildIds = [...client.guilds.cache.keys()].filter(isGuildAllowed);
  const claims = await listWelcomeAutoRoleRemovalClaims(guildIds);
  for (const claim of claims) {
    throwIfWelcomeAborted(signal);
    if (!claim.intent ||
        welcomeAutoRoleRemovalIntentKey(claim.intent.guildId, claim.intent.userId) !== claim.key) {
      log.error(`Malformed welcome auto-role removal ${claim.key} retained for inspection`);
      continue;
    }
    try {
      const result = await settleWelcomeAutoRoleRemovalIntent(client, claim.intent, signal);
      if (result.status !== 'pending' && result.status !== 'fenced') {
        log.info(`Recovered welcome auto-role removal ${claim.intent.token}: ${result.status}`);
      }
    } catch (error) {
      if ((error as { name?: string })?.name === 'AbortError') throw error;
      log.warn(`Welcome auto-role removal ${claim.intent.token} retained for retry`, {
        error: String(error),
      });
    }
  }
}
