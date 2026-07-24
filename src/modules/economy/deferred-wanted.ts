import type { Prisma } from '@prisma/client';
import { getDatabase } from '../../core/Database';
import { logger } from '../../core/Logger';
import { scheduleTask, unscheduleTask } from '../../core/SchedulerManager';
import { isGuildAllowed } from '../../core/Whitelist';
import { invalidateProfileCache } from './database';

export const DEFERRED_WANTED_SCOPE = 'economy_deferred_wanted';
const TASK = 'economy:deferredWanted';
const INTERVAL_MS = 30_000;
const COMPLETED_RETENTION_MS = 30 * 24 * 60 * 60_000;

const log = logger.child('Economy:DeferredWanted');

interface DeferredWantedMetadata {
  state: 'pending' | 'completed' | 'cancelled';
  stars: number;
  decayMs: number;
  source: string;
}

function parseMetadata(value: unknown): DeferredWantedMetadata | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (!['pending', 'completed', 'cancelled'].includes(String(raw.state))) return null;
  const stars = Number(raw.stars);
  const decayMs = Number(raw.decayMs);
  if (!Number.isSafeInteger(stars) || stars <= 0 || stars > 100) return null;
  if (!Number.isSafeInteger(decayMs) || decayMs < 60_000) return null;
  return {
    state: raw.state as DeferredWantedMetadata['state'],
    stars,
    decayMs,
    source: typeof raw.source === 'string' ? raw.source : 'unknown',
  };
}

export function deferredWantedClaimKey(sourceKey: string): string {
  return `economy:wanted:${sourceKey}`;
}

export async function createDeferredWantedClaimInTransaction(
  tx: Prisma.TransactionClient,
  sourceKey: string,
  guildId: string,
  userId: string,
  stars: number,
  decayMs: number,
  dueAt: Date,
): Promise<boolean> {
  if (!Number.isSafeInteger(stars) || stars <= 0 || stars > 100) throw new Error('invalid_wanted_stars');
  if (!Number.isSafeInteger(decayMs) || decayMs < 60_000) throw new Error('invalid_wanted_decay');
  const claim = await tx.operationClaim.createMany({
    data: [{
      key: deferredWantedClaimKey(sourceKey),
      scope: DEFERRED_WANTED_SCOPE,
      guildId,
      userId,
      metadata: { state: 'pending', stars, decayMs, source: sourceKey },
      expiresAt: dueAt,
    }],
    skipDuplicates: true,
  });
  return claim.count === 1;
}

export async function scheduleDeferredWanted(
  sourceKey: string,
  guildId: string,
  userId: string,
  stars: number,
  decayMs: number,
  delayMs = 300_000,
): Promise<boolean> {
  return getDatabase().$transaction((tx) => createDeferredWantedClaimInTransaction(
    tx,
    sourceKey,
    guildId,
    userId,
    stars,
    decayMs,
    new Date(Date.now() + Math.max(0, delayMs)),
  ));
}

export async function processDueDeferredWanted(): Promise<number> {
  const db = getDatabase();
  const due = await db.operationClaim.findMany({
    where: {
      scope: DEFERRED_WANTED_SCOPE,
      expiresAt: { lte: new Date() },
    },
    orderBy: { expiresAt: 'asc' },
    take: 100,
  });

  let completed = 0;
  for (const candidate of due) {
    if (!candidate.guildId || !isGuildAllowed(candidate.guildId)) continue;
    try {
      const applied = await db.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT "key" FROM "operation_claims" WHERE "key" = ${candidate.key} FOR UPDATE`;
        const claim = await tx.operationClaim.findUnique({ where: { key: candidate.key } });
        const metadata = parseMetadata(claim?.metadata);
        if (
          !claim ||
          claim.scope !== DEFERRED_WANTED_SCOPE ||
          !claim.guildId ||
          !claim.userId ||
          !metadata ||
          metadata.state !== 'pending' ||
          !claim.expiresAt ||
          claim.expiresAt.getTime() > Date.now()
        ) return null;

        const profile = await tx.economyProfile.upsert({
          where: { guildId_userId: { guildId: claim.guildId, userId: claim.userId } },
          create: { guildId: claim.guildId, userId: claim.userId },
          update: {},
        });
        await tx.economyProfile.update({
          where: { id: profile.id },
          data: {
            wantedStars: { increment: metadata.stars },
            wantedNextDecay: profile.wantedNextDecay ?? new Date(Date.now() + metadata.decayMs),
          },
        });
        await tx.operationClaim.update({
          where: { key: claim.key },
          data: {
            metadata: { ...metadata, state: 'completed' },
            expiresAt: new Date(Date.now() + COMPLETED_RETENTION_MS),
          },
        });
        return { guildId: claim.guildId, userId: claim.userId };
      });
      if (applied) {
        completed++;
        await invalidateProfileCache(applied.guildId, applied.userId);
      }
    } catch (error) {
      log.error(`Deferred wanted claim ${candidate.key} failed; it will be retried`, error);
    }
  }
  return completed;
}

export function startDeferredWantedScheduler(): void {
  scheduleTask(TASK, INTERVAL_MS, async () => {
    const completed = await processDueDeferredWanted();
    if (completed > 0) log.info(`Applied ${completed} deferred wanted claim(s)`);
  }, { exclusive: true, immediate: true });
}

export function stopDeferredWantedScheduler(): void {
  unscheduleTask(TASK);
}
