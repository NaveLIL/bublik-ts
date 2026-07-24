import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { ModuleBootController } from '../../src/core/ModuleLifecycle';

class ReadySource extends EventEmitter {
  constructor(private ready: boolean) {
    super();
  }

  isReady(): boolean {
    return this.ready;
  }

  markReady(): void {
    this.ready = true;
    this.emit('ready');
  }
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

test('ready-client boot is observed without blocking module registration', async () => {
  const source = new ReadySource(true);
  const controller = new ModuleBootController();
  const bootStarted = deferred();
  const never = new Promise<void>(() => undefined);

  controller.start(source, async () => {
    bootStarted.resolve();
    await never;
  }, () => assert.fail('never boot must not reject'));
  await bootStarted.promise;

  const startedAt = Date.now();
  assert.equal(await controller.stop(10), false);
  assert.ok(Date.now() - startedAt < 500);
});

test('stopped boot cannot resurrect a scheduler after its restore resolves late', async () => {
  const source = new ReadySource(true);
  const controller = new ModuleBootController();
  const restoreStarted = deferred();
  const restoreGate = deferred();
  let schedulerStarted = false;

  controller.start(source, async (isCurrent) => {
    restoreStarted.resolve();
    await restoreGate.promise;
    if (!isCurrent()) return;
    schedulerStarted = true;
  }, () => assert.fail('boot must not reject'));
  await restoreStarted.promise;
  assert.equal(await controller.stop(10), false);

  restoreGate.resolve();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(schedulerStarted, false);
});

test('legacy unload can retain ownership until boot work actually settles', async () => {
  const source = new ReadySource(true);
  const controller = new ModuleBootController();
  const bootStarted = deferred();
  const bootGate = deferred();
  controller.start(source, async () => {
    bootStarted.resolve();
    await bootGate.promise;
  }, () => assert.fail('boot must not reject'));
  await bootStarted.promise;

  const draining = controller.stopAndDrain();
  assert.equal(await Promise.race([
    draining.then(() => 'drained'),
    new Promise<string>((resolve) => setTimeout(() => resolve('pending'), 10)),
  ]), 'pending');
  bootGate.resolve();
  assert.equal(await draining, true);
});

test('stop detaches a pending ready listener and boot rejection is observed', async () => {
  const waitingSource = new ReadySource(false);
  const waitingController = new ModuleBootController();
  let lateBootCalls = 0;
  waitingController.start(waitingSource, async () => {
    lateBootCalls++;
  }, () => assert.fail('detached boot must not reject'));
  assert.equal(await waitingController.stop(10), true);
  waitingSource.markReady();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(lateBootCalls, 0);

  const readySource = new ReadySource(true);
  const rejectingController = new ModuleBootController();
  const observed = deferred();
  rejectingController.start(readySource, async () => {
    throw new Error('boot failed');
  }, (error) => {
    assert.match(String(error), /boot failed/);
    observed.resolve();
  });
  await observed.promise;
  assert.equal(await rejectingController.stop(10), true);
});
