import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { BublikClient } from '../../src/bot';
import {
  drainScheduledTasks,
  drainScheduledTasksByPrefix,
  getSchedulerStats,
  scheduleTask,
  unscheduleTask,
  waitForPromiseWithin,
} from '../../src/core/SchedulerManager';
import brModule from '../../src/modules/br';
import economyModule from '../../src/modules/economy';
import vacationModule from '../../src/modules/vacation';

class PendingReadyClient extends EventEmitter {
  isReady(): boolean {
    return false;
  }
}

function asBublikClient(client: PendingReadyClient): BublikClient {
  return client as unknown as BublikClient;
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

test('economy unload detaches pending ready boot and cannot resurrect its tasks', async () => {
  const source = new PendingReadyClient();
  const client = asBublikClient(source);

  await economyModule.onLoad?.(client);
  assert.equal(source.listenerCount('ready'), 1);

  await economyModule.onUnload?.(client);
  assert.equal(source.listenerCount('ready'), 0);

  source.emit('ready');
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(
    getSchedulerStats().filter(({ name }) => name.startsWith('economy:')),
    [],
  );
});

test('vacation unload detaches pending ready boot and leaves no future ticks', async () => {
  const source = new PendingReadyClient();
  const client = asBublikClient(source);

  await vacationModule.onLoad?.(client);
  assert.equal(source.listenerCount('ready'), 1);

  await vacationModule.onUnload?.(client);
  assert.equal(source.listenerCount('ready'), 0);

  source.emit('ready');
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(
    getSchedulerStats().filter(({ name }) => name.startsWith('vacation:')),
    [],
  );
});

test('BR unload drains only its scheduler namespace', async () => {
  const brStarted = deferred();
  const otherStarted = deferred();
  const releaseBr = deferred();
  const releaseOther = deferred();

  scheduleTask('br:lifecycle-test', 60_000, async () => {
    brStarted.resolve();
    await releaseBr.promise;
  }, { immediate: true });
  scheduleTask('other:lifecycle-test', 60_000, async () => {
    otherStarted.resolve();
    await releaseOther.promise;
  }, { immediate: true });

  try {
    await Promise.all([brStarted.promise, otherStarted.promise]);
    unscheduleTask('br:lifecycle-test');
    unscheduleTask('other:lifecycle-test');

    const unloading = Promise.resolve(brModule.onUnload?.(asBublikClient(new PendingReadyClient())));
    assert.equal(await waitForPromiseWithin(unloading, 10), false);

    releaseBr.resolve();
    assert.equal(await waitForPromiseWithin(unloading, 500), true);
    assert.equal(await drainScheduledTasksByPrefix('other:', 10), false);
  } finally {
    unscheduleTask('br:lifecycle-test');
    unscheduleTask('other:lifecycle-test');
    releaseBr.resolve();
    releaseOther.resolve();
    await drainScheduledTasks(500);
  }
});
