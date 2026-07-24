import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test, { after } from 'node:test';
import {
  isPermissionSyncDue,
  parsePermissionSyncIntent,
  PERMISSION_PREPARED_LEASE_MS,
  sortUniquePermissionChannelIds,
  type PermissionSyncIntent,
} from '../../src/modules/tempvoice/permissionSync';
import {
  normalizePermissionSubjects,
  stopRateLimitCleanup,
} from '../../src/modules/tempvoice/utils';

after(() => stopRateLimitCleanup());

const prepared: PermissionSyncIntent = {
  version: 1,
  token: 'mutation-token',
  guildId: 'guild-1',
  channelId: 'channel-1',
  reason: 'test mutation',
  phase: 'prepared',
  preparedAt: 1_000_000,
  readyAt: null,
};

test('permission intent parser accepts only coherent two-phase records', () => {
  assert.deepEqual(parsePermissionSyncIntent(prepared), prepared);

  const ready: PermissionSyncIntent = {
    ...prepared,
    phase: 'ready',
    readyAt: prepared.preparedAt + 1,
  };
  assert.deepEqual(parsePermissionSyncIntent(ready), ready);
  assert.equal(parsePermissionSyncIntent({ ...prepared, token: '' }), null);
  assert.equal(parsePermissionSyncIntent({ ...prepared, readyAt: prepared.preparedAt }), null);
  assert.equal(parsePermissionSyncIntent({ ...ready, readyAt: null }), null);
  assert.equal(parsePermissionSyncIntent({ ...ready, readyAt: prepared.preparedAt - 1 }), null);
});

test('fresh prepared intent is leased to its mutation and stale intent is recovered', () => {
  assert.equal(isPermissionSyncDue(prepared, prepared.preparedAt), false);
  assert.equal(
    isPermissionSyncDue(prepared, prepared.preparedAt + PERMISSION_PREPARED_LEASE_MS - 1),
    false,
  );
  assert.equal(
    isPermissionSyncDue(prepared, prepared.preparedAt + PERMISSION_PREPARED_LEASE_MS),
    true,
  );
  assert.equal(
    isPermissionSyncDue({ ...prepared, phase: 'ready', readyAt: prepared.preparedAt }, prepared.preparedAt),
    true,
  );
});

test('canonical permission subjects are unique and blocked wins legacy overlap', () => {
  assert.deepEqual(
    normalizePermissionSubjects(
      ['trusted', 'trusted', 'overlap', ''],
      ['blocked', 'overlap', 'blocked', ''],
    ),
    {
      trusted: ['trusted'],
      blocked: ['blocked', 'overlap'],
    },
  );
});

test('permission mutations cannot bypass the durable reconciler', () => {
  const handlers = readFileSync(
    path.resolve('src/modules/tempvoice/handlers.ts'),
    'utf8',
  );
  assert.doesNotMatch(handlers, /permissionOverwrites\.set/);
  assert.ok((handlers.match(/runPermissionMutation\(/g) ?? []).length >= 8);

  const lifecycle = readFileSync(
    path.resolve('src/modules/tempvoice/lifecycle.ts'),
    'utf8',
  );
  assert.match(lifecycle, /runPermissionMutation\([\s\S]*?'channel creation'/);
  assert.match(lifecycle, /deleteTimers\.delete\(channelId\);\s*if \(!isGuildAllowed\(state\.guild\.id\)\) return;/);
  assert.match(lifecycle, /deleteTimers\.delete\(channelData\.id\);\s*if \(!isGuildAllowed\(guild\.id\)\) return;/);
});

test('channel mutation lock covers prepare, DB write and reconciliation in order', () => {
  const source = readFileSync(
    path.resolve('src/modules/tempvoice/permissionSync.ts'),
    'utf8',
  );
  const start = source.indexOf('export async function runPermissionMutation');
  const end = source.indexOf('/** Generator role changes', start);
  const body = source.slice(start, end);

  const acquire = body.indexOf("acquireMutationLock('channel', channelId)");
  const prepareIntent = body.indexOf('preparePermissionSync(guildId, channelId, reason)');
  const mutate = body.indexOf('await mutation()');
  const finish = body.indexOf('finishPreparedIntent(client, intent)');
  const release = body.indexOf('releaseMutationLock(mutationLock)');
  assert.ok(start >= 0 && end > start);
  assert.ok(acquire >= 0 && acquire < prepareIntent);
  assert.ok(prepareIntent < mutate && mutate < finish && finish < release);

  // Even if a lease expires or a lock is lost, a failed token CAS must recreate
  // durable work after the late DB writer finishes.
  const finishStart = source.indexOf('async function finishPreparedIntent');
  const finishEnd = source.indexOf('/** Intent is committed', finishStart);
  const finishBody = source.slice(finishStart, finishEnd);
  assert.match(finishBody, /if \(ready\) return reconcileChannelPermissions/);
  assert.match(finishBody, /queuePermissionAudit\([\s\S]*?'ready CAS verification'/);
});

test('generator permission mutation locks every affected channel in stable order', () => {
  assert.deepEqual(
    sortUniquePermissionChannelIds(['channel-b', 'channel-a', 'channel-b', '', 'channel-c']),
    ['channel-a', 'channel-b', 'channel-c'],
  );

  const source = readFileSync(
    path.resolve('src/modules/tempvoice/permissionSync.ts'),
    'utf8',
  );
  const start = source.indexOf('export async function runGeneratorPermissionMutation');
  const end = source.indexOf('/** Queue a canonical audit', start);
  const body = source.slice(start, end);
  assert.ok(start >= 0 && end > start);
  assert.equal((body.match(/acquireChannelMutationLocks\(/g) ?? []).length, 2);

  const firstLock = body.indexOf('acquireChannelMutationLocks(channelIds');
  const firstPrepare = body.indexOf('preparePermissionSync(guildId, id, reason)');
  const mutate = body.indexOf('await mutation()');
  const secondSnapshot = body.indexOf('const currentChannelIds');
  const secondLock = body.indexOf('acquireChannelMutationLocks(currentChannelIds');
  const finish = body.indexOf('finishPreparedIntent(client, intent)');
  assert.ok(firstLock >= 0 && firstLock < firstPrepare && firstPrepare < mutate);
  assert.ok(mutate < secondSnapshot && secondSnapshot < secondLock && secondLock < finish);
});
