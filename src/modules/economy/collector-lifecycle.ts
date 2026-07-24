import { isGuildAllowed } from '../../core/Whitelist';

interface StoppableCollector {
  stop(reason?: string): unknown;
  once(event: 'end', listener: (...args: unknown[]) => void): unknown;
}

const activeCollectors = new Set<StoppableCollector>();
let acceptingCollectorActions = false;

export function activateEconomyCollectors(): void {
  acceptingCollectorActions = true;
}

export function registerEconomyCollector<T extends StoppableCollector>(collector: T): T {
  if (!acceptingCollectorActions) {
    collector.stop('module_unload');
    return collector;
  }
  activeCollectors.add(collector);
  collector.once('end', () => activeCollectors.delete(collector));
  return collector;
}

/** Component collectors receive events outside the normal command dispatcher. */
export function canProcessEconomyCollector(guildId: string): boolean {
  return acceptingCollectorActions && isGuildAllowed(guildId);
}

export function stopAllEconomyCollectors(): void {
  acceptingCollectorActions = false;
  const snapshot = [...activeCollectors];
  activeCollectors.clear();
  for (const collector of snapshot) collector.stop('module_unload');
}

export function getActiveEconomyCollectorCount(): number {
  return activeCollectors.size;
}
