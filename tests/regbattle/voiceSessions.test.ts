import test from 'node:test';
import assert from 'node:assert/strict';
import {
  type PbVoiceSession,
  applySessionEndRoles,
  applySessionRoles,
  buildPlayedOrigin,
  buildPlayedResetRoleIds,
  buildSessionEndPlan,
  buildTeamSessionReturnRoleIds,
  canCarrySessionTo,
  hasPbRoleProvenance,
  shouldCleanupInviteOnTransition,
  suppressSessionForVacation,
} from '../../src/modules/regbattle/voiceSessions';

function session(
  source: PbVoiceSession['source'],
  returnRoleIds: string[],
  eligibilityRoleId: string | null = null,
): PbVoiceSession {
  return {
    version: 2,
    hadPingRole: returnRoleIds.includes('ping'),
    hadPlayedRole: returnRoleIds.includes('played'),
    guildId: 'guild',
    userId: 'user',
    joinedAt: 1,
    source,
    status: 'active',
    currentChannelId: 'voice',
    currentChannelKind: 'regular',
    squadId: 'squad',
    squadVoiceId: 'voice',
    teamId: source === 'team' ? 'team' : null,
    returnRoleIds,
    eligibilityRoleId,
    inviteSquadVoiceId: source === 'invite' ? 'voice' : null,
    inSquadRoleId: 'in',
    pingRoleId: 'ping',
    playedTodayRoleId: 'played',
    playedMinMinutes: 15,
    playedResetRoleIds: [],
  };
}

test('short ping session restores only its proven ping role', () => {
  const plan = buildSessionEndPlan(session('ping', ['ping'], 'ping'), 'in', 'ping', 'played', false);
  assert.deepEqual(plan.removeRoleIds, ['in']);
  assert.deepEqual(plan.addRoleIds, ['ping']);
  assert.equal(plan.shouldMarkPlayed, false);
});

test('long ping session converts ping to played and records reset provenance', () => {
  const value = session('ping', ['ping'], 'ping');
  const plan = buildSessionEndPlan(value, 'in', 'ping', 'played', true);
  assert.deepEqual(plan.addRoleIds, ['played']);
  assert.equal(plan.shouldMarkPlayed, true);
  assert.deepEqual(buildPlayedResetRoleIds(buildPlayedOrigin(value, 'ping')), ['ping']);
});

test('played source cannot be downgraded to ping on a short leave', () => {
  const plan = buildSessionEndPlan(session('played', ['played']), 'in', 'ping', 'played', false);
  assert.deepEqual(plan.addRoleIds, ['played']);
  assert.equal(plan.shouldMarkPlayed, false);
});

test('team session restores exact team role and suppresses ping after a long battle', () => {
  const plan = buildSessionEndPlan(
    session('team', ['team-role', 'ping'], 'team-role'),
    'in',
    'ping',
    'played',
    true,
  );
  assert.deepEqual(new Set(plan.addRoleIds), new Set(['team-role', 'played']));
  assert.deepEqual(buildPlayedResetRoleIds(buildPlayedOrigin(session('team', ['team-role']), 'ping')), []);
});

test('invited guest with ping provenance never receives a team role', () => {
  const value = session('invite', ['ping'], 'ping');
  const plan = buildSessionEndPlan(value, 'in', 'ping', 'played', true);
  assert.deepEqual(plan.addRoleIds, ['played']);
  assert.equal(plan.addRoleIds.includes('team-role'), false);
  assert.deepEqual(buildPlayedResetRoleIds(buildPlayedOrigin(value, 'ping')), ['ping']);
});

test('team/invite session preserves reset provenance inherited from playedToday', () => {
  const value = { ...session('team', ['team-role', 'played'], 'team-role'), playedResetRoleIds: ['ping'] };
  assert.deepEqual(buildPlayedResetRoleIds(buildPlayedOrigin(value, 'ping')), ['ping']);
});

test('team, invite and commander access cannot start rotation without ping/played provenance', () => {
  assert.equal(hasPbRoleProvenance(false, false), false);
  assert.equal(hasPbRoleProvenance(true, false), true);
  assert.equal(hasPbRoleProvenance(false, true), true);
});

test('team membership cannot manufacture a team role that was absent on entry', () => {
  assert.deepEqual(
    buildTeamSessionReturnRoleIds('team-role', false, 'played', true, 'ping', true),
    ['played', 'ping'],
  );
  assert.deepEqual(
    buildTeamSessionReturnRoleIds('team-role', true, 'played', false, 'ping', true),
    ['team-role', 'ping'],
  );
});

test('legacy played role without provenance cannot manufacture a ping role at reset', () => {
  assert.deepEqual(buildPlayedResetRoleIds(null), []);
});

test('legacy v1 access-only sessions finish without a played award or invented roles', () => {
  const current = session('team', ['team-role'], 'team-role');
  const { hadPingRole: _hadPingRole, hadPlayedRole: _hadPlayedRole, ...legacyBase } = current;
  const legacyTeam: PbVoiceSession = { ...legacyBase, version: 1 };
  const teamPlan = buildSessionEndPlan(legacyTeam, 'in', 'ping', 'played', true);
  assert.deepEqual(teamPlan.removeRoleIds, ['in']);
  assert.deepEqual(teamPlan.addRoleIds, ['team-role']);
  assert.equal(teamPlan.shouldMarkPlayed, false);

  const legacyInvite: PbVoiceSession = {
    ...legacyBase,
    version: 1,
    source: 'invite',
    eligibilityRoleId: null,
    returnRoleIds: ['ping', 'played'],
  };
  const invitePlan = buildSessionEndPlan(legacyInvite, 'in', 'ping', 'played', true);
  assert.deepEqual(invitePlan.removeRoleIds, ['in']);
  assert.deepEqual(invitePlan.addRoleIds, []);
  assert.equal(invitePlan.shouldMarkPlayed, false);
});

test('legacy v1 sessions cannot replay entry role mutations', async () => {
  const current = session('team', ['team-role', 'ping'], 'team-role');
  const { hadPingRole: _hadPingRole, hadPlayedRole: _hadPlayedRole, ...legacyBase } = current;
  const legacy: PbVoiceSession = { ...legacyBase, version: 1 };
  let mutations = 0;
  const member = {
    id: 'user',
    guild: { id: 'guild' },
    user: { tag: 'user' },
    roles: {
      cache: new Map([['team-role', {}], ['ping', {}]]),
      add: async () => { mutations++; },
      remove: async () => { mutations++; },
    },
  } as unknown as Parameters<typeof applySessionRoles>[0];

  assert.equal(await applySessionRoles(member, legacy, 'in'), false);
  assert.equal(mutations, 0);
});

test('voice fence aborts an entry rotation immediately before Discord mutation', async () => {
  let checks = 0;
  let mutations = 0;
  const member = {
    id: 'user',
    guild: { id: 'guild' },
    user: { tag: 'user' },
    roles: {
      cache: new Map([['ping', {}]]),
      add: async () => { mutations++; },
      remove: async () => { mutations++; },
    },
  } as unknown as Parameters<typeof applySessionRoles>[0];

  await assert.rejects(
    applySessionRoles(member, session('ping', ['ping'], 'ping'), null, undefined, () => {
      checks++;
      if (checks === 2) throw new Error('stale voice');
    }),
    /stale voice/,
  );
  assert.equal(mutations, 0);
});

test('voice fence aborts an end rotation immediately before Discord mutation', async () => {
  let checks = 0;
  let mutations = 0;
  const member = {
    id: 'user',
    guild: { id: 'guild' },
    user: { tag: 'user' },
    roles: {
      cache: new Map([['in', {}]]),
      add: async () => { mutations++; },
      remove: async () => { mutations++; },
    },
  } as unknown as Parameters<typeof applySessionEndRoles>[0];

  await assert.rejects(
    applySessionEndRoles(member, {
      removeRoleIds: ['in'],
      addRoleIds: [],
      shouldMarkPlayed: false,
    }, undefined, () => {
      checks++;
      if (checks === 2) throw new Error('stale voice');
    }),
    /stale voice/,
  );
  assert.equal(mutations, 0);
});

test('no-op Discord role state still verifies the member-role lease', async () => {
  let leaseChecks = 0;
  const member = {
    id: 'user',
    guild: { id: 'guild' },
    user: { tag: 'user' },
    roles: {
      cache: new Map(),
      add: async () => undefined,
      remove: async () => undefined,
    },
  } as unknown as Parameters<typeof applySessionRoles>[0];
  const lock: NonNullable<Parameters<typeof applySessionRoles>[3]> = {
    assertOwned: async () => { leaseChecks++; },
    setRedisValue: async () => undefined,
    deleteRedisKey: async () => undefined,
    deleteRedisKeys: async () => undefined,
  };

  assert.equal(
    await applySessionRoles(member, session('ping', ['ping'], 'ping'), null, lock),
    true,
  );
  assert.equal(leaseChecks, 2);
});

test('lease loss after Discord REST escapes and leaves durable recovery to the caller', async () => {
  let leaseChecks = 0;
  let removals = 0;
  const member = {
    id: 'user',
    guild: { id: 'guild' },
    user: { tag: 'user' },
    roles: {
      cache: new Map([['ping', {}]]),
      add: async () => undefined,
      remove: async () => { removals++; },
    },
  } as unknown as Parameters<typeof applySessionRoles>[0];
  const lock: NonNullable<Parameters<typeof applySessionRoles>[3]> = {
    assertOwned: async () => {
      leaseChecks++;
      if (leaseChecks === 3) throw new Error('member role lock was lost');
    },
    setRedisValue: async () => undefined,
    deleteRedisKey: async () => undefined,
    deleteRedisKeys: async () => undefined,
  };

  await assert.rejects(
    applySessionRoles(member, session('ping', ['ping'], 'ping'), null, lock),
    /lock was lost/,
  );
  assert.equal(removals, 1);
});

test('entry rotation is fail-fast and never grants in-squad after provenance removal fails', async () => {
  let additions = 0;
  let removals = 0;
  const member = {
    id: 'user',
    guild: { id: 'guild' },
    user: { tag: 'user' },
    roles: {
      cache: new Map([['ping', {}]]),
      add: async () => { additions++; },
      remove: async () => {
        removals++;
        throw new Error('Discord unavailable');
      },
    },
  } as unknown as Parameters<typeof applySessionRoles>[0];

  assert.equal(
    await applySessionRoles(member, session('ping', ['ping'], 'ping'), 'in'),
    false,
  );
  assert.equal(removals, 1);
  assert.equal(additions, 0);
});

test('end rotation is fail-fast and never restores provenance before in-squad removal', async () => {
  let additions = 0;
  let removals = 0;
  const member = {
    id: 'user',
    guild: { id: 'guild' },
    user: { tag: 'user' },
    roles: {
      cache: new Map([['in', {}]]),
      add: async () => { additions++; },
      remove: async () => {
        removals++;
        throw new Error('Discord unavailable');
      },
    },
  } as unknown as Parameters<typeof applySessionEndRoles>[0];

  assert.equal(await applySessionEndRoles(member, {
    removeRoleIds: ['in'],
    addRoleIds: ['ping'],
    shouldMarkPlayed: false,
  }), false);
  assert.equal(removals, 1);
  assert.equal(additions, 0);
});

test('generic ping or played provenance cannot cross into a private team voice', () => {
  const destination = { teamId: 'private-team', squadVoiceId: 'private-voice' };
  assert.equal(canCarrySessionTo(session('ping', ['ping']), destination), false);
  assert.equal(canCarrySessionTo(session('played', ['played']), destination), false);
});

test('private team voice carries only exact team membership or exact invite', () => {
  const teamSession = session('team', ['team-role']);
  teamSession.teamId = 'team-a';
  assert.equal(
    canCarrySessionTo(teamSession, { teamId: 'team-a', squadVoiceId: 'voice-a' }),
    true,
  );
  assert.equal(
    canCarrySessionTo(teamSession, { teamId: 'team-b', squadVoiceId: 'voice-b' }),
    false,
  );

  const inviteSession = session('invite', []);
  inviteSession.inviteSquadVoiceId = 'voice-a';
  assert.equal(
    canCarrySessionTo(inviteSession, { teamId: 'team-a', squadVoiceId: 'voice-a' }),
    true,
  );
  assert.equal(
    canCarrySessionTo(inviteSession, { teamId: 'team-a', squadVoiceId: 'voice-b' }),
    false,
  );
});

test('vacation suppression preserves ping provenance but can never award stale played-today', () => {
  const value = session('played', ['played']);
  value.playedResetRoleIds = ['ping'];
  const suppressed = suppressSessionForVacation(value, 123_456);

  assert.equal(suppressed.status, 'ending');
  assert.equal(suppressed.endedAt, 123_456);
  assert.equal(suppressed.awardPlayed, false);
  assert.equal(suppressed.returnRoleIds.includes('played'), false);
  assert.equal(suppressed.returnRoleIds.includes('ping'), true);

  const plan = buildSessionEndPlan(
    suppressed,
    'in',
    'ping',
    'played',
    suppressed.awardPlayed ?? true,
  );
  assert.deepEqual(plan.addRoleIds, ['ping']);
  assert.equal(plan.shouldMarkPlayed, false);
});

test('vacation suppression keeps the first frozen PB timestamp on retries', () => {
  const first = suppressSessionForVacation(session('ping', ['ping']), 100_000);
  const retried = suppressSessionForVacation(first, 900_000);
  assert.equal(first.endedAt, 100_000);
  assert.equal(retried.endedAt, 100_000);
});

test('vacation suppression strips stale played-today even from a legacy v1 session', () => {
  const current = session('played', ['played']);
  const { hadPingRole: _hadPingRole, hadPlayedRole: _hadPlayedRole, ...legacyBase } = current;
  const legacy: PbVoiceSession = { ...legacyBase, version: 1, eligibilityRoleId: 'played' };
  const suppressed = suppressSessionForVacation(legacy);
  const plan = buildSessionEndPlan(suppressed, 'in', 'ping', 'played', false);
  assert.deepEqual(suppressed.returnRoleIds, []);
  assert.deepEqual(plan.addRoleIds, []);
  assert.equal(plan.shouldMarkPlayed, false);
});

test('an exact squad invite survives main-air moves and is cleaned on squad exit', () => {
  assert.equal(shouldCleanupInviteOnTransition(null, 'squad-a'), false);
  assert.equal(shouldCleanupInviteOnTransition('squad-a', 'squad-a'), false);
  assert.equal(shouldCleanupInviteOnTransition('squad-a', 'squad-b'), true);
  assert.equal(shouldCleanupInviteOnTransition('squad-a', null), true);
});
