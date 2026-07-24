import { randomUUID } from 'node:crypto';

const ACTION_CLAIM_GRACE_MS = 3 * 60_000;
const COUNTER_TTL_MS = 24 * 60 * 60_000;

export interface PingerCooldownStore {
  set(
    key: string,
    value: string,
    expiryMode: 'PX',
    ttlMs: number,
    condition?: 'NX',
  ): Promise<string | null>;
  get(key: string): Promise<string | null>;
  del(key: string): Promise<number>;
  eval(
    script: string,
    numberOfKeys: number,
    ...args: string[]
  ): Promise<unknown>;
}

export interface PingerCooldownClaim {
  key: string;
  token: string;
  intervalMs: number;
}

export type PingerActionKind = 'role' | 'individual' | 'full';

function actionClaimSafetyTtlMs(intervalMs: number): number {
  const ttlMs = intervalMs + ACTION_CLAIM_GRACE_MS;
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= intervalMs) {
    throw new Error('Invalid pinger cooldown safety TTL');
  }
  return ttlMs;
}

export function pingerActionCooldownKey(guildId: string, kind: PingerActionKind): string {
  if (!guildId) throw new Error('Pinger cooldown requires a guild id');
  return `rb:pinger:cooldown:${guildId}:${kind}`;
}

export function pingerIndividualUserCooldownKey(guildId: string, userId: string): string {
  if (!guildId || !userId) throw new Error('Pinger user cooldown requires guild and user ids');
  return `rb:pinger:individual-user:${guildId}:${userId}`;
}

export function pingerEscalationCooldownKey(guildId: string): string {
  if (!guildId) throw new Error('Pinger escalation cooldown requires a guild id');
  return `rb:pinger:escalation:${guildId}`;
}

export function pingerNoProgressCounterKey(guildId: string): string {
  if (!guildId) throw new Error('Pinger progress counter requires a guild id');
  return `rb:pinger:no-progress:${guildId}`;
}

export async function claimPingerCooldown(
  store: PingerCooldownStore,
  key: string,
  intervalMs: number,
  token: string = randomUUID(),
): Promise<PingerCooldownClaim | null> {
  if (!key || !token || !Number.isSafeInteger(intervalMs) || intervalMs <= 0) {
    throw new Error('Invalid pinger cooldown claim');
  }
  const claimTtlMs = actionClaimSafetyTtlMs(intervalMs);
  const acquired = await store.set(key, token, 'PX', claimTtlMs, 'NX');
  return acquired === 'OK' ? { key, token, intervalMs } : null;
}

const CONFIRM_SCRIPT = `
if redis.call('get', KEYS[1]) ~= ARGV[1] then return 0 end
redis.call('psetex', KEYS[1], ARGV[2], ARGV[1])
return 1
`;

/**
 * Proves that the preflight still owns its claim and renews the conservative
 * safety lease before the final external-state reads. The real cooldown still
 * starts at terminal send/failure time through `finalizePingerCooldown`.
 */
export async function confirmPingerCooldown(
  store: PingerCooldownStore,
  claim: PingerCooldownClaim,
): Promise<boolean> {
  const result = await store.eval(
    CONFIRM_SCRIPT,
    1,
    claim.key,
    claim.token,
    String(actionClaimSafetyTtlMs(claim.intervalMs)),
  );
  return Number(result) === 1;
}

const FINALIZE_SCRIPT = `
if redis.call('get', KEYS[1]) ~= ARGV[1] then return 0 end
redis.call('psetex', KEYS[1], ARGV[2], ARGV[1])
return 1
`;

/** Starts the real interval at terminal send/failure time, not at preflight. */
export async function finalizePingerCooldown(
  store: PingerCooldownStore,
  claim: PingerCooldownClaim,
): Promise<boolean> {
  const result = await store.eval(
    FINALIZE_SCRIPT,
    1,
    claim.key,
    claim.token,
    String(claim.intervalMs),
  );
  return Number(result) === 1;
}

const RELEASE_SCRIPT = `
if redis.call('get', KEYS[1]) ~= ARGV[1] then return 0 end
return redis.call('del', KEYS[1])
`;

/** Releases only a pre-send action aborted by a fresh state/revision fence. */
export async function releasePingerCooldown(
  store: PingerCooldownStore,
  claim: PingerCooldownClaim,
): Promise<boolean> {
  const result = await store.eval(RELEASE_SCRIPT, 1, claim.key, claim.token);
  return Number(result) === 1;
}

export async function isPingerEscalationCoolingDown(
  store: PingerCooldownStore,
  guildId: string,
): Promise<boolean> {
  return (await store.get(pingerEscalationCooldownKey(guildId))) !== null;
}

export async function startPingerEscalationCooldown(
  store: PingerCooldownStore,
  guildId: string,
  ttlMs: number,
): Promise<void> {
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) throw new Error('Invalid escalation cooldown');
  await store.set(pingerEscalationCooldownKey(guildId), '1', 'PX', ttlMs);
}

export async function loadPingerNoProgressCounter(
  store: PingerCooldownStore,
  guildId: string,
): Promise<number> {
  const raw = await store.get(pingerNoProgressCounterKey(guildId));
  if (raw === null) return 0;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : Number.MAX_SAFE_INTEGER;
}

const INCREMENT_COUNTER_SCRIPT = `
local value = redis.call('incr', KEYS[1])
redis.call('pexpire', KEYS[1], ARGV[1])
return value
`;

export async function incrementPingerNoProgressCounter(
  store: PingerCooldownStore,
  guildId: string,
): Promise<number> {
  const result = await store.eval(
    INCREMENT_COUNTER_SCRIPT,
    1,
    pingerNoProgressCounterKey(guildId),
    String(COUNTER_TTL_MS),
  );
  const count = Number(result);
  if (!Number.isSafeInteger(count) || count < 1) {
    throw new Error('Invalid pinger progress counter response');
  }
  return count;
}

export async function resetPingerNoProgressCounter(
  store: PingerCooldownStore,
  guildId: string,
): Promise<void> {
  await store.del(pingerNoProgressCounterKey(guildId));
}
