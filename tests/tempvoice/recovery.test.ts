import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildPendingVoiceSettlement,
  isPendingVoiceSettlement,
  isTempVoiceRewardGrantPending,
  isUnknownChannelError,
  MissingRewardRoleRetryGate,
  pendingVoiceSettlementKey,
} from '../../src/modules/tempvoice/recovery';

const session = {
  sessionId: 'guild:user/channel:session',
  joinedAt: 1_000_000,
  channelId: 'voice-1',
  generatorId: 'generator-1',
};

test('voice settlement contains only completed whole minutes', () => {
  assert.equal(buildPendingVoiceSettlement('guild', 'user', session, session.joinedAt + 59_999), null);

  const pending = buildPendingVoiceSettlement(
    'guild',
    'user',
    session,
    session.joinedAt + 125_999,
  );
  assert.ok(pending);
  assert.equal(pending.minutes, 2);
  assert.equal(pending.sessionId, session.sessionId);
  assert.equal(isPendingVoiceSettlement(pending), true);
});

test('settlement validator rejects malformed or non-positive accounting rows', () => {
  const pending = buildPendingVoiceSettlement(
    'guild',
    'user',
    session,
    session.joinedAt + 60_000,
  );
  assert.ok(pending);
  assert.equal(isPendingVoiceSettlement({ ...pending, minutes: 0 }), false);
  assert.equal(isPendingVoiceSettlement({ ...pending, guildId: '' }), false);
  assert.equal(isPendingVoiceSettlement('{"minutes":1}'), false);
});

test('only Discord Unknown Channel is treated as confirmed deletion', () => {
  assert.equal(isUnknownChannelError({ code: 10_003 }), true);
  assert.equal(isUnknownChannelError({ rawError: { code: '10003' } }), true);
  assert.equal(isUnknownChannelError({ cause: { code: 10_003 } }), true);
  assert.equal(isUnknownChannelError({ code: 50_013 }), false);
  assert.equal(isUnknownChannelError(new Error('network timeout')), false);
});

test('earned TempVoice reward remains pending until its durable grant marker exists', () => {
  assert.equal(isTempVoiceRewardGrantPending('reward-role', 300, 299, false), false);
  assert.equal(isTempVoiceRewardGrantPending('reward-role', 300, 300, false), true);
  assert.equal(isTempVoiceRewardGrantPending('reward-role', 300, 600, true), false);
  assert.equal(isTempVoiceRewardGrantPending(null, 300, 600, false), false);
});

test('pending settlement keys safely encode legacy session identifiers', () => {
  assert.equal(
    pendingVoiceSettlementKey(session.sessionId),
    'tempvoice:pending-settlement:guild%3Auser%2Fchannel%3Asession',
  );
});

test('missing TempVoice reward role quarantines one generator configuration', () => {
  const gate = new MissingRewardRoleRetryGate(100, 800);
  const key = 'guild:generator';

  assert.equal(gate.canAttempt(key, 'deleted-role', 1_000), true);
  const first = gate.quarantine(key, 'deleted-role', 1_000);
  assert.deepEqual(first, {
    roleId: 'deleted-role',
    failures: 1,
    retryAt: 1_100,
  });
  assert.equal(gate.canAttempt(key, 'deleted-role', 1_099), false);
  assert.equal(gate.canAttempt(key, 'deleted-role', 1_100), true);
});

test('missing reward role retries use bounded exponential backoff', () => {
  const gate = new MissingRewardRoleRetryGate(100, 400);
  const key = 'guild:generator';

  assert.equal(gate.quarantine(key, 'deleted-role', 1_000).retryAt, 1_100);
  assert.equal(gate.quarantine(key, 'deleted-role', 2_000).retryAt, 2_200);
  assert.equal(gate.quarantine(key, 'deleted-role', 3_000).retryAt, 3_400);
  assert.equal(gate.quarantine(key, 'deleted-role', 4_000).retryAt, 4_400);
});

test('fixing reward role configuration bypasses quarantine immediately', () => {
  const gate = new MissingRewardRoleRetryGate(10_000, 10_000);
  const key = 'guild:generator';

  gate.quarantine(key, 'deleted-role', 1_000);
  assert.equal(gate.canAttempt(key, 'deleted-role', 1_001), false);
  assert.equal(gate.canAttempt(key, 'replacement-role', 1_001), true);

  gate.quarantine(key, 'replacement-role', 2_000);
  gate.release(key, 'replacement-role');
  assert.equal(gate.canAttempt(key, 'replacement-role', 2_001), true);
});
