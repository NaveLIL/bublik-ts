import assert from 'node:assert/strict';
import test from 'node:test';
import {
  claimPingerCooldown,
  confirmPingerCooldown,
  finalizePingerCooldown,
  incrementPingerNoProgressCounter,
  isPingerEscalationCoolingDown,
  loadPingerNoProgressCounter,
  pingerActionCooldownKey,
  releasePingerCooldown,
  resetPingerNoProgressCounter,
  startPingerEscalationCooldown,
  type PingerCooldownStore,
} from '../../src/modules/regbattle/pingerCooldown';

class MemoryStore implements PingerCooldownStore {
  readonly values = new Map<string, string>();
  readonly ttls = new Map<string, number>();

  async set(key: string, value: string, _mode: 'PX', ttlMs: number, condition?: 'NX') {
    if (condition === 'NX' && this.values.has(key)) return null;
    this.values.set(key, value);
    this.ttls.set(key, ttlMs);
    return 'OK';
  }

  async get(key: string) { return this.values.get(key) ?? null; }
  async del(key: string) {
    this.ttls.delete(key);
    return this.values.delete(key) ? 1 : 0;
  }

  async eval(script: string, _keys: number, ...args: string[]) {
    const [key] = args;
    if (script.includes("redis.call('incr'")) {
      const next = Number(this.values.get(key) ?? '0') + 1;
      this.values.set(key, String(next));
      this.ttls.set(key, Number(args[1]));
      return next;
    }
    const token = args[1];
    if (this.values.get(key) !== token) return 0;
    if (script.includes("redis.call('psetex'")) {
      this.values.set(key, token);
      this.ttls.set(key, Number(args[2]));
      return 1;
    }
    return this.del(key);
  }
}

test('action cooldown elects one process and finalizes from terminal time', async () => {
  const store = new MemoryStore();
  const key = pingerActionCooldownKey('guild', 'role');
  const winner = await claimPingerCooldown(store, key, 300_000, 'winner');
  assert.ok(winner);
  assert.equal(await claimPingerCooldown(store, key, 300_000, 'loser'), null);
  assert.equal(store.ttls.get(key), 480_000);
  assert.equal(await confirmPingerCooldown(store, winner), true);
  assert.equal(store.ttls.get(key), 480_000);
  assert.equal(await finalizePingerCooldown(store, winner), true);
  assert.equal(store.ttls.get(key), 300_000);
});

test('a confirmed or finalized owner can token-release a final-fence abort', async () => {
  const store = new MemoryStore();
  const confirmedKey = pingerActionCooldownKey('guild', 'role');
  const confirmed = await claimPingerCooldown(store, confirmedKey, 300_000, 'confirmed');
  assert.ok(confirmed);
  assert.equal(await confirmPingerCooldown(store, confirmed), true);
  assert.equal(await releasePingerCooldown(store, confirmed), true);
  assert.equal(await store.get(confirmedKey), null);

  const finalizedKey = pingerActionCooldownKey('guild', 'full');
  const finalized = await claimPingerCooldown(store, finalizedKey, 900_000, 'finalized');
  assert.ok(finalized);
  assert.equal(await finalizePingerCooldown(store, finalized), true);
  assert.equal(await releasePingerCooldown(store, finalized), true);
  assert.equal(await store.get(finalizedKey), null);
});

test('stale owners cannot finalize or release a successor claim', async () => {
  const store = new MemoryStore();
  const key = pingerActionCooldownKey('guild', 'full');
  const stale = await claimPingerCooldown(store, key, 900_000, 'stale');
  assert.ok(stale);
  store.values.set(key, 'successor');
  assert.equal(await confirmPingerCooldown(store, stale), false);
  assert.equal(await finalizePingerCooldown(store, stale), false);
  assert.equal(await releasePingerCooldown(store, stale), false);
  assert.equal(await store.get(key), 'successor');
});

test('escalation cooldown and no-progress counter survive runtime state loss', async () => {
  const store = new MemoryStore();
  await startPingerEscalationCooldown(store, 'guild', 1_800_000);
  assert.equal(await isPingerEscalationCoolingDown(store, 'guild'), true);
  assert.equal(await incrementPingerNoProgressCounter(store, 'guild'), 1);
  assert.equal(await incrementPingerNoProgressCounter(store, 'guild'), 2);
  assert.equal(await loadPingerNoProgressCounter(store, 'guild'), 2);
  await resetPingerNoProgressCounter(store, 'guild');
  assert.equal(await loadPingerNoProgressCounter(store, 'guild'), 0);
});
