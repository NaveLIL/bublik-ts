import test from 'node:test';
import assert from 'node:assert/strict';
import {
  drainScheduledTasks,
  drainScheduledTasksByPrefix,
  scheduleTask,
  unscheduleTask,
  waitForPromiseWithin,
} from '../../src/core/SchedulerManager';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

test('module boot waits are bounded without cancelling completed work', async () => {
  assert.equal(await waitForPromiseWithin(Promise.resolve(), 50), true);
  const never = new Promise<void>(() => undefined);
  const startedAt = Date.now();
  assert.equal(await waitForPromiseWithin(never, 10), false);
  assert.ok(Date.now() - startedAt < 500);
});

test('scoped scheduler drain waits for its module but not unrelated work', async () => {
  const teamsStarted = deferred();
  const otherStarted = deferred();
  const releaseTeams = deferred();
  const releaseOther = deferred();

  scheduleTask('teams:testDrain', 60_000, async () => {
    teamsStarted.resolve();
    await releaseTeams.promise;
  }, { immediate: true });
  scheduleTask('other:testDrain', 60_000, async () => {
    otherStarted.resolve();
    await releaseOther.promise;
  }, { immediate: true });

  await Promise.all([teamsStarted.promise, otherStarted.promise]);
  unscheduleTask('teams:testDrain');
  unscheduleTask('other:testDrain');

  const scopedDrain = drainScheduledTasksByPrefix('teams:');
  releaseTeams.resolve();
  assert.equal(await waitForPromiseWithin(scopedDrain, 500), true);
  assert.equal(await drainScheduledTasksByPrefix('other:', 10), false);

  releaseOther.resolve();
  assert.equal(await drainScheduledTasks(500), true);
});
