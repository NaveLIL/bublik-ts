import { randomUUID } from 'node:crypto';
import { ownsReminderClaim } from './policy';

export interface ReminderClaimRedis {
  set(
    key: string,
    value: string,
    expiryMode: 'EX',
    ttlSeconds: number,
    setMode: 'NX',
  ): Promise<string | null>;
  get(key: string): Promise<string | null>;
}

/**
 * Redis clients may retry SET NX after losing an `OK` response. The retry then
 * returns null even though our first command installed the token, so every
 * non-OK outcome is resolved by reading the exact UUID back.
 */
export async function acquireReminderClaimToken(
  redis: ReminderClaimRedis,
  key: string,
  ttlSeconds: number,
  token = randomUUID(),
): Promise<string | null> {
  try {
    const result = await redis.set(key, token, 'EX', ttlSeconds, 'NX');
    if (result === 'OK') return token;
  } catch (error) {
    const persisted = await redis.get(key);
    if (ownsReminderClaim(persisted, token)) return token;
    throw error;
  }

  const persisted = await redis.get(key);
  return ownsReminderClaim(persisted, token) ? token : null;
}
