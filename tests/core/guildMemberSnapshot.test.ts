import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import ts from 'typescript';
import { Collection, Guild, GuildMember, Status } from 'discord.js';
import {
  gatewayMemberRateLimitRetryAfterMs,
  GuildMemberSnapshotCoordinator,
  GuildMemberSnapshotUnavailableError,
} from '../../src/core/GuildMemberSnapshot';

function deferred(): { promise: Promise<void>; resolve: () => void; reject: (error: unknown) => void } {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function fakeGuild(
  id: string,
  fetchAll: () => Promise<unknown>,
): Guild {
  return {
    id,
    available: true,
    shard: { status: Status.Ready },
    members: {
      cache: new Collection<string, GuildMember>(),
      fetch: fetchAll,
    },
  } as unknown as Guild;
}

test('concurrent and sequential consumers share one complete member request', async () => {
  const gate = deferred();
  let fetches = 0;
  const guild = fakeGuild('guild', async () => {
    fetches += 1;
    await gate.promise;
  });
  const coordinator = new GuildMemberSnapshotCoordinator();

  const first = coordinator.get(guild);
  const second = coordinator.get(guild);
  assert.equal(fetches, 1);
  gate.resolve();

  assert.equal(await first, guild.members.cache);
  assert.equal(await second, guild.members.cache);
  assert.equal(await coordinator.get(guild), guild.members.cache);
  assert.equal(fetches, 1);
});

test('a failed request never marks a partial cache complete', async () => {
  let fetches = 0;
  const guild = fakeGuild('guild', async () => {
    fetches += 1;
    if (fetches === 1) throw new Error('gateway failed');
  });
  const coordinator = new GuildMemberSnapshotCoordinator();

  await assert.rejects(coordinator.get(guild), /gateway failed/);
  await coordinator.get(guild);
  assert.equal(fetches, 2);
});

test('a captured generation token fails closed after gateway invalidation', async () => {
  const guild = fakeGuild('guild', async () => undefined);
  const coordinator = new GuildMemberSnapshotCoordinator();
  const snapshot = await coordinator.snapshot(guild);

  assert.equal(coordinator.assertCurrent(guild, snapshot.token), guild.members.cache);
  coordinator.invalidateGuild(guild.id);
  assert.throws(
    () => coordinator.assertCurrent(guild, snapshot.token),
    GuildMemberSnapshotUnavailableError,
  );
});

test('opcode 8 rate limiting waits for retry_after and retries only once', async () => {
  const delays: number[] = [];
  let fetches = 0;
  const limited = {
    name: 'GatewayRateLimitError',
    data: { opcode: 8, retry_after: 0.5 },
  };
  const guild = fakeGuild('guild', async () => {
    fetches += 1;
    if (fetches === 1) throw limited;
  });
  const coordinator = new GuildMemberSnapshotCoordinator({
    sleep: async (delayMs) => { delays.push(delayMs); },
    rateLimitRetryMarginMs: 25,
  });

  await coordinator.get(guild);
  assert.equal(fetches, 2);
  assert.deepEqual(delays, [525]);
  assert.equal(gatewayMemberRateLimitRetryAfterMs(limited), 500);

  const alwaysLimited = fakeGuild('other', async () => { throw limited; });
  await assert.rejects(coordinator.get(alwaysLimited), (error) => error === limited);
  assert.deepEqual(delays, [525, 525]);
});

test('gateway invalidation serializes the replacement behind a stale in-flight request', async () => {
  const gate = deferred();
  let fetches = 0;
  const guild = fakeGuild('guild', async () => {
    fetches += 1;
    if (fetches === 1) await gate.promise;
  });
  const coordinator = new GuildMemberSnapshotCoordinator();

  const first = coordinator.get(guild);
  coordinator.invalidateGuild(guild.id);
  const replacement = coordinator.get(guild);
  assert.equal(fetches, 1, 'the replacement must not overlap the stale opcode-8 request');
  gate.resolve();
  await assert.rejects(first, GuildMemberSnapshotUnavailableError);
  await replacement;
  assert.equal(fetches, 2);
});

test('unavailable guilds and disconnected shards fail closed without fetching', async () => {
  let fetches = 0;
  const guild = fakeGuild('guild', async () => { fetches += 1; });
  const coordinator = new GuildMemberSnapshotCoordinator();

  (guild as { available: boolean }).available = false;
  await assert.rejects(coordinator.get(guild), GuildMemberSnapshotUnavailableError);
  (guild as { available: boolean }).available = true;
  (guild.shard as { status: Status }).status = Status.Reconnecting;
  await assert.rejects(coordinator.get(guild), GuildMemberSnapshotUnavailableError);
  assert.equal(fetches, 0);
});

test('different guilds have independent full-member request state', async () => {
  let firstFetches = 0;
  let secondFetches = 0;
  const coordinator = new GuildMemberSnapshotCoordinator();
  await Promise.all([
    coordinator.get(fakeGuild('first', async () => { firstFetches += 1; })),
    coordinator.get(fakeGuild('second', async () => { secondFetches += 1; })),
  ]);
  assert.equal(firstFetches, 1);
  assert.equal(secondFetches, 1);
});

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const resolved = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(resolved);
    return entry.isFile() && entry.name.endsWith('.ts') ? [resolved] : [];
  });
}

test('all production full-member requests go through the shared coordinator', () => {
  const sourceRoot = path.resolve(process.cwd(), 'src');
  const coordinatorPath = path.resolve(sourceRoot, 'core', 'GuildMemberSnapshot.ts');
  const violations: string[] = [];

  for (const file of sourceFiles(sourceRoot)) {
    if (path.resolve(file) === coordinatorPath) continue;
    const source = ts.createSourceFile(
      file,
      readFileSync(file, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && node.arguments.length === 0 &&
          ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'fetch' &&
          ts.isPropertyAccessExpression(node.expression.expression) &&
          node.expression.expression.name.text === 'members') {
        const location = source.getLineAndCharacterOfPosition(node.getStart(source));
        violations.push(`${path.relative(sourceRoot, file)}:${location.line + 1}`);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }

  assert.deepEqual(violations, []);
});
