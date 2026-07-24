import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildMarkedChannelName,
  creationMarkerSuffix,
  parseTempVoiceCreationIntent,
  type TempVoiceCreationIntent,
} from '../../src/modules/tempvoice/creationRecovery';
import { getSchedulerStats } from '../../src/core/SchedulerManager';

function intent(marker = 'abc123'): TempVoiceCreationIntent {
  const desiredName = 'Личный голосовой канал';
  return {
    version: 1,
    token: 'token',
    guildId: 'guild',
    ownerId: 'owner',
    generatorId: 'generator',
    categoryId: 'category',
    marker,
    desiredName,
    markedName: buildMarkedChannelName(desiredName, marker),
    channelId: null,
    preparedAt: 1,
  };
}

test('creation marker survives Discord channel-name truncation', () => {
  const marker = 'unique1234';
  const marked = buildMarkedChannelName('x'.repeat(200), marker);
  assert.equal(marked.length <= 100, true);
  assert.equal(marked.endsWith(creationMarkerSuffix(marker)), true);
  assert.notEqual(creationMarkerSuffix('one'), creationMarkerSuffix('two'));
});

test('creation intent parser accepts exact markers and rejects malformed metadata', () => {
  const value = intent();
  assert.deepEqual(parseTempVoiceCreationIntent(JSON.parse(JSON.stringify(value))), value);
  assert.equal(parseTempVoiceCreationIntent({ ...value, markedName: 'unmarked' }), null);
  assert.equal(parseTempVoiceCreationIntent({ ...value, token: '' }), null);
  assert.equal(parseTempVoiceCreationIntent({ ...value, preparedAt: Number.NaN }), null);
});

test('importing creation recovery does not start the TempVoice runtime timer', () => {
  assert.equal(
    getSchedulerStats().some(({ name }) => name === 'tempvoice:rateLimitCleanup'),
    false,
  );
});
