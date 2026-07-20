/** Return the first free positive per-guild squad number. */
export function firstFreeSquadNumber(numbers: Iterable<number>): number {
  const used = new Set<number>();
  for (const number of numbers) {
    if (Number.isSafeInteger(number) && number > 0) used.add(number);
  }

  let candidate = 1;
  while (used.has(candidate)) {
    if (candidate === Number.MAX_SAFE_INTEGER) {
      throw new Error('No safe squad number is available');
    }
    candidate++;
  }
  return candidate;
}

export const LEGACY_SQUAD_CREATION_PLACEHOLDER = '⚔️ Создание отряда…';

/**
 * Repair only Bublik's exact legacy provisional name. Deliberately leave every
 * other name alone because commanders may rename their voice channel by hand.
 */
export function legacySquadPlaceholderRepair(
  currentName: string,
  canonicalName: string,
): string | null {
  return currentName === LEGACY_SQUAD_CREATION_PLACEHOLDER
    ? canonicalName
    : null;
}
