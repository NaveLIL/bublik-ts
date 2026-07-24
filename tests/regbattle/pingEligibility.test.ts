import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildPbMassRoleMentionPlan,
  isPbIndividualEscalationReady,
  isPbIndividualPingEligible,
  isPbMassRoleMentionSafe,
  isPbVacationExcluded,
  type PbPingCandidate,
  type PbPingEligibilitySnapshot,
  type PbPingPolicy,
} from '../../src/modules/regbattle/pingEligibility';

const candidate: PbPingCandidate = {
  guildId: 'guild',
  userId: 'fighter',
  isBot: false,
  roleIds: new Set(['ping']),
  voiceChannelId: null,
};

const policy: PbPingPolicy = {
  pingRoleId: 'ping',
  playedTodayRoleId: 'played',
  pbChannelIds: new Set(['squad', 'reserve']),
};

const snapshot: PbPingEligibilitySnapshot = {
  guildId: 'guild',
  excludedUserIds: new Set(),
  vacationRoleId: 'vacation-role',
};

test('PB individual eligibility is fail-closed without a matching DB snapshot', () => {
  assert.equal(isPbIndividualPingEligible(candidate, policy, null), false);
  assert.equal(
    isPbIndividualPingEligible(candidate, policy, { ...snapshot, guildId: 'other' }),
    false,
  );
});

test('regular or NS vacation snapshot excludes an otherwise eligible fighter', () => {
  assert.equal(
    isPbIndividualPingEligible(candidate, policy, {
      ...snapshot,
      excludedUserIds: new Set([candidate.userId]),
    }),
    false,
  );
});

test('actual vacation role excludes a fighter even without a live DB row', () => {
  assert.equal(
    isPbIndividualPingEligible(
      { ...candidate, roleIds: new Set(['ping', 'vacation-role']) },
      policy,
      snapshot,
    ),
    false,
  );
});

test('shared vacation predicate is fail-closed and catches durable or role-only leave', () => {
  assert.equal(isPbVacationExcluded(candidate, null), true);
  assert.equal(isPbVacationExcluded(candidate, { ...snapshot, guildId: 'other' }), true);
  assert.equal(isPbVacationExcluded(candidate, snapshot), false);
  assert.equal(isPbVacationExcluded(candidate, {
    ...snapshot,
    excludedUserIds: new Set([candidate.userId]),
  }), true);
  assert.equal(isPbVacationExcluded({
    ...candidate,
    roleIds: new Set(['ping', 'vacation-role']),
  }, snapshot), true);
});

test('shared policy also rejects bots, played fighters, PB occupants and missing ping role', () => {
  assert.equal(isPbIndividualPingEligible({ ...candidate, isBot: true }, policy, snapshot), false);
  assert.equal(
    isPbIndividualPingEligible(
      { ...candidate, roleIds: new Set(['ping', 'played']) },
      policy,
      snapshot,
    ),
    false,
  );
  assert.equal(
    isPbIndividualPingEligible({ ...candidate, voiceChannelId: 'reserve' }, policy, snapshot),
    false,
  );
  assert.equal(
    isPbIndividualPingEligible({ ...candidate, roleIds: new Set() }, policy, snapshot),
    false,
  );
  assert.equal(isPbIndividualPingEligible(candidate, policy, snapshot), true);
});

test('mass role mentions fail closed on vacation role drift or an incomplete snapshot', () => {
  const unavailable = { ...snapshot, excludedUserIds: new Set(['vacationer']) };
  assert.equal(isPbMassRoleMentionSafe(null, new Map()), false);
  assert.equal(isPbMassRoleMentionSafe(unavailable, new Map()), false);
  assert.equal(isPbMassRoleMentionSafe(unavailable, new Map([['vacationer', true]])), false);
  assert.equal(isPbMassRoleMentionSafe(unavailable, new Map([['vacationer', false]])), true);
});

test('mass role mention allows exactly one configured role for a fully eligible population', () => {
  assert.deepEqual(
    buildPbMassRoleMentionPlan(policy, snapshot, new Map(), [candidate], true),
    {
      content: '<@&ping>',
      allowedMentions: {
        parse: [],
        roles: ['ping'],
        users: [],
        repliedUser: false,
      },
    },
  );
});

test('mass role mention fails closed for every unsafe role-population drift', () => {
  const unavailable = {
    ...snapshot,
    excludedUserIds: new Set(['vacationer']),
  };
  const cases: Array<{
    name: string;
    snapshot: PbPingEligibilitySnapshot | null;
    state: ReadonlyMap<string, boolean>;
    members: PbPingCandidate[];
  }> = [
    { name: 'missing snapshot', snapshot: null, state: new Map(), members: [candidate] },
    {
      name: 'cross-guild snapshot',
      snapshot: { ...snapshot, guildId: 'other' },
      state: new Map(),
      members: [candidate],
    },
    { name: 'incomplete unavailable state', snapshot: unavailable, state: new Map(), members: [candidate] },
    {
      name: 'vacationer still has ping role',
      snapshot: unavailable,
      state: new Map([['vacationer', true]]),
      members: [{ ...candidate, userId: 'vacationer' }],
    },
    {
      name: 'vacation role without DB row',
      snapshot,
      state: new Map(),
      members: [{ ...candidate, roleIds: new Set(['ping', 'vacation-role']) }],
    },
    {
      name: 'played role drift',
      snapshot,
      state: new Map(),
      members: [{ ...candidate, roleIds: new Set(['ping', 'played']) }],
    },
    {
      name: 'PB occupant drift',
      snapshot,
      state: new Map(),
      members: [{ ...candidate, voiceChannelId: 'squad' }],
    },
    {
      name: 'bot role holder',
      snapshot,
      state: new Map(),
      members: [{ ...candidate, isBot: true }],
    },
  ];

  for (const unsafe of cases) {
    assert.equal(
      buildPbMassRoleMentionPlan(policy, unsafe.snapshot, unsafe.state, unsafe.members, true),
      null,
      unsafe.name,
    );
  }
  assert.equal(buildPbMassRoleMentionPlan(policy, snapshot, new Map(), [], true), null);
  assert.equal(buildPbMassRoleMentionPlan(policy, snapshot, new Map(), [candidate], false), null);
});

test('unsafe mass-mention fallback cannot bypass the individual-ping cooldown', () => {
  const thirtyMinutes = 30 * 60_000;
  const endedAt = 10_000;
  assert.equal(isPbIndividualEscalationReady(endedAt + thirtyMinutes - 1, endedAt), false);
  assert.equal(isPbIndividualEscalationReady(endedAt + thirtyMinutes, endedAt), true);
  assert.equal(isPbIndividualEscalationReady(endedAt - 1, endedAt), false);
  assert.equal(isPbIndividualEscalationReady(Number.NaN, endedAt), false);
  assert.equal(isPbIndividualEscalationReady(endedAt, endedAt, 0), false);
});
