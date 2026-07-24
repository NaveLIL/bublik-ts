import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ensureCompleteIntegrityMemberSnapshot,
  resolveStableIntegrityLocation,
  runIsolatedIntegrityTasks,
} from '../../src/modules/regbattle/integrityPolicy';

test('one permanently failing integrity item cannot starve later items', async () => {
  const processed: string[] = [];
  const errors: string[] = [];
  await runIsolatedIntegrityTasks(
    ['broken', 'healthy'],
    async (item) => {
      if (item === 'broken') throw new Error('persistent failure');
      processed.push(item);
    },
    (item) => errors.push(item),
  );
  assert.deepEqual(errors, ['broken']);
  assert.deepEqual(processed, ['healthy']);
});

test('member completeness barrier retries failure and fetches only once after success', async () => {
  const ready = new Set<string>();
  let attempts = 0;
  const fetchAll = async () => {
    attempts++;
    if (attempts === 1) throw new Error('transient gateway failure');
  };
  await assert.rejects(ensureCompleteIntegrityMemberSnapshot('guild', ready, fetchAll));
  assert.equal(ready.has('guild'), false);
  await ensureCompleteIntegrityMemberSnapshot('guild', ready, fetchAll);
  await ensureCompleteIntegrityMemberSnapshot('guild', ready, fetchAll);
  assert.equal(attempts, 2);
  assert.equal(ready.has('guild'), true);
});

test('integrity location barrier rejects a leave while asynchronous resolution is in flight', async () => {
  let channelId: string | null = 'pb';
  let release!: () => void;
  const paused = new Promise<void>((resolve) => { release = resolve; });
  const resultPromise = resolveStableIntegrityLocation(
    () => channelId,
    async (observed) => {
      await paused;
      return { channelId: observed };
    },
    (location) => location.channelId,
  );

  channelId = null;
  release();
  assert.equal(await resultPromise, null);
});

test('integrity location barrier returns a stable current location', async () => {
  const location = await resolveStableIntegrityLocation(
    () => 'pb',
    async (channelId) => ({ channelId, kind: 'regular' }),
    (resolved) => resolved.channelId,
  );
  assert.deepEqual(location, { channelId: 'pb', kind: 'regular' });
});
