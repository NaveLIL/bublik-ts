const VOICE_REWARD_TARGET_PREFIX = 'voice-reward:v1:';
const POSTGRES_INT_MAX = 2_147_483_647;
const MAX_REWARD_SECONDS = Math.floor(POSTGRES_INT_MAX / 1_000);
export const LEGACY_VOICE_REWARD_SECONDS = 10 * 60;

export interface VoiceRewardTransactionMetadata {
  seconds: number;
  isPb: boolean;
}

/**
 * EconomyTransaction has no JSON metadata column. Keep the exact rewarded
 * duration in its otherwise-unused targetId so PB hours remain rebuildable
 * when the configured ticker interval is not ten minutes.
 */
export function encodeVoiceRewardTransactionTarget(
  seconds: number,
  isPb: boolean,
): string {
  if (!Number.isSafeInteger(seconds) || seconds <= 0 || seconds > MAX_REWARD_SECONDS) {
    throw new Error('invalid_voice_reward_seconds');
  }
  return `${VOICE_REWARD_TARGET_PREFIX}${isPb ? 'pb' : 'base'}:${seconds}`;
}

export function parseVoiceRewardTransactionTarget(
  value: unknown,
): VoiceRewardTransactionMetadata | null {
  if (typeof value !== 'string' || !value.startsWith(VOICE_REWARD_TARGET_PREFIX)) return null;
  const match = /^voice-reward:v1:(pb|base):(\d+)$/.exec(value);
  if (!match) return null;
  const seconds = Number(match[2]);
  if (!Number.isSafeInteger(seconds) || seconds <= 0 || seconds > MAX_REWARD_SECONDS) return null;
  return { seconds, isPb: match[1] === 'pb' };
}

export function isStructuredVoiceRewardTarget(value: unknown): boolean {
  return typeof value === 'string' && value.startsWith(VOICE_REWARD_TARGET_PREFIX);
}

function isLegacyPbVoiceDetail(details: unknown): boolean {
  return typeof details === 'string' && /(?:\bPB\b|ПБ)/iu.test(details);
}

/** Pure rebuild reducer shared by the command and safety tests. */
export function rebuildPbVoiceSecondsFromRecords(
  records: readonly { targetId?: string | null; details?: string | null }[],
): number {
  let total = 0;
  for (const record of records) {
    const parsed = parseVoiceRewardTransactionTarget(record.targetId);
    if (parsed) {
      if (parsed.isPb) total = Math.min(POSTGRES_INT_MAX, total + parsed.seconds);
      continue;
    }

    // A malformed v1 marker must fail closed instead of being reinterpreted as
    // a legacy ten-minute row from its human-readable description.
    if (isStructuredVoiceRewardTarget(record.targetId)) continue;
    if (isLegacyPbVoiceDetail(record.details)) {
      total = Math.min(POSTGRES_INT_MAX, total + LEGACY_VOICE_REWARD_SECONDS);
    }
  }
  return total;
}
