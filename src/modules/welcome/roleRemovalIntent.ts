import { randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { getDatabase } from '../../core/Database';
import { WELCOME_ROLE_LATE_APPLY_GRACE_MS } from './roleGrantIntent';

export const WELCOME_AUTO_ROLE_REMOVAL_SCOPE = 'welcome_auto_role_removal';

export interface WelcomeAutoRoleRegrantProof {
  membershipGeneration: string;
  observedAt: number;
}

export interface WelcomeAutoRoleRemovalIntent {
  version: 2;
  token: string;
  revision: number;
  guildId: string;
  userId: string;
  roleId: string;
  membershipGeneration: string;
  phase: 'prepared' | 'dispatched';
  preparedAt: number;
  removalDispatchedAt: number | null;
  updatedAt: number;
  removalAttempts: number;
  /** Desired role observed while a dispatched DELETE was still ambiguous. */
  regrant: WelcomeAutoRoleRegrantProof | null;
}

export interface PrepareWelcomeAutoRoleRemovalInput {
  guildId: string;
  userId: string;
  roleId: string;
  membershipGeneration: string;
}

export type WelcomeAutoRoleRemovalDatabase = Pick<Prisma.TransactionClient, 'operationClaim'>;

export class WelcomeAutoRoleRemovalFencedError extends Error {
  constructor(intent: Pick<WelcomeAutoRoleRemovalIntent, 'guildId' | 'userId' | 'token'>) {
    super(`Welcome auto-role removal was fenced for ${intent.guildId}:${intent.userId}:${intent.token}`);
    this.name = 'WelcomeAutoRoleRemovalFencedError';
  }
}

export function welcomeAutoRoleRemovalIntentKey(guildId: string, userId: string): string {
  return `welcome-auto-role-removal:${guildId}:${userId}`;
}

function asMetadata(intent: WelcomeAutoRoleRemovalIntent): Prisma.InputJsonObject {
  return intent as unknown as Prisma.InputJsonObject;
}

function isExactRemovalIntent(
  left: WelcomeAutoRoleRemovalIntent,
  right: WelcomeAutoRoleRemovalIntent,
): boolean {
  return left.version === right.version && left.token === right.token &&
    left.revision === right.revision && left.guildId === right.guildId &&
    left.userId === right.userId && left.roleId === right.roleId &&
    left.membershipGeneration === right.membershipGeneration &&
    left.phase === right.phase && left.preparedAt === right.preparedAt &&
    left.removalDispatchedAt === right.removalDispatchedAt &&
    left.updatedAt === right.updatedAt && left.removalAttempts === right.removalAttempts &&
    left.regrant?.membershipGeneration === right.regrant?.membershipGeneration &&
    left.regrant?.observedAt === right.regrant?.observedAt;
}

export function parseWelcomeAutoRoleRemovalIntent(value: unknown): WelcomeAutoRoleRemovalIntent | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const intent = value as Partial<Omit<WelcomeAutoRoleRemovalIntent, 'version' | 'regrant'>> & {
    version?: number;
    regrant?: unknown;
    regrantRequired?: unknown;
  };
  if (
    (intent.version !== 1 && intent.version !== 2) ||
    typeof intent.token !== 'string' || !intent.token ||
    typeof intent.revision !== 'number' || !Number.isInteger(intent.revision) || intent.revision < 0 ||
    typeof intent.guildId !== 'string' || !intent.guildId ||
    typeof intent.userId !== 'string' || !intent.userId ||
    typeof intent.roleId !== 'string' || !intent.roleId ||
    typeof intent.membershipGeneration !== 'string' ||
      !intent.membershipGeneration || intent.membershipGeneration === 'unknown' ||
    (intent.phase !== 'prepared' && intent.phase !== 'dispatched') ||
    typeof intent.preparedAt !== 'number' || !Number.isFinite(intent.preparedAt) ||
    !(intent.removalDispatchedAt === null ||
      (typeof intent.removalDispatchedAt === 'number' && Number.isFinite(intent.removalDispatchedAt))) ||
    typeof intent.updatedAt !== 'number' || !Number.isFinite(intent.updatedAt) ||
    typeof intent.removalAttempts !== 'number' ||
      !Number.isInteger(intent.removalAttempts) || intent.removalAttempts < 0
  ) return null;
  let regrant: WelcomeAutoRoleRegrantProof | null;
  if (intent.version === 1) {
    if (typeof intent.regrantRequired !== 'boolean') return null;
    regrant = intent.regrantRequired
      ? { membershipGeneration: intent.membershipGeneration, observedAt: intent.updatedAt }
      : null;
  } else if (intent.regrant === null) {
    regrant = null;
  } else if (intent.regrant && typeof intent.regrant === 'object' &&
      !Array.isArray(intent.regrant)) {
    const candidate = intent.regrant as Partial<WelcomeAutoRoleRegrantProof>;
    if (typeof candidate.membershipGeneration !== 'string' ||
        candidate.membershipGeneration === 'unknown' ||
        candidate.membershipGeneration.length === 0 ||
        typeof candidate.observedAt !== 'number' ||
        !Number.isFinite(candidate.observedAt)) return null;
    regrant = candidate as WelcomeAutoRoleRegrantProof;
  } else {
    return null;
  }
  if (intent.updatedAt < intent.preparedAt) return null;
  if (intent.phase === 'prepared' &&
      (intent.revision !== 0 || intent.removalDispatchedAt !== null ||
       intent.removalAttempts !== 0 || regrant !== null)) {
    return null;
  }
  if (intent.phase === 'dispatched' &&
      (intent.removalDispatchedAt === null || intent.removalAttempts < 1 ||
       intent.updatedAt < intent.removalDispatchedAt)) return null;
  if (regrant && (intent.removalDispatchedAt === null ||
      regrant.observedAt < intent.removalDispatchedAt ||
      intent.updatedAt < regrant.observedAt)) return null;
  return {
    version: 2,
    token: intent.token,
    revision: intent.revision,
    guildId: intent.guildId,
    userId: intent.userId,
    roleId: intent.roleId,
    membershipGeneration: intent.membershipGeneration,
    phase: intent.phase,
    preparedAt: intent.preparedAt,
    removalDispatchedAt: intent.removalDispatchedAt,
    updatedAt: intent.updatedAt,
    removalAttempts: intent.removalAttempts,
    regrant,
  };
}

export async function readWelcomeAutoRoleRemovalIntent(
  guildId: string,
  userId: string,
  database: WelcomeAutoRoleRemovalDatabase = getDatabase(),
): Promise<WelcomeAutoRoleRemovalIntent | null> {
  const key = welcomeAutoRoleRemovalIntentKey(guildId, userId);
  const claim = await database.operationClaim.findUnique({ where: { key } });
  if (!claim) return null;
  if (claim.scope !== WELCOME_AUTO_ROLE_REMOVAL_SCOPE) {
    throw new Error(`Unexpected OperationClaim scope at ${key}`);
  }
  const intent = parseWelcomeAutoRoleRemovalIntent(claim.metadata);
  if (!intent || welcomeAutoRoleRemovalIntentKey(intent.guildId, intent.userId) !== key) {
    throw new Error(`Malformed welcome auto-role removal retained at ${key}`);
  }
  return intent;
}

export async function prepareWelcomeAutoRoleRemovalIntent(
  input: PrepareWelcomeAutoRoleRemovalInput,
  database: WelcomeAutoRoleRemovalDatabase = getDatabase(),
  now = Date.now(),
  token = randomUUID(),
): Promise<{ intent: WelcomeAutoRoleRemovalIntent; created: boolean }> {
  if (!input.membershipGeneration || input.membershipGeneration === 'unknown') {
    throw new Error('Welcome auto-role removal requires an authoritative membership generation');
  }
  const intent: WelcomeAutoRoleRemovalIntent = {
    version: 2,
    token,
    revision: 0,
    ...input,
    phase: 'prepared',
    preparedAt: now,
    removalDispatchedAt: null,
    updatedAt: now,
    removalAttempts: 0,
    regrant: null,
  };
  const key = welcomeAutoRoleRemovalIntentKey(input.guildId, input.userId);
  try {
    const inserted = await database.operationClaim.createMany({
      data: [{
        key,
        scope: WELCOME_AUTO_ROLE_REMOVAL_SCOPE,
        guildId: input.guildId,
        userId: input.userId,
        metadata: asMetadata(intent),
      }],
      skipDuplicates: true,
    });
    if (inserted.count === 1) return { intent, created: true };
  } catch (error) {
    const persisted = await readWelcomeAutoRoleRemovalIntent(
      input.guildId,
      input.userId,
      database,
    ).catch(() => null);
    if (persisted?.token === token && isExactRemovalIntent(persisted, intent)) {
      return { intent: persisted, created: true };
    }
    if (!persisted) throw error;
    return { intent: persisted, created: false };
  }
  const persisted = await readWelcomeAutoRoleRemovalIntent(input.guildId, input.userId, database);
  if (!persisted) throw new Error(`Welcome auto-role removal disappeared at ${key}`);
  return { intent: persisted, created: persisted.token === token };
}

export async function assertWelcomeAutoRoleRemovalCurrent(
  intent: WelcomeAutoRoleRemovalIntent,
  database: WelcomeAutoRoleRemovalDatabase = getDatabase(),
): Promise<void> {
  const current = await readWelcomeAutoRoleRemovalIntent(intent.guildId, intent.userId, database);
  if (current?.token !== intent.token || current.revision !== intent.revision) {
    throw new WelcomeAutoRoleRemovalFencedError(intent);
  }
}

export async function recordWelcomeAutoRoleRemovalDispatch(
  intent: WelcomeAutoRoleRemovalIntent,
  database: WelcomeAutoRoleRemovalDatabase = getDatabase(),
  now = Date.now(),
): Promise<WelcomeAutoRoleRemovalIntent> {
  const transitionAt = Math.max(now, intent.updatedAt);
  const updated: WelcomeAutoRoleRemovalIntent = {
    ...intent,
    revision: intent.revision + 1,
    phase: 'dispatched',
    removalDispatchedAt: transitionAt,
    updatedAt: transitionAt,
    removalAttempts: intent.removalAttempts + 1,
    regrant: null,
  };
  const key = welcomeAutoRoleRemovalIntentKey(intent.guildId, intent.userId);
  try {
    const result = await database.operationClaim.updateMany({
      where: {
        key,
        scope: WELCOME_AUTO_ROLE_REMOVAL_SCOPE,
        AND: [
          { metadata: { path: ['token'], equals: intent.token } },
          { metadata: { path: ['revision'], equals: intent.revision } },
        ],
      },
      data: { metadata: asMetadata(updated) },
    });
    if (result.count === 1) return updated;
  } catch (error) {
    const persisted = await readWelcomeAutoRoleRemovalIntent(
      intent.guildId,
      intent.userId,
      database,
    ).catch(() => null);
    if (persisted && isExactRemovalIntent(persisted, updated)) return persisted;
    if (persisted?.token === intent.token && persisted.revision === intent.revision) throw error;
    throw new WelcomeAutoRoleRemovalFencedError(intent);
  }
  const current = await readWelcomeAutoRoleRemovalIntent(intent.guildId, intent.userId, database);
  if (current?.token === intent.token && current.revision === intent.revision) {
    throw new Error(`Welcome auto-role removal dispatch failed at ${key}`);
  }
  throw new WelcomeAutoRoleRemovalFencedError(intent);
}

export async function recordWelcomeAutoRoleRegrantObserved(
  intent: WelcomeAutoRoleRemovalIntent,
  membershipGeneration: string,
  database: WelcomeAutoRoleRemovalDatabase = getDatabase(),
  now = Date.now(),
): Promise<WelcomeAutoRoleRemovalIntent> {
  if (intent.phase !== 'dispatched') {
    throw new Error('A regrant can only be observed after an auto-role DELETE was dispatched');
  }
  if (!membershipGeneration || membershipGeneration === 'unknown') {
    throw new Error('A regrant observation requires an authoritative membership generation');
  }
  if (intent.regrant?.membershipGeneration === membershipGeneration) return intent;
  const transitionAt = Math.max(now, intent.updatedAt);
  const updated: WelcomeAutoRoleRemovalIntent = {
    ...intent,
    revision: intent.revision + 1,
    updatedAt: transitionAt,
    regrant: { membershipGeneration, observedAt: transitionAt },
  };
  const key = welcomeAutoRoleRemovalIntentKey(intent.guildId, intent.userId);
  try {
    const result = await database.operationClaim.updateMany({
      where: {
        key,
        scope: WELCOME_AUTO_ROLE_REMOVAL_SCOPE,
        AND: [
          { metadata: { path: ['token'], equals: intent.token } },
          { metadata: { path: ['revision'], equals: intent.revision } },
        ],
      },
      data: { metadata: asMetadata(updated) },
    });
    if (result.count === 1) return updated;
  } catch (error) {
    const persisted = await readWelcomeAutoRoleRemovalIntent(
      intent.guildId,
      intent.userId,
      database,
    ).catch(() => null);
    if (persisted && isExactRemovalIntent(persisted, updated)) return persisted;
    if (persisted?.token === intent.token && persisted.revision === intent.revision) throw error;
    throw new WelcomeAutoRoleRemovalFencedError(intent);
  }
  const current = await readWelcomeAutoRoleRemovalIntent(intent.guildId, intent.userId, database);
  if (current?.token === intent.token && current.revision === intent.revision) {
    throw new Error(`Welcome auto-role regrant observation failed at ${key}`);
  }
  throw new WelcomeAutoRoleRemovalFencedError(intent);
}

export async function completeWelcomeAutoRoleRemovalIntent(
  intent: WelcomeAutoRoleRemovalIntent,
  database: WelcomeAutoRoleRemovalDatabase = getDatabase(),
): Promise<boolean> {
  const key = welcomeAutoRoleRemovalIntentKey(intent.guildId, intent.userId);
  try {
    const removed = await database.operationClaim.deleteMany({
      where: {
        key,
        scope: WELCOME_AUTO_ROLE_REMOVAL_SCOPE,
        AND: [
          { metadata: { path: ['token'], equals: intent.token } },
          { metadata: { path: ['revision'], equals: intent.revision } },
        ],
      },
    });
    if (removed.count === 1) return true;
  } catch (error) {
    const current = await readWelcomeAutoRoleRemovalIntent(
      intent.guildId,
      intent.userId,
      database,
    ).catch(() => undefined);
    if (current === null) return true;
    if (current && (current.token !== intent.token || current.revision !== intent.revision)) {
      throw new WelcomeAutoRoleRemovalFencedError(intent);
    }
    throw error;
  }
  const current = await readWelcomeAutoRoleRemovalIntent(intent.guildId, intent.userId, database);
  if (!current) return true;
  if (current.token !== intent.token || current.revision !== intent.revision) {
    throw new WelcomeAutoRoleRemovalFencedError(intent);
  }
  throw new Error(`Welcome auto-role removal completion failed at ${key}`);
}

export function isWelcomeAutoRoleRemovalPastGrace(
  intent: WelcomeAutoRoleRemovalIntent,
  now = Date.now(),
  graceMs = WELCOME_ROLE_LATE_APPLY_GRACE_MS,
): boolean {
  return intent.phase === 'dispatched' && intent.removalDispatchedAt !== null &&
    now >= intent.removalDispatchedAt + graceMs;
}

export async function listWelcomeAutoRoleRemovalClaims(
  guildIds: readonly string[],
  database: WelcomeAutoRoleRemovalDatabase = getDatabase(),
): Promise<Array<{ key: string; intent: WelcomeAutoRoleRemovalIntent | null }>> {
  if (guildIds.length === 0) return [];
  const claims = await database.operationClaim.findMany({
    where: {
      scope: WELCOME_AUTO_ROLE_REMOVAL_SCOPE,
      guildId: { in: [...new Set(guildIds)] },
    },
    orderBy: { createdAt: 'asc' },
  });
  return claims.map((claim) => ({
    key: claim.key,
    intent: parseWelcomeAutoRoleRemovalIntent(claim.metadata),
  }));
}
