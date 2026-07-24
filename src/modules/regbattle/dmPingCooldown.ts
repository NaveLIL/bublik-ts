import { randomUUID } from 'node:crypto';
import {
  DM_PING_COOLDOWN_MS,
  DM_SEND_DELAY_MS,
} from './constants';

const MAX_CLAIM_TTL_MS = 24 * 60 * 60_000;
const PER_RECIPIENT_GUARD_MS = 60_000;
const PREVIEW_TOKEN_RE = /^[0-9a-f]{16}$/;

export interface DmPingCooldownStore {
  set(
    key: string,
    value: string,
    expiryMode: 'PX',
    ttlMs: number,
    condition: 'NX',
  ): Promise<string | null>;
  eval(
    script: string,
    numberOfKeys: number,
    ...args: string[]
  ): Promise<unknown>;
}

export interface DmPingCooldownClaim {
  token: string;
  raw: string;
  expiresAt: number;
  ttlMs: number;
}

export interface ParsedDmPingCooldown {
  expiresAt: number;
  token: string | null;
}

export type DmPingPreviewClaimResult =
  | { status: 'claimed'; claim: DmPingCooldownClaim; message: string }
  | { status: 'cooldown' }
  | { status: 'expired' };

export function createDmPingPreviewToken(): string {
  return randomUUID().replaceAll('-', '').slice(0, 16);
}

export function isDmPingPreviewToken(value: unknown): value is string {
  return typeof value === 'string' && PREVIEW_TOKEN_RE.test(value);
}

export function parseDmPingCooldown(raw: string | null): ParsedDmPingCooldown | null {
  if (!raw) return null;
  const match = /^(\d+)(?::([A-Za-z0-9-]{1,128}))?$/.exec(raw);
  if (!match) return null;
  const expiresAt = Number(match[1]);
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= 0) return null;
  return { expiresAt, token: match[2] ?? null };
}

/** Existing but malformed Redis state is treated as a full active cooldown. */
export function dmPingCooldownSecondsLeft(
  raw: string | null,
  now: number = Date.now(),
): number | null {
  if (raw === null) return null;
  const parsed = parseDmPingCooldown(raw);
  if (!parsed || !Number.isFinite(now)) return Math.ceil(DM_PING_COOLDOWN_MS / 1000);
  return Math.max(Math.ceil((parsed.expiresAt - now) / 1000), 1);
}

/**
 * A crashed batch must retain its claim for its conservative projected
 * duration. Successful batches shorten this to the normal cooldown.
 */
export function dmPingBatchClaimTtlMs(targetCount: number): number {
  if (!Number.isSafeInteger(targetCount) || targetCount <= 0) return MAX_CLAIM_TTL_MS;
  const projected = DM_PING_COOLDOWN_MS +
    targetCount * (DM_SEND_DELAY_MS + PER_RECIPIENT_GUARD_MS);
  return Math.min(Math.max(projected, DM_PING_COOLDOWN_MS), MAX_CLAIM_TTL_MS);
}

export async function claimDmPingCooldown(
  store: DmPingCooldownStore,
  key: string,
  targetCount: number,
  now: number = Date.now(),
  token: string = randomUUID(),
): Promise<DmPingCooldownClaim | null> {
  if (!key || !Number.isSafeInteger(now) || now <= 0 || !token) {
    throw new Error('Invalid DM ping cooldown claim');
  }
  const ttlMs = dmPingBatchClaimTtlMs(targetCount);
  const expiresAt = now + ttlMs;
  if (!Number.isSafeInteger(expiresAt)) throw new Error('DM ping cooldown expiry overflow');
  const raw = `${expiresAt}:${token}`;
  const acquired = await store.set(key, raw, 'PX', ttlMs, 'NX');
  return acquired === 'OK' ? { token, raw, expiresAt, ttlMs } : null;
}

const CONSUME_PREVIEW_SCRIPT = `
if redis.call('exists', KEYS[1]) == 1 then
  return {0}
end
local message = redis.call('get', KEYS[2])
if not message then
  return {-1}
end
local acquired = redis.call('set', KEYS[1], ARGV[1], 'PX', ARGV[2], 'NX')
if not acquired then
  return {0}
end
redis.call('del', KEYS[2])
return {1, message}
`;

/**
 * Atomically elects one confirmation, consumes its exact nonce-bound preview,
 * and creates the cooldown before any DM can be sent. A concurrent cancel can
 * therefore win only by deleting the preview first; it can never report a
 * cancellation for a batch that was already claimed.
 */
export async function consumeDmPingPreviewAndClaim(
  store: DmPingCooldownStore,
  cooldownKey: string,
  messageKey: string,
  targetCount: number,
  now: number = Date.now(),
  token: string = randomUUID(),
): Promise<DmPingPreviewClaimResult> {
  if (!cooldownKey || !messageKey || cooldownKey === messageKey ||
      !Number.isSafeInteger(now) || now <= 0 || !token) {
    throw new Error('Invalid DM ping preview claim');
  }
  const ttlMs = dmPingBatchClaimTtlMs(targetCount);
  const expiresAt = now + ttlMs;
  if (!Number.isSafeInteger(expiresAt)) throw new Error('DM ping cooldown expiry overflow');
  const raw = `${expiresAt}:${token}`;
  const result = await store.eval(
    CONSUME_PREVIEW_SCRIPT,
    2,
    cooldownKey,
    messageKey,
    raw,
    String(ttlMs),
  );
  if (!Array.isArray(result) || result.length === 0) {
    throw new Error('Invalid DM ping preview claim response');
  }
  const status = Number(result[0]);
  if (status === 0) return { status: 'cooldown' };
  if (status === -1) return { status: 'expired' };
  if (status !== 1 || typeof result[1] !== 'string') {
    throw new Error('Invalid DM ping preview claim response');
  }
  return {
    status: 'claimed',
    claim: { token, raw, expiresAt, ttlMs },
    message: result[1],
  };
}

const FINALIZE_CLAIM_SCRIPT = `
if redis.call('get', KEYS[1]) ~= ARGV[1] then
  return 0
end
redis.call('psetex', KEYS[1], ARGV[2], ARGV[3])
return 1
`;

export async function finalizeDmPingCooldown(
  store: DmPingCooldownStore,
  key: string,
  claim: DmPingCooldownClaim,
  now: number = Date.now(),
): Promise<boolean> {
  if (!Number.isSafeInteger(now) || now <= 0) return false;
  const expiresAt = now + DM_PING_COOLDOWN_MS;
  if (!Number.isSafeInteger(expiresAt)) return false;
  const nextRaw = `${expiresAt}:${claim.token}`;
  const result = await store.eval(
    FINALIZE_CLAIM_SCRIPT,
    1,
    key,
    claim.raw,
    String(DM_PING_COOLDOWN_MS),
    nextRaw,
  );
  return Number(result) === 1;
}
