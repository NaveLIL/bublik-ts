import type { EconomyConfig, Prisma } from '@prisma/client';
import { getDatabase } from '../../core/Database';
import { invalidateConfigCache } from './database';

const PB_TIER_RECONCILIATION_VERSION = 1 as const;
const PB_TIER_RECONCILIATION_SCOPE = 'economy_pb_tier_reconciliation';

export interface PbTierReconciliationMetadata {
  version: typeof PB_TIER_RECONCILIATION_VERSION;
  retiredRoleIds: string[];
}

export interface PbTierReconciliationSnapshot {
  config: Pick<EconomyConfig, 'enabled' | 'pbRoleIds'> | null;
  retiredRoleIds: string[];
}

function reconciliationKey(guildId: string): string {
  return `economy:pb-tier-reconciliation:${guildId}`;
}

function normalizeRoleIds(roleIds: readonly string[]): string[] {
  return [...new Set(roleIds.filter((roleId) => typeof roleId === 'string' && roleId.length > 0))];
}

function sortedRoleIds(roleIds: readonly string[]): string[] {
  return normalizeRoleIds(roleIds).sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
}

async function lockPbTierConfiguration(
  tx: Prisma.TransactionClient,
  guildId: string,
): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`economy-pb-tier-config:${guildId}`}))`;
}

export function parsePbTierReconciliationMetadata(
  value: unknown,
): PbTierReconciliationMetadata | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as { version?: unknown; retiredRoleIds?: unknown };
  if (candidate.version !== PB_TIER_RECONCILIATION_VERSION) return null;
  if (!Array.isArray(candidate.retiredRoleIds)) return null;
  if (!candidate.retiredRoleIds.every((roleId) => typeof roleId === 'string' && roleId.length > 0)) {
    return null;
  }
  return {
    version: PB_TIER_RECONCILIATION_VERSION,
    retiredRoleIds: sortedRoleIds(candidate.retiredRoleIds),
  };
}

export function mergeRetiredPbRoleIds(
  previouslyConfiguredRoleIds: readonly string[],
  pendingRetiredRoleIds: readonly string[],
  nextConfiguredRoleIds: readonly string[],
): string[] {
  const configured = new Set(normalizeRoleIds(nextConfiguredRoleIds));
  return sortedRoleIds([...previouslyConfiguredRoleIds, ...pendingRetiredRoleIds])
    .filter((roleId) => !configured.has(roleId));
}

function metadataJson(retiredRoleIds: readonly string[]): Prisma.InputJsonObject {
  return {
    version: PB_TIER_RECONCILIATION_VERSION,
    retiredRoleIds: sortedRoleIds(retiredRoleIds),
  };
}

function parseClaim(
  guildId: string,
  claim: { scope: string; metadata: Prisma.JsonValue | null } | null,
): string[] {
  if (!claim) return [];
  if (claim.scope !== PB_TIER_RECONCILIATION_SCOPE) {
    throw new Error(`Unexpected PB tier reconciliation scope for ${guildId}`);
  }
  const parsed = parsePbTierReconciliationMetadata(claim.metadata);
  if (!parsed) throw new Error(`Invalid PB tier reconciliation metadata for ${guildId}`);
  return parsed.retiredRoleIds;
}

/** Atomically replace PB roles and persist every displaced role for retry. */
export async function replacePbTierRolesWithReconciliationIntent(
  guildId: string,
  nextPbRoleIds: readonly string[],
): Promise<{ config: EconomyConfig; retiredRoleIds: string[] }> {
  const db = getDatabase();
  const result = await db.$transaction(async (tx) => {
    await lockPbTierConfiguration(tx, guildId);
    const [currentConfig, currentClaim] = await Promise.all([
      tx.economyConfig.findUnique({ where: { guildId } }),
      tx.operationClaim.findUnique({
        where: { key: reconciliationKey(guildId) },
        select: { scope: true, metadata: true },
      }),
    ]);
    const retiredRoleIds = mergeRetiredPbRoleIds(
      currentConfig?.pbRoleIds ?? [],
      parseClaim(guildId, currentClaim),
      nextPbRoleIds,
    );
    const config = await tx.economyConfig.upsert({
      where: { guildId },
      create: { guildId, pbRoleIds: [...nextPbRoleIds] },
      update: { pbRoleIds: [...nextPbRoleIds] },
    });

    if (retiredRoleIds.length > 0) {
      await tx.operationClaim.upsert({
        where: { key: reconciliationKey(guildId) },
        create: {
          key: reconciliationKey(guildId),
          scope: PB_TIER_RECONCILIATION_SCOPE,
          guildId,
          metadata: metadataJson(retiredRoleIds),
          expiresAt: null,
        },
        update: {
          scope: PB_TIER_RECONCILIATION_SCOPE,
          guildId,
          userId: null,
          metadata: metadataJson(retiredRoleIds),
          expiresAt: null,
        },
      });
    } else {
      await tx.operationClaim.deleteMany({
        where: { key: reconciliationKey(guildId), scope: PB_TIER_RECONCILIATION_SCOPE },
      });
    }
    return { config, retiredRoleIds };
  });
  await invalidateConfigCache(guildId);
  return result;
}

/** Read config and retry intent under the same configuration fence. */
export async function loadPbTierReconciliationSnapshot(
  guildId: string,
): Promise<PbTierReconciliationSnapshot> {
  const db = getDatabase();
  return db.$transaction(async (tx) => {
    await lockPbTierConfiguration(tx, guildId);
    const [config, claim] = await Promise.all([
      tx.economyConfig.findUnique({
        where: { guildId },
        select: { enabled: true, pbRoleIds: true },
      }),
      tx.operationClaim.findUnique({
        where: { key: reconciliationKey(guildId) },
        select: { scope: true, metadata: true },
      }),
    ]);
    return { config, retiredRoleIds: parseClaim(guildId, claim) };
  });
}

/**
 * Delete only the exact intent that was fully verified. A concurrent config
 * replacement changes the claim under the same advisory fence and wins.
 */
export async function completePbTierReconciliationIntent(
  guildId: string,
  expectedRetiredRoleIds: readonly string[],
): Promise<boolean> {
  const expected = sortedRoleIds(expectedRetiredRoleIds);
  if (expected.length === 0) return false;
  const db = getDatabase();
  return db.$transaction(async (tx) => {
    await lockPbTierConfiguration(tx, guildId);
    const [config, claim] = await Promise.all([
      tx.economyConfig.findUnique({ where: { guildId }, select: { pbRoleIds: true } }),
      tx.operationClaim.findUnique({
        where: { key: reconciliationKey(guildId) },
        select: { scope: true, metadata: true },
      }),
    ]);
    const current = parseClaim(guildId, claim);
    if (current.length !== expected.length || current.some((roleId, index) => roleId !== expected[index])) {
      return false;
    }
    const configured = new Set(normalizeRoleIds(config?.pbRoleIds ?? []));
    if (expected.some((roleId) => configured.has(roleId))) return false;
    const deleted = await tx.operationClaim.deleteMany({
      where: { key: reconciliationKey(guildId), scope: PB_TIER_RECONCILIATION_SCOPE },
    });
    return deleted.count === 1;
  });
}
