import assert from 'node:assert/strict';
import test from 'node:test';
import {
  claimDmPingCooldown,
  consumeDmPingPreviewAndClaim,
  createDmPingPreviewToken,
  dmPingBatchClaimTtlMs,
  dmPingCooldownSecondsLeft,
  finalizeDmPingCooldown,
  isDmPingPreviewToken,
  parseDmPingCooldown,
  type DmPingCooldownStore,
} from '../../src/modules/regbattle/dmPingCooldown';

class MemoryStore implements DmPingCooldownStore {
  value: string | null = null;
  messageValue: string | null = null;
  ttlMs = 0;

  async set(
    _key: string,
    value: string,
    _expiryMode: 'PX',
    ttlMs: number,
    _condition: 'NX',
  ): Promise<string | null> {
    if (this.value !== null) return null;
    this.value = value;
    this.ttlMs = ttlMs;
    return 'OK';
  }

  async eval(
    _script: string,
    numberOfKeys: number,
    ...args: string[]
  ): Promise<unknown> {
    if (numberOfKeys === 2) {
      const [, , replacement, ttlMs] = args;
      if (this.value !== null) return [0];
      if (this.messageValue === null) return [-1];
      const message = this.messageValue;
      this.value = replacement;
      this.messageValue = null;
      this.ttlMs = Number(ttlMs);
      return [1, message];
    }
    const [, expected, ttlMs, replacement] = args;
    if (this.value !== expected) return 0;
    this.value = replacement;
    this.ttlMs = Number(ttlMs);
    return 1;
  }
}

test('only one concurrent DM confirmation consumes the preview and acquires the claim', async () => {
  const store = new MemoryStore();
  store.messageValue = 'exact preview';
  const [first, second] = await Promise.all([
    consumeDmPingPreviewAndClaim(store, 'cooldown', 'message', 10, 1_000, 'claim-a'),
    consumeDmPingPreviewAndClaim(store, 'cooldown', 'message', 10, 1_000, 'claim-b'),
  ]);
  assert.equal([first, second].filter((result) => result.status === 'claimed').length, 1);
  assert.equal([first, second].filter((result) => result.status === 'cooldown').length, 1);
  assert.equal(store.messageValue, null);
  assert.match(store.value ?? '', /^\d+:claim-[ab]$/);
});

test('confirm and cancel have one exact nonce-bound winner', async () => {
  const cancelled = new MemoryStore();
  cancelled.messageValue = null; // cancel DEL won first
  assert.deepEqual(
    await consumeDmPingPreviewAndClaim(cancelled, 'cooldown', 'message', 1, 1_000, 'confirm'),
    { status: 'expired' },
  );
  assert.equal(cancelled.value, null);

  const confirmed = new MemoryStore();
  confirmed.messageValue = 'send me';
  const result = await consumeDmPingPreviewAndClaim(
    confirmed,
    'cooldown',
    'message',
    1,
    1_000,
    'confirm',
  );
  assert.equal(result.status, 'claimed');
  assert.equal(confirmed.messageValue, null, 'a later cancel sees DEL=0 and reports expired');
});

test('only the exact owner can shorten a completed batch to the normal cooldown', async () => {
  const store = new MemoryStore();
  const claim = await claimDmPingCooldown(store, 'cooldown', 25, 10_000, 'owner');
  assert.ok(claim);
  assert.equal(await finalizeDmPingCooldown(store, 'cooldown', { ...claim, raw: 'stale' }, 20_000), false);
  assert.equal(await finalizeDmPingCooldown(store, 'cooldown', claim, 20_000), true);
  assert.deepEqual(parseDmPingCooldown(store.value), {
    expiresAt: 20_000 + 5 * 60_000,
    token: 'owner',
  });
  assert.equal(store.ttlMs, 5 * 60_000);
});

test('cooldown parsing supports legacy values and fails closed on malformed state', () => {
  assert.deepEqual(parseDmPingCooldown('123456'), { expiresAt: 123456, token: null });
  assert.deepEqual(parseDmPingCooldown('123456:0123456789abcdef'), {
    expiresAt: 123456,
    token: '0123456789abcdef', // gitleaks:allow -- deterministic test fence
  });
  assert.equal(parseDmPingCooldown('NaN:token'), null);
  assert.equal(dmPingCooldownSecondsLeft(null, 100_000), null);
  assert.equal(dmPingCooldownSecondsLeft('101000', 100_000), 1);
  assert.equal(dmPingCooldownSecondsLeft('broken', 100_000), 300);
});

test('batch claim TTL is conservative and preview tokens are bounded', () => {
  assert.ok(dmPingBatchClaimTtlMs(20) > 5 * 60_000);
  assert.equal(dmPingBatchClaimTtlMs(0), 24 * 60 * 60_000);
  const token = createDmPingPreviewToken();
  assert.equal(isDmPingPreviewToken(token), true);
  assert.equal(isDmPingPreviewToken('../bad'), false);
});
