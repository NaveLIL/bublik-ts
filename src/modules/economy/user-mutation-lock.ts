import type { Prisma } from '@prisma/client';

/**
 * Serializes destructive/manual profile mutations with the voice payout for
 * the same guild member. The profile row is additionally locked by admin
 * mutations, but this advisory key also covers the create/delete boundary.
 */
export async function lockEconomyUserMutation(
  tx: Prisma.TransactionClient,
  guildId: string,
  userId: string,
): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`economy-user:${guildId}:${userId}`}))`;
}
