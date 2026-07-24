import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import test from 'node:test';
import type { BublikClient } from '../../src/bot';
import { ModuleLoader, ModuleLoaderOptions } from '../../src/core/ModuleLoader';
import { ModuleExecutionGuard, ModuleState } from '../../src/types';

const MODULE_NAME = 'moduleloader_fixture';
const COMMAND_NAME = 'moduleloader-fixture-command';
const fixturePath = path.resolve(process.cwd(), 'tests/fixtures/moduleloader/index.cjs');

interface FixtureCommand {
  data: { name: string };
  generation: number;
  execute(): Promise<void>;
  autocomplete(): Promise<void>;
}

interface FixtureControls {
  imports: number;
  guardedEvent: boolean;
  guardedOnLoad: boolean;
  guardedOnUnload: boolean;
  bothOnLoad: boolean;
  onLoad(
    generation: number,
    client: unknown,
    guard: ModuleExecutionGuard | undefined,
  ): Promise<void> | void;
  onUnload(
    generation: number,
    client: unknown,
    guard: ModuleExecutionGuard | undefined,
  ): Promise<void> | void;
  onEvent(
    generation: number,
    value: unknown,
    guard: ModuleExecutionGuard | undefined,
  ): Promise<void> | void;
  onCommand(generation: number): Promise<void> | void;
  onAutocomplete(generation: number): Promise<void> | void;
}

interface Deferred {
  promise: Promise<void>;
  resolve(): void;
  reject(error: unknown): void;
}

class FakeCommandRegistry {
  private readonly commands = new Map<string, { command: FixtureCommand; moduleName: string }>();
  syncCalls = 0;

  register(command: FixtureCommand, moduleName: string): void {
    if (this.commands.has(command.data.name)) throw new Error('duplicate fixture command');
    this.commands.set(command.data.name, { command, moduleName });
  }

  unregister(name: string, moduleName?: string): void {
    const current = this.commands.get(name);
    if (!current || (moduleName && current.moduleName !== moduleName)) return;
    this.commands.delete(name);
  }

  getCommand(name: string): { command: FixtureCommand; moduleName: string } | undefined {
    return this.commands.get(name);
  }

  async syncAllCommands(): Promise<void> {
    this.syncCalls++;
  }
}

class FakeClient extends EventEmitter {
  readonly commandRegistry = new FakeCommandRegistry();
}

function deferred(): Deferred {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

function createHarness(options: ModuleLoaderOptions = {}): {
  client: FakeClient;
  controls: FixtureControls;
  loader: ModuleLoader;
  dispose(): void;
} {
  const client = new FakeClient();
  const controls: FixtureControls = {
    imports: 0,
    guardedEvent: false,
    guardedOnLoad: false,
    guardedOnUnload: false,
    bothOnLoad: false,
    onLoad: () => undefined,
    onUnload: () => undefined,
    onEvent: () => undefined,
    onCommand: () => undefined,
    onAutocomplete: () => undefined,
  };
  const fixtureGlobal = globalThis as typeof globalThis & {
    __bublikModuleLoaderFixture?: FixtureControls;
  };
  fixtureGlobal.__bublikModuleLoaderFixture = controls;

  const loader = new ModuleLoader(client as unknown as BublikClient, options);
  const testableLoader = loader as unknown as {
    resolveModulePath(name: string): string | null;
  };
  testableLoader.resolveModulePath = (name) => name === MODULE_NAME ? fixturePath : null;

  return {
    client,
    controls,
    loader,
    dispose: () => {
      if (fixtureGlobal.__bublikModuleLoaderFixture === controls) {
        delete fixtureGlobal.__bublikModuleLoaderFixture;
      }
      delete require.cache[require.resolve(fixturePath)];
    },
  };
}

async function within<T>(promise: Promise<T>, timeoutMs = 1_000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error('ModuleLoader operation timed out')), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function waitUntil(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Condition did not become true in time');
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  }
}

test('lifecycle hooks require one explicit legacy or guarded contract', async (t) => {
  const { client, controls, loader, dispose } = createHarness();
  t.after(dispose);
  controls.bothOnLoad = true;

  assert.equal(await loader.load(MODULE_NAME), false);
  assert.equal(loader.getModule(MODULE_NAME)?.state, ModuleState.Error);
  assert.equal(client.listenerCount('moduleloaderFixtureEvent'), 0);
  assert.equal(client.commandRegistry.getCommand(COMMAND_NAME), undefined);
});

test('concurrent unload calls serialize and clean a module exactly once', async (t) => {
  const { controls, loader, dispose } = createHarness();
  t.after(dispose);
  const unloadEntered = deferred();
  const unloadGate = deferred();
  let unloadCalls = 0;
  controls.onUnload = async () => {
    unloadCalls++;
    unloadEntered.resolve();
    await unloadGate.promise;
  };

  assert.equal(await loader.load(MODULE_NAME), true);
  const first = loader.unload(MODULE_NAME);
  await unloadEntered.promise;
  const second = loader.unload(MODULE_NAME);
  unloadGate.resolve();

  assert.deepEqual(await within(Promise.all([first, second])), [true, false]);
  assert.equal(unloadCalls, 1);
  assert.equal(loader.getModule(MODULE_NAME), undefined);
});

test('concurrent unload then reload is ordered and reload uses unlocked internals', async (t) => {
  const { client, controls, loader, dispose } = createHarness();
  t.after(dispose);
  const firstUnloadEntered = deferred();
  const firstUnloadGate = deferred();
  const unloadedGenerations: number[] = [];
  controls.onUnload = async (generation) => {
    unloadedGenerations.push(generation);
    if (generation === 1) {
      firstUnloadEntered.resolve();
      await firstUnloadGate.promise;
    }
  };

  assert.equal(await loader.load(MODULE_NAME), true);
  const unloading = loader.unload(MODULE_NAME);
  await firstUnloadEntered.promise;
  const reloading = loader.reload(MODULE_NAME);
  firstUnloadGate.resolve();

  assert.deepEqual(await within(Promise.all([unloading, reloading])), [true, true]);
  assert.equal(loader.getModule(MODULE_NAME)?.module.version, '2');
  assert.equal(client.commandRegistry.getCommand(COMMAND_NAME)?.command.generation, 2);

  // A normal reload must not enqueue public unload/load behind itself.
  assert.equal(await within(loader.reload(MODULE_NAME)), true);
  assert.equal(loader.getModule(MODULE_NAME)?.module.version, '3');
  assert.deepEqual(unloadedGenerations, [1, 2]);
  assert.equal(client.commandRegistry.syncCalls, 2);
});

test('legacy onLoad racing unload stays quarantined and cleans up exactly once', async (t) => {
  const { controls, loader, dispose } = createHarness({ lifecycleTimeoutMs: 15 });
  t.after(dispose);
  const loadEntered = deferred();
  const loadGate = deferred();
  let unloadCalls = 0;
  controls.onLoad = async () => {
    loadEntered.resolve();
    await loadGate.promise;
  };
  controls.onUnload = () => { unloadCalls++; };

  const loading = loader.load(MODULE_NAME);
  await loadEntered.promise;
  assert.equal(await within(loader.unload(MODULE_NAME)), false);
  assert.equal(loader.getModule(MODULE_NAME)?.state, ModuleState.Quarantined);
  assert.equal(unloadCalls, 0);
  loadGate.reject(new Error('fixture onLoad failed'));

  assert.equal(await within(loading), false);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(unloadCalls, 1);
  assert.equal(loader.getModule(MODULE_NAME), undefined);
});

test('legacy onLoad retains ownership and cache until its late write settles', async (t) => {
  const { client, controls, loader, dispose } = createHarness({ lifecycleTimeoutMs: 15 });
  t.after(dispose);
  const oldLoadEntered = deferred();
  const oldLoadGate = deferred();
  const oldLoadFinished = deferred();
  const unloadedGenerations: number[] = [];
  let published = 'initial';
  controls.onLoad = async (generation, _client, guard) => {
    if (generation === 1) {
      assert.equal(guard, undefined);
      oldLoadEntered.resolve();
      await oldLoadGate.promise;
      published = 'legacy-load-finished';
      oldLoadFinished.resolve();
    }
  };
  controls.onUnload = (generation) => { unloadedGenerations.push(generation); };

  const oldLoad = loader.load(MODULE_NAME);
  await oldLoadEntered.promise;
  assert.equal(await within(loader.reload(MODULE_NAME)), false);
  assert.equal(controls.imports, 1);
  assert.equal(loader.getModule(MODULE_NAME)?.state, ModuleState.Quarantined);
  assert.equal(client.commandRegistry.getCommand(COMMAND_NAME), undefined);
  assert.ok(require.cache[require.resolve(fixturePath)]);

  oldLoadGate.resolve();
  await oldLoadFinished.promise;
  assert.equal(await within(oldLoad), false);
  assert.equal(published, 'legacy-load-finished');

  assert.equal(await within(loader.reload(MODULE_NAME)), true);
  published = 'replacement';

  assert.equal(loader.getModule(MODULE_NAME)?.state, ModuleState.Loaded);
  assert.equal(loader.getModule(MODULE_NAME)?.module.version, '2');
  assert.equal(client.commandRegistry.getCommand(COMMAND_NAME)?.command.generation, 2);
  assert.ok(require.cache[require.resolve(fixturePath)]);
  assert.deepEqual(unloadedGenerations, [1]);
});

test('reload drains an already-running module event before lifecycle cleanup', async (t) => {
  const { client, controls, loader, dispose } = createHarness({
    eventDrainTimeoutMs: 500,
    lifecycleTimeoutMs: 500,
  });
  t.after(dispose);
  const eventEntered = deferred();
  const eventGate = deferred();
  const sequence: string[] = [];
  controls.onEvent = async (generation) => {
    sequence.push(`event-start:${generation}`);
    eventEntered.resolve();
    await eventGate.promise;
    sequence.push(`event-end:${generation}`);
  };
  controls.onUnload = (generation) => {
    sequence.push(`unload:${generation}`);
  };

  assert.equal(await loader.load(MODULE_NAME), true);
  client.emit('moduleloaderFixtureEvent', 'payload');
  await eventEntered.promise;
  const reloading = loader.reload(MODULE_NAME);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(sequence, ['event-start:1']);

  eventGate.resolve();
  assert.equal(await within(reloading), true);
  assert.deepEqual(sequence, ['event-start:1', 'event-end:1', 'unload:1']);
});

test('legacy event timeout quarantines its generation before any replacement loads', async (t) => {
  const { client, controls, loader, dispose } = createHarness({
    eventDrainTimeoutMs: 15,
    lifecycleTimeoutMs: 100,
  });
  t.after(dispose);
  const eventEntered = deferred();
  const eventGate = deferred();
  const eventFinished = deferred();
  let published = 'initial';
  let unloadCalls = 0;
  controls.onEvent = async (generation, _value, guard) => {
    if (generation !== 1) return;
    assert.equal(guard, undefined);
    eventEntered.resolve();
    await eventGate.promise;
    published = 'legacy-event-finished';
    eventFinished.resolve();
  };
  controls.onUnload = () => { unloadCalls++; };

  assert.equal(await loader.load(MODULE_NAME), true);
  client.emit('moduleloaderFixtureEvent', 'payload');
  await eventEntered.promise;

  assert.equal(await within(loader.reload(MODULE_NAME)), false);
  assert.equal(controls.imports, 1);
  assert.equal(loader.getModule(MODULE_NAME)?.state, ModuleState.Quarantined);
  assert.equal(loader.getHealthyModules().length, 0);
  assert.deepEqual(loader.getLoadedModuleNames(), []);
  assert.equal(client.listenerCount('moduleloaderFixtureEvent'), 0);
  assert.equal(client.commandRegistry.getCommand(COMMAND_NAME), undefined);
  assert.ok(require.cache[require.resolve(fixturePath)]);
  assert.equal(unloadCalls, 0);

  eventGate.resolve();
  await eventFinished.promise;
  assert.equal(published, 'legacy-event-finished');

  assert.equal(await within(loader.reload(MODULE_NAME)), true);
  published = 'replacement';
  assert.equal(loader.getModule(MODULE_NAME)?.module.version, '2');
  assert.equal(client.commandRegistry.getCommand(COMMAND_NAME)?.command.generation, 2);
  assert.equal(unloadCalls, 1);
  assert.equal(published, 'replacement');
});

test('automatic quarantine cleanup rearms from a legacy event into a hung legacy onUnload', async (t) => {
  const { client, controls, loader, dispose } = createHarness({
    eventDrainTimeoutMs: 15,
    lifecycleTimeoutMs: 15,
  });
  t.after(dispose);
  const eventEntered = deferred();
  const eventGate = deferred();
  const unloadEntered = deferred();
  const unloadGate = deferred();
  let unloadCalls = 0;
  controls.onEvent = async () => {
    eventEntered.resolve();
    await eventGate.promise;
  };
  controls.onUnload = async () => {
    unloadCalls++;
    unloadEntered.resolve();
    await unloadGate.promise;
  };

  assert.equal(await loader.load(MODULE_NAME), true);
  client.emit('moduleloaderFixtureEvent', 'payload');
  await eventEntered.promise;

  assert.equal(await within(loader.reload(MODULE_NAME)), false);
  assert.equal(loader.getModule(MODULE_NAME)?.state, ModuleState.Quarantined);
  assert.equal(unloadCalls, 0);

  eventGate.resolve();
  await within(unloadEntered.promise);
  await new Promise<void>((resolve) => setTimeout(resolve, 30));
  assert.equal(loader.getModule(MODULE_NAME)?.state, ModuleState.Quarantined);
  assert.equal(controls.imports, 1);
  assert.equal(unloadCalls, 1);

  unloadGate.resolve();
  await waitUntil(() => loader.getModule(MODULE_NAME) === undefined);
  assert.equal(unloadCalls, 1);
});

test('legacy command timeout quarantines its generation before replacement', async (t) => {
  const { client, controls, loader, dispose } = createHarness({
    eventDrainTimeoutMs: 15,
    lifecycleTimeoutMs: 100,
  });
  t.after(dispose);
  const commandEntered = deferred();
  const commandGate = deferred();
  const sequence: string[] = [];
  controls.onCommand = async (generation) => {
    sequence.push(`command-start:${generation}`);
    commandEntered.resolve();
    await commandGate.promise;
    sequence.push(`command-end:${generation}`);
  };
  controls.onUnload = (generation) => {
    sequence.push(`unload:${generation}`);
  };

  assert.equal(await loader.load(MODULE_NAME), true);
  const running = client.commandRegistry.getCommand(COMMAND_NAME)!.command.execute();
  await commandEntered.promise;

  assert.equal(await within(loader.reload(MODULE_NAME)), false);
  assert.equal(controls.imports, 1);
  assert.equal(loader.getModule(MODULE_NAME)?.state, ModuleState.Quarantined);
  assert.equal(client.commandRegistry.getCommand(COMMAND_NAME), undefined);
  assert.deepEqual(sequence, ['command-start:1']);

  commandGate.resolve();
  await running;
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(sequence, ['command-start:1', 'command-end:1', 'unload:1']);
  assert.equal(await within(loader.reload(MODULE_NAME)), true);
  assert.equal(loader.getModule(MODULE_NAME)?.module.version, '2');
});

test('a command captured before unload cannot start after its generation is gone', async (t) => {
  const { client, controls, loader, dispose } = createHarness();
  t.after(dispose);
  let executions = 0;
  controls.onCommand = () => { executions++; };

  assert.equal(await loader.load(MODULE_NAME), true);
  const captured = client.commandRegistry.getCommand(COMMAND_NAME)!.command;
  assert.equal(await loader.unload(MODULE_NAME), true);
  await captured.execute();
  assert.equal(executions, 0);
});

test('runLegacyModuleWork owns quarantine and cache until exact settlement, then auto-finalizes', async (t) => {
  const { client, controls, loader, dispose } = createHarness({
    eventDrainTimeoutMs: 15,
    lifecycleTimeoutMs: 100,
  });
  t.after(dispose);
  const workEntered = deferred();
  const workGate = deferred();
  let unloadCalls = 0;
  let workCalls = 0;
  controls.onUnload = () => { unloadCalls++; };

  assert.equal(await loader.load(MODULE_NAME), true);
  const running = loader.runLegacyModuleWork(MODULE_NAME, async () => {
    workCalls++;
    workEntered.resolve();
    await workGate.promise;
    return 'settled';
  });
  await workEntered.promise;

  assert.equal(await within(loader.reload(MODULE_NAME)), false);
  assert.equal(loader.getModule(MODULE_NAME)?.state, ModuleState.Quarantined);
  assert.equal(controls.imports, 1);
  assert.equal(client.commandRegistry.getCommand(COMMAND_NAME), undefined);
  assert.ok(require.cache[require.resolve(fixturePath)]);
  assert.equal(unloadCalls, 0);

  let staleCalls = 0;
  assert.equal(await loader.runLegacyModuleWork(MODULE_NAME, () => { staleCalls++; }), null);
  assert.equal(staleCalls, 0);

  workGate.resolve();
  assert.equal(await running, 'settled');
  await waitUntil(() => loader.getModule(MODULE_NAME) === undefined);
  assert.equal(unloadCalls, 1);
  assert.equal(workCalls, 1);
  assert.equal(require.cache[require.resolve(fixturePath)], undefined);

  assert.equal(await loader.runLegacyModuleWork(MODULE_NAME, () => { staleCalls++; }), null);
  assert.equal(staleCalls, 0);
});

test('autocomplete is tracked while running and a captured old generation is fenced afterward', async (t) => {
  const { client, controls, loader, dispose } = createHarness({
    eventDrainTimeoutMs: 15,
    lifecycleTimeoutMs: 100,
  });
  t.after(dispose);
  const autocompleteEntered = deferred();
  const autocompleteGate = deferred();
  let autocompleteCalls = 0;
  controls.onAutocomplete = async () => {
    autocompleteCalls++;
    autocompleteEntered.resolve();
    await autocompleteGate.promise;
  };

  assert.equal(await loader.load(MODULE_NAME), true);
  const captured = client.commandRegistry.getCommand(COMMAND_NAME)!.command;
  const running = captured.autocomplete();
  await autocompleteEntered.promise;

  assert.equal(await within(loader.reload(MODULE_NAME)), false);
  assert.equal(loader.getModule(MODULE_NAME)?.state, ModuleState.Quarantined);
  assert.equal(client.commandRegistry.getCommand(COMMAND_NAME), undefined);

  autocompleteGate.resolve();
  await running;
  await waitUntil(() => loader.getModule(MODULE_NAME) === undefined);
  await captured.autocomplete();
  assert.equal(autocompleteCalls, 1);
});

test('timed-out old event is fenced from mutating its replacement generation', async (t) => {
  const { client, controls, loader, dispose } = createHarness({
    eventDrainTimeoutMs: 15,
    lifecycleTimeoutMs: 100,
  });
  t.after(dispose);
  controls.guardedEvent = true;
  const eventEntered = deferred();
  const eventGate = deferred();
  const eventFinished = deferred();
  let published = 'initial';
  let oldGuard: ModuleExecutionGuard | null = null;
  controls.onEvent = async (generation, _value, guard) => {
    if (generation !== 1) return;
    assert.ok(guard);
    oldGuard = guard;
    eventEntered.resolve();
    await eventGate.promise;
    if (guard.isCurrent()) published = 'stale-event';
    eventFinished.resolve();
  };

  assert.equal(await loader.load(MODULE_NAME), true);
  client.emit('moduleloaderFixtureEvent', 'payload');
  await eventEntered.promise;
  assert.equal(await within(loader.reload(MODULE_NAME)), true);
  published = 'replacement';
  assert.equal(loader.getModule(MODULE_NAME)?.module.version, '2');
  assert.equal(oldGuard?.signal.aborted, true);

  eventGate.resolve();
  await eventFinished.promise;
  assert.equal(published, 'replacement');
  assert.equal(oldGuard?.isCurrent(), false);
});

test('hung onLoad times out and its late generation cannot publish over a replacement', async (t) => {
  const { controls, loader, dispose } = createHarness({
    eventDrainTimeoutMs: 100,
    lifecycleTimeoutMs: 15,
  });
  t.after(dispose);
  controls.guardedOnLoad = true;
  const loadEntered = deferred();
  const loadGate = deferred();
  const loadFinished = deferred();
  let published = 'initial';
  let oldGuard: ModuleExecutionGuard | null = null;
  controls.onLoad = async (generation, _client, guard) => {
    if (generation !== 1) return;
    assert.ok(guard);
    oldGuard = guard;
    loadEntered.resolve();
    await loadGate.promise;
    if (guard.isCurrent()) published = 'stale-load';
    loadFinished.resolve();
  };

  const firstLoad = loader.load(MODULE_NAME);
  await loadEntered.promise;
  assert.equal(await within(firstLoad), false);
  assert.equal(loader.getModule(MODULE_NAME)?.state, ModuleState.Error);
  assert.equal(oldGuard?.signal.aborted, true);

  assert.equal(await within(loader.reload(MODULE_NAME)), true);
  published = 'replacement';
  loadGate.resolve();
  await loadFinished.promise;
  assert.equal(published, 'replacement');
  assert.equal(loader.getModule(MODULE_NAME)?.module.version, '2');
});

test('legacy onUnload retains ownership until its late write settles and runs once', async (t) => {
  const { client, controls, loader, dispose } = createHarness({
    eventDrainTimeoutMs: 100,
    lifecycleTimeoutMs: 15,
  });
  t.after(dispose);
  const unloadEntered = deferred();
  const unloadGate = deferred();
  const unloadFinished = deferred();
  let published = 'initial';
  let unloadCalls = 0;
  controls.onUnload = async (generation, _client, guard) => {
    if (generation !== 1) return;
    assert.equal(guard, undefined);
    unloadCalls++;
    unloadEntered.resolve();
    await unloadGate.promise;
    published = 'legacy-unload-finished';
    unloadFinished.resolve();
  };

  assert.equal(await loader.load(MODULE_NAME), true);
  const firstReload = loader.reload(MODULE_NAME);
  await unloadEntered.promise;
  assert.equal(await within(firstReload), false);
  assert.equal(controls.imports, 1);
  assert.equal(loader.getModule(MODULE_NAME)?.state, ModuleState.Quarantined);
  assert.equal(client.commandRegistry.getCommand(COMMAND_NAME), undefined);
  assert.ok(require.cache[require.resolve(fixturePath)]);

  // Repeated calls stay bounded and must await the exact same legacy promise.
  assert.equal(await within(loader.unload(MODULE_NAME)), false);
  assert.equal(unloadCalls, 1);

  unloadGate.resolve();
  await unloadFinished.promise;
  assert.equal(published, 'legacy-unload-finished');
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(loader.getModule(MODULE_NAME), undefined);

  assert.equal(await within(loader.reload(MODULE_NAME)), true);
  published = 'replacement';
  assert.equal(unloadCalls, 1);
  assert.equal(loader.getModule(MODULE_NAME)?.module.version, '2');
  assert.equal(client.commandRegistry.getCommand(COMMAND_NAME)?.command.generation, 2);
  assert.equal(published, 'replacement');
});

test('explicit guarded onUnload timeout permits a fenced replacement', async (t) => {
  const { client, controls, loader, dispose } = createHarness({
    eventDrainTimeoutMs: 100,
    lifecycleTimeoutMs: 15,
  });
  t.after(dispose);
  controls.guardedOnUnload = true;
  const unloadEntered = deferred();
  const unloadGate = deferred();
  const unloadFinished = deferred();
  let published = 'initial';
  controls.onUnload = async (generation, _client, guard) => {
    if (generation !== 1) return;
    assert.ok(guard);
    unloadEntered.resolve();
    await unloadGate.promise;
    if (guard.ownsGeneration()) published = 'stale-cleanup';
    unloadFinished.resolve();
  };

  assert.equal(await loader.load(MODULE_NAME), true);
  const reloading = loader.reload(MODULE_NAME);
  await unloadEntered.promise;
  assert.equal(await within(reloading), true);
  published = 'replacement';
  assert.equal(loader.getModule(MODULE_NAME)?.module.version, '2');
  assert.equal(client.commandRegistry.getCommand(COMMAND_NAME)?.command.generation, 2);

  unloadGate.resolve();
  await unloadFinished.promise;
  assert.equal(published, 'replacement');
  assert.equal(loader.getModule(MODULE_NAME)?.module.version, '2');
  assert.equal(client.commandRegistry.getCommand(COMMAND_NAME)?.command.generation, 2);
  assert.ok(require.cache[require.resolve(fixturePath)]);
});
