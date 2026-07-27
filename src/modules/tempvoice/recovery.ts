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

export interface MissingRewardRoleQuarantine {
  roleId: string;
  failures: number;
  retryAt: number;
}

/**
 * A deleted configured reward role is a permanent configuration error, not a
 * transient Discord failure. Quarantine that generator/role pair so one bad
 * configuration cannot retry once per pending member and flood the logs.
 *
 * The settlement itself remains durable. Changing the configured role id
 * bypasses the quarantine immediately, while an unchanged configuration is
 * retried with bounded exponential backoff.
 */
export class MissingRewardRoleRetryGate {
  private readonly quarantines = new Map<string, MissingRewardRoleQuarantine>();

  constructor(
    private readonly initialDelayMs = 60 * 60 * 1_000,
    private readonly maxDelayMs = 24 * 60 * 60 * 1_000,
  ) {
    if (!Number.isFinite(initialDelayMs) || initialDelayMs <= 0) {
      throw new Error('Missing reward role retry delay must be positive');
    }
    if (!Number.isFinite(maxDelayMs) || maxDelayMs < initialDelayMs) {
      throw new Error('Missing reward role maximum retry delay is invalid');
    }
  }

  canAttempt(key: string, roleId: string, now = Date.now()): boolean {
    const quarantine = this.quarantines.get(key);
    if (!quarantine) return true;
    if (quarantine.roleId !== roleId) {
      this.quarantines.delete(key);
      return true;
    }
    return now >= quarantine.retryAt;
  }

  quarantine(key: string, roleId: string, now = Date.now()): MissingRewardRoleQuarantine {
    const previous = this.quarantines.get(key);
    const failures = previous?.roleId === roleId ? previous.failures + 1 : 1;
    const exponent = Math.min(failures - 1, 30);
    const delayMs = Math.min(this.maxDelayMs, this.initialDelayMs * (2 ** exponent));
    const quarantine = {
      roleId,
      failures,
      retryAt: now + delayMs,
    };
    this.quarantines.set(key, quarantine);
    return quarantine;
  }

  release(key: string, roleId?: string): void {
    const quarantine = this.quarantines.get(key);
    if (!quarantine || (roleId && quarantine.roleId !== roleId)) return;
    this.quarantines.delete(key);
  }
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
