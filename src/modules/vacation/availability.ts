import type { Prisma } from '@prisma/client';
import { getDatabase } from '../../core/Database';

export const UNAVAILABLE_VACATION_STATUSES = [
  'activating',
  'active',
  'restoring',
] as const;

export const UNAVAILABLE_NS_STATUSES = [
  'activating',
  'active',
  'restoring',
] as const;

type AvailabilityDatabase = Pick<
  Prisma.TransactionClient,
  'vacationRequest' | 'nsVacation'
>;

/**
 * Batch-load the durable regular and NS vacation exclusion set. Errors are
 * intentionally allowed to propagate: callers must fail closed, never treat a
 * database outage as an empty vacation list.
 */
export async function loadUnavailableUserIds(
  guildId: string,
  userIds?: readonly string[],
  database: AvailabilityDatabase = getDatabase(),
): Promise<Set<string>> {
  if (!guildId) throw new Error('Vacation availability requires a guild id');
  const scopedIds = userIds ? [...new Set(userIds.filter(Boolean))] : null;
  if (scopedIds?.length === 0) return new Set();
  const userFilter = scopedIds === null ? {} : { userId: { in: scopedIds } };

  const [regularVacations, nsVacations] = await Promise.all([
    database.vacationRequest.findMany({
      where: {
        guildId,
        status: { in: [...UNAVAILABLE_VACATION_STATUSES] },
        ...userFilter,
      },
      select: { userId: true },
    }),
    database.nsVacation.findMany({
      where: {
        guildId,
        status: { in: [...UNAVAILABLE_NS_STATUSES] },
        ...userFilter,
      },
      select: { userId: true },
    }),
  ]);

  return new Set([
    ...regularVacations.map(({ userId }) => userId),
    ...nsVacations.map(({ userId }) => userId),
  ]);
}

export async function isUserUnavailable(guildId: string, userId: string): Promise<boolean> {
  return (await loadUnavailableUserIds(guildId, [userId])).has(userId);
}
