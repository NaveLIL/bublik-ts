import type { Prisma } from '@prisma/client';
import { getDatabase } from '../../core/Database';

const MEMBERSHIP_SCOPE = 'welcome_membership_truth';

export interface WelcomeMembershipMarker {
  state: 'present' | 'left';
  generation: string;
}

function markerKey(guildId: string, userId: string): string {
  return `welcome-membership:${guildId}:${userId}`;
}

function readMarker(metadata: Prisma.JsonValue | null): WelcomeMembershipMarker | null {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null;
  const state = metadata.state;
  const generation = metadata.generation;
  if ((state !== 'present' && state !== 'left') || typeof generation !== 'string') return null;
  return { state, generation };
}

export function shouldRecordWelcomeMemberLeft(
  marker: WelcomeMembershipMarker | null,
  removeGeneration: string,
): boolean {
  if (!marker) return true;
  if (marker.state === 'left') return false;
  if (removeGeneration === 'unknown') return false;
  return marker.generation === removeGeneration;
}

async function lockMembershipTruth(
  transaction: Pick<Prisma.TransactionClient, '$executeRaw'>,
  guildId: string,
  userId: string,
): Promise<void> {
  await transaction.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`welcome-membership:${guildId}:${userId}`}))`;
}

/** Present marker and LeftMember deletion commit atomically under a DB fence. */
export async function recordWelcomeMemberPresent(
  guildId: string,
  userId: string,
  generation: string,
): Promise<void> {
  const db = getDatabase();
  await db.$transaction(async (tx) => {
    await lockMembershipTruth(tx, guildId, userId);
    await tx.operationClaim.upsert({
      where: { key: markerKey(guildId, userId) },
      create: {
        key: markerKey(guildId, userId),
        scope: MEMBERSHIP_SCOPE,
        guildId,
        userId,
        metadata: { state: 'present', generation, updatedAt: new Date().toISOString() },
      },
      update: {
        scope: MEMBERSHIP_SCOPE,
        guildId,
        userId,
        metadata: { state: 'present', generation, updatedAt: new Date().toISOString() },
      },
    });
    await tx.leftMember.deleteMany({ where: { guildId, userId } });
  });
}

/**
 * A remove may commit only if no newer present generation won the same DB
 * fence. This closes the REST-decision -> stale-upsert window without holding a
 * PostgreSQL transaction open over Discord REST.
 */
export async function recordWelcomeMemberLeft(
  guildId: string,
  userId: string,
  generation: string,
  leftAt = new Date(),
): Promise<boolean> {
  const db = getDatabase();
  return db.$transaction(async (tx) => {
    await lockMembershipTruth(tx, guildId, userId);
    const existing = await tx.operationClaim.findUnique({
      where: { key: markerKey(guildId, userId) },
      select: { metadata: true },
    });
    const marker = readMarker(existing?.metadata ?? null);
    // A prior attempt may have committed durable leave truth and crashed before
    // Redis/UI cleanup. Resume that cleanup without moving leftAt forward.
    if (marker?.state === 'left') return true;
    if (!shouldRecordWelcomeMemberLeft(marker, generation)) {
      return false;
    }

    await tx.operationClaim.upsert({
      where: { key: markerKey(guildId, userId) },
      create: {
        key: markerKey(guildId, userId),
        scope: MEMBERSHIP_SCOPE,
        guildId,
        userId,
        metadata: { state: 'left', generation, updatedAt: leftAt.toISOString() },
      },
      update: {
        scope: MEMBERSHIP_SCOPE,
        guildId,
        userId,
        metadata: { state: 'left', generation, updatedAt: leftAt.toISOString() },
      },
    });
    await tx.leftMember.upsert({
      where: { guildId_userId: { guildId, userId } },
      create: { guildId, userId, leftAt },
      update: { leftAt },
    });
    return true;
  });
}
