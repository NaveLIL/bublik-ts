import test from 'node:test';
import assert from 'node:assert/strict';
import type { Guild } from 'discord.js';
import {
  type OrdersMuteRecord,
  type OrdersMuteCasStore,
  type OrdersMuteCleanupLeaseStore,
  OrdersMuteCleanupLeaseLostError,
  OrdersMuteRuntimeFence,
  claimExactOrdersMuteCleanup,
  deleteExactOrdersMuteCleanup,
  isOrdersMuteTargetAuthoritativelyGone,
  parseOrdersMuteRecord,
  runOrdersMuteCleanupWithImmediateRepair,
  scheduleOrdersMuteRecovery,
  selectOrdersMuteCandidateIds,
  unmuteClaimedOrdersMember,
  updateOrdersMuteNotification,
  withOrdersMuteCleanupLease,
} from '../../src/modules/regbattle/ordersMutes';

function record(): OrdersMuteRecord {
  return {
    version: 1,
    status: 'active',
    guildId: 'guild',
    squadId: 'squad',
    ownerId: 'owner',
    userIds: ['one', 'one', 'two'],
    createdAt: 100,
    expiresAt: 200,
    notificationChannelId: null,
    notificationMessageId: null,
    cleanupToken: null,
  };
}

class MemoryOrdersMuteStore implements OrdersMuteCasStore {
  constructor(private value: string | null) {}

  async read(): Promise<string | null> {
    return this.value;
  }

  async compareSet(_key: string, expected: string, next: string): Promise<boolean> {
    if (this.value !== expected) return false;
    this.value = next;
    return true;
  }

  async compareDelete(_key: string, expected: string): Promise<boolean> {
    if (this.value !== expected) return false;
    this.value = null;
    return true;
  }

  claimIfAbsent(raw: string): boolean {
    if (this.value !== null) return false;
    this.value = raw;
    return true;
  }

  current(): string | null {
    return this.value;
  }
}

class MemoryOrdersMuteLeaseStore implements OrdersMuteCleanupLeaseStore {
  private readonly owners = new Map<string, { token: string; expiresAt: number }>();
  renewCalls = 0;
  rejectRenewals = false;
  private renewAttempts = 0;
  private renewObserved: (() => void) | null = null;

  async acquire(key: string, token: string, ttlMs: number): Promise<boolean> {
    this.expireIfDue(key);
    if (this.owners.has(key)) return false;
    this.owners.set(key, { token, expiresAt: Date.now() + ttlMs });
    return true;
  }

  async readToken(key: string): Promise<string | null> {
    this.expireIfDue(key);
    return this.owners.get(key)?.token ?? null;
  }

  async renew(key: string, token: string, ttlMs: number): Promise<boolean> {
    this.expireIfDue(key);
    const current = this.owners.get(key);
    if (!current || current.token !== token) return false;
    this.renewAttempts++;
    this.renewObserved?.();
    this.renewObserved = null;
    if (this.rejectRenewals) return false;
    current.expiresAt = Date.now() + ttlMs;
    this.renewCalls++;
    return true;
  }

  async release(key: string, token: string): Promise<void> {
    if (this.owners.get(key)?.token === token) this.owners.delete(key);
  }

  expire(key: string): void {
    this.owners.delete(key);
  }

  waitForRenew(): Promise<void> {
    if (this.renewAttempts > 0) return Promise.resolve();
    return new Promise((resolve) => { this.renewObserved = resolve; });
  }

  private expireIfDue(key: string): void {
    const current = this.owners.get(key);
    if (current && current.expiresAt <= Date.now()) this.owners.delete(key);
  }
}

test('orders mute record round-trips and deduplicates recovery targets', () => {
  const parsed = parseOrdersMuteRecord(JSON.parse(JSON.stringify(record())));
  assert.ok(parsed);
  assert.deepEqual(parsed.userIds, ['one', 'two']);
});

test('orders mute recovery rejects malformed or impossible durable state', () => {
  assert.equal(parseOrdersMuteRecord({ ...record(), version: 2 }), null);
  assert.equal(parseOrdersMuteRecord({ ...record(), status: 'unknown' }), null);
  assert.equal(parseOrdersMuteRecord({ ...record(), userIds: [null] }), null);
  assert.equal(parseOrdersMuteRecord({ ...record(), createdAt: 300, expiresAt: 200 }), null);
  assert.equal(parseOrdersMuteRecord({ ...record(), expiresAt: Number.NaN }), null);
  assert.equal(parseOrdersMuteRecord({ ...record(), status: 'cleaning', cleanupToken: null }), null);
});

test('pre-existing server mutes are never claimed by orders recovery', () => {
  assert.deepEqual(selectOrdersMuteCandidateIds([
    { id: 'already-muted', serverMute: true },
    { id: 'ours', serverMute: false },
    { id: 'unknown-state', serverMute: null },
    { id: 'ours', serverMute: false },
  ]), ['ours']);
});

test('tokenised exact cleanup cannot cross into a replacement mute generation', async () => {
  const original = record();
  const originalRaw = JSON.stringify(original);
  const store = new MemoryOrdersMuteStore(originalRaw);
  const claim = await claimExactOrdersMuteCleanup(
    store,
    'orders-key',
    originalRaw,
    true,
    300,
    'cleanup-old',
  );
  assert.ok(claim);
  assert.equal(claim.record.status, 'cleaning');
  assert.equal(claim.record.cleanupToken, 'cleanup-old');

  const replacementRaw = JSON.stringify({
    ...original,
    createdAt: 400,
    expiresAt: 500,
  });
  assert.equal(store.claimIfAbsent(replacementRaw), false, 'cleaning row blocks NX replacement');
  assert.equal(await deleteExactOrdersMuteCleanup(store, 'orders-key', claim.raw), true);
  assert.equal(store.claimIfAbsent(replacementRaw), true);
  assert.equal(
    await deleteExactOrdersMuteCleanup(store, 'orders-key', claim.raw),
    false,
    'late old CAS-delete cannot remove replacement',
  );
  assert.equal(store.current(), replacementRaw);
});

test('orders cleanup lease renews and excludes a second worker', async () => {
  const store = new MemoryOrdersMuteLeaseStore();
  const first = withOrdersMuteCleanupLease(
    store,
    'orders-lock',
    async (assertOwned) => {
      await store.waitForRenew();
      await new Promise((resolve) => setTimeout(resolve, 120));
      await assertOwned();
      const second = await withOrdersMuteCleanupLease(
        store,
        'orders-lock',
        async () => 'unexpected',
        { ttlMs: 100, renewMs: 10 },
      );
      assert.deepEqual(second, { acquired: false });
      return 'owned';
    },
    { ttlMs: 100, renewMs: 10 },
  );

  assert.deepEqual(await first, { acquired: true, value: 'owned' });
  assert.ok(store.renewCalls >= 1);
});

test('a failed renewal is permanent ownership loss even while the token is still readable', async () => {
  const store = new MemoryOrdersMuteLeaseStore();
  store.rejectRenewals = true;

  await assert.rejects(
    withOrdersMuteCleanupLease(
      store,
      'orders-lock',
      async (assertOwned) => {
        await store.waitForRenew();
        await new Promise<void>((resolve) => setImmediate(resolve));
        await assertOwned();
      },
      { ttlMs: 100, renewMs: 10 },
    ),
    OrdersMuteCleanupLeaseLostError,
  );
});

test('a worker stops before its next mutation after cleanup lease loss', async () => {
  const store = new MemoryOrdersMuteLeaseStore();
  const mutations: string[] = [];

  await assert.rejects(
    withOrdersMuteCleanupLease(
      store,
      'orders-lock',
      async (assertOwned) => {
        await assertOwned();
        mutations.push('old-before-loss');
        store.expire('orders-lock');
        const replacement = await withOrdersMuteCleanupLease(
          store,
          'orders-lock',
          async (assertReplacementOwned) => {
            await assertReplacementOwned();
            mutations.push('replacement');
          },
          { ttlMs: 1_000, renewMs: 500 },
        );
        assert.equal(replacement.acquired, true);
        await assertOwned();
        mutations.push('old-after-loss');
      },
      { ttlMs: 1_000, renewMs: 500 },
    ),
    OrdersMuteCleanupLeaseLostError,
  );
  assert.deepEqual(mutations, ['old-before-loss', 'replacement']);
});

test('lost cleanup ownership triggers one immediate safe repair', async () => {
  let repairs = 0;
  const result = await runOrdersMuteCleanupWithImmediateRepair(
    async (markRepairable) => {
      markRepairable();
      throw new OrdersMuteCleanupLeaseLostError('fixture');
    },
    async () => {
      repairs++;
      return 'reconciled';
    },
  );
  assert.equal(result, 'reconciled');
  assert.equal(repairs, 1);
});

test('orders cleanup force-fetches voice state and unmutes despite stale false cache', async () => {
  let fetchForce: boolean | undefined;
  const muteValues: boolean[] = [];
  let ownershipChecks = 0;
  const guild = {
    voiceStates: {
      async fetch(_userId: string, options: { force?: boolean }) {
        fetchForce = options.force;
        return {
          serverMute: false,
          async setMute(value: boolean) { muteValues.push(value); },
        };
      },
    },
  } as unknown as Guild;

  await unmuteClaimedOrdersMember(
    guild,
    'user',
    async () => { ownershipChecks++; },
  );
  assert.equal(fetchForce, true);
  assert.deepEqual(muteValues, [false]);
  assert.equal(ownershipChecks, 3);
});

test('authoritative missing/not-in-voice outcomes resolve, transient unmute remains retryable', async () => {
  for (const code of [10007, 10065]) {
    const guild = {
      voiceStates: { fetch: async () => { throw { code }; } },
    } as unknown as Guild;
    await unmuteClaimedOrdersMember(guild, 'user');
  }

  const disconnectedDuringUnmute = {
    voiceStates: {
      fetch: async () => ({ setMute: async () => { throw { code: 40032 }; } }),
    },
  } as unknown as Guild;
  await unmuteClaimedOrdersMember(disconnectedDuringUnmute, 'user');

  const transient = {
    voiceStates: {
      fetch: async () => ({ setMute: async () => { throw new Error('network timeout'); } }),
    },
  } as unknown as Guild;
  await assert.rejects(unmuteClaimedOrdersMember(transient, 'user'), /network timeout/);
  assert.equal(isOrdersMuteTargetAuthoritativelyGone({ code: 10065 }), true);
  assert.equal(isOrdersMuteTargetAuthoritativelyGone(new Error('network timeout')), false);
});

test('transient orders notification failure remains retryable while unknown message resolves', async () => {
  let editError: unknown = new Error('network timeout');
  let edits = 0;
  let ownershipChecks = 0;
  let markedMutations = 0;
  const channel = {
    isTextBased: () => true,
    messages: {
      fetch: async () => ({
        edit: async () => {
          edits++;
          throw editError;
        },
      }),
    },
  };
  const guild = {
    id: 'guild',
    channels: {
      cache: { get: () => channel },
      fetch: async () => channel,
    },
  } as unknown as Guild;
  const notificationRecord = {
    ...record(),
    notificationChannelId: 'channel',
    notificationMessageId: 'message',
  };
  const payloadFactory = async () => ({ content: 'ended' });

  assert.equal(await updateOrdersMuteNotification(
    guild,
    notificationRecord,
    async () => { ownershipChecks++; },
    () => { markedMutations++; },
    payloadFactory,
  ), false);
  assert.equal(edits, 1);
  assert.equal(ownershipChecks, 2);
  assert.equal(markedMutations, 1);

  editError = { code: 10008 };
  assert.equal(await updateOrdersMuteNotification(
    guild,
    notificationRecord,
    async () => undefined,
    () => undefined,
    payloadFactory,
  ), true);
});

test('late orders handler cannot schedule a timer after stop and new generation', async () => {
  const fence = new OrdersMuteRuntimeFence();
  const oldGeneration = fence.begin();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const lateHandler = (async () => {
    await gate;
    return scheduleOrdersMuteRecovery(
      { ...record(), expiresAt: Date.now() + 60_000 },
      {} as never,
      oldGeneration,
    );
  })();

  fence.invalidate();
  const newGeneration = fence.begin();
  release();
  assert.equal(await lateHandler, false);
  assert.equal(oldGeneration(), false);
  assert.equal(newGeneration(), true);
});
