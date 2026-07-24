import test from 'node:test';
import assert from 'node:assert/strict';
import {
  completeVoicePresenceTransitionAfterWrite,
  completeVoiceRuntimeRecoveryAfterReset,
  crossedPbTierThreshold,
  deleteAllOwnedVoicePresenceObservations,
  deleteOwnedVoicePresenceObservationsForGuilds,
  isVoicePayoutAfkState,
  isVoicePresenceObservationEligible,
  parseOwnedVoicePresenceKey,
  parseVoicePresenceObservation,
  runVoiceTasksWithConcurrency,
  VoicePayoutRuntimeGate,
  VoiceCoalescedRecoveryPump,
  VoicePresenceContinuityGuard,
  VoiceSerializedWorkQueue,
  voicePresenceOwnedKey,
  voicePresenceTransitionAction,
} from '../voice-tracker';

async function openHealthyGate(gate: VoicePayoutRuntimeGate, shardId: number): Promise<void> {
  const tokens = [
    gate.beginRedisRecovery(),
    gate.beginShardRecovery(shardId),
  ];
  await completeVoiceRuntimeRecoveryAfterReset(gate, tokens, async () => undefined);
}

test('shard disconnect immediately invalidates a captured payout snapshot', async () => {
  const gate = new VoicePayoutRuntimeGate();
  gate.reset();
  await openHealthyGate(gate, 3);
  const beforeDisconnect = gate.capture(3);
  assert.ok(beforeDisconnect);

  gate.blockShard(3);

  assert.equal(gate.capture(3), null);
  assert.equal(gate.isCurrent(beforeDisconnect), false);
});

test('resume reset failure leaves the shard blocked until a later successful reset', async () => {
  const gate = new VoicePayoutRuntimeGate();
  gate.reset();
  await openHealthyGate(gate, 7);

  const failedResume = gate.beginShardRecovery(7);
  await assert.rejects(
    completeVoiceRuntimeRecoveryAfterReset(gate, [failedResume], async () => {
      throw new Error('redis_pipeline_failed');
    }),
    /redis_pipeline_failed/,
  );
  assert.equal(gate.capture(7), null);

  const successfulRetry = gate.beginShardRecovery(7);
  await completeVoiceRuntimeRecoveryAfterReset(gate, [successfulRetry], async () => undefined);
  assert.ok(gate.capture(7));
});

test('Redis reconnect invalidates snapshots and only a successful rebuild reopens payouts', async () => {
  const gate = new VoicePayoutRuntimeGate();
  gate.reset();
  await openHealthyGate(gate, 1);
  const beforeReconnect = gate.capture(1);
  assert.ok(beforeReconnect);

  gate.blockRedis();
  assert.equal(gate.capture(1), null);
  assert.equal(gate.isCurrent(beforeReconnect), false);

  const reconnect = gate.beginRedisRecovery();
  await completeVoiceRuntimeRecoveryAfterReset(gate, [reconnect], async () => undefined);
  assert.ok(gate.capture(1));
});

test('Redis recovery cannot reopen a Discord shard that is still disconnected', async () => {
  const gate = new VoicePayoutRuntimeGate();
  gate.reset();
  await openHealthyGate(gate, 5);
  gate.blockShard(5);
  gate.blockRedis();

  const redisRecovery = gate.beginRedisRecovery();
  await completeVoiceRuntimeRecoveryAfterReset(gate, [redisRecovery], async () => undefined);

  assert.equal(gate.capture(5), null);
  const shardRecovery = gate.beginShardRecovery(5);
  await completeVoiceRuntimeRecoveryAfterReset(gate, [shardRecovery], async () => undefined);
  assert.ok(gate.capture(5));
});

test('guild unavailability invalidates only that guild and reset success reopens it', async () => {
  const gate = new VoicePayoutRuntimeGate();
  gate.reset();
  await openHealthyGate(gate, 2);
  const affected = gate.capture(2, 'guild-a');
  const sibling = gate.capture(2, 'guild-b');
  assert.ok(affected);
  assert.ok(sibling);

  gate.blockGuild('guild-a');
  assert.equal(gate.capture(2, 'guild-a'), null);
  assert.equal(gate.isCurrent(affected), false);
  assert.equal(gate.isCurrent(sibling), true);

  const failed = gate.beginGuildRecovery('guild-a');
  await assert.rejects(
    completeVoiceRuntimeRecoveryAfterReset(gate, [failed], async () => {
      throw new Error('guild_reset_failed');
    }),
    /guild_reset_failed/,
  );
  assert.equal(gate.capture(2, 'guild-a'), null);

  const successful = gate.beginGuildRecovery('guild-a');
  await completeVoiceRuntimeRecoveryAfterReset(gate, [successful], async () => undefined);
  assert.ok(gate.capture(2, 'guild-a'));
});

test('same-channel Discord session replacement cannot reuse an old Redis observation', () => {
  const observation = parseVoicePresenceObservation({
    version: 4,
    ownerId: 'owner-0123456789abcdef',
    channelId: 'voice-1',
    sessionId: 'session-old',
    observedAtMs: 1_000_000,
    generation: '01234567-89ab-cdef-0123-456789abcdef',
  });
  assert.ok(observation);
  assert.equal(
    isVoicePresenceObservationEligible(
      observation,
      'voice-1',
      'session-new',
      2_000_000,
      600_000,
    ),
    false,
  );
  assert.equal(
    isVoicePresenceObservationEligible(
      observation,
      'voice-1',
      'session-old',
      2_000_000,
      600_000,
      'different-owner-0123456789',
    ),
    false,
  );
  assert.equal(
    voicePresenceTransitionAction(
      'voice-1',
      'voice-1',
      false,
      false,
      'session-old',
      'session-new',
    ),
    'reset',
  );
  assert.equal(parseVoicePresenceObservation({
    version: 3,
    ownerId: 'owner-0123456789abcdef',
    channelId: 'voice-1',
    observedAtMs: 1_000_000,
    generation: '01234567-89ab-cdef-0123-456789abcdef',
  }), null);
});

test('failed transition remains quarantined until the matching write succeeds', async () => {
  const guard = new VoicePresenceContinuityGuard();
  const first = guard.quarantine('guild:user');
  assert.equal(guard.isQuarantined('guild:user'), true);

  await assert.rejects(
    completeVoicePresenceTransitionAfterWrite(
      guard,
      'guild:user',
      first,
      async () => { throw new Error('redis_write_failed'); },
    ),
    /redis_write_failed/,
  );
  assert.equal(guard.isQuarantined('guild:user'), true);

  // A newer transition supersedes the failed one; its late completion cannot
  // clear the quarantine that protects the current Discord state.
  const second = guard.quarantine('guild:user');
  assert.equal(guard.release('guild:user', first), false);
  assert.equal(guard.isQuarantined('guild:user'), true);
  assert.equal(guard.release('guild:user', second), true);
  assert.equal(guard.isQuarantined('guild:user'), false);
});

test('authoritative reset releases only snapshotted quarantine generations', () => {
  const guard = new VoicePresenceContinuityGuard();
  const oldToken = guard.quarantine('guild:old-user');
  guard.quarantine('guild:new-user');
  const snapshot = guard.snapshot((key) => key.startsWith('guild:'));
  assert.equal(snapshot.get('guild:old-user'), oldToken);

  const replacement = guard.quarantine('guild:old-user');
  assert.equal(guard.releaseSnapshot(snapshot), 1);
  assert.equal(guard.currentToken('guild:old-user'), replacement);
  assert.equal(guard.isQuarantined('guild:new-user'), false);
});

test('voice observation cleanup scans once and cannot cross process owners or guilds', async () => {
  const owner = 'owner-0123456789abcdef';
  const foreignOwner = 'owner-fedcba9876543210';
  const ownA = voicePresenceOwnedKey(owner, 'guild-a', 'user-1');
  const ownB = voicePresenceOwnedKey(owner, 'guild-b', 'user-2');
  const ownC = voicePresenceOwnedKey(owner, 'guild-c', 'user-3');
  const foreignA = voicePresenceOwnedKey(foreignOwner, 'guild-a', 'user-4');
  const pages = [
    ['1', [ownA, ownC, foreignA]],
    ['0', [ownB]],
  ] as const;
  let scanCalls = 0;
  const deleted: string[] = [];
  const redis = {
    async scan() {
      return pages[scanCalls++];
    },
    async del(...keys: string[]) {
      deleted.push(...keys);
      return keys.length;
    },
  } as unknown as Parameters<typeof deleteOwnedVoicePresenceObservationsForGuilds>[0];

  await deleteOwnedVoicePresenceObservationsForGuilds(
    redis,
    owner,
    new Set(['guild-a', 'guild-b']),
  );

  assert.equal(scanCalls, 2);
  assert.deepEqual(deleted.sort(), [ownA, ownB].sort());
  assert.deepEqual(parseOwnedVoicePresenceKey(ownA, owner), {
    guildId: 'guild-a',
    userId: 'user-1',
  });
  assert.equal(parseOwnedVoicePresenceKey(foreignA, owner), null);
});

test('module unload cleanup deletes only the stopped runtime owner namespace', async () => {
  const owner = 'owner-0123456789abcdef';
  const foreignOwner = 'owner-fedcba9876543210';
  const ownA = voicePresenceOwnedKey(owner, 'guild-a', 'user-1');
  const ownB = voicePresenceOwnedKey(owner, 'guild-b', 'user-2');
  const foreign = voicePresenceOwnedKey(foreignOwner, 'guild-a', 'user-3');
  const pages = [
    ['1', [ownA, foreign]],
    ['0', [ownB]],
  ] as const;
  let scanCalls = 0;
  const deleted: string[] = [];
  const redis = {
    async scan() { return pages[scanCalls++]; },
    async del(...keys: string[]) {
      deleted.push(...keys);
      return keys.length;
    },
  } as unknown as Parameters<typeof deleteAllOwnedVoicePresenceObservations>[0];

  const count = await deleteAllOwnedVoicePresenceObservations(redis, owner);
  assert.equal(count, 2);
  assert.equal(scanCalls, 2);
  assert.deepEqual(deleted.sort(), [ownA, ownB].sort());
});

test('serialized reset work drains and preserves enqueue order across a rejection', async () => {
  const queue = new VoiceSerializedWorkQueue();
  const events: string[] = [];
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const first = queue.enqueue(async () => {
    events.push('first-start');
    await firstGate;
    events.push('first-end');
    throw new Error('expected-reset-failure');
  });
  let drained = false;
  const drain = queue.drain().then(() => { drained = true; });
  await new Promise<void>((resolve) => setImmediate(resolve));
  const second = queue.enqueue(async () => {
    events.push('second');
  });
  assert.equal(drained, false);
  releaseFirst();
  await assert.rejects(first, /expected-reset-failure/);
  await second;
  await drain;
  assert.deepEqual(events, ['first-start', 'first-end', 'second']);
});

test('availability recovery requests in one burst share a single reset batch', async () => {
  const queue = new VoiceSerializedWorkQueue();
  const pending = new Map<string, string>();
  const batches: string[][] = [];
  const pump = new VoiceCoalescedRecoveryPump(
    queue,
    () => {
      const batch = [...pending.values()];
      pending.clear();
      return batch;
    },
    async (batch) => { batches.push([...batch].sort()); },
  );

  pending.set('guild-a', 'guild-a');
  const first = pump.request();
  pending.set('guild-b', 'guild-b');
  const second = pump.request();
  assert.equal(first, second);
  await pump.drain();
  assert.deepEqual(batches, [['guild-a', 'guild-b']]);
});

test('PB tier work runs with a bounded concurrency and syncs only on threshold crossing', async () => {
  assert.equal(crossedPbTierThreshold(49 * 3_600, 50 * 3_600, 1), true);
  assert.equal(crossedPbTierThreshold(50 * 3_600, 50 * 3_600 + 600, 1), false);
  assert.equal(crossedPbTierThreshold(49 * 3_600, 50 * 3_600, 0), false);
  let active = 0;
  let maxActive = 0;
  const visited: number[] = [];
  await runVoiceTasksWithConcurrency([1, 2, 3, 4, 5], 2, async (value) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise<void>((resolve) => setImmediate(resolve));
    visited.push(value);
    active -= 1;
  });
  assert.equal(maxActive, 2);
  assert.deepEqual(visited.sort(), [1, 2, 3, 4, 5]);
});

test('the configured Discord AFK channel is ineligible even without mute flags', () => {
  const state = {
    channelId: 'guild-afk',
    sessionId: 'session-1',
    serverMute: false,
    serverDeaf: false,
    selfMute: false,
    selfDeaf: false,
  };
  assert.equal(isVoicePayoutAfkState(state, 'guild-afk'), true);
  assert.equal(isVoicePayoutAfkState({ ...state, channelId: 'voice-1' }, 'guild-afk'), false);
  assert.equal(
    voicePresenceTransitionAction(
      'voice-1',
      'guild-afk',
      false,
      true,
      'session-1',
      'session-1',
    ),
    'delete',
  );
});
