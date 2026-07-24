import test from 'node:test';
import assert from 'node:assert/strict';
import { ChannelType } from 'discord.js';
import {
  assertStatusPanelPipelineSucceeded,
  isStatusPanelTextChannel,
  isOwnedStatusPanelMessageIdentity,
  parseStatusPanelAbsentState,
  shouldPurgeStatusPanelAbsentState,
  shouldReplaceStatusPanelRetry,
  statusPanelTrailingRetryDelay,
  statusPanelSquadSnapshot,
} from '../../src/modules/regbattle/statusPanelPolicy';

test('status panel channels are constrained to the expected guild and text type', () => {
  const valid = { type: ChannelType.GuildText, guildId: 'guild-a' };
  assert.equal(isStatusPanelTextChannel(valid, 'guild-a'), true);
  assert.equal(isStatusPanelTextChannel(valid, 'guild-b'), false);
  assert.equal(isStatusPanelTextChannel({ type: ChannelType.GuildVoice, guildId: 'guild-a' }, 'guild-a'), false);
  assert.equal(isStatusPanelTextChannel(null, 'guild-a'), false);
});

test('an exact panel reference cannot authorise a foreign or unrelated message', () => {
  const tokens = ['assembly panel'];
  const owned = { author: { id: 'bot' }, embeds: [{ title: '⚔️ Assembly Panel' }] };
  assert.equal(isOwnedStatusPanelMessageIdentity(owned, 'bot', tokens), true);
  assert.equal(isOwnedStatusPanelMessageIdentity({ ...owned, author: { id: 'user' } }, 'bot', tokens), false);
  assert.equal(
    isOwnedStatusPanelMessageIdentity({ author: { id: 'bot' }, embeds: [{ title: 'Moderation panel' }] }, 'bot', tokens),
    false,
  );
  assert.equal(isOwnedStatusPanelMessageIdentity(owned, undefined, tokens), false);
});

test('absentee state cannot carry accumulated time across a reset epoch', () => {
  const old = JSON.stringify({ epoch: '2026-07-19', acc: 120_000, onAt: 900_000 });
  assert.deepEqual(parseStatusPanelAbsentState(old, 1_000_000, '2026-07-20'), {
    epoch: '2026-07-20',
    acc: 0,
    onAt: null,
  });
});

test('legacy absentee state is adopted without a deployment-time time loss', () => {
  assert.deepEqual(
    parseStatusPanelAbsentState(JSON.stringify({ acc: 60_000, onAt: 900_000 }), 1_000_000, '2026-07-20'),
    { epoch: '2026-07-20', acc: 60_000, onAt: 900_000 },
  );
  assert.deepEqual(
    parseStatusPanelAbsentState('900000', 1_000_000, '2026-07-20'),
    { epoch: '2026-07-20', acc: 100_000, onAt: null },
  );
});

test('squad population snapshot is order-independent but detects authoritative changes', () => {
  const first = [
    { id: 'b', voiceChannelId: 'voice-b', airChannelId: null, ownerId: 'owner-b', number: 2 },
    { id: 'a', voiceChannelId: 'voice-a', airChannelId: 'air-a', ownerId: 'owner-a', number: 1 },
  ];
  const reordered = [first[1], first[0]];
  assert.equal(statusPanelSquadSnapshot(first), statusPanelSquadSnapshot(reordered));

  const remapped = [
    first[0],
    { ...first[1], airChannelId: 'air-new' },
  ];
  assert.notEqual(statusPanelSquadSnapshot(first), statusPanelSquadSnapshot(remapped));
  assert.notEqual(statusPanelSquadSnapshot(first), statusPanelSquadSnapshot(first.slice(0, 1)));
});

test('daily absentee purge preserves only valid state from the current reset epoch', () => {
  const current = '2026-07-20';
  assert.equal(shouldPurgeStatusPanelAbsentState(
    JSON.stringify({ epoch: current, acc: 60_000, onAt: 1_000_000 }),
    current,
  ), false);
  assert.equal(shouldPurgeStatusPanelAbsentState(
    JSON.stringify({ epoch: current, acc: 60_000, onAt: null }),
    current,
  ), false);
  assert.equal(shouldPurgeStatusPanelAbsentState(
    JSON.stringify({ epoch: '2026-07-19', acc: 60_000, onAt: null }),
    current,
  ), true);
  assert.equal(shouldPurgeStatusPanelAbsentState(
    JSON.stringify({ acc: 60_000, onAt: null }),
    current,
  ), true);
  assert.equal(shouldPurgeStatusPanelAbsentState('900000', current), true);
  assert.equal(shouldPurgeStatusPanelAbsentState(
    JSON.stringify({ epoch: current, acc: -1, onAt: null }),
    current,
  ), true);
  assert.equal(shouldPurgeStatusPanelAbsentState(null, current), false);
});

test('status panel retry coalescing keeps the earliest trailing repair', () => {
  assert.equal(shouldReplaceStatusPanelRetry(null, 2_000), true);
  assert.equal(shouldReplaceStatusPanelRetry(2_000, 1_500), true);
  assert.equal(shouldReplaceStatusPanelRetry(2_000, 2_000), false);
  assert.equal(shouldReplaceStatusPanelRetry(2_000, 2_500), false);
  assert.equal(statusPanelTrailingRetryDelay(1_000, 0, 15_000), 14_000);
  assert.equal(statusPanelTrailingRetryDelay(20_000, 0, 15_000), 1);
});

test('status panel pipeline validation catches resolved per-command Redis failures', () => {
  assert.doesNotThrow(() => assertStatusPanelPipelineSucceeded([
    [null, 'OK'],
    [null, 1],
  ], 2));
  assert.throws(
    () => assertStatusPanelPipelineSucceeded([[new Error('READONLY'), null]], 1),
    /pipeline command failed/i,
  );
  assert.throws(
    () => assertStatusPanelPipelineSucceeded([[null, null]], 1),
    /returned no result/i,
  );
  assert.throws(
    () => assertStatusPanelPipelineSucceeded(null, 1),
    /returned no replies/i,
  );
  assert.throws(
    () => assertStatusPanelPipelineSucceeded([[null, 'OK']], 2),
    /1\/2 replies/i,
  );
});
