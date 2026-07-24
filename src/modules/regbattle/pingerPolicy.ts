export interface PingerSquadOccupancy {
  count: number;
  size: number;
}

export interface PingerOccupancySummary {
  occupiedSlots: number;
  allFull: boolean;
}

export interface PingerObservedSquad extends PingerSquadOccupancy {
  squadId: string;
  notifyOff: boolean;
}

/**
 * Stable runtime observation used to self-heal a missed voice/UI wake-up.
 * The pinger already reads this data every cycle, so comparing it does not add
 * Discord or database traffic. Sorting makes the signature independent of DB
 * row order.
 */
export function buildPingerObservationSignature(
  squads: readonly PingerObservedSquad[],
): string {
  return JSON.stringify(
    [...squads]
      .sort((left, right) => left.squadId.localeCompare(right.squadId))
      .map((squad) => [squad.squadId, squad.count, squad.size, squad.notifyOff]),
  );
}

/**
 * Count only occupied capacity. Overflow in one squad must never compensate
 * for an empty slot in another squad or look like recruiting progress.
 */
export function summarizePingerOccupancy(
  squads: readonly PingerSquadOccupancy[],
): PingerOccupancySummary {
  return {
    occupiedSlots: squads.reduce((sum, squad) => sum + Math.min(squad.count, squad.size), 0),
    allFull: squads.length > 0 && squads.every((squad) => squad.count >= squad.size),
  };
}

export function selectNotifyEnabledSquads<T extends { squadId: string }>(
  squads: readonly T[],
  notifyOffSquadIds: ReadonlySet<string>,
): T[] {
  return squads.filter((squad) => !notifyOffSquadIds.has(squad.squadId));
}

export function isPingerActionDue(now: number, lastActionAt: number, intervalMs: number): boolean {
  return now - lastActionAt >= intervalMs;
}

export type PingerLocalCooldownOutcome =
  | 'sent-or-ambiguous'
  | 'retained-without-send'
  | 'released'
  | 'ownership-lost';

/**
 * A released or superseded distributed claim did not perform this action and
 * must not manufacture a process-local cooldown. Sent/ambiguous work and an
 * intentionally retained claim may throttle the same process as well.
 */
export function shouldAdvancePingerLocalCooldown(
  outcome: PingerLocalCooldownOutcome,
): boolean {
  return outcome === 'sent-or-ambiguous' || outcome === 'retained-without-send';
}

export function nextPingerRevision(current: number): number {
  return current + 1;
}

export function hasPendingPingerRevision(requested: number, processed: number): boolean {
  return requested > processed;
}

export function completePingerRevision(processed: number, observed: number): number {
  return Math.max(processed, observed);
}

export function wasPingerRecalculatedSince(observed: number, current: number): boolean {
  return current > observed;
}

export function selectAllowedCachedGuildsToSeed(
  allowedGuildIds: readonly string[],
  cachedGuildIds: ReadonlySet<string>,
  attemptedGuildIds: ReadonlySet<string>,
): string[] {
  return allowedGuildIds.filter(
    (guildId) => cachedGuildIds.has(guildId) && !attemptedGuildIds.has(guildId),
  );
}

export type IndividualQueueRefreshOutcome = 'ready' | 'empty' | 'retry';

/** Only an authoritative empty queue ends a round and starts its cooldown. */
export function shouldEndEscalationAfterQueueRefresh(
  outcome: IndividualQueueRefreshOutcome,
): boolean {
  return outcome === 'empty';
}

export type IndividualCandidateDisposition = 'sent' | 'authoritative-skip' | 'retry';

export function nextIndividualCandidateIndex(
  current: number,
  disposition: IndividualCandidateDisposition,
): number {
  return disposition === 'retry' ? current : current + 1;
}

/** Bounded per-guild isolation: one slow Discord guild cannot starve all peers. */
export async function runPingerTasksWithConcurrency<T>(
  items: readonly T[],
  concurrency: number,
  task: (item: T) => Promise<void>,
  onError: (item: T, error: unknown) => void,
): Promise<void> {
  const workerCount = Math.min(items.length, Math.max(1, Math.floor(concurrency)));
  let nextIndex = 0;
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (nextIndex < items.length) {
      const item = items[nextIndex++];
      try {
        await task(item);
      } catch (error) {
        onError(item, error);
      }
    }
  }));
}
