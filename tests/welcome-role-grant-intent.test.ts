import assert from 'node:assert/strict';
import test from 'node:test';
import { acquireReminderClaimToken } from '../src/modules/welcome/reminderClaim';
import {
  completeWelcomeRoleGrantIntent,
  isWelcomeRoleRemovalPastGrace,
  parseWelcomeRoleGrantIntent,
  prepareWelcomeRoleGrantIntent,
  recordWelcomeRoleGrantDispatch,
  recordWelcomeRoleRemovalDispatch,
  replaceWelcomeRoleGrantIntent,
  WELCOME_ROLE_GRANT_SCOPE,
  WELCOME_ROLE_LATE_APPLY_GRACE_MS,
  welcomeRoleGrantIntentKey,
  type WelcomeRoleGrantIntent,
} from '../src/modules/welcome/roleGrantIntent';
import {
  dispatchWelcomeRoleCompensationAfterPreflight,
  reconcileWelcomeRoleGrantIntent,
  reconcileWelcomeRoleGrantWithGenerationRetry,
  settleWelcomeRoleGrantIntent,
  type WelcomeRoleGrantRecoveryState,
} from '../src/modules/welcome/roleGrantRecovery';

function intent(overrides: Partial<WelcomeRoleGrantIntent> = {}): WelcomeRoleGrantIntent {
  return {
    version: 2,
    token: 'intent-token',
    revision: 0,
    guildId: 'guild',
    userId: 'user',
    roleId: 'role',
    kind: 'auto',
    policy: 'join',
    membershipGeneration: '1234',
    preexisting: false,
    phase: 'prepared',
    preparedAt: 1_000,
    dispatchedAt: null,
    updatedAt: 1_000,
    dispatchAttempts: 0,
    removalDispatchedAt: null,
    removalAttempts: 0,
    compensationMembershipGeneration: null,
    compensationReason: null,
    ...overrides,
  };
}

type RecoveryHarnessState = Omit<
  WelcomeRoleGrantRecoveryState,
  'currentMembershipGeneration' | 'currentGenerationAuthorityAllowed' |
  'replacementAuthorityAllowed'
> & Partial<Pick<
  WelcomeRoleGrantRecoveryState,
  'currentMembershipGeneration' | 'currentGenerationAuthorityAllowed' |
  'replacementAuthorityAllowed'
>>;

function recoveryHarness(initialIntent: WelcomeRoleGrantIntent, initialState: RecoveryHarnessState) {
  let persistedIntent = initialIntent;
  let state: WelcomeRoleGrantRecoveryState = {
    currentGenerationAuthorityAllowed: initialState.generationMatches
      ? initialState.authorityAllowed
      : false,
    replacementAuthorityAllowed: initialIntent.kind === 'auto' &&
      (initialIntent.policy === 'join' || initialIntent.policy === 'repair') &&
      !initialState.generationMatches,
    currentMembershipGeneration: initialState.generationMatches
      ? initialIntent.membershipGeneration
      : 'next-generation',
    ...initialState,
  };
  let transitionNow = 1_100;
  let completed = false;
  const events: string[] = [];
  const recordRemovalDispatch = async (
    current: WelcomeRoleGrantIntent,
    membershipGeneration: string,
    reason: WelcomeRoleGrantIntent['compensationReason'] & string,
  ): Promise<WelcomeRoleGrantIntent> => {
    events.push('remove-dispatch');
    persistedIntent = {
      ...current,
      revision: current.revision + 1,
      phase: 'compensating',
      removalDispatchedAt: transitionNow,
      removalAttempts: current.removalAttempts + 1,
      compensationMembershipGeneration: membershipGeneration,
      compensationReason: reason,
      updatedAt: transitionNow,
    };
    return persistedIntent;
  };
  const removeRole = async (): Promise<void> => {
    events.push('remove');
    state.rolePresent = false;
  };
  return {
    events,
    get intent() { return persistedIntent; },
    get state() { return state; },
    setState(next: Partial<WelcomeRoleGrantRecoveryState>) { state = { ...state, ...next }; },
    setTransitionNow(next: number) { transitionNow = next; },
    recordRemovalDispatch,
    removeRole,
    get completed() { return completed; },
    dependencies: {
      async assertCurrent() { events.push('assert'); },
      async loadFreshState() { events.push('load'); return { ...state }; },
      async recordDispatch(current: WelcomeRoleGrantIntent) {
        events.push('dispatch');
        persistedIntent = {
          ...current,
          revision: current.revision + 1,
          phase: 'dispatched',
          dispatchedAt: transitionNow,
          updatedAt: transitionNow,
          dispatchAttempts: current.dispatchAttempts + 1,
          removalDispatchedAt: null,
          compensationMembershipGeneration: null,
          compensationReason: null,
        };
        return persistedIntent;
      },
      async dispatchRemoval(
        current: WelcomeRoleGrantIntent,
        membershipGeneration: string,
        reason: WelcomeRoleGrantIntent['compensationReason'] & string,
      ) {
        events.push('remove-preflight');
        const updated = await recordRemovalDispatch(current, membershipGeneration, reason);
        await removeRole();
        return updated;
      },
      async addRole() { events.push('add'); state.rolePresent = true; },
      async complete() { events.push('complete'); completed = true; return true; },
    },
  };
}

test('restart recovers a crash after prepare by converging and verifying the grant', async () => {
  const prepared = intent();
  const harness = recoveryHarness(prepared, {
    authorityAllowed: true,
    generationMatches: true,
    rolePresent: false,
    roleRemovable: true,
  });
  const result = await reconcileWelcomeRoleGrantIntent(prepared, harness.dependencies, 1_200);
  assert.deepEqual(result, { status: 'granted-observed', roleGranted: true });
  assert.equal(harness.completed, false);
  assert.equal(harness.intent.phase, 'dispatched');
  assert.deepEqual(harness.events.filter((event) =>
    ['dispatch', 'add'].includes(event)), ['dispatch', 'add']);
});

test('restart after Discord applied the role settles without issuing a second add', async () => {
  const dispatched = intent({
    phase: 'dispatched',
    revision: 1,
    dispatchedAt: 1_100,
    updatedAt: 1_100,
    dispatchAttempts: 1,
  });
  const harness = recoveryHarness(dispatched, {
    authorityAllowed: true,
    generationMatches: true,
    rolePresent: true,
    roleRemovable: true,
  });
  const result = await reconcileWelcomeRoleGrantIntent(dispatched, harness.dependencies, 1_200);
  assert.equal(result.status, 'granted-observed');
  assert.equal(harness.events.includes('add'), false);
  assert.equal(harness.completed, false);
  const settled = await reconcileWelcomeRoleGrantIntent(
    dispatched,
    harness.dependencies,
    1_100 + WELCOME_ROLE_LATE_APPLY_GRACE_MS,
  );
  assert.equal(settled.status, 'granted');
  assert.equal(harness.completed, true);
});

test('grant terminal completion reloads policy and retains provenance when it flips', async () => {
  const dispatched = intent({
    revision: 1,
    phase: 'dispatched',
    dispatchedAt: 1_000,
    updatedAt: 1_000,
    dispatchAttempts: 1,
  });
  const harness = recoveryHarness(dispatched, {
    authorityAllowed: false,
    generationMatches: true,
    rolePresent: false,
    roleRemovable: true,
  });
  let loads = 0;
  const dependencies = {
    ...harness.dependencies,
    async loadFreshState() {
      loads++;
      if (loads === 2) harness.setState({
        authorityAllowed: true,
        currentGenerationAuthorityAllowed: true,
      });
      return { ...harness.state };
    },
  };

  const result = await reconcileWelcomeRoleGrantIntent(
    dispatched,
    dependencies,
    1_000 + WELCOME_ROLE_LATE_APPLY_GRACE_MS,
  );
  assert.equal(result.status, 'pending');
  assert.equal(harness.completed, false);
  assert.equal(loads, 2);
  const continued = await reconcileWelcomeRoleGrantIntent(
    dispatched,
    dependencies,
    1_000 + WELCOME_ROLE_LATE_APPLY_GRACE_MS,
  );
  assert.equal(continued.roleGranted, true);
  assert.equal(harness.state.rolePresent, true);
});

test('successful grant completion retains its claim when policy or role flips on reload', async () => {
  for (const flip of ['policy', 'role'] as const) {
    const dispatched = intent({
      revision: 1,
      phase: 'dispatched',
      dispatchedAt: 1_000,
      updatedAt: 1_000,
      dispatchAttempts: 1,
    });
    const harness = recoveryHarness(dispatched, {
      authorityAllowed: true,
      currentGenerationAuthorityAllowed: true,
      generationMatches: true,
      rolePresent: true,
      roleRemovable: true,
    });
    let loads = 0;
    const dependencies = {
      ...harness.dependencies,
      async loadFreshState() {
        loads++;
        if (loads === 2) {
          harness.setState(flip === 'policy'
            ? { authorityAllowed: false, currentGenerationAuthorityAllowed: false }
            : { rolePresent: false });
        }
        return { ...harness.state };
      },
    };

    const result = await reconcileWelcomeRoleGrantIntent(
      dispatched,
      dependencies,
      1_000 + WELCOME_ROLE_LATE_APPLY_GRACE_MS,
    );
    assert.deepEqual(result, { status: 'pending', roleGranted: false }, flip);
    assert.equal(harness.completed, false, flip);
    assert.equal(loads, 2, flip);
  }
});

test('observed authorized role remains watched through vacation and a late ambiguous reapply', async () => {
  const dispatched = intent({
    revision: 1,
    phase: 'dispatched',
    dispatchedAt: 4_000,
    updatedAt: 4_000,
    dispatchAttempts: 1,
  });
  const harness = recoveryHarness(dispatched, {
    authorityAllowed: true,
    generationMatches: true,
    rolePresent: true,
    roleRemovable: true,
  });

  const observed = await reconcileWelcomeRoleGrantIntent(dispatched, harness.dependencies, 4_100);
  assert.deepEqual(observed, { status: 'granted-observed', roleGranted: true });
  assert.equal(harness.completed, false);

  // Vacation/config authority removes the visible B result while A remains an
  // outcome-ambiguous in-flight request.
  harness.setState({ authorityAllowed: false, rolePresent: false });
  const waiting = await reconcileWelcomeRoleGrantIntent(dispatched, harness.dependencies, 4_200);
  assert.equal(waiting.status, 'pending');
  assert.equal(harness.completed, false);

  // Late A materializes; recovery compensates but keeps watching until grace.
  harness.setState({ rolePresent: true });
  harness.setTransitionNow(4_300);
  const compensated = await reconcileWelcomeRoleGrantIntent(dispatched, harness.dependencies, 4_300);
  assert.equal(compensated.status, 'pending');
  assert.equal(harness.state.rolePresent, false);
  assert.equal(harness.completed, false);

  const settled = await reconcileWelcomeRoleGrantIntent(
    harness.intent,
    harness.dependencies,
    4_300 + WELCOME_ROLE_LATE_APPLY_GRACE_MS,
  );
  assert.equal(settled.status, 'compensated');
  assert.equal(harness.completed, true);
});

test('intent row is durably prepared before dispatch and completed by token CAS', async () => {
  let stored: Record<string, unknown> | null = null;
  const database = {
    operationClaim: {
      async createMany({ data }: { data: Array<Record<string, unknown>> }) {
        stored = data[0];
        return { count: 1 };
      },
      async findUnique() { return stored; },
      async updateMany({ data }: { data: { metadata: WelcomeRoleGrantIntent } }) {
        if (!stored) return { count: 0 };
        stored = { ...stored, metadata: data.metadata };
        return { count: 1 };
      },
      async deleteMany() { stored = null; return { count: 1 }; },
    },
  };
  const prepared = await prepareWelcomeRoleGrantIntent({
    guildId: 'guild',
    userId: 'user',
    roleId: 'role',
    kind: 'auto',
    policy: 'join',
    membershipGeneration: '1234',
  }, database as never, 1_000, 'durable-token');
  assert.equal(prepared.created, true);
  assert.equal(parseWelcomeRoleGrantIntent(stored?.metadata)?.phase, 'prepared');

  const dispatched = await recordWelcomeRoleGrantDispatch(prepared.intent, database as never, 1_100);
  assert.equal(parseWelcomeRoleGrantIntent(stored?.metadata)?.phase, 'dispatched');
  assert.equal(dispatched.token, 'durable-token');
  const redispatched = await recordWelcomeRoleGrantDispatch(dispatched, database as never, 2_000);
  assert.equal(redispatched.dispatchedAt, 2_000);
  assert.equal(redispatched.dispatchAttempts, 2);
  assert.equal(await completeWelcomeRoleGrantIntent(redispatched, database as never), true);
  assert.equal(stored, null);
});

test('new grant writes reject unknown generation while legacy rows stay readable and inert', async () => {
  await assert.rejects(
    prepareWelcomeRoleGrantIntent({
      guildId: 'guild',
      userId: 'user',
      roleId: 'role',
      kind: 'auto',
      policy: 'join',
      membershipGeneration: 'unknown',
    }, {} as never),
    /authoritative membership generation/,
  );

  const legacyPrepared = intent({ membershipGeneration: 'unknown' });
  assert.equal(parseWelcomeRoleGrantIntent(legacyPrepared)?.membershipGeneration, 'unknown');
  await assert.rejects(recordWelcomeRoleGrantDispatch(legacyPrepared, {} as never), /authoritative/);
  await assert.rejects(
    replaceWelcomeRoleGrantIntent(
      legacyPrepared,
      { ...legacyPrepared, membershipGeneration: '5678' },
      {} as never,
    ),
    /authoritative generations/,
  );

  const preparedHarness = recoveryHarness(legacyPrepared, {
    authorityAllowed: false,
    generationMatches: false,
    currentMembershipGeneration: '5678',
    rolePresent: false,
    roleRemovable: true,
    replacementAuthorityAllowed: true,
  });
  const retired = await reconcileWelcomeRoleGrantIntent(
    legacyPrepared,
    preparedHarness.dependencies,
    2_000,
  );
  assert.equal(retired.status, 'absent-settled');
  assert.equal(preparedHarness.completed, true);
  assert.equal(preparedHarness.events.includes('add'), false);

  const legacyDispatched = intent({
    membershipGeneration: 'unknown',
    revision: 1,
    phase: 'dispatched',
    dispatchedAt: 1_000,
    updatedAt: 1_000,
    dispatchAttempts: 1,
  });
  const ambiguousHarness = recoveryHarness(legacyDispatched, {
    authorityAllowed: false,
    generationMatches: false,
    currentMembershipGeneration: 'unknown',
    rolePresent: true,
    roleRemovable: true,
  });
  const retained = await reconcileWelcomeRoleGrantIntent(
    legacyDispatched,
    ambiguousHarness.dependencies,
    1_000 + WELCOME_ROLE_LATE_APPLY_GRACE_MS,
  );
  assert.equal(retained.status, 'pending');
  assert.equal(ambiguousHarness.completed, false);
  assert.equal(ambiguousHarness.events.includes('remove'), false);
});

test('forbidden absent dispatch survives grace, catches a late apply, and keeps watching after removal', async () => {
  const dispatched = intent({
    phase: 'dispatched',
    revision: 1,
    dispatchedAt: 2_000,
    updatedAt: 2_000,
    dispatchAttempts: 1,
  });
  const harness = recoveryHarness(dispatched, {
    authorityAllowed: false,
    generationMatches: true,
    rolePresent: false,
    roleRemovable: true,
  });

  const waiting = await reconcileWelcomeRoleGrantIntent(
    dispatched,
    harness.dependencies,
    2_000 + WELCOME_ROLE_LATE_APPLY_GRACE_MS - 1,
  );
  assert.equal(waiting.status, 'pending');
  assert.equal(harness.completed, false);

  harness.setState({ rolePresent: true });
  harness.setTransitionNow(2_000 + WELCOME_ROLE_LATE_APPLY_GRACE_MS - 1);
  const compensatedButWatching = await reconcileWelcomeRoleGrantIntent(
    dispatched,
    harness.dependencies,
    2_000 + WELCOME_ROLE_LATE_APPLY_GRACE_MS - 1,
  );
  assert.equal(compensatedButWatching.status, 'pending');
  assert.equal(harness.state.rolePresent, false);
  assert.equal(harness.completed, false);
  assert.equal(harness.events.includes('remove'), true);

  const settled = await reconcileWelcomeRoleGrantIntent(
    harness.intent,
    harness.dependencies,
    harness.intent.removalDispatchedAt! + WELCOME_ROLE_LATE_APPLY_GRACE_MS,
  );
  assert.equal(settled.status, 'compensated');
  assert.equal(harness.completed, true);
});

test('a role appearing before dispatch is foreign and is never removed', async () => {
  const prepared = intent();
  const harness = recoveryHarness(prepared, {
    authorityAllowed: false,
    generationMatches: true,
    rolePresent: true,
    roleRemovable: true,
  });
  const result = await reconcileWelcomeRoleGrantIntent(prepared, harness.dependencies, 1_100);
  assert.equal(result.status, 'foreign-settled');
  assert.equal(harness.events.includes('remove'), false);
  assert.equal(harness.completed, true);
});

test('a new membership generation is never destructively cleaned by an old intent', async () => {
  const dispatched = intent({
    phase: 'dispatched',
    revision: 1,
    dispatchedAt: 2_000,
    updatedAt: 2_000,
    dispatchAttempts: 1,
  });
  const harness = recoveryHarness(dispatched, {
    authorityAllowed: false,
    generationMatches: false,
    rolePresent: true,
    roleRemovable: true,
  });
  const result = await reconcileWelcomeRoleGrantIntent(
    dispatched,
    harness.dependencies,
    2_000 + WELCOME_ROLE_LATE_APPLY_GRACE_MS,
  );
  assert.equal(result.status, 'generation-retry');
  assert.equal(harness.events.includes('remove'), false);
});

test('same-role late auto ADD is handed to an eligible current membership without DELETE', async () => {
  const dispatched = intent({
    revision: 1,
    phase: 'dispatched',
    dispatchedAt: 2_000,
    updatedAt: 2_000,
    dispatchAttempts: 1,
  });
  const harness = recoveryHarness(dispatched, {
    authorityAllowed: false,
    currentGenerationAuthorityAllowed: true,
    replacementAuthorityAllowed: true,
    generationMatches: false,
    currentMembershipGeneration: '5678',
    rolePresent: true,
    roleRemovable: true,
  });

  const duringGrace = await reconcileWelcomeRoleGrantIntent(
    dispatched,
    harness.dependencies,
    2_100,
  );
  assert.equal(duringGrace.status, 'pending');
  assert.equal(harness.events.includes('remove'), false);

  const transferable = await reconcileWelcomeRoleGrantIntent(
    dispatched,
    harness.dependencies,
    2_000 + WELCOME_ROLE_LATE_APPLY_GRACE_MS,
  );
  assert.equal(transferable.status, 'generation-retry');
  assert.equal(harness.events.includes('remove'), false);
});

test('same-role forbidden late auto ADD is durably compensated on the new membership', async () => {
  const dispatched = intent({
    revision: 1,
    phase: 'dispatched',
    dispatchedAt: 2_000,
    updatedAt: 2_000,
    dispatchAttempts: 1,
  });
  const harness = recoveryHarness(dispatched, {
    authorityAllowed: false,
    currentGenerationAuthorityAllowed: false,
    replacementAuthorityAllowed: false,
    generationMatches: false,
    currentMembershipGeneration: '5678',
    rolePresent: true,
    roleRemovable: true,
  });
  harness.setTransitionNow(2_100);

  const result = await reconcileWelcomeRoleGrantIntent(
    dispatched,
    harness.dependencies,
    2_100,
  );
  assert.equal(result.status, 'pending');
  assert.equal(harness.intent.phase, 'compensating');
  assert.equal(harness.intent.compensationMembershipGeneration, '5678');
  assert.equal(harness.intent.compensationReason, 'membership-generation-mismatch');
  assert.equal(harness.state.rolePresent, false);
});

test('auto-role A to B waits for durable A compensation before generation replacement', async () => {
  const dispatchedA = intent({
    roleId: 'auto-a',
    revision: 1,
    phase: 'dispatched',
    dispatchedAt: 2_000,
    updatedAt: 2_000,
    dispatchAttempts: 1,
  });
  const harness = recoveryHarness(dispatchedA, {
    authorityAllowed: false,
    currentGenerationAuthorityAllowed: false,
    replacementAuthorityAllowed: true,
    generationMatches: false,
    currentMembershipGeneration: '5678',
    rolePresent: true,
    roleRemovable: true,
  });
  harness.setTransitionNow(2_100);
  const compensated = await reconcileWelcomeRoleGrantIntent(
    dispatchedA,
    harness.dependencies,
    2_100,
  );
  assert.equal(compensated.status, 'pending');
  assert.equal(harness.intent.compensationReason, 'membership-generation-mismatch');
  assert.equal(harness.state.rolePresent, false);

  const replace = await reconcileWelcomeRoleGrantIntent(
    harness.intent,
    harness.dependencies,
    2_100 + WELCOME_ROLE_LATE_APPLY_GRACE_MS,
  );
  assert.equal(replace.status, 'generation-retry');
});

test('a role first observed after old ADD grace is foreign and never compensated', async () => {
  const dispatched = intent({
    revision: 1,
    phase: 'dispatched',
    dispatchedAt: 2_000,
    updatedAt: 2_000,
    dispatchAttempts: 1,
  });
  const harness = recoveryHarness(dispatched, {
    authorityAllowed: false,
    currentGenerationAuthorityAllowed: false,
    replacementAuthorityAllowed: false,
    generationMatches: false,
    currentMembershipGeneration: '5678',
    rolePresent: true,
    roleRemovable: true,
  });
  const result = await reconcileWelcomeRoleGrantIntent(
    dispatched,
    harness.dependencies,
    2_000 + WELCOME_ROLE_LATE_APPLY_GRACE_MS,
  );
  assert.equal(result.status, 'foreign-settled');
  assert.equal(harness.events.includes('remove'), false);
});

test('old join generation is atomically retried for the current generation after grace', async () => {
  const oldIntent = intent({
    token: 'old-generation',
    revision: 1,
    phase: 'dispatched',
    dispatchedAt: 2_000,
    updatedAt: 2_000,
    dispatchAttempts: 1,
  });
  const currentIntent = intent({
    token: 'current-generation',
    membershipGeneration: '5678',
    preparedAt: 2_000 + WELCOME_ROLE_LATE_APPLY_GRACE_MS,
    updatedAt: 2_000 + WELCOME_ROLE_LATE_APPLY_GRACE_MS,
  });
  const oldHarness = recoveryHarness(oldIntent, {
    authorityAllowed: false,
    generationMatches: false,
    rolePresent: false,
    roleRemovable: true,
  });
  const currentHarness = recoveryHarness(currentIntent, {
    authorityAllowed: true,
    generationMatches: true,
    rolePresent: false,
    roleRemovable: true,
  });
  let replacements = 0;
  const result = await reconcileWelcomeRoleGrantWithGenerationRetry(
    oldIntent,
    (active) => active.token === oldIntent.token
      ? oldHarness.dependencies
      : currentHarness.dependencies,
    async () => {
      replacements++;
      return currentIntent;
    },
    2_000 + WELCOME_ROLE_LATE_APPLY_GRACE_MS,
  );
  assert.equal(replacements, 1);
  assert.equal(currentHarness.events.includes('add'), true);
  assert.equal(currentHarness.state.rolePresent, true);
  assert.equal(oldHarness.events.includes('remove'), false);
  assert.equal(result.roleGranted, true);
});

test('rules intent is never transferred to a new membership generation', async () => {
  const rulesIntent = intent({
    kind: 'recruit',
    policy: 'rules',
    revision: 1,
    phase: 'dispatched',
    dispatchedAt: 2_000,
    updatedAt: 2_000,
    dispatchAttempts: 1,
  });
  const harness = recoveryHarness(rulesIntent, {
    authorityAllowed: false,
    generationMatches: false,
    rolePresent: false,
    roleRemovable: true,
  });
  const result = await reconcileWelcomeRoleGrantIntent(
    rulesIntent,
    harness.dependencies,
    2_000 + WELCOME_ROLE_LATE_APPLY_GRACE_MS,
  );
  assert.equal(result.status, 'absent-settled');
  assert.equal(harness.completed, true);
});

test('late-delete regrant intent is membership-specific and never transferred', async () => {
  const recoveryIntent = intent({
    policy: 'removal-recovery',
    revision: 1,
    phase: 'dispatched',
    dispatchedAt: 2_000,
    updatedAt: 2_000,
    dispatchAttempts: 1,
  });
  const harness = recoveryHarness(recoveryIntent, {
    authorityAllowed: false,
    generationMatches: false,
    rolePresent: false,
    roleRemovable: true,
  });
  const result = await reconcileWelcomeRoleGrantIntent(
    recoveryIntent,
    harness.dependencies,
    2_000 + WELCOME_ROLE_LATE_APPLY_GRACE_MS,
  );
  assert.equal(result.status, 'absent-settled');
  assert.equal(harness.completed, true);
});

test('a dispatched rules add observed on a new membership is durably compensated', async () => {
  const rulesIntent = intent({
    kind: 'recruit',
    policy: 'rules',
    revision: 1,
    phase: 'dispatched',
    dispatchedAt: 2_000,
    updatedAt: 2_000,
    dispatchAttempts: 1,
  });
  const harness = recoveryHarness(rulesIntent, {
    authorityAllowed: false,
    generationMatches: false,
    currentMembershipGeneration: 'new-membership',
    rolePresent: true,
    roleRemovable: true,
  });
  harness.setTransitionNow(2_100);

  const result = await reconcileWelcomeRoleGrantIntent(
    rulesIntent,
    harness.dependencies,
    2_100,
  );
  assert.equal(result.status, 'pending');
  assert.equal(harness.state.rolePresent, false);
  assert.deepEqual(
    harness.events.filter((event) => event === 'remove-dispatch' || event === 'remove'),
    ['remove-dispatch', 'remove'],
  );
  assert.equal(harness.intent.phase, 'compensating');
  assert.equal(harness.intent.compensationMembershipGeneration, 'new-membership');
  assert.equal(harness.intent.compensationReason, 'rules-generation-mismatch');
  assert.equal(harness.completed, false);

  const waiting = await reconcileWelcomeRoleGrantIntent(
    harness.intent,
    harness.dependencies,
    2_100 + WELCOME_ROLE_LATE_APPLY_GRACE_MS - 1,
  );
  assert.equal(waiting.status, 'pending');
  assert.equal(harness.completed, false);

  const settled = await reconcileWelcomeRoleGrantIntent(
    harness.intent,
    harness.dependencies,
    2_100 + WELCOME_ROLE_LATE_APPLY_GRACE_MS,
  );
  assert.equal(settled.status, 'absent-settled');
  assert.equal(harness.completed, true);
});

test('compensation removal grace starts after delayed fresh preflight, at actual DELETE dispatch', async () => {
  const dispatched = intent({
    revision: 1,
    phase: 'dispatched',
    dispatchedAt: 2_000,
    updatedAt: 2_000,
    dispatchAttempts: 1,
  });
  const harness = recoveryHarness(dispatched, {
    authorityAllowed: false,
    generationMatches: true,
    rolePresent: true,
    roleRemovable: true,
  });
  const actualDeleteAt = 40_000;
  const dependencies = {
    ...harness.dependencies,
    async dispatchRemoval(
      current: WelcomeRoleGrantIntent,
      membershipGeneration: string,
      reason: WelcomeRoleGrantIntent['compensationReason'] & string,
    ) {
      return dispatchWelcomeRoleCompensationAfterPreflight(
        current,
        membershipGeneration,
        reason,
        {
          loadFreshState: async () => {
            harness.events.push('slow-fresh-preflight-complete');
            harness.setTransitionNow(actualDeleteAt);
            return { ...harness.state };
          },
          recordDispatch: harness.recordRemovalDispatch,
          assertLockOwned: async () => undefined,
          assertCurrent: async () => undefined,
          removeRole: async () => harness.removeRole(),
          now: () => actualDeleteAt,
        },
      );
    },
  };

  await reconcileWelcomeRoleGrantIntent(dispatched, dependencies, 2_100);
  assert.equal(harness.intent.removalDispatchedAt, actualDeleteAt);
  assert.equal(isWelcomeRoleRemovalPastGrace(
    harness.intent,
    actualDeleteAt + WELCOME_ROLE_LATE_APPLY_GRACE_MS - 1,
  ), false);
  assert.deepEqual(
    harness.events.filter((event) => [
      'slow-fresh-preflight-complete',
      'remove-dispatch',
      'remove',
    ].includes(event)),
    [
      'slow-fresh-preflight-complete',
      'remove-dispatch',
      'slow-fresh-preflight-complete',
      'remove',
    ],
  );
});

test('compensation DELETE never crosses its post-CAS generation, lease, revision or age fence', async () => {
  for (const blockedBy of ['rejoin', 'lease', 'revision', 'age'] as const) {
    const dispatched = intent({
      revision: 1,
      phase: 'dispatched',
      dispatchedAt: 2_000,
      updatedAt: 2_000,
      dispatchAttempts: 1,
    });
    const harness = recoveryHarness(dispatched, {
      authorityAllowed: false,
      generationMatches: true,
      rolePresent: true,
      roleRemovable: true,
    });
    harness.setTransitionNow(4_000);
    let loads = 0;
    const operation = dispatchWelcomeRoleCompensationAfterPreflight(
      dispatched,
      '1234',
      'authority-revoked',
      {
        loadFreshState: async () => {
          loads++;
          if (loads === 2 && blockedBy === 'rejoin') harness.setState({
            generationMatches: false,
            currentMembershipGeneration: '5678',
          });
          return { ...harness.state };
        },
        recordDispatch: harness.recordRemovalDispatch,
        assertLockOwned: async () => {
          if (blockedBy === 'lease') throw new Error('lease lost');
        },
        assertCurrent: async () => {
          if (blockedBy === 'revision') throw new Error('revision advanced');
        },
        removeRole: async () => harness.removeRole(),
        now: () => blockedBy === 'age'
          ? 4_000 + WELCOME_ROLE_LATE_APPLY_GRACE_MS
          : 4_001,
      },
    );
    if (blockedBy === 'lease' || blockedBy === 'revision') {
      await assert.rejects(operation, new RegExp(blockedBy === 'lease' ? 'lease' : 'revision'));
    } else {
      await operation;
    }
    assert.equal(harness.events.includes('remove'), false, blockedBy);
    assert.equal(harness.intent.phase, 'compensating', blockedBy);
  }
});

test('auto compensation DELETE stops when current-generation eligibility returns', async () => {
  for (const eligibilityAt of ['initial-preflight', 'post-dispatch-reload'] as const) {
    const dispatched = intent({
      revision: 1,
      phase: 'dispatched',
      dispatchedAt: 2_000,
      updatedAt: 2_000,
      dispatchAttempts: 1,
    });
    const harness = recoveryHarness(dispatched, {
      authorityAllowed: false,
      currentGenerationAuthorityAllowed: eligibilityAt === 'initial-preflight',
      replacementAuthorityAllowed: false,
      generationMatches: false,
      currentMembershipGeneration: '5678',
      rolePresent: true,
      roleRemovable: true,
    });
    harness.setTransitionNow(4_000);
    let loads = 0;
    const result = await dispatchWelcomeRoleCompensationAfterPreflight(
      dispatched,
      '5678',
      'membership-generation-mismatch',
      {
        loadFreshState: async () => {
          loads++;
          if (loads === 2 && eligibilityAt === 'post-dispatch-reload') {
            harness.setState({ currentGenerationAuthorityAllowed: true });
          }
          return { ...harness.state };
        },
        recordDispatch: harness.recordRemovalDispatch,
        assertLockOwned: async () => undefined,
        assertCurrent: async () => undefined,
        removeRole: async () => harness.removeRole(),
        now: () => 4_001,
      },
    );

    assert.equal(harness.events.includes('remove'), false, eligibilityAt);
    assert.equal(
      harness.events.includes('remove-dispatch'),
      eligibilityAt === 'post-dispatch-reload',
      eligibilityAt,
    );
    assert.equal(
      result.phase,
      eligibilityAt === 'initial-preflight' ? 'dispatched' : 'compensating',
      eligibilityAt,
    );
    assert.equal(loads, eligibilityAt === 'initial-preflight' ? 1 : 2, eligibilityAt);
  }
});

test('a prepared role on a new membership remains foreign and is never compensated', async () => {
  const preparedRules = intent({ kind: 'recruit', policy: 'rules' });
  const harness = recoveryHarness(preparedRules, {
    authorityAllowed: false,
    generationMatches: false,
    currentMembershipGeneration: 'new-membership',
    rolePresent: true,
    roleRemovable: true,
  });
  const result = await reconcileWelcomeRoleGrantIntent(
    preparedRules,
    harness.dependencies,
    2_000,
  );
  assert.equal(result.status, 'foreign-settled');
  assert.equal(harness.events.includes('remove-dispatch'), false);
  assert.equal(harness.events.includes('remove'), false);
});

test('an ambiguous compensation DELETE gets its own grace before a legitimate re-grant', async () => {
  const dispatched = intent({
    revision: 1,
    phase: 'dispatched',
    dispatchedAt: 2_000,
    updatedAt: 2_000,
    dispatchAttempts: 1,
  });
  const harness = recoveryHarness(dispatched, {
    authorityAllowed: false,
    generationMatches: true,
    rolePresent: true,
    roleRemovable: true,
  });
  const removalAt = 2_000 + WELCOME_ROLE_LATE_APPLY_GRACE_MS + 100;
  harness.setTransitionNow(removalAt);

  const removed = await reconcileWelcomeRoleGrantIntent(
    dispatched,
    harness.dependencies,
    removalAt,
  );
  assert.equal(removed.status, 'pending');
  assert.equal(harness.intent.phase, 'compensating');
  assert.equal(isWelcomeRoleRemovalPastGrace(harness.intent, removalAt), false);
  assert.equal(harness.completed, false);

  harness.setState({ authorityAllowed: true, rolePresent: false });
  const beforeGrace = await reconcileWelcomeRoleGrantIntent(
    harness.intent,
    harness.dependencies,
    removalAt + WELCOME_ROLE_LATE_APPLY_GRACE_MS - 1,
  );
  assert.equal(beforeGrace.status, 'pending');
  assert.equal(harness.events.filter((event) => event === 'add').length, 0);

  const safeRegrantAt = removalAt + WELCOME_ROLE_LATE_APPLY_GRACE_MS;
  harness.setTransitionNow(safeRegrantAt);
  const regranted = await reconcileWelcomeRoleGrantIntent(
    harness.intent,
    harness.dependencies,
    safeRegrantAt,
  );
  assert.equal(regranted.status, 'granted-observed');
  assert.equal(harness.events.filter((event) => event === 'add').length, 1);
  assert.equal(harness.intent.phase, 'dispatched');
  assert.equal(harness.intent.removalDispatchedAt, null);
});

test('a response-lost compensation DELETE remains durable and cannot settle early', async () => {
  const dispatched = intent({
    revision: 1,
    phase: 'dispatched',
    dispatchedAt: 2_000,
    updatedAt: 2_000,
    dispatchAttempts: 1,
  });
  const harness = recoveryHarness(dispatched, {
    authorityAllowed: false,
    generationMatches: true,
    rolePresent: true,
    roleRemovable: true,
  });
  harness.setTransitionNow(3_000);
  const dependencies = {
    ...harness.dependencies,
    async dispatchRemoval(
      current: WelcomeRoleGrantIntent,
      membershipGeneration: string,
      reason: WelcomeRoleGrantIntent['compensationReason'] & string,
    ) {
      const updated = await harness.dependencies.dispatchRemoval(
        current,
        membershipGeneration,
        reason,
      );
      harness.events.push('remove-response-lost');
      harness.setState({ rolePresent: false });
      return updated;
    },
  };

  const result = await reconcileWelcomeRoleGrantIntent(dispatched, dependencies, 3_000);
  assert.equal(result.status, 'pending');
  assert.equal(harness.intent.phase, 'compensating');
  assert.equal(harness.completed, false);
  assert.equal(harness.events.includes('remove-response-lost'), true);

  harness.setState({ rolePresent: true });
  harness.setTransitionNow(4_000);
  const retried = await reconcileWelcomeRoleGrantIntent(
    harness.intent,
    dependencies,
    4_000,
  );
  assert.equal(retried.status, 'pending');
  assert.equal(harness.intent.removalDispatchedAt, 4_000);
  assert.equal(harness.intent.removalAttempts, 2);

  const stillWaiting = await reconcileWelcomeRoleGrantIntent(
    harness.intent,
    dependencies,
    3_000 + WELCOME_ROLE_LATE_APPLY_GRACE_MS,
  );
  assert.equal(stillWaiting.status, 'pending');
  assert.equal(harness.completed, false);
});

test('an ambiguous removal CAS response is accepted only for the exact next state', async () => {
  const dispatched = intent({
    revision: 1,
    phase: 'dispatched',
    dispatchedAt: 2_000,
    updatedAt: 2_000,
    dispatchAttempts: 1,
  });
  let claim = {
    key: welcomeRoleGrantIntentKey('guild', 'user', 'auto'),
    scope: WELCOME_ROLE_GRANT_SCOPE,
    guildId: 'guild',
    userId: 'user',
    metadata: dispatched,
  };
  const database = {
    operationClaim: {
      async findUnique() { return claim; },
      async updateMany({ data }: { data: { metadata: WelcomeRoleGrantIntent } }) {
        claim = { ...claim, metadata: data.metadata };
        throw new Error('database response lost after commit');
      },
    },
  };

  const compensated = await recordWelcomeRoleRemovalDispatch(
    dispatched,
    dispatched.membershipGeneration,
    'authority-revoked',
    database as never,
    3_000,
  );
  assert.equal(compensated.phase, 'compensating');
  assert.equal(compensated.revision, 2);
  assert.equal(compensated.removalDispatchedAt, 3_000);
});

test('legacy v1 intents normalize safely and migrate on the next exact removal CAS', async () => {
  const current = intent({
    revision: 1,
    phase: 'dispatched',
    dispatchedAt: 2_000,
    updatedAt: 2_000,
    dispatchAttempts: 1,
  });
  const legacy: Record<string, unknown> = { ...current, version: 1 };
  delete legacy.removalDispatchedAt;
  delete legacy.removalAttempts;
  delete legacy.compensationMembershipGeneration;
  delete legacy.compensationReason;
  let stored = {
    key: welcomeRoleGrantIntentKey('guild', 'user', 'auto'),
    scope: WELCOME_ROLE_GRANT_SCOPE,
    guildId: 'guild',
    userId: 'user',
    metadata: legacy,
  };
  const database = {
    operationClaim: {
      async findUnique() { return stored; },
      async updateMany({ data }: { data: { metadata: WelcomeRoleGrantIntent } }) {
        stored = { ...stored, metadata: data.metadata };
        return { count: 1 };
      },
    },
  };

  const parsed = parseWelcomeRoleGrantIntent(legacy);
  assert.ok(parsed);
  assert.equal(parsed.version, 2);
  assert.equal(parsed.removalAttempts, 0);
  assert.equal(parsed.removalDispatchedAt, null);
  const migrated = await recordWelcomeRoleRemovalDispatch(
    parsed,
    '1234',
    'authority-revoked',
    database as never,
    3_000,
  );
  assert.equal(migrated.version, 2);
  assert.equal(migrated.phase, 'compensating');
  assert.equal(parseWelcomeRoleGrantIntent(stored.metadata)?.version, 2);
});

test('an already-aborted welcome settlement cannot enter Discord recovery', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    settleWelcomeRoleGrantIntent({} as never, intent(), controller.signal),
    { name: 'AbortError' },
  );
});

test('same-token stale revision cannot roll back dispatch state or delete a redispatch', async () => {
  const stale = intent({
    token: 'same-token',
    revision: 1,
    phase: 'dispatched',
    dispatchedAt: 2_000,
    updatedAt: 2_000,
    dispatchAttempts: 1,
  });
  const current = intent({
    token: 'same-token',
    revision: 2,
    phase: 'dispatched',
    dispatchedAt: 5_000,
    updatedAt: 5_000,
    dispatchAttempts: 2,
  });
  const key = welcomeRoleGrantIntentKey('guild', 'user', 'auto');
  const claim = {
    key,
    scope: WELCOME_ROLE_GRANT_SCOPE,
    guildId: 'guild',
    userId: 'user',
    metadata: current,
    createdAt: new Date(),
    expiresAt: null,
  };
  const expectedRevision = (where: {
    AND?: Array<{ metadata?: { equals?: unknown } }>;
  }) => where.AND?.[1]?.metadata?.equals;
  const database = {
    operationClaim: {
      async findUnique() { return claim; },
      async updateMany({ where }: { where: { AND?: Array<{ metadata?: { equals?: unknown } }> } }) {
        return { count: expectedRevision(where) === current.revision ? 1 : 0 };
      },
      async deleteMany({ where }: { where: { AND?: Array<{ metadata?: { equals?: unknown } }> } }) {
        return { count: expectedRevision(where) === current.revision ? 1 : 0 };
      },
    },
  };

  await assert.rejects(
    recordWelcomeRoleGrantDispatch(stale, database as never, 6_000),
    { name: 'WelcomeRoleGrantIntentFencedError' },
  );
  await assert.rejects(
    completeWelcomeRoleGrantIntent(stale, database as never),
    { name: 'WelcomeRoleGrantIntentFencedError' },
  );
  await assert.rejects(
    recordWelcomeRoleRemovalDispatch(
      stale,
      stale.membershipGeneration,
      'authority-revoked',
      database as never,
      6_000,
    ),
    { name: 'WelcomeRoleGrantIntentFencedError' },
  );
  const persisted = parseWelcomeRoleGrantIntent(claim.metadata);
  assert.equal(persisted?.revision, 2);
  assert.equal(persisted?.dispatchedAt, 5_000);
  assert.equal(persisted?.dispatchAttempts, 2);
});

test('old token cannot dispatch or delete a replacement intent', async () => {
  const oldIntent = intent({ token: 'old-token' });
  const replacement = intent({ token: 'new-token' });
  const key = welcomeRoleGrantIntentKey('guild', 'user', 'auto');
  let claim = {
    key,
    scope: WELCOME_ROLE_GRANT_SCOPE,
    guildId: 'guild',
    userId: 'user',
    metadata: replacement,
    createdAt: new Date(),
    expiresAt: null,
  };
  const database = {
    operationClaim: {
      async findUnique() { return claim; },
      async updateMany() { return { count: 0 }; },
      async deleteMany({ where }: { where: { AND?: Array<{ metadata?: { equals?: unknown } }> } }) {
        const expectedToken = where.AND?.[0]?.metadata?.equals;
        const expectedRevision = where.AND?.[1]?.metadata?.equals;
        if (expectedToken === replacement.token && expectedRevision === replacement.revision) {
          claim = null as never;
          return { count: 1 };
        }
        return { count: 0 };
      },
    },
  };

  await assert.rejects(
    recordWelcomeRoleGrantDispatch(oldIntent, database as never, 2_000),
    { name: 'WelcomeRoleGrantIntentFencedError' },
  );
  await assert.rejects(
    completeWelcomeRoleGrantIntent(oldIntent, database as never),
    { name: 'WelcomeRoleGrantIntentFencedError' },
  );
  assert.equal(parseWelcomeRoleGrantIntent(claim.metadata)?.token, 'new-token');
  assert.equal(await completeWelcomeRoleGrantIntent(replacement, database as never), true);
});

test('ambiguous reminder SET null is owned only when GET returns the same UUID', async () => {
  const calls: string[] = [];
  const owned = await acquireReminderClaimToken({
    async set(_key, token) { calls.push(`set:${token}`); return null; },
    async get() { calls.push('get'); return 'claim-token'; },
  }, 'reminder-key', 60, 'claim-token');
  assert.equal(owned, 'claim-token');
  assert.deepEqual(calls, ['set:claim-token', 'get']);

  const foreign = await acquireReminderClaimToken({
    async set() { return null; },
    async get() { return 'other-token'; },
  }, 'reminder-key', 60, 'claim-token');
  assert.equal(foreign, null);
});
