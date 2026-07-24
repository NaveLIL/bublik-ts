import type { VoiceSession } from './utils';

/** Discord REST code returned when a channel is confirmed to no longer exist. */
export const UNKNOWN_CHANNEL_CODE = 10_003;

export interface PendingVoiceSettlement {
  version: 1;
  guildId: string;
  userId: string;
  sessionId: string;
  generatorId: string;
  channelId: string;
  joinedAt: number;
  endedAt: number;
  minutes: number;
  createdAt: number;
}

function readDiscordErrorCode(error: unknown): unknown {
  if (!error || typeof error !== 'object') return undefined;
  const value = error as {
    code?: unknown;
    rawError?: { code?: unknown };
    cause?: unknown;
  };
  return value.code ?? value.rawError?.code ?? readDiscordErrorCode(value.cause);
}

/** Do not interpret timeouts, cache misses or arbitrary REST failures as deletion. */
export function isUnknownChannelError(error: unknown): boolean {
  const code = readDiscordErrorCode(error);
  return typeof code === 'number'
    ? code === UNKNOWN_CHANNEL_CODE
    : code === String(UNKNOWN_CHANNEL_CODE);
}

/**
 * A settlement remains durable until a configured, newly-earned reward has
 * either been verified in Discord or was already recorded as granted.
 */
export function isTempVoiceRewardGrantPending(
  rewardRoleId: string | null | undefined,
  rewardThresholdMin: number,
  totalVoiceMinutes: number,
  rewardGranted: boolean,
): boolean {
  return Boolean(rewardRoleId) &&
    !rewardGranted &&
    Number.isFinite(rewardThresholdMin) &&
    Number.isFinite(totalVoiceMinutes) &&
    totalVoiceMinutes >= rewardThresholdMin;
}

export function buildPendingVoiceSettlement(
  guildId: string,
  userId: string,
  session: VoiceSession,
  endedAt: number,
): PendingVoiceSettlement | null {
  const safeEnd = Math.max(session.joinedAt, endedAt);
  const minutes = Math.floor((safeEnd - session.joinedAt) / 60_000);
  if (minutes <= 0) return null;

  return {
    version: 1,
    guildId,
    userId,
    sessionId: session.sessionId,
    generatorId: session.generatorId,
    channelId: session.channelId,
    joinedAt: session.joinedAt,
    endedAt: safeEnd,
    minutes,
    createdAt: Date.now(),
  };
}

export function isPendingVoiceSettlement(value: unknown): value is PendingVoiceSettlement {
  if (!value || typeof value !== 'object') return false;
  const pending = value as Partial<PendingVoiceSettlement>;
  return (
    pending.version === 1 &&
    typeof pending.guildId === 'string' && pending.guildId.length > 0 &&
    typeof pending.userId === 'string' && pending.userId.length > 0 &&
    typeof pending.sessionId === 'string' && pending.sessionId.length > 0 &&
    typeof pending.generatorId === 'string' && pending.generatorId.length > 0 &&
    typeof pending.channelId === 'string' && pending.channelId.length > 0 &&
    typeof pending.joinedAt === 'number' && Number.isFinite(pending.joinedAt) &&
    typeof pending.endedAt === 'number' && Number.isFinite(pending.endedAt) &&
    typeof pending.minutes === 'number' && Number.isInteger(pending.minutes) && pending.minutes > 0 &&
    typeof pending.createdAt === 'number' && Number.isFinite(pending.createdAt)
  );
}

export function pendingVoiceSettlementKey(sessionId: string): string {
  return `tempvoice:pending-settlement:${encodeURIComponent(sessionId)}`;
}
