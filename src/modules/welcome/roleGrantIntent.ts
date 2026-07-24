import { randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { getDatabase } from '../../core/Database';
import { isAuthoritativeMembershipGeneration } from './policy';

export const WELCOME_ROLE_GRANT_SCOPE = 'welcome_role_grant';
export const WELCOME_ROLE_LATE_APPLY_GRACE_MS = 15 * 60_000;

export type WelcomeAutomaticRoleKind = 'auto' | 'recruit';
export type WelcomeRoleGrantPolicy = 'join' | 'repair' | 'rules' | 'removal-recovery';
export type WelcomeRoleGrantPhase = 'prepared' | 'dispatched' | 'compensating';
export type WelcomeRoleCompensationReason =
  | 'authority-revoked'
  | 'rules-generation-mismatch'
  | 'membership-generation-mismatch';

export interface WelcomeRoleGrantIntent {
  version: 2;
  token: string;
  revision: number;
  guildId: string;
  userId: string;
  roleId: string;
  kind: WelcomeAutomaticRoleKind;
  policy: WelcomeRoleGrantPolicy;
  membershipGeneration: string;
  preexisting: false;
  phase: WelcomeRoleGrantPhase;
  preparedAt: number;
  dispatchedAt: number | null;
  updatedAt: number;
  dispatchAttempts: number;
  removalDispatchedAt: number | null;
  removalAttempts: number;
  compensationMembershipGeneration: string | null;
  compensationReason: WelcomeRoleCompensationReason | null;
}

export interface PrepareWelcomeRoleGrantInput {
  guildId: string;
  userId: string;
  roleId: string;
  kind: WelcomeAutomaticRoleKind;
  policy: WelcomeRoleGrantPolicy;
  membershipGeneration: string;
}

export type WelcomeRoleIntentDatabase = Pick<Prisma.TransactionClient, 'operationClaim'>;

export class WelcomeRoleGrantIntentFencedError extends Error {
  constructor(intent: Pick<WelcomeRoleGrantIntent, 'guildId' | 'userId' | 'kind' | 'token'>) {
    super(`Welcome role grant intent was fenced for ${intent.guildId}:${intent.userId}:${intent.kind}:${intent.token}`);
    this.name = 'WelcomeRoleGrantIntentFencedError';
  }
}

export function welcomeRoleGrantIntentKey(
  guildId: string,
  userId: string,
  kind: WelcomeAutomaticRoleKind,
): string {
  return `welcome-role-grant:${guildId}:${userId}:${kind}`;
}

function asMetadata(intent: WelcomeRoleGrantIntent): Prisma.InputJsonObject {
  return intent as unknown as Prisma.InputJsonObject;
}

function isExactIntentState(
  left: WelcomeRoleGrantIntent,
  right: WelcomeRoleGrantIntent,
): boolean {
  return left.version === right.version &&
    left.token === right.token &&
    left.revision === right.revision &&
    left.guildId === right.guildId &&
    left.userId === right.userId &&
    left.roleId === right.roleId &&
    left.kind === right.kind &&
    left.policy === right.policy &&
    left.membershipGeneration === right.membershipGeneration &&
    left.preexisting === right.preexisting &&
    left.phase === right.phase &&
    left.preparedAt === right.preparedAt &&
    left.dispatchedAt === right.dispatchedAt &&
    left.updatedAt === right.updatedAt &&
    left.dispatchAttempts === right.dispatchAttempts &&
    left.removalDispatchedAt === right.removalDispatchedAt &&
    left.removalAttempts === right.removalAttempts &&
    left.compensationMembershipGeneration === right.compensationMembershipGeneration &&
    left.compensationReason === right.compensationReason;
}

export function parseWelcomeRoleGrantIntent(value: unknown): WelcomeRoleGrantIntent | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const intent = value as Partial<Omit<WelcomeRoleGrantIntent, 'version'>> & { version?: number };
  const validKind = intent.kind === 'auto' || intent.kind === 'recruit';
  const validPolicy = intent.policy === 'join' || intent.policy === 'repair' ||
    intent.policy === 'rules' || intent.policy === 'removal-recovery';
  const validPhase = intent.phase === 'prepared' || intent.phase === 'dispatched' ||
    intent.phase === 'compensating';
  if (
    (intent.version !== 1 && intent.version !== 2) ||
    typeof intent.token !== 'string' || !intent.token ||
    typeof intent.revision !== 'number' ||
    !Number.isInteger(intent.revision) || intent.revision < 0 ||
    typeof intent.guildId !== 'string' || !intent.guildId ||
    typeof intent.userId !== 'string' || !intent.userId ||
    typeof intent.roleId !== 'string' || !intent.roleId ||
    !validKind ||
    !validPolicy ||
    !validPhase ||
    typeof intent.membershipGeneration !== 'string' || !intent.membershipGeneration ||
    intent.preexisting !== false ||
    typeof intent.preparedAt !== 'number' || !Number.isFinite(intent.preparedAt) ||
    !(intent.dispatchedAt === null ||
      (typeof intent.dispatchedAt === 'number' && Number.isFinite(intent.dispatchedAt))) ||
    typeof intent.updatedAt !== 'number' || !Number.isFinite(intent.updatedAt) ||
    typeof intent.dispatchAttempts !== 'number' ||
    !Number.isInteger(intent.dispatchAttempts) || intent.dispatchAttempts < 0
  ) return null;
  if (intent.kind === 'recruit' && intent.policy !== 'rules') return null;
  if (intent.kind === 'auto' && intent.policy === 'rules') return null;
  if (intent.phase === 'prepared' &&
      (intent.dispatchedAt !== null || intent.dispatchAttempts !== 0)) return null;
  if ((intent.phase === 'dispatched' || intent.phase === 'compensating') &&
      (intent.dispatchedAt === null || intent.dispatchAttempts < 1)) return null;
  if (intent.updatedAt < intent.preparedAt) return null;
  if (intent.dispatchedAt !== null && intent.updatedAt < intent.dispatchedAt) return null;

  // Version 1 existed before Discord role removals received their own durable
  // dispatch record. Normalize it in memory; the next exact CAS transition
  // writes version 2 without mutating a claim merely because it was read.
  if (intent.version === 1) {
    if (intent.phase === 'compensating') return null;
    return {
      ...(intent as Omit<WelcomeRoleGrantIntent, 'version' | 'removalDispatchedAt' |
        'removalAttempts' | 'compensationMembershipGeneration' | 'compensationReason'>),
      version: 2,
      removalDispatchedAt: null,
      removalAttempts: 0,
      compensationMembershipGeneration: null,
      compensationReason: null,
    };
  }

  const validCompensationReason = intent.compensationReason === null ||
    intent.compensationReason === 'authority-revoked' ||
    intent.compensationReason === 'rules-generation-mismatch' ||
    intent.compensationReason === 'membership-generation-mismatch';
  if (
    !(intent.removalDispatchedAt === null ||
      (typeof intent.removalDispatchedAt === 'number' && Number.isFinite(intent.removalDispatchedAt))) ||
    typeof intent.removalAttempts !== 'number' ||
    !Number.isInteger(intent.removalAttempts) || intent.removalAttempts < 0 ||
    !(intent.compensationMembershipGeneration === null ||
      (typeof intent.compensationMembershipGeneration === 'string' &&
        intent.compensationMembershipGeneration.length > 0)) ||
    !validCompensationReason
  ) return null;
  if (intent.phase === 'compensating') {
    if (intent.removalDispatchedAt === null || intent.removalAttempts < 1 ||
        intent.compensationMembershipGeneration === null ||
        intent.compensationMembershipGeneration === 'unknown' ||
        intent.compensationReason === null ||
        intent.removalDispatchedAt < intent.dispatchedAt! ||
        intent.updatedAt < intent.removalDispatchedAt ||
        (intent.compensationReason === 'rules-generation-mismatch' && intent.policy !== 'rules')) return null;
  } else if (intent.removalDispatchedAt !== null ||
      intent.compensationMembershipGeneration !== null || intent.compensationReason !== null) return null;
  return intent as WelcomeRoleGrantIntent;
}

export async function readWelcomeRoleGrantIntent(
  guildId: string,
  userId: string,
  kind: WelcomeAutomaticRoleKind,
  database: WelcomeRoleIntentDatabase = getDatabase(),
): Promise<WelcomeRoleGrantIntent | null> {
  const key = welcomeRoleGrantIntentKey(guildId, userId, kind);
  const claim = await database.operationClaim.findUnique({ where: { key } });
  if (!claim) return null;
  if (claim.scope !== WELCOME_ROLE_GRANT_SCOPE) {
    throw new Error(`Unexpected OperationClaim scope at ${key}`);
  }
  const intent = parseWelcomeRoleGrantIntent(claim.metadata);
  if (!intent || welcomeRoleGrantIntentKey(intent.guildId, intent.userId, intent.kind) !== key) {
    throw new Error(`Malformed welcome role grant intent retained at ${key}`);
  }
  return intent;
}

export async function prepareWelcomeRoleGrantIntent(
  input: PrepareWelcomeRoleGrantInput,
  database: WelcomeRoleIntentDatabase = getDatabase(),
  now = Date.now(),
  token = randomUUID(),
): Promise<{ intent: WelcomeRoleGrantIntent; created: boolean }> {
  if (!isAuthoritativeMembershipGeneration(input.membershipGeneration)) {
    throw new Error('Welcome role grant requires an authoritative membership generation');
  }
  const intent: WelcomeRoleGrantIntent = {
    version: 2,
    token,
    revision: 0,
    ...input,
    preexisting: false,
    phase: 'prepared',
    preparedAt: now,
    dispatchedAt: null,
    updatedAt: now,
    dispatchAttempts: 0,
    removalDispatchedAt: null,
    removalAttempts: 0,
    compensationMembershipGeneration: null,
    compensationReason: null,
  };
  const key = welcomeRoleGrantIntentKey(input.guildId, input.userId, input.kind);
  try {
    const inserted = await database.operationClaim.createMany({
      data: [{
        key,
        scope: WELCOME_ROLE_GRANT_SCOPE,
        guildId: input.guildId,
        userId: input.userId,
        metadata: asMetadata(intent),
      }],
      skipDuplicates: true,
    });
    if (inserted.count === 1) return { intent, created: true };
  } catch (error) {
    const persisted = await readWelcomeRoleGrantIntent(
      input.guildId,
      input.userId,
      input.kind,
      database,
    ).catch(() => null);
    if (persisted?.token === token) return { intent: persisted, created: true };
    if (!persisted) throw error;
    return { intent: persisted, created: false };
  }
  const persisted = await readWelcomeRoleGrantIntent(
    input.guildId,
    input.userId,
    input.kind,
    database,
  );
  if (!persisted) throw new Error(`Welcome role grant intent disappeared at ${key}`);
  return { intent: persisted, created: persisted.token === token };
}

/** Atomically hand the stable key from an old membership to a new UUID intent. */
export async function replaceWelcomeRoleGrantIntent(
  expected: WelcomeRoleGrantIntent,
  input: PrepareWelcomeRoleGrantInput,
  database: WelcomeRoleIntentDatabase = getDatabase(),
  now = Date.now(),
  token = randomUUID(),
): Promise<WelcomeRoleGrantIntent> {
  if (input.guildId !== expected.guildId ||
      input.userId !== expected.userId ||
      input.kind !== expected.kind) {
    throw new Error('Welcome role grant replacement must keep the stable claim key');
  }
  if (!isAuthoritativeMembershipGeneration(expected.membershipGeneration) ||
      !isAuthoritativeMembershipGeneration(input.membershipGeneration)) {
    throw new Error('Welcome role grant replacement requires authoritative generations');
  }
  const replacement: WelcomeRoleGrantIntent = {
    version: 2,
    token,
    revision: 0,
    ...input,
    preexisting: false,
    phase: 'prepared',
    preparedAt: now,
    dispatchedAt: null,
    updatedAt: now,
    dispatchAttempts: 0,
    removalDispatchedAt: null,
    removalAttempts: 0,
    compensationMembershipGeneration: null,
    compensationReason: null,
  };
  const key = welcomeRoleGrantIntentKey(expected.guildId, expected.userId, expected.kind);
  try {
    const result = await database.operationClaim.updateMany({
      where: {
        key,
        scope: WELCOME_ROLE_GRANT_SCOPE,
        AND: [
          { metadata: { path: ['token'], equals: expected.token } },
          { metadata: { path: ['revision'], equals: expected.revision } },
        ],
      },
      data: { metadata: asMetadata(replacement) },
    });
    if (result.count === 1) return replacement;
  } catch (error) {
    const current = await readWelcomeRoleGrantIntent(
      expected.guildId,
      expected.userId,
      expected.kind,
      database,
    ).catch(() => null);
    if (current?.token === replacement.token && current.revision === replacement.revision) {
      return current;
    }
    if (current?.token === expected.token && current.revision === expected.revision) throw error;
    throw new WelcomeRoleGrantIntentFencedError(expected);
  }
  const current = await readWelcomeRoleGrantIntent(
    expected.guildId,
    expected.userId,
    expected.kind,
    database,
  );
  if (current?.token === replacement.token && current.revision === replacement.revision) {
    return current;
  }
  throw new WelcomeRoleGrantIntentFencedError(expected);
}

/**
 * Atomically carry exact old-ADD provenance to a known current membership when
 * the same role is still policy-authorized. No Discord mutation happens here;
 * the new dispatched tombstone keeps watching the adopted result through a
 * fresh grace window before terminal completion.
 */
export async function handoffWelcomeRoleGrantIntentGeneration(
  expected: WelcomeRoleGrantIntent,
  input: PrepareWelcomeRoleGrantInput,
  database: WelcomeRoleIntentDatabase = getDatabase(),
  now = Date.now(),
  token = randomUUID(),
): Promise<WelcomeRoleGrantIntent> {
  if (expected.phase !== 'dispatched' || expected.dispatchedAt === null ||
      expected.dispatchAttempts < 1 || expected.roleId !== input.roleId ||
      expected.guildId !== input.guildId || expected.userId !== input.userId ||
      expected.kind !== input.kind) {
    throw new Error('Welcome role generation handoff requires exact dispatched ADD provenance');
  }
  if (!isAuthoritativeMembershipGeneration(expected.membershipGeneration) ||
      !isAuthoritativeMembershipGeneration(input.membershipGeneration)) {
    throw new Error('Welcome role generation handoff requires authoritative generations');
  }
  const transitionAt = Math.max(now, expected.updatedAt);
  const replacement: WelcomeRoleGrantIntent = {
    version: 2,
    token,
    revision: 0,
    ...input,
    preexisting: false,
    phase: 'dispatched',
    preparedAt: transitionAt,
    dispatchedAt: transitionAt,
    updatedAt: transitionAt,
    dispatchAttempts: expected.dispatchAttempts,
    removalDispatchedAt: null,
    removalAttempts: 0,
    compensationMembershipGeneration: null,
    compensationReason: null,
  };
  const key = welcomeRoleGrantIntentKey(expected.guildId, expected.userId, expected.kind);
  try {
    const result = await database.operationClaim.updateMany({
      where: {
        key,
        scope: WELCOME_ROLE_GRANT_SCOPE,
        AND: [
          { metadata: { path: ['token'], equals: expected.token } },
          { metadata: { path: ['revision'], equals: expected.revision } },
        ],
      },
      data: { metadata: asMetadata(replacement) },
    });
    if (result.count === 1) return replacement;
  } catch (error) {
    const current = await readWelcomeRoleGrantIntent(
      expected.guildId,
      expected.userId,
      expected.kind,
      database,
    ).catch(() => null);
    if (current && isExactIntentState(current, replacement)) return current;
    if (current?.token === expected.token && current.revision === expected.revision) throw error;
    throw new WelcomeRoleGrantIntentFencedError(expected);
  }
  const current = await readWelcomeRoleGrantIntent(
    expected.guildId,
    expected.userId,
    expected.kind,
    database,
  );
  if (current && isExactIntentState(current, replacement)) return current;
  throw new WelcomeRoleGrantIntentFencedError(expected);
}

export async function assertWelcomeRoleGrantIntentCurrent(
  intent: WelcomeRoleGrantIntent,
  database: WelcomeRoleIntentDatabase = getDatabase(),
): Promise<void> {
  const current = await readWelcomeRoleGrantIntent(
    intent.guildId,
    intent.userId,
    intent.kind,
    database,
  );
  if (current?.token !== intent.token || current.revision !== intent.revision) {
    throw new WelcomeRoleGrantIntentFencedError(intent);
  }
}

async function persistWelcomeRoleGrantTransition(
  intent: WelcomeRoleGrantIntent,
  updated: WelcomeRoleGrantIntent,
  database: WelcomeRoleIntentDatabase,
  transition: string,
): Promise<WelcomeRoleGrantIntent> {
  const key = welcomeRoleGrantIntentKey(intent.guildId, intent.userId, intent.kind);
  try {
    const result = await database.operationClaim.updateMany({
      where: {
        key,
        scope: WELCOME_ROLE_GRANT_SCOPE,
        AND: [
          { metadata: { path: ['token'], equals: intent.token } },
          { metadata: { path: ['revision'], equals: intent.revision } },
        ],
      },
      data: { metadata: asMetadata(updated) },
    });
    if (result.count === 1) return updated;
  } catch (error) {
    const persisted = await readWelcomeRoleGrantIntent(
      intent.guildId,
      intent.userId,
      intent.kind,
      database,
    ).catch(() => null);
    // An exception can be an ambiguous response after the write committed. Only
    // the complete state produced by this exact attempt proves that outcome.
    if (persisted && isExactIntentState(persisted, updated)) return persisted;
    if (persisted?.token === intent.token) {
      if (persisted.revision !== intent.revision) {
        throw new WelcomeRoleGrantIntentFencedError(intent);
      }
      throw error;
    }
    if (!persisted) throw error;
    throw new WelcomeRoleGrantIntentFencedError(intent);
  }

  const current = await readWelcomeRoleGrantIntent(
    intent.guildId,
    intent.userId,
    intent.kind,
    database,
  );
  // A successful zero-row CAS is unambiguous: this worker did not perform the
  // transition. Even an identical next revision belongs to another worker.
  if (current?.token === intent.token) {
    if (current.revision !== intent.revision) {
      throw new WelcomeRoleGrantIntentFencedError(intent);
    }
    throw new Error(`Welcome role grant ${transition} transition failed at ${key}`);
  }
  throw new WelcomeRoleGrantIntentFencedError(intent);
}

export async function recordWelcomeRoleGrantDispatch(
  intent: WelcomeRoleGrantIntent,
  database: WelcomeRoleIntentDatabase = getDatabase(),
  now = Date.now(),
): Promise<WelcomeRoleGrantIntent> {
  if (!isAuthoritativeMembershipGeneration(intent.membershipGeneration)) {
    throw new Error('Welcome role grant dispatch requires an authoritative membership generation');
  }
  const transitionAt = Math.max(now, intent.updatedAt);
  const updated: WelcomeRoleGrantIntent = {
    ...intent,
    revision: intent.revision + 1,
    phase: 'dispatched',
    // Every idempotent retry can itself have a late Discord response, so grace
    // is measured from the most recent REST dispatch rather than the first.
    dispatchedAt: transitionAt,
    updatedAt: transitionAt,
    dispatchAttempts: intent.dispatchAttempts + 1,
    removalDispatchedAt: null,
    compensationMembershipGeneration: null,
    compensationReason: null,
  };
  return persistWelcomeRoleGrantTransition(intent, updated, database, 'add-dispatch');
}

/**
 * Persist the ownership tombstone immediately before a Discord role DELETE.
 * A rules-generation mismatch is compensatable only from a previously
 * dispatched, non-preexisting add intent; prepared/foreign roles never reach
 * this transition.
 */
export async function recordWelcomeRoleRemovalDispatch(
  intent: WelcomeRoleGrantIntent,
  compensationMembershipGeneration: string,
  compensationReason: WelcomeRoleCompensationReason,
  database: WelcomeRoleIntentDatabase = getDatabase(),
  now = Date.now(),
): Promise<WelcomeRoleGrantIntent> {
  if (intent.phase === 'prepared' || intent.dispatchedAt === null) {
    throw new Error('Welcome role removal requires durable add-dispatch provenance');
  }
  if (!isAuthoritativeMembershipGeneration(intent.membershipGeneration)) {
    throw new Error('Welcome role removal cannot use unknown add provenance');
  }
  if (!compensationMembershipGeneration || compensationMembershipGeneration === 'unknown') {
    throw new Error('Welcome role removal requires an authoritative membership generation');
  }
  const transitionAt = Math.max(now, intent.updatedAt);
  const updated: WelcomeRoleGrantIntent = {
    ...intent,
    version: 2,
    revision: intent.revision + 1,
    phase: 'compensating',
    removalDispatchedAt: transitionAt,
    removalAttempts: intent.removalAttempts + 1,
    compensationMembershipGeneration,
    compensationReason,
    updatedAt: transitionAt,
  };
  return persistWelcomeRoleGrantTransition(intent, updated, database, 'remove-dispatch');
}

/** Token-CAS completion; false means a newer intent owns the stable key. */
export async function completeWelcomeRoleGrantIntent(
  intent: WelcomeRoleGrantIntent,
  database: WelcomeRoleIntentDatabase = getDatabase(),
): Promise<boolean> {
  const key = welcomeRoleGrantIntentKey(intent.guildId, intent.userId, intent.kind);
  try {
    const removed = await database.operationClaim.deleteMany({
      where: {
        key,
        scope: WELCOME_ROLE_GRANT_SCOPE,
        AND: [
          { metadata: { path: ['token'], equals: intent.token } },
          { metadata: { path: ['revision'], equals: intent.revision } },
        ],
      },
    });
    if (removed.count === 1) return true;
  } catch (error) {
    const current = await readWelcomeRoleGrantIntent(
      intent.guildId,
      intent.userId,
      intent.kind,
      database,
    ).catch(() => undefined);
    if (current === null) return true;
    if (current &&
        (current.token !== intent.token || current.revision !== intent.revision)) {
      throw new WelcomeRoleGrantIntentFencedError(intent);
    }
    throw error;
  }
  const current = await readWelcomeRoleGrantIntent(
    intent.guildId,
    intent.userId,
    intent.kind,
    database,
  );
  if (!current) return true;
  if (current.token !== intent.token || current.revision !== intent.revision) {
    throw new WelcomeRoleGrantIntentFencedError(intent);
  }
  throw new Error(`Welcome role grant intent completion failed at ${key}`);
}

export function isWelcomeRoleGrantIntentPastGrace(
  intent: WelcomeRoleGrantIntent,
  now = Date.now(),
  graceMs = WELCOME_ROLE_LATE_APPLY_GRACE_MS,
): boolean {
  return now >= (intent.dispatchedAt ?? intent.preparedAt) + graceMs;
}

export function isWelcomeRoleRemovalPastGrace(
  intent: WelcomeRoleGrantIntent,
  now = Date.now(),
  graceMs = WELCOME_ROLE_LATE_APPLY_GRACE_MS,
): boolean {
  return intent.phase === 'compensating' && intent.removalDispatchedAt !== null &&
    now >= intent.removalDispatchedAt + graceMs;
}

export async function listWelcomeRoleGrantIntentClaims(
  guildIds: readonly string[],
  database: WelcomeRoleIntentDatabase = getDatabase(),
): Promise<Array<{ key: string; intent: WelcomeRoleGrantIntent | null }>> {
  if (guildIds.length === 0) return [];
  const claims = await database.operationClaim.findMany({
    where: {
      scope: WELCOME_ROLE_GRANT_SCOPE,
      guildId: { in: [...new Set(guildIds)] },
    },
    orderBy: { createdAt: 'asc' },
  });
  return claims.map((claim) => ({
    key: claim.key,
    intent: parseWelcomeRoleGrantIntent(claim.metadata),
  }));
}
