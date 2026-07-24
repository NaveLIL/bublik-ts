import { randomInt as cryptoRandomInt } from 'node:crypto';

const RANDOM_SCALE = 1_000_000_000;

/** Cryptographically strong value in the half-open interval [0, 1). */
export function secureRandomFloat(): number {
  return cryptoRandomInt(0, RANDOM_SCALE) / RANDOM_SCALE;
}

/** Cryptographically strong integer in the inclusive interval [min, max]. */
export function secureRandomInt(min: number, max: number): number {
  const lower = Math.ceil(min);
  const upper = Math.floor(max);
  if (!Number.isSafeInteger(lower) || !Number.isSafeInteger(upper) || upper < lower) {
    throw new Error('invalid_random_range');
  }
  return cryptoRandomInt(lower, upper + 1);
}

export function secureChancePercent(percent: number): boolean {
  const chance = Math.max(0, Math.min(100, percent));
  return secureRandomFloat() * 100 < chance;
}
