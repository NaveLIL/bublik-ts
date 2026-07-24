import assert from 'node:assert/strict';
import test from 'node:test';
import type { BublikClient } from '../../src/bot';
import {
  CommandRegistry,
  CommandRegistryOptions,
  CommandSyncConvergenceError,
} from '../../src/core/CommandRegistry';
import { Config } from '../../src/config';
import { BublikCommand, CommandScope } from '../../src/types';

interface Deferred {
  promise: Promise<void>;
  resolve(): void;
}

interface PublishedCommand {
  name?: string;
  description?: string;
}

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((onResolve) => {
    resolve = onResolve;
  });
  return { promise, resolve };
}

function command(version: number): BublikCommand {
  const data = {
    name: 'schema',
    setIntegrationTypes() { return this; },
    setContexts() { return this; },
    toJSON() {
      return { name: 'schema', description: `version-${version}` };
    },
  } as unknown as BublikCommand['data'];
  return {
    data,
    scope: CommandScope.Global,
    category: 'test',
    descriptionKey: 'test.schema',
    async execute() {},
  };
}

function createRegistry(options: CommandRegistryOptions = {}): CommandRegistry {
  const client = {
    guilds: { cache: new Map<string, unknown>() },
  } as unknown as BublikClient;
  return new CommandRegistry(client, options);
}

function installRest(
  registry: CommandRegistry,
  put: (route: string, options: { body: PublishedCommand[] }) => Promise<unknown>,
): void {
  (registry as unknown as { rest: { put: typeof put } }).rest = { put };
}

test('slash sync serializes PUTs and repairs a snapshot changed in flight', async (t) => {
  const mutableConfig = Config as unknown as { devGuildId: string | null };
  const originalDevGuildId = mutableConfig.devGuildId;
  mutableConfig.devGuildId = null;
  t.after(() => { mutableConfig.devGuildId = originalDevGuildId; });

  const registry = createRegistry();
  const firstStarted = deferred();
  const firstGate = deferred();
  const bodies: PublishedCommand[][] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  installRest(registry, async (_route, { body }) => {
    bodies.push(body);
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    if (bodies.length === 1) {
      firstStarted.resolve();
      await firstGate.promise;
    }
    inFlight--;
    return {};
  });

  registry.register(command(1), 'fixture');
  const oldSync = registry.syncGlobalCommands();
  await firstStarted.promise;
  registry.unregister('schema', 'fixture');
  registry.register(command(2), 'fixture');
  const newSync = registry.syncGlobalCommands();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(bodies.length, 1);

  firstGate.resolve();
  await Promise.all([oldSync, newSync]);
  assert.equal(maxInFlight, 1);
  assert.equal(bodies[0]?.[0]?.description, 'version-1');
  assert.equal(bodies[1]?.[0]?.description, 'version-2');
  assert.equal(bodies.at(-1)?.[0]?.description, 'version-2');
});

test('ambiguous stale PUT immediately converges the current command snapshot', async (t) => {
  const mutableConfig = Config as unknown as { devGuildId: string | null };
  const originalDevGuildId = mutableConfig.devGuildId;
  mutableConfig.devGuildId = null;
  t.after(() => { mutableConfig.devGuildId = originalDevGuildId; });

  const registry = createRegistry();
  const firstStarted = deferred();
  const firstGate = deferred();
  const bodies: PublishedCommand[][] = [];
  installRest(registry, async (_route, { body }) => {
    bodies.push(body);
    if (bodies.length === 1) {
      firstStarted.resolve();
      await firstGate.promise;
      throw new Error('ambiguous REST completion');
    }
    return {};
  });

  registry.register(command(1), 'fixture');
  const syncing = registry.syncGlobalCommands();
  await firstStarted.promise;
  registry.unregister('schema', 'fixture');
  registry.register(command(2), 'fixture');
  firstGate.resolve();

  await syncing;
  assert.deepEqual(
    bodies.map((body) => body[0]?.description),
    ['version-1', 'version-2'],
  );
});

test('ambiguous current PUT is retried once for acknowledged convergence', async (t) => {
  const mutableConfig = Config as unknown as { devGuildId: string | null };
  const originalDevGuildId = mutableConfig.devGuildId;
  mutableConfig.devGuildId = null;
  t.after(() => { mutableConfig.devGuildId = originalDevGuildId; });

  const registry = createRegistry();
  const bodies: PublishedCommand[][] = [];
  installRest(registry, async (_route, { body }) => {
    bodies.push(body);
    if (bodies.length === 1) throw new Error('ambiguous REST completion');
    return {};
  });

  registry.register(command(1), 'fixture');
  await registry.syncGlobalCommands();
  assert.deepEqual(
    bodies.map((body) => body[0]?.description),
    ['version-1', 'version-1'],
  );
});

test('continuous revisions are bounded and a queued sync repairs the latest snapshot', async (t) => {
  const mutableConfig = Config as unknown as { devGuildId: string | null };
  const originalDevGuildId = mutableConfig.devGuildId;
  mutableConfig.devGuildId = null;
  t.after(() => { mutableConfig.devGuildId = originalDevGuildId; });

  const registry = createRegistry({
    convergenceMaxAttempts: 3,
    convergenceDeadlineMs: 1_000,
  });
  const bodies: PublishedCommand[][] = [];
  let version = 1;
  let churn = true;
  installRest(registry, async (_route, { body }) => {
    bodies.push(body);
    if (churn) {
      registry.unregister('schema', 'fixture');
      registry.register(command(++version), 'fixture');
      if (bodies.length === 3) churn = false;
    }
    return {};
  });

  registry.register(command(version), 'fixture');
  const bounded = registry.syncGlobalCommands();
  const queuedRepair = registry.syncGlobalCommands();

  await assert.rejects(
    bounded,
    (error: unknown) => error instanceof CommandSyncConvergenceError && error.attempts === 3,
  );
  await queuedRepair;

  assert.equal(bodies.length, 4);
  assert.deepEqual(
    bodies.map((body) => body[0]?.description),
    ['version-1', 'version-2', 'version-3', 'version-4'],
  );
});

test('convergence deadline releases the queue after a stale slow PUT', async (t) => {
  const mutableConfig = Config as unknown as { devGuildId: string | null };
  const originalDevGuildId = mutableConfig.devGuildId;
  mutableConfig.devGuildId = null;
  t.after(() => { mutableConfig.devGuildId = originalDevGuildId; });

  const registry = createRegistry({
    convergenceMaxAttempts: 10,
    convergenceDeadlineMs: 1,
  });
  const bodies: PublishedCommand[][] = [];
  let version = 1;
  let mutate = true;
  installRest(registry, async (_route, { body }) => {
    bodies.push(body);
    if (mutate) {
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
      registry.unregister('schema', 'fixture');
      registry.register(command(++version), 'fixture');
      mutate = false;
    }
    return {};
  });

  registry.register(command(version), 'fixture');
  const bounded = registry.syncGlobalCommands();
  const queuedRepair = registry.syncGlobalCommands();

  await assert.rejects(bounded, CommandSyncConvergenceError);
  await queuedRepair;
  assert.deepEqual(
    bodies.map((body) => body[0]?.description),
    ['version-1', 'version-2'],
  );
});

test('a permanent current-revision REST failure releases the next queued sync', async (t) => {
  const mutableConfig = Config as unknown as { devGuildId: string | null };
  const originalDevGuildId = mutableConfig.devGuildId;
  mutableConfig.devGuildId = null;
  t.after(() => { mutableConfig.devGuildId = originalDevGuildId; });

  const registry = createRegistry();
  let putCalls = 0;
  installRest(registry, async () => {
    putCalls++;
    if (putCalls <= 2) throw new Error('permanent current-revision failure');
    return {};
  });

  registry.register(command(1), 'fixture');
  const failed = registry.syncGlobalCommands();
  const queued = registry.syncGlobalCommands();

  await assert.rejects(failed, /permanent current-revision failure/);
  await queued;
  assert.equal(putCalls, 3);
});

test('syncAll retries both scopes when the registry changes between global and guild publish', async () => {
  const registry = createRegistry();
  const publications: string[] = [];
  let mutated = false;
  const currentDescription = (): string => {
    const registered = registry.getCommand('schema');
    assert.ok(registered);
    const json = registered.command.data.toJSON() as PublishedCommand;
    assert.ok(json.description);
    return json.description;
  };
  const testable = registry as unknown as {
    publishGlobalCommands(): Promise<void>;
    publishGuildCommands(guildId?: string): Promise<void>;
  };
  testable.publishGlobalCommands = async () => {
    publications.push(`global:${currentDescription()}`);
    if (!mutated) {
      mutated = true;
      registry.unregister('schema', 'fixture');
      registry.register(command(2), 'fixture');
    }
  };
  testable.publishGuildCommands = async () => {
    publications.push(`guild:${currentDescription()}`);
  };

  registry.register(command(1), 'fixture');
  await registry.syncAllCommands();

  assert.deepEqual(publications, [
    'global:version-1',
    'guild:version-2',
    'global:version-2',
    'guild:version-2',
  ]);
});
