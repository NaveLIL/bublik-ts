import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildPendingVoiceSettlement,
  isPendingVoiceSettlement,
  isTempVoiceRewardGrantPending,
  isUnknownChannelError,
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
