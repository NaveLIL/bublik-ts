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
  MAX_DM_PING_PREVIEW_TARGETS,
  parseDmPingPreviewEnvelope,
  parseDmPingCooldown,
  serializeDmPingPreviewEnvelope,
  type DmPingCooldownStore,
} from '../../src/modules/regbattle/dmPingCooldown';

const PREVIEW_NONCE = '0123456789abcdef'; // gitleaks:allow -- deterministic test nonce

function previewEnvelope(message = 'exact preview', targetCount = 1): string {
  return serializeDmPingPreviewEnvelope(
    PREVIEW_NONCE,
    message,
    Array.from({ length: targetCount }, (_, index) => String(index + 1)),
  );
}

class MemoryStore implements DmPingCooldownStore {
  value: string | null = null;
  messageValue: string | null = null;
  ttlMs = 0;

  async get(key: string): Promise<string | null> {
    return key === 'cooldown' ? this.value : this.messageValue;
  }

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
      const [, , expectedPreview, replacement, ttlMs] = args;
      if (this.value !== null) return [0];
      if (this.messageValue === null || this.messageValue !== expectedPreview) return [-1];
      this.value = replacement;
      this.messageValue = null;
      this.ttlMs = Number(ttlMs);
      return [1];
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
  store.messageValue = previewEnvelope('exact preview', 10);
  const [first, second] = await Promise.all([
    consumeDmPingPreviewAndClaim(store, 'cooldown', 'message', PREVIEW_NONCE, 1_000, 'claim-a'),
    consumeDmPingPreviewAndClaim(store, 'cooldown', 'message', PREVIEW_NONCE, 1_000, 'claim-b'),
  ]);
  assert.equal([first, second].filter((result) => result.status === 'claimed').length, 1);
  assert.equal([first, second].filter((result) => result.status === 'cooldown').length, 1);
  assert.equal(store.messageValue, null);
  assert.match(store.value ?? '', /^\d+:claim-[ab]$/);
  assert.equal(store.ttlMs, dmPingBatchClaimTtlMs(10));
});

test('confirm and cancel have one exact nonce-bound winner', async () => {
  const cancelled = new MemoryStore();
  cancelled.messageValue = null; // cancel DEL won first
  assert.deepEqual(
    await consumeDmPingPreviewAndClaim(
      cancelled,
      'cooldown',
      'message',
      PREVIEW_NONCE,
      1_000,
      'confirm',
    ),
    { status: 'expired' },
  );
  assert.equal(cancelled.value, null);

  const confirmed = new MemoryStore();
  confirmed.messageValue = previewEnvelope('send me');
  const result = await consumeDmPingPreviewAndClaim(
    confirmed,
    'cooldown',
    'message',
    PREVIEW_NONCE,
    1_000,
    'confirm',
  );
  assert.equal(result.status, 'claimed');
  assert.equal(confirmed.messageValue, null, 'a later cancel sees DEL=0 and reports expired');
});

test('preview envelope is nonce-bound and preserves the exact target snapshot', () => {
  const raw = previewEnvelope('message', 3);
  assert.deepEqual(parseDmPingPreviewEnvelope(raw, PREVIEW_NONCE), {
    version: 2,
    nonce: PREVIEW_NONCE,
    message: 'message',
    targetIds: ['1', '2', '3'],
  });
  assert.equal(parseDmPingPreviewEnvelope(raw, 'fedcba9876543210'), null);
  assert.equal(parseDmPingPreviewEnvelope('legacy plain message', PREVIEW_NONCE), null);
});

test('legacy and malformed previews expire safely without acquiring a cooldown', async () => {
  for (const raw of [
    'legacy plain message',
    JSON.stringify({ version: 2, nonce: PREVIEW_NONCE, message: 'x', targetIds: [] }),
    JSON.stringify({
      version: 2,
      nonce: PREVIEW_NONCE,
      message: 'x',
      targetIds: ['1', '1'],
    }),
  ]) {
    const store = new MemoryStore();
    store.messageValue = raw;
    assert.deepEqual(
      await consumeDmPingPreviewAndClaim(
        store,
        'cooldown',
        'message',
        PREVIEW_NONCE,
        1_000,
        'claim',
      ),
      { status: 'expired' },
    );
    assert.equal(store.value, null);
    assert.equal(store.messageValue, raw, 'invalid preview remains bounded by its original Redis TTL');
  }
});

test('replacement between preview read and atomic claim cannot be consumed', async () => {
  class ReplacingStore extends MemoryStore {
    override async eval(
      script: string,
      numberOfKeys: number,
      ...args: string[]
    ): Promise<unknown> {
      if (numberOfKeys === 2) this.messageValue = previewEnvelope('replacement', 2);
      return super.eval(script, numberOfKeys, ...args);
    }
  }
  const store = new ReplacingStore();
  store.messageValue = previewEnvelope('original');
  assert.deepEqual(
    await consumeDmPingPreviewAndClaim(
      store,
      'cooldown',
      'message',
      PREVIEW_NONCE,
      1_000,
      'claim',
    ),
    { status: 'expired' },
  );
  assert.equal(store.value, null);
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

test('preview target boundary cannot outlive the maximum conservative claim', () => {
  const maxClaimTtlMs = 24 * 60 * 60_000;
  const safeTtlMs = dmPingBatchClaimTtlMs(MAX_DM_PING_PREVIEW_TARGETS);
  assert.ok(MAX_DM_PING_PREVIEW_TARGETS > 0);
  assert.ok(safeTtlMs <= maxClaimTtlMs);
  assert.equal(
    dmPingBatchClaimTtlMs(MAX_DM_PING_PREVIEW_TARGETS + 1),
    maxClaimTtlMs,
    'the first rejected count would already saturate the 24-hour claim',
  );

  const safeRaw = previewEnvelope('safe boundary', MAX_DM_PING_PREVIEW_TARGETS);
  assert.equal(
    parseDmPingPreviewEnvelope(safeRaw, PREVIEW_NONCE)?.targetIds.length,
    MAX_DM_PING_PREVIEW_TARGETS,
  );
  assert.throws(
    () => previewEnvelope('unsafe boundary', MAX_DM_PING_PREVIEW_TARGETS + 1),
    /Invalid DM ping preview envelope/,
  );

  const unsafeRaw = JSON.stringify({
    version: 2,
    nonce: PREVIEW_NONCE,
    message: 'unsafe boundary',
    targetIds: Array.from(
      { length: MAX_DM_PING_PREVIEW_TARGETS + 1 },
      (_, index) => String(index + 1),
    ),
  });
  assert.equal(parseDmPingPreviewEnvelope(unsafeRaw, PREVIEW_NONCE), null);
});
