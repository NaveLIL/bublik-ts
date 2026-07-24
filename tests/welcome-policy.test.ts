import assert from 'node:assert/strict';
import test from 'node:test';
import { PermissionsBitField } from 'discord.js';
import { resolveLegacyWelcomeGuildId } from '../src/core/GuildConfig';
import {
  areWelcomeRoleIdsDistinct,
  hasDangerousWelcomeRolePermissions,
  hasTicketPanelMemberAccess,
  isAutoRoleRepairCandidate,
  isAuthoritativeMembershipGeneration,
  isWelcomeReminderCandidate,
  membershipGeneration,
  needsAutoRoleRemoval,
  ownsReminderClaim,
  runValidatedTicketHandoffAttempt,
  runWelcomePostDispatchRoleMutation,
  runWelcomeRoleGrantSaga,
  welcomeMessageNonce,
  throwIfWelcomeAborted,
  shouldReleaseUnsentReminderClaim,
} from '../src/modules/welcome/policy';
import { shouldRecordWelcomeMemberLeft } from '../src/modules/welcome/membershipStore';

test('welcome role IDs must be distinct across partial configuration updates', () => {
  assert.equal(areWelcomeRoleIdsDistinct(['auto', 'member', 'recruit']), true);
  assert.equal(areWelcomeRoleIdsDistinct(['auto', null, 'auto']), false);
  assert.equal(areWelcomeRoleIdsDistinct([null, undefined, 'member']), true);
});

test('automatic welcome roles cannot carry staff or mass-mention authority', () => {
  for (const permission of [
    PermissionsBitField.Flags.Administrator,
    PermissionsBitField.Flags.ManageRoles,
    PermissionsBitField.Flags.BanMembers,
    PermissionsBitField.Flags.MentionEveryone,
  ]) {
    assert.equal(hasDangerousWelcomeRolePermissions({
      permissions: new PermissionsBitField(permission),
    }), true);
  }
  assert.equal(hasDangerousWelcomeRolePermissions({
    permissions: new PermissionsBitField(PermissionsBitField.Flags.ViewChannel),
  }), false);
});

test('ADIR ticket handoff requires the newcomer to see panel history', () => {
  assert.equal(hasTicketPanelMemberAccess(new PermissionsBitField([
    PermissionsBitField.Flags.ViewChannel,
    PermissionsBitField.Flags.ReadMessageHistory,
  ])), true);
  assert.equal(hasTicketPanelMemberAccess(new PermissionsBitField([
    PermissionsBitField.Flags.ViewChannel,
  ])), false);
  assert.equal(hasTicketPanelMemberAccess(null), false);
});

test('legacy auto-role repair only targets members whose sole role is everyone', () => {
  assert.equal(isAutoRoleRepairCandidate('guild', ['guild'], 'auto', 'member'), true);
  assert.equal(isAutoRoleRepairCandidate('guild', ['guild', 'other'], 'auto', 'member'), false);
  assert.equal(isAutoRoleRepairCandidate('guild', ['guild', 'member'], 'auto', 'member'), false);
  assert.equal(isAutoRoleRepairCandidate('guild', ['guild', 'auto'], 'auto', 'member'), false);
});

test('auto-role removal reconciliation requires both distinct configured roles', () => {
  assert.equal(needsAutoRoleRemoval(['guild', 'auto', 'member'], 'auto', 'member'), true);
  assert.equal(needsAutoRoleRemoval(['guild', 'member'], 'auto', 'member'), false);
  assert.equal(needsAutoRoleRemoval(['guild', 'auto'], 'auto', 'auto'), false);
});

test('reminders include auto-role-only newcomers but exclude progressed users', () => {
  assert.equal(isWelcomeReminderCandidate(
    'guild', ['guild'], 'auto', 'member', 'recruit',
  ), true);
  assert.equal(isWelcomeReminderCandidate(
    'guild', ['guild', 'auto'], 'auto', 'member', 'recruit',
  ), true);
  assert.equal(isWelcomeReminderCandidate(
    'guild', ['guild', 'member'], 'auto', 'member', 'recruit',
  ), false);
  assert.equal(isWelcomeReminderCandidate(
    'guild', ['guild', 'recruit'], 'auto', 'member', 'recruit',
  ), false);
  assert.equal(isWelcomeReminderCandidate(
    'guild', ['guild', 'unrelated'], 'auto', 'member', 'recruit',
  ), false);
});

test('membership generation and Discord nonce are deterministic and bounded', () => {
  assert.equal(membershipGeneration(1234.9), '1234');
  assert.equal(membershipGeneration(null), 'unknown');
  assert.equal(isAuthoritativeMembershipGeneration('1234'), true);
  assert.equal(isAuthoritativeMembershipGeneration('unknown'), false);
  const first = welcomeMessageNonce('join', 'guild', 'user', '1234');
  const repeated = welcomeMessageNonce('join', 'guild', 'user', '1234');
  const nextStay = welcomeMessageNonce('join', 'guild', 'user', '5678');
  const otherScope = welcomeMessageNonce('ticket-other', 'guild', 'user', '1234');
  assert.equal(first, repeated);
  assert.notEqual(first, nextStay);
  assert.notEqual(first, otherScope);
  assert.equal(first.length, 25);
});

test('all four role mutations share the final lock and exact-revision fence', async () => {
  for (const source of [
    'handler-add',
    'recovery-add',
    'grant-compensation-delete',
    'normal-delete',
  ]) {
    for (const lostFence of ['lock', 'revision'] as const) {
      let mutations = 0;
      await assert.rejects(
        runWelcomePostDispatchRoleMutation({
          intent: { source, revision: 2 },
          dispatchedAt: 1_000,
          maxDispatchAgeMs: 10_000,
          loadAuthoritativeState: async () => ({ allowed: true }),
          mutationAllowed: (state) => state.allowed,
          assertLockOwned: async () => {
            if (lostFence === 'lock') throw new Error(`${source}: lease lost`);
          },
          assertIntentCurrent: async () => {
            if (lostFence === 'revision') throw new Error(`${source}: revision advanced`);
          },
          mutate: async () => { mutations++; },
          now: () => 1_001,
        }),
        new RegExp(lostFence === 'lock' ? 'lease lost' : 'revision advanced'),
      );
      assert.equal(mutations, 0, `${source} mutated after ${lostFence} fence loss`);
    }
  }
});

test('the final fence detects lease loss while the exact revision check awaits', async () => {
  let lockChecks = 0;
  let replacementOwnsLease = false;
  let mutations = 0;
  await assert.rejects(
    runWelcomePostDispatchRoleMutation({
      intent: { revision: 2 },
      dispatchedAt: 1_000,
      maxDispatchAgeMs: 10_000,
      loadAuthoritativeState: async () => ({ allowed: true }),
      mutationAllowed: (state) => state.allowed,
      assertLockOwned: async () => {
        lockChecks++;
        if (replacementOwnsLease) throw new Error('replacement owns lease');
      },
      assertIntentCurrent: async () => {
        await Promise.resolve();
        replacementOwnsLease = true;
      },
      mutate: async () => { mutations++; },
      now: () => 1_001,
    }),
    /replacement owns lease/,
  );
  assert.equal(lockChecks, 2);
  assert.equal(mutations, 0);
});

test('post-dispatch authoritative policy, generation and age can all veto REST', async () => {
  for (const reason of ['rejoin', 'config', 'vacation', 'presence'] as const) {
    let mutations = 0;
    const status = await runWelcomePostDispatchRoleMutation({
      intent: { generation: 'old' },
      dispatchedAt: 1_000,
      maxDispatchAgeMs: 10_000,
      loadAuthoritativeState: async () => ({ reason }),
      mutationAllowed: () => false,
      assertLockOwned: async () => undefined,
      assertIntentCurrent: async () => undefined,
      mutate: async () => { mutations++; },
      now: () => 1_001,
    });
    assert.equal(status, 'rejected', reason);
    assert.equal(mutations, 0, reason);
  }

  let currentTime = 1_001;
  let delayedMutations = 0;
  const delayed = await runWelcomePostDispatchRoleMutation({
    intent: { generation: 'known' },
    dispatchedAt: 1_000,
    maxDispatchAgeMs: 10_000,
    loadAuthoritativeState: async () => ({ allowed: true }),
    mutationAllowed: (state) => state.allowed,
    assertLockOwned: async () => undefined,
    assertIntentCurrent: async () => { currentTime = 11_000; },
    mutate: async () => { delayedMutations++; },
    now: () => currentTime,
  });
  assert.equal(delayed, 'expired');
  assert.equal(delayedMutations, 0);

  const future = await runWelcomePostDispatchRoleMutation({
    intent: {},
    dispatchedAt: 2_000,
    maxDispatchAgeMs: 10_000,
    loadAuthoritativeState: async () => true,
    mutationAllowed: Boolean,
    assertLockOwned: async () => undefined,
    assertIntentCurrent: async () => undefined,
    mutate: async () => { delayedMutations++; },
    now: () => 1_999,
  });
  assert.equal(future, 'expired');
  assert.equal(delayedMutations, 0);
});

test('welcome abort fence rejects work after module unload', () => {
  const controller = new AbortController();
  throwIfWelcomeAborted(controller.signal);
  controller.abort();
  assert.throws(() => throwIfWelcomeAborted(controller.signal), { name: 'AbortError' });
});

test('reminder claim is released only before any Discord send can have begun', () => {
  assert.equal(shouldReleaseUnsentReminderClaim(null, false), false);
  assert.equal(shouldReleaseUnsentReminderClaim('claim-a', false), true);
  assert.equal(shouldReleaseUnsentReminderClaim('claim-a', true), false);
  assert.equal(ownsReminderClaim('claim-a', 'claim-a'), true);
  assert.equal(ownsReminderClaim('claim-b', 'claim-a'), false);
  assert.equal(ownsReminderClaim(null, 'claim-a'), false);
});

test('vacation beginning while the original lock waits forces a new-lock compensation phase', async () => {
  const progress = { preexisting: null as boolean | null, addBegan: false };
  let vacationStatus = 'pending';
  let lockGeneration = 0;
  let removedOwnedRole = false;
  const result = await runWelcomeRoleGrantSaga(
    progress,
    async () => {
      lockGeneration++;
      vacationStatus = 'activating';
      progress.preexisting = false;
      progress.addBegan = true;
      return true;
    },
    async () => {
      lockGeneration++;
      removedOwnedRole = vacationStatus === 'activating' &&
        progress.preexisting === false && progress.addBegan;
      return false;
    },
  );
  assert.equal(result, false);
  assert.equal(lockGeneration, 2);
  assert.equal(removedOwnedRole, true);
});

test('lease loss after an in-flight add still reconciles a late success under a new lease', async () => {
  const progress = { preexisting: null as boolean | null, addBegan: false };
  let lockGeneration = 0;
  let rolePresent = false;
  const result = await runWelcomeRoleGrantSaga(
    progress,
    async () => {
      lockGeneration++;
      progress.preexisting = false;
      progress.addBegan = true;
      rolePresent = true;
      const error = new Error('lease lost after REST completed');
      error.name = 'WelcomeRoleFenceLostError';
      throw error;
    },
    async () => {
      lockGeneration++;
      return rolePresent && progress.preexisting === false && progress.addBegan;
    },
  );
  assert.equal(result, true);
  assert.equal(lockGeneration, 2);
});

test('successful ticket send with failed post-validation never reaches terminal state', async () => {
  let validation = 0;
  let sends = 0;
  let terminalized = false;
  await assert.rejects(async () => {
    await runValidatedTicketHandoffAttempt(
      async () => {
        validation++;
        if (validation === 2) throw new Error('member lost panel access');
        return { channelId: 'tickets' };
      },
      async () => { sends++; },
    );
    terminalized = true;
  }, /lost panel access/);
  assert.equal(sends, 1);
  assert.equal(validation, 2);
  assert.equal(terminalized, false);
});

test('newer present membership fences stale and unknown remove writes', () => {
  assert.equal(shouldRecordWelcomeMemberLeft(null, 'old'), true);
  assert.equal(shouldRecordWelcomeMemberLeft({ state: 'present', generation: 'new' }, 'old'), false);
  assert.equal(shouldRecordWelcomeMemberLeft({ state: 'present', generation: 'new' }, 'unknown'), false);
  assert.equal(shouldRecordWelcomeMemberLeft({ state: 'present', generation: 'same' }, 'same'), true);
  assert.equal(shouldRecordWelcomeMemberLeft({ state: 'left', generation: 'same' }, 'same'), false);
});

test('legacy welcome target requires one unambiguous guild unless explicitly set', () => {
  assert.equal(resolveLegacyWelcomeGuildId({
    explicitGuildId: 'explicit',
    devGuildId: 'dev',
    allowedGuildIds: ['one', 'two'],
  }), 'explicit');
  assert.equal(resolveLegacyWelcomeGuildId({
    explicitGuildId: null,
    devGuildId: 'one',
    allowedGuildIds: ['one'],
  }), 'one');
  assert.throws(() => resolveLegacyWelcomeGuildId({
    explicitGuildId: null,
    devGuildId: null,
    allowedGuildIds: [],
  }), /unknown/i);
  assert.throws(() => resolveLegacyWelcomeGuildId({
    explicitGuildId: null,
    devGuildId: 'one',
    allowedGuildIds: ['two'],
  }), /ambiguous/i);
});
