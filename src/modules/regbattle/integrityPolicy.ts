/** Sequential isolation prevents one persistent guild/member failure starving later work. */
export async function runIsolatedIntegrityTasks<T>(
  items: Iterable<T>,
  task: (item: T) => Promise<void>,
  onError: (item: T, error: unknown) => void,
): Promise<void> {
  for (const item of items) {
    try {
      await task(item);
    } catch (error) {
      onError(item, error);
    }
  }
}

/**
 * Destructive role enumeration is allowed only after one complete member
 * snapshot in this runtime generation. Failed attempts remain retryable.
 */
export async function ensureCompleteIntegrityMemberSnapshot(
  guildId: string,
  readyGuildIds: Set<string>,
  fetchAllMembers: () => Promise<unknown>,
): Promise<void> {
  if (!guildId) throw new Error('Integrity snapshot requires a guild id');
  if (readyGuildIds.has(guildId)) return;
  await fetchAllMembers();
  readyGuildIds.add(guildId);
}

/**
 * Resolves a voice location only if the gateway channel stayed unchanged for
 * the whole asynchronous resolver. A concurrent join/leave is left to its own
 * queued voice transition or the next integrity pass instead of acting on a
 * stale snapshot.
 */
export async function resolveStableIntegrityLocation<T>(
  readChannelId: () => string | null,
  resolveLocation: (channelId: string | null) => Promise<T>,
  readResolvedChannelId: (location: T) => string | null,
): Promise<T | null> {
  const observedChannelId = readChannelId();
  const location = await resolveLocation(observedChannelId);
  if (readChannelId() !== observedChannelId) return null;
  if (readResolvedChannelId(location) !== observedChannelId) return null;
  return location;
}
