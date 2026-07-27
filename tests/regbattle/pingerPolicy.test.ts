import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildPingerObservationSignature,
  canSendPingerFullSuggestion,
  completePingerRevision,
  hasPendingPingerRevision,
  isPingerActionDue,
  nextIndividualCandidateIndex,
  nextPingerRevision,
  runPingerTasksWithConcurrency,
  selectAllowedCachedGuildsToSeed,
  selectNotifyEnabledSquads,
  selectPingerPopulationPhase,
  selectPingerClaimSettlement,
  shouldAdvancePingerLocalCooldown,
  shouldEndEscalationAfterQueueRefresh,
  summarizePingerOccupancy,
  wasPingerRecalculatedSince,
} from '../../src/modules/regbattle/pingerPolicy';

test('runtime observation detects missed occupancy and notify wake-ups independent of row order', () => {
  const initial = buildPingerObservationSignature([
    { squadId: 'b', count: 2, size: 5, notifyOff: false },
    { squadId: 'a', count: 5, size: 5, notifyOff: false },
  ]);
  assert.equal(initial, buildPingerObservationSignature([
    { squadId: 'a', count: 5, size: 5, notifyOff: false },
    { squadId: 'b', count: 2, size: 5, notifyOff: false },
  ]));
  assert.notEqual(initial, buildPingerObservationSignature([
    { squadId: 'a', count: 5, size: 5, notifyOff: false },
    { squadId: 'b', count: 3, size: 5, notifyOff: false },
  ]));
  assert.notEqual(initial, buildPingerObservationSignature([
    { squadId: 'a', count: 5, size: 5, notifyOff: false },
    { squadId: 'b', count: 2, size: 5, notifyOff: true },
  ]));
});

test('FULL requires every squad to be full and overflow cannot hide another deficit', () => {
  const summary = summarizePingerOccupancy([
    { count: 10, size: 5 },
    { count: 0, size: 5 },
  ]);

  assert.equal(summary.allFull, false);
  assert.equal(summary.occupiedSlots, 5);
  assert.deepEqual(summarizePingerOccupancy([
    { count: 6, size: 5 },
    { count: 5, size: 5 },
  ]), {
    allFull: true,
    occupiedSlots: 10,
  });
  assert.equal(summarizePingerOccupancy([]).allFull, false);
});

test('overflow changes do not create false recruiting progress', () => {
  const before = summarizePingerOccupancy([
    { count: 6, size: 5 },
    { count: 2, size: 5 },
  ]).occupiedSlots;
  const overflowOnly = summarizePingerOccupancy([
    { count: 9, size: 5 },
    { count: 2, size: 5 },
  ]).occupiedSlots;
  const realProgress = summarizePingerOccupancy([
    { count: 9, size: 5 },
    { count: 3, size: 5 },
  ]).occupiedSlots;

  assert.equal(overflowOnly, before);
  assert.equal(realProgress, before + 1);
});

test('notify-off squads are removed from the advertised set', () => {
  const squads = [
    { squadId: 'on', number: 1 },
    { squadId: 'off', number: 2 },
  ];

  assert.deepEqual(
    selectNotifyEnabledSquads(squads, new Set(['off'])).map((squad) => squad.squadId),
    ['on'],
  );
});

test('notify-off occupancy cannot manufacture recruiting progress', () => {
  const notifyOff = new Set(['silent']);
  const before = selectNotifyEnabledSquads([
    { squadId: 'active', count: 2, size: 5 },
    { squadId: 'silent', count: 1, size: 5 },
  ], notifyOff);
  const after = selectNotifyEnabledSquads([
    { squadId: 'active', count: 2, size: 5 },
    { squadId: 'silent', count: 2, size: 5 },
  ], notifyOff);

  assert.equal(summarizePingerOccupancy(before).occupiedSlots, 2);
  assert.equal(summarizePingerOccupancy(after).occupiedSlots, 2);
});

test('FULL and IDLE decisions consider only notification-enabled squads', () => {
  const squads = [
    { squadId: 'full-active', count: 5, size: 5 },
    { squadId: 'unfilled-silent', count: 1, size: 5 },
  ];
  const active = selectNotifyEnabledSquads(squads, new Set(['unfilled-silent']));

  assert.equal(selectPingerPopulationPhase(active), 'full');
  assert.equal(
    selectPingerPopulationPhase(selectNotifyEnabledSquads(squads, new Set(squads.map((s) => s.squadId)))),
    'idle',
  );
  assert.equal(selectPingerPopulationPhase(squads), 'recruiting');
});

test('FULL reserve send gate rejects a stale revision or late free slot', () => {
  const full = [{ count: 5, size: 5 }];

  assert.equal(canSendPingerFullSuggestion(7, 7, full), true);
  assert.equal(canSendPingerFullSuggestion(7, 8, full), false);
  assert.equal(canSendPingerFullSuggestion(7, 7, [{ count: 4, size: 5 }]), false);
  assert.equal(canSendPingerFullSuggestion(7, 7, []), false);
});

test('FULL status refresh is due only at or after the interval boundary', () => {
  assert.equal(isPingerActionDue(999, 0, 1_000), false);
  assert.equal(isPingerActionDue(1_000, 0, 1_000), true);
  assert.equal(isPingerActionDue(900, 1_000, 1_000), false);
});

test('released and superseded claims never manufacture a local cooldown', () => {
  assert.equal(shouldAdvancePingerLocalCooldown('released'), false);
  assert.equal(shouldAdvancePingerLocalCooldown('ownership-lost'), false);
  assert.equal(shouldAdvancePingerLocalCooldown('retained-without-send'), true);
  assert.equal(shouldAdvancePingerLocalCooldown('sent-or-ambiguous'), true);
});

test('only an explicit safe abort releases a pinger claim early', () => {
  assert.equal(selectPingerClaimSettlement(false, false, true), 'release');
  assert.equal(selectPingerClaimSettlement(false, true, true), 'ownership-lost');
  assert.equal(selectPingerClaimSettlement(false, false, false), 'finalize');
  assert.equal(selectPingerClaimSettlement(true, false, true), 'finalize');
  assert.equal(selectPingerClaimSettlement(true, true, true), 'finalize');
});

test('a recalculation requested during async work remains pending', () => {
  const observed = 1;
  const requestedDuringRead = nextPingerRevision(observed);
  const processed = completePingerRevision(0, observed);

  assert.equal(wasPingerRecalculatedSince(observed, requestedDuringRead), true);
  assert.equal(hasPendingPingerRevision(requestedDuringRead, processed), true);
  assert.equal(hasPendingPingerRevision(observed, processed), false);
});

test('empty squad state is discarded normally but retained for a concurrent fresh reset', () => {
  const observed = 4;

  assert.equal(wasPingerRecalculatedSince(observed, observed), false);
  assert.equal(
    wasPingerRecalculatedSince(observed, nextPingerRevision(observed)),
    true,
  );
});

test('startup seeding includes each allowed cached guild once', () => {
  const cached = new Set(['cached', 'already-attempted', 'not-allowed']);
  const first = selectAllowedCachedGuildsToSeed(
    ['cached', 'already-attempted', 'not-cached'],
    cached,
    new Set(['already-attempted']),
  );

  assert.deepEqual(first, ['cached']);
  assert.deepEqual(
    selectAllowedCachedGuildsToSeed(
      ['cached', 'already-attempted', 'not-cached'],
      cached,
      new Set(['already-attempted', ...first]),
    ),
    [],
  );
});

test('only authoritative empty queue ends escalation and starts cooldown', () => {
  assert.equal(shouldEndEscalationAfterQueueRefresh('empty'), true);
  assert.equal(shouldEndEscalationAfterQueueRefresh('retry'), false);
  assert.equal(shouldEndEscalationAfterQueueRefresh('ready'), false);
});

test('transient candidate failure retries the same user while terminal outcomes advance', () => {
  assert.equal(nextIndividualCandidateIndex(3, 'retry'), 3);
  assert.equal(nextIndividualCandidateIndex(3, 'authoritative-skip'), 4);
  assert.equal(nextIndividualCandidateIndex(3, 'sent'), 4);
});

test('bounded guild processing isolates failures and never exceeds its concurrency', async () => {
  let active = 0;
  let maxActive = 0;
  const completed: number[] = [];
  const failed: number[] = [];
  await runPingerTasksWithConcurrency([1, 2, 3, 4], 2, async (item) => {
    active++;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 2));
    active--;
    if (item === 2) throw new Error('slow guild failed');
    completed.push(item);
  }, (item) => failed.push(item));

  assert.equal(maxActive, 2);
  assert.deepEqual(failed, [2]);
  assert.deepEqual(completed.sort(), [1, 3, 4]);
});
