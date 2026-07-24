import { getDatabase } from '../../core/Database';
import { invalidateProfileCache } from './database';
import { lockEconomyUserMutation } from './user-mutation-lock';
import { rebuildPbVoiceSecondsFromRecords } from './voice-reward-metadata';

const POSTGRES_INT_MAX = 2_147_483_647;

export interface PbVoiceHoursAdminChange {
  restoreFromTransactions: boolean;
  setHours: number | null;
  addHours: number | null;
}

export function calculateAdminPbVoiceSeconds(
  currentSeconds: number,
  restoredSeconds: number | null,
  setHours: number | null,
  addHours: number | null,
): number {
  let nextSeconds = Number.isSafeInteger(currentSeconds) && currentSeconds > 0 ? currentSeconds : 0;
  if (restoredSeconds !== null) nextSeconds = restoredSeconds;
  if (setHours !== null) nextSeconds = setHours * 3_600;
  if (addHours !== null) nextSeconds += addHours * 3_600;
  nextSeconds = Math.max(0, nextSeconds);
  if (!Number.isSafeInteger(nextSeconds) || nextSeconds > POSTGRES_INT_MAX) {
    throw new Error('invalid_pb_voice_seconds');
  }
  return nextSeconds;
}

export async function resetEconomyProfileAtomically(
  guildId: string,
  userId: string,
): Promise<void> {
  const db = getDatabase();
  await db.$transaction(async (tx) => {
    await lockEconomyUserMutation(tx, guildId, userId);
    const profile = await tx.economyProfile.findUnique({
      where: { guildId_userId: { guildId, userId } },
      select: { id: true },
    });
    if (!profile) return;
    await tx.$queryRaw`SELECT "id" FROM "economy_profiles" WHERE "id" = ${profile.id} FOR UPDATE`;
    // EconomyTransaction has ON DELETE CASCADE, so this single deletion is the
    // atomic reset boundary and cannot leave a profile without its audit log.
    await tx.economyProfile.delete({ where: { id: profile.id } });
  });
  await invalidateProfileCache(guildId, userId);
}

export async function updatePbVoiceHoursAtomically(
  guildId: string,
  userId: string,
  change: PbVoiceHoursAdminChange,
): Promise<number> {
  const db = getDatabase();
  const nextSeconds = await db.$transaction(async (tx) => {
    await lockEconomyUserMutation(tx, guildId, userId);
    const profile = await tx.economyProfile.upsert({
      where: { guildId_userId: { guildId, userId } },
      create: { guildId, userId },
      update: {},
    });
    await tx.$queryRaw`SELECT "id" FROM "economy_profiles" WHERE "id" = ${profile.id} FOR UPDATE`;
    const fresh = await tx.economyProfile.findUniqueOrThrow({
      where: { id: profile.id },
      select: { pbVoiceSeconds: true },
    });
    let restoredSeconds: number | null = null;
    if (change.restoreFromTransactions) {
      const records = await tx.economyTransaction.findMany({
        where: { guildId, userId, type: 'earn_voice' },
        select: { targetId: true, details: true },
      });
      restoredSeconds = rebuildPbVoiceSecondsFromRecords(records);
    }
    const calculated = calculateAdminPbVoiceSeconds(
      fresh.pbVoiceSeconds,
      restoredSeconds,
      change.setHours,
      change.addHours,
    );
    const updated = await tx.economyProfile.update({
      where: { id: profile.id },
      data: { pbVoiceSeconds: calculated },
      select: { pbVoiceSeconds: true },
    });
    return updated.pbVoiceSeconds;
  });
  await invalidateProfileCache(guildId, userId);
  return nextSeconds;
}
