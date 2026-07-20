import { randomUUID } from 'node:crypto';
import {
  DM_PING_COOLDOWN_MS,
  DM_SEND_DELAY_MS,
} from './constants';

const MAX_CLAIM_TTL_MS = 24 * 60 * 60_000;
const PER_RECIPIENT_GUARD_MS = 60_000;
const PREVIEW_TOKEN_RE = /^[0-9a-f]{16}$/;
const DISCORD_SNOWFLAKE_RE = /^\d{1,20}$/;
const DM_PING_PREVIEW_VERSION = 2;
const MAX_DM_PING_PREVIEW_MESSAGE_LENGTH = 1_500;

/** Largest batch whose conservative projected claim still fits in 24 hours. */
export const MAX_DM_PING_PREVIEW_TARGETS = Math.floor(
  (MAX_CLAIM_TTL_MS - DM_PING_COOLDOWN_MS) /
  (DM_SEND_DELAY_MS + PER_RECIPIENT_GUARD_MS),
);

export interface DmPingCooldownStore {
  get(key: string): Promise<string | null>;
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

export interface DmPingPreviewEnvelope {
  version: typeof DM_PING_PREVIEW_VERSION;
  nonce: string;
  message: string;
  targetIds: string[];
}

export type DmPingPreviewClaimResult =
  | { status: 'claimed'; claim: DmPingCooldownClaim; preview: DmPingPreviewEnvelope }
  | { status: 'cooldown' }
  | { status: 'expired' };

export function createDmPingPreviewToken(): string {
  return randomUUID().replaceAll('-', '').slice(0, 16);
}

export function isDmPingPreviewToken(value: unknown): value is string {
  return typeof value === 'string' && PREVIEW_TOKEN_RE.test(value);
}

function isDmPingTargetId(value: unknown): value is string {
  return typeof value === 'string' && DISCORD_SNOWFLAKE_RE.test(value);
}

/**
 * Keep the exact recipient snapshot next to the preview text. The nonce is
 * duplicated inside the value so moving/copying a Redis value to another
 * preview key cannot authorise a different confirmation button.
 */
export function serializeDmPingPreviewEnvelope(
  nonce: string,
  message: string,
  targetIds: readonly string[],
): string {
  if (!isDmPingPreviewToken(nonce) || typeof message !== 'string' ||
      message.length === 0 || message.length > MAX_DM_PING_PREVIEW_MESSAGE_LENGTH ||
      !Array.isArray(targetIds) || targetIds.length === 0 ||
      targetIds.length > MAX_DM_PING_PREVIEW_TARGETS) {
    throw new Error('Invalid DM ping preview envelope');
  }
  const uniqueTargetIds = new Set<string>();
  for (const targetId of targetIds) {
    if (!isDmPingTargetId(targetId) || uniqueTargetIds.has(targetId)) {
      throw new Error('Invalid DM ping preview envelope');
    }
    uniqueTargetIds.add(targetId);
  }
  const envelope: DmPingPreviewEnvelope = {
    version: DM_PING_PREVIEW_VERSION,
    nonce,
    message,
    targetIds: [...targetIds],
  };
  return JSON.stringify(envelope);
}

/** Legacy plain-message previews deliberately fail closed and expire by TTL. */
export function parseDmPingPreviewEnvelope(
  raw: string | null,
  expectedNonce: string,
): DmPingPreviewEnvelope | null {
  if (!raw || !isDmPingPreviewToken(expectedNonce)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const candidate = parsed as Partial<DmPingPreviewEnvelope>;
  if (candidate.version !== DM_PING_PREVIEW_VERSION ||
      candidate.nonce !== expectedNonce ||
      typeof candidate.message !== 'string' || candidate.message.length === 0 ||
      candidate.message.length > MAX_DM_PING_PREVIEW_MESSAGE_LENGTH ||
      !Array.isArray(candidate.targetIds) || candidate.targetIds.length === 0 ||
      candidate.targetIds.length > MAX_DM_PING_PREVIEW_TARGETS) {
    return null;
  }
  const uniqueTargetIds = new Set<string>();
  for (const targetId of candidate.targetIds) {
    if (!isDmPingTargetId(targetId) || uniqueTargetIds.has(targetId)) return null;
    uniqueTargetIds.add(targetId);
  }
  return {
    version: DM_PING_PREVIEW_VERSION,
    nonce: candidate.nonce,
    message: candidate.message,
    targetIds: [...candidate.targetIds],
  };
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
local preview = redis.call('get', KEYS[2])
if not preview or preview ~= ARGV[1] then
  return {-1}
end
local acquired = redis.call('set', KEYS[1], ARGV[2], 'PX', ARGV[3], 'NX')
if not acquired then
  return {0}
end
redis.call('del', KEYS[2])
return {1}
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
  previewKey: string,
  previewNonce: string,
  now: number = Date.now(),
  token: string = randomUUID(),
): Promise<DmPingPreviewClaimResult> {
  if (!cooldownKey || !previewKey || cooldownKey === previewKey ||
      !isDmPingPreviewToken(previewNonce) ||
      !Number.isSafeInteger(now) || now <= 0 || !token) {
    throw new Error('Invalid DM ping preview claim');
  }

  // Parse before entering Lua so the claim TTL is derived from the exact
  // recipient snapshot. Lua compares this raw value before claiming, making
  // the optimistic read safe against confirm/cancel/replacement races.
  const rawPreview = await store.get(previewKey);
  const preview = parseDmPingPreviewEnvelope(rawPreview, previewNonce);
  if (!rawPreview || !preview) {
    return await store.get(cooldownKey) === null
      ? { status: 'expired' }
      : { status: 'cooldown' };
  }

  const ttlMs = dmPingBatchClaimTtlMs(preview.targetIds.length);
  const expiresAt = now + ttlMs;
  if (!Number.isSafeInteger(expiresAt)) throw new Error('DM ping cooldown expiry overflow');
  const raw = `${expiresAt}:${token}`;
  const result = await store.eval(
    CONSUME_PREVIEW_SCRIPT,
    2,
    cooldownKey,
    previewKey,
    rawPreview,
    raw,
    String(ttlMs),
  );
  if (!Array.isArray(result) || result.length === 0) {
    throw new Error('Invalid DM ping preview claim response');
  }
  const status = Number(result[0]);
  if (status === 0) return { status: 'cooldown' };
  if (status === -1) return { status: 'expired' };
  if (status !== 1) {
    throw new Error('Invalid DM ping preview claim response');
  }
  return {
    status: 'claimed',
    claim: { token, raw, expiresAt, ttlMs },
    preview,
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
