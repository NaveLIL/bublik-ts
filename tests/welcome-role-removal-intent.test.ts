import assert from 'node:assert/strict';
import test from 'node:test';
import {
  completeWelcomeAutoRoleRemovalIntent,
  isWelcomeAutoRoleRemovalPastGrace,
  parseWelcomeAutoRoleRemovalIntent,
  prepareWelcomeAutoRoleRemovalIntent,
  recordWelcomeAutoRoleRemovalDispatch,
  recordWelcomeAutoRoleRegrantObserved,
  WELCOME_AUTO_ROLE_REMOVAL_SCOPE,
  type WelcomeAutoRoleRemovalIntent,
  welcomeAutoRoleRemovalIntentKey,
} from '../src/modules/welcome/roleRemovalIntent';
import {
  commitWelcomeAutoRoleRegrantHandoff,
  dispatchWelcomeAutoRoleRemovalAfterPreflight,
  reconcileWelcomeAutoRoleRemovalIntent,
  type WelcomeAutoRoleRemovalState,
} from '../src/modules/welcome/roleRemovalRecovery';
import { WELCOME_ROLE_LATE_APPLY_GRACE_MS } from '../src/modules/welcome/roleGrantIntent';

function removalIntent(
  overrides: Partial<WelcomeAutoRoleRemovalIntent> = {},
): WelcomeAutoRoleRemovalIntent {
  return {
    version: 2,
    token: 'removal-token',
    revision: 0,
    guildId: 'guild',
    userId: 'user',
    roleId: 'auto-role',
    membershipGeneration: '1234',
    phase: 'prepared',
    preparedAt: 1_000,
    removalDispatchedAt: null,
    updatedAt: 1_000,
    removalAttempts: 0,
    regrant: null,
    ...overrides,
  };
}

function removalHarness(
  initialIntent: WelcomeAutoRoleRemovalIntent,
  initialState: WelcomeAutoRoleRemovalState,
) {
  let intent = initialIntent;
  let state = { ...initialState };
  let dispatchAt = 2_000;
  let completed = false;
  let handedOff = false;
  let handoffGeneration: string | null = null;
  const events: string[] = [];
  const recordDispatch = async (
    current: WelcomeAutoRoleRemovalIntent,
  ): Promise<WelcomeAutoRoleRemovalIntent> => {
    intent = {
      ...current,
      revision: current.revision + 1,
      phase: 'dispatched',
      removalDispatchedAt: dispatchAt,
      updatedAt: dispatchAt,
      removalAttempts: current.removalAttempts + 1,
      regrant: null,
    };
    events.push('dispatch-cas');
    return intent;
  };
  const removeRole = async (): Promise<void> => {
    events.push('delete');
    state.rolePresent = false;
  };
  return {
    events,
    get intent() { return intent; },
    get state() { return state; },
    get completed() { return completed; },
    get handedOff() { return handedOff; },
    get handoffGeneration() { return handoffGeneration; },
    setState(next: Partial<WelcomeAutoRoleRemovalState>) { state = { ...state, ...next }; },
    setDispatchAt(next: number) { dispatchAt = next; },
    recordDispatch,
    removeRole,
    dependencies: {
      async assertCurrent() { events.push('assert'); },
      async loadFreshState() { events.push('load'); return { ...state }; },
      async dispatchRemoval(current: WelcomeAutoRoleRemovalIntent) {
        events.push('fresh-preflight');
        const updated = await recordDispatch(current);
        await removeRole();
        return updated;
      },
      async recordRegrantObserved(
        current: WelcomeAutoRoleRemovalIntent,
        membershipGeneration: string,
      ) {
        events.push('regrant-observed');
        intent = {
          ...current,
          revision: current.revision + 1,
          updatedAt: Math.max(current.updatedAt, dispatchAt),
          regrant: {
            membershipGeneration,
            observedAt: Math.max(current.updatedAt, dispatchAt),
          },
        };
        return intent;
      },
      async handoffRegrant(_current: WelcomeAutoRoleRemovalIntent, generation: string) {
        events.push('regrant-handoff');
        handedOff = true;
        handoffGeneration = generation;
        completed = true;
        return true;
      },
      async complete() { events.push('complete'); completed = true; return true; },
    },
  };
}

test('normal auto-role DELETE records its clock after fresh preflight and keeps a grace tombstone', async () => {
  const prepared = removalIntent();
  const harness = removalHarness(prepared, {
    authorityAllowed: true,
    regrantAuthorityAllowed: false,
    generationMatches: true,
    currentMembershipGeneration: '1234',
    rolePresent: true,
    roleRemovable: true,
  });
  const actualDeleteAt = 40_000;
  const dependencies = {
    ...harness.dependencies,
    dispatchRemoval: (current: WelcomeAutoRoleRemovalIntent) =>
      dispatchWelcomeAutoRoleRemovalAfterPreflight(current, {
        loadFreshState: async () => {
          harness.events.push('fresh-preflight');
          harness.setDispatchAt(actualDeleteAt);
          return { ...harness.state };
        },
        recordDispatch: harness.recordDispatch,
        assertLockOwned: async () => undefined,
        assertCurrent: async () => undefined,
        removeRole: async () => harness.removeRole(),
        now: () => actualDeleteAt,
      }),
  };

  const result = await reconcileWelcomeAutoRoleRemovalIntent(
    prepared,
    dependencies,
    1_100,
  );
  assert.deepEqual(result, { status: 'pending', roleAbsent: true });
  assert.equal(harness.intent.removalDispatchedAt, actualDeleteAt);
  assert.equal(harness.completed, false);
  assert.equal(isWelcomeAutoRoleRemovalPastGrace(
    harness.intent,
    actualDeleteAt + WELCOME_ROLE_LATE_APPLY_GRACE_MS - 1,
  ), false);
  assert.deepEqual(
    harness.events.filter((event) => ['fresh-preflight', 'dispatch-cas', 'delete'].includes(event)),
    ['fresh-preflight', 'dispatch-cas', 'fresh-preflight', 'delete'],
  );
});

test('normal DELETE never crosses its post-CAS generation, lease, revision or age fence', async () => {
  for (const blockedBy of ['rejoin', 'lease', 'revision', 'age'] as const) {
    const prepared = removalIntent();
    const harness = removalHarness(prepared, {
      authorityAllowed: true,
      regrantAuthorityAllowed: false,
      generationMatches: true,
      currentMembershipGeneration: '1234',
      rolePresent: true,
      roleRemovable: true,
    });
    harness.setDispatchAt(4_000);
    let loads = 0;
    const operation = dispatchWelcomeAutoRoleRemovalAfterPreflight(prepared, {
      loadFreshState: async () => {
        loads++;
        if (loads === 2 && blockedBy === 'rejoin') harness.setState({
          authorityAllowed: false,
          generationMatches: false,
          currentMembershipGeneration: '5678',
        });
        return { ...harness.state };
      },
      recordDispatch: harness.recordDispatch,
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
    });
    if (blockedBy === 'lease' || blockedBy === 'revision') {
      await assert.rejects(operation, new RegExp(blockedBy === 'lease' ? 'lease' : 'revision'));
    } else {
      await operation;
    }
    assert.equal(harness.events.includes('delete'), false, blockedBy);
    assert.equal(harness.intent.phase, 'dispatched', blockedBy);
  }
});

test('manual or preexisting regrant is preserved when it survives the ambiguous DELETE grace', async () => {
  const dispatched = removalIntent({
    revision: 1,
    phase: 'dispatched',
    removalDispatchedAt: 2_000,
    updatedAt: 2_000,
    removalAttempts: 1,
  });
  const harness = removalHarness(dispatched, {
    authorityAllowed: false,
    regrantAuthorityAllowed: true,
    generationMatches: true,
    currentMembershipGeneration: '1234',
    rolePresent: true,
    roleRemovable: true,
  });

  const waiting = await reconcileWelcomeAutoRoleRemovalIntent(
    dispatched,
    harness.dependencies,
    2_000 + WELCOME_ROLE_LATE_APPLY_GRACE_MS - 1,
  );
  assert.equal(waiting.status, 'pending');
  assert.equal(harness.intent.regrant?.membershipGeneration, '1234');
  assert.equal(harness.events.includes('delete'), false);
  assert.equal(harness.completed, false);

  const preserved = await reconcileWelcomeAutoRoleRemovalIntent(
    harness.intent,
    harness.dependencies,
    2_000 + WELCOME_ROLE_LATE_APPLY_GRACE_MS,
  );
  assert.deepEqual(preserved, { status: 'preserved', roleAbsent: false });
  assert.equal(harness.completed, true);
  assert.equal(harness.events.includes('delete'), false);
});

test('a late ambiguous DELETE is handed to a durable regrant after add authority returned', async () => {
  const dispatched = removalIntent({
    revision: 1,
    phase: 'dispatched',
    removalDispatchedAt: 2_000,
    updatedAt: 2_000,
    removalAttempts: 1,
  });
  const harness = removalHarness(dispatched, {
    authorityAllowed: false,
    regrantAuthorityAllowed: true,
    generationMatches: true,
    currentMembershipGeneration: '1234',
    rolePresent: true,
    roleRemovable: true,
  });

  await reconcileWelcomeAutoRoleRemovalIntent(
    dispatched,
    harness.dependencies,
    2_000 + WELCOME_ROLE_LATE_APPLY_GRACE_MS - 1,
  );
  harness.setState({ rolePresent: false });
  const recovered = await reconcileWelcomeAutoRoleRemovalIntent(
    harness.intent,
    harness.dependencies,
    2_000 + WELCOME_ROLE_LATE_APPLY_GRACE_MS,
  );

  assert.deepEqual(recovered, { status: 'regrant-pending', roleAbsent: true });
  assert.equal(harness.handedOff, true);
  assert.deepEqual(
    harness.events.filter((event) => event.startsWith('regrant-')),
    ['regrant-observed', 'regrant-handoff'],
  );
});

test('authority return with an absent role waits for DELETE grace before allowing a new add saga', async () => {
  const dispatched = removalIntent({
    revision: 1,
    phase: 'dispatched',
    removalDispatchedAt: 3_000,
    updatedAt: 3_000,
    removalAttempts: 1,
  });
  const harness = removalHarness(dispatched, {
    authorityAllowed: false,
    regrantAuthorityAllowed: true,
    generationMatches: true,
    currentMembershipGeneration: '1234',
    rolePresent: false,
    roleRemovable: true,
  });
  const waiting = await reconcileWelcomeAutoRoleRemovalIntent(
    dispatched,
    harness.dependencies,
    3_000 + WELCOME_ROLE_LATE_APPLY_GRACE_MS - 1,
  );
  assert.equal(waiting.status, 'pending');
  assert.equal(harness.completed, false);

  const released = await reconcileWelcomeAutoRoleRemovalIntent(
    dispatched,
    harness.dependencies,
    3_000 + WELCOME_ROLE_LATE_APPLY_GRACE_MS,
  );
  assert.deepEqual(released, { status: 'absent-settled', roleAbsent: true });
  assert.equal(harness.handedOff, false);
  assert.equal(harness.completed, true);
});

test('every real retry DELETE advances revision and starts a new independent grace', async () => {
  const first = removalIntent({
    revision: 1,
    phase: 'dispatched',
    removalDispatchedAt: 2_000,
    updatedAt: 2_000,
    removalAttempts: 1,
    regrant: { membershipGeneration: '1234', observedAt: 2_000 },
  });
  const harness = removalHarness(first, {
    authorityAllowed: true,
    regrantAuthorityAllowed: false,
    generationMatches: true,
    currentMembershipGeneration: '1234',
    rolePresent: true,
    roleRemovable: true,
  });
  harness.setDispatchAt(8_000);
  const retried = await reconcileWelcomeAutoRoleRemovalIntent(first, harness.dependencies, 8_000);
  assert.equal(retried.status, 'pending');
  assert.equal(harness.intent.revision, 2);
  assert.equal(harness.intent.removalAttempts, 2);
  assert.equal(harness.intent.removalDispatchedAt, 8_000);
  assert.equal(harness.intent.regrant, null);
  assert.equal(isWelcomeAutoRoleRemovalPastGrace(
    harness.intent,
    2_000 + WELCOME_ROLE_LATE_APPLY_GRACE_MS,
  ), false);
});

test('membership replacement can never receive a DELETE prepared for an older member generation', async () => {
  const dispatched = removalIntent({
    revision: 1,
    phase: 'dispatched',
    removalDispatchedAt: 2_000,
    updatedAt: 2_000,
    removalAttempts: 1,
  });
  const harness = removalHarness(dispatched, {
    authorityAllowed: true,
    regrantAuthorityAllowed: false,
    generationMatches: false,
    currentMembershipGeneration: '5678',
    rolePresent: true,
    roleRemovable: true,
  });
  const result = await reconcileWelcomeAutoRoleRemovalIntent(
    dispatched,
    harness.dependencies,
    2_000 + WELCOME_ROLE_LATE_APPLY_GRACE_MS,
  );
  assert.deepEqual(result, { status: 'preserved', roleAbsent: false });
  assert.equal(harness.events.includes('delete'), false);
});

test('old ambiguous DELETE hands an absent role to the fresh current membership', async () => {
  const dispatched = removalIntent({
    revision: 1,
    phase: 'dispatched',
    removalDispatchedAt: 2_000,
    updatedAt: 2_000,
    removalAttempts: 1,
  });
  const harness = removalHarness(dispatched, {
    authorityAllowed: false,
    regrantAuthorityAllowed: true,
    generationMatches: false,
    currentMembershipGeneration: '5678',
    rolePresent: false,
    roleRemovable: true,
  });
  const result = await reconcileWelcomeAutoRoleRemovalIntent(
    dispatched,
    harness.dependencies,
    2_000 + WELCOME_ROLE_LATE_APPLY_GRACE_MS,
  );
  assert.deepEqual(result, { status: 'regrant-pending', roleAbsent: true });
  assert.equal(harness.handoffGeneration, '5678');
});

test('cross-generation desired role proof follows the current membership, not DELETE origin', async () => {
  const dispatched = removalIntent({
    revision: 1,
    phase: 'dispatched',
    removalDispatchedAt: 2_000,
    updatedAt: 2_000,
    removalAttempts: 1,
  });
  const harness = removalHarness(dispatched, {
    authorityAllowed: false,
    regrantAuthorityAllowed: true,
    generationMatches: false,
    currentMembershipGeneration: '5678',
    rolePresent: true,
    roleRemovable: true,
  });
  await reconcileWelcomeAutoRoleRemovalIntent(
    dispatched,
    harness.dependencies,
    2_100,
  );
  assert.equal(harness.intent.regrant?.membershipGeneration, '5678');

  harness.setState({ rolePresent: false });
  const result = await reconcileWelcomeAutoRoleRemovalIntent(
    harness.intent,
    harness.dependencies,
    2_000 + WELCOME_ROLE_LATE_APPLY_GRACE_MS,
  );
  assert.equal(result.status, 'regrant-pending');
  assert.equal(harness.handoffGeneration, '5678');
});

test('crash with both removal and matching prepared grant completes handoff without duplicate ADD', async () => {
  const removal = removalIntent({
    revision: 2,
    phase: 'dispatched',
    removalDispatchedAt: 2_000,
    updatedAt: 2_100,
    removalAttempts: 1,
    regrant: { membershipGeneration: '5678', observedAt: 2_100 },
  });
  const preparedGrant = {
    version: 2 as const,
    token: 'prepared-handoff',
    revision: 0,
    guildId: 'guild',
    userId: 'user',
    roleId: 'auto-role',
    kind: 'auto' as const,
    policy: 'removal-recovery' as const,
    membershipGeneration: '5678',
    preexisting: false as const,
    phase: 'prepared' as const,
    preparedAt: 2_100,
    dispatchedAt: null,
    updatedAt: 2_100,
    dispatchAttempts: 0,
    removalDispatchedAt: null,
    removalAttempts: 0,
    compensationMembershipGeneration: null,
    compensationReason: null,
  };
  let prepares = 0;
  let completed = 0;
  const result = await commitWelcomeAutoRoleRegrantHandoff(removal, '5678', {
    readGrant: async () => preparedGrant,
    completePreparedGrant: async () => { throw new Error('must preserve matching grant'); },
    prepareGrant: async () => { prepares++; return preparedGrant; },
    assertRemovalCurrent: async () => undefined,
    completeRemoval: async () => { completed++; return true; },
  });
  assert.equal(result, true);
  assert.equal(prepares, 0);
  assert.equal(completed, 1);
});

test('removal terminal completion reloads policy and does not erase a changed claim', async () => {
  const dispatched = removalIntent({
    revision: 1,
    phase: 'dispatched',
    removalDispatchedAt: 2_000,
    updatedAt: 2_000,
    removalAttempts: 1,
  });
  const harness = removalHarness(dispatched, {
    authorityAllowed: true,
    regrantAuthorityAllowed: false,
    generationMatches: true,
    currentMembershipGeneration: '1234',
    rolePresent: false,
    roleRemovable: true,
  });
  let loads = 0;
  const dependencies = {
    ...harness.dependencies,
    async loadFreshState() {
      loads++;
      if (loads === 2) harness.setState({
        authorityAllowed: false,
        regrantAuthorityAllowed: true,
      });
      return { ...harness.state };
    },
  };
  const result = await reconcileWelcomeAutoRoleRemovalIntent(
    dispatched,
    dependencies,
    2_000 + WELCOME_ROLE_LATE_APPLY_GRACE_MS,
  );
  assert.equal(result.status, 'pending');
  assert.equal(harness.completed, false);
  assert.equal(loads, 2);
  const settled = await reconcileWelcomeAutoRoleRemovalIntent(
    dispatched,
    dependencies,
    2_000 + WELCOME_ROLE_LATE_APPLY_GRACE_MS,
  );
  assert.equal(settled.status, 'absent-settled');
  assert.equal(harness.completed, true);
});

test('normal removal intent persists dispatch and completion with exact token plus revision CAS', async () => {
  let claim: { key: string; scope: string; guildId: string; userId: string; metadata: unknown } | null = null;
  const expected = (where: { AND?: Array<{ metadata?: { equals?: unknown } }> }, index: number) =>
    where.AND?.[index]?.metadata?.equals;
  const database = {
    operationClaim: {
      async createMany({ data }: { data: Array<typeof claim & object> }) {
        if (claim) return { count: 0 };
        claim = data[0] as typeof claim;
        return { count: 1 };
      },
      async findUnique() { return claim; },
      async updateMany({ where, data }: {
        where: { AND?: Array<{ metadata?: { equals?: unknown } }> };
        data: { metadata: WelcomeAutoRoleRemovalIntent };
      }) {
        const current = parseWelcomeAutoRoleRemovalIntent(claim?.metadata);
        if (!current || expected(where, 0) !== current.token || expected(where, 1) !== current.revision) {
          return { count: 0 };
        }
        claim = { ...claim!, metadata: data.metadata };
        return { count: 1 };
      },
      async deleteMany({ where }: { where: { AND?: Array<{ metadata?: { equals?: unknown } }> } }) {
        const current = parseWelcomeAutoRoleRemovalIntent(claim?.metadata);
        if (!current || expected(where, 0) !== current.token || expected(where, 1) !== current.revision) {
          return { count: 0 };
        }
        claim = null;
        return { count: 1 };
      },
    },
  };
  const prepared = await prepareWelcomeAutoRoleRemovalIntent({
    guildId: 'guild',
    userId: 'user',
    roleId: 'auto-role',
    membershipGeneration: '1234',
  }, database as never, 1_000, 'durable-removal');
  assert.equal(prepared.created, true);
  assert.equal(claim?.scope, WELCOME_AUTO_ROLE_REMOVAL_SCOPE);
  assert.equal(claim?.key, welcomeAutoRoleRemovalIntentKey('guild', 'user'));

  const dispatched = await recordWelcomeAutoRoleRemovalDispatch(
    prepared.intent,
    database as never,
    2_000,
  );
  assert.equal(dispatched.revision, 1);
  assert.equal(dispatched.removalDispatchedAt, 2_000);
  const observed = await recordWelcomeAutoRoleRegrantObserved(
    dispatched,
    '1234',
    database as never,
    3_000,
  );
  assert.equal(observed.revision, 2);
  assert.equal(observed.regrant?.membershipGeneration, '1234');
  await assert.rejects(
    completeWelcomeAutoRoleRemovalIntent(prepared.intent, database as never),
    { name: 'WelcomeAutoRoleRemovalFencedError' },
  );
  await assert.rejects(
    completeWelcomeAutoRoleRemovalIntent(dispatched, database as never),
    { name: 'WelcomeAutoRoleRemovalFencedError' },
  );
  assert.equal(await completeWelcomeAutoRoleRemovalIntent(observed, database as never), true);
  assert.equal(claim, null);
});

test('legacy v1 removal regrant proof remains readable and is generation-tagged', () => {
  const current = removalIntent({
    revision: 2,
    phase: 'dispatched',
    removalDispatchedAt: 2_000,
    updatedAt: 2_100,
    removalAttempts: 1,
  });
  const legacy = {
    ...current,
    version: 1,
    regrantRequired: true,
  };
  delete (legacy as { regrant?: unknown }).regrant;
  const parsed = parseWelcomeAutoRoleRemovalIntent(legacy);
  assert.equal(parsed?.version, 2);
  assert.deepEqual(parsed?.regrant, {
    membershipGeneration: '1234',
    observedAt: 2_100,
  });
});
