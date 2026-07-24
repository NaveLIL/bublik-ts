import { waitForPromiseWithin } from './SchedulerManager';

interface ReadyEventSource {
  isReady(): boolean;
  once(event: 'ready', listener: () => void): unknown;
  off(event: 'ready', listener: () => void): unknown;
}

/**
 * Owns a module's asynchronous boot without making ModuleLoader wait for
 * Discord/Redis recovery. Every boot receives a generation predicate and must
 * check it before publishing timers or other runtime state.
 */
export class ModuleBootController {
  private generation = 0;
  private readySource: ReadyEventSource | null = null;
  private readyListener: (() => void) | null = null;
  private readonly inFlight = new Set<Promise<void>>();

  start(
    source: ReadyEventSource,
    boot: (isCurrent: () => boolean) => Promise<void>,
    onError: (error: unknown) => void,
  ): void {
    this.invalidateReadyListener();
    const generation = ++this.generation;
    const isCurrent = (): boolean => generation === this.generation;

    const launch = (): void => {
      if (!isCurrent()) return;
      this.readyListener = null;
      this.readySource = null;
      // Deferring through a promise also turns synchronous boot exceptions into
      // an observed rejection and guarantees start() itself never blocks.
      const pending = Promise.resolve().then(() => boot(isCurrent));
      this.inFlight.add(pending);
      void pending
        .catch((error: unknown) => {
          try {
            onError(error);
          } catch {
            // Logging must not create an unhandled rejection of its own.
          }
        })
        .finally(() => this.inFlight.delete(pending));
    };

    if (source.isReady()) {
      launch();
      return;
    }

    this.readySource = source;
    this.readyListener = launch;
    source.once('ready', launch);
  }

  /** Invalidate late boot work, detach ready, and wait only up to timeoutMs. */
  async stop(timeoutMs = 15_000): Promise<boolean> {
    this.generation++;
    this.invalidateReadyListener();
    if (this.inFlight.size === 0) return true;
    return waitForPromiseWithin(Promise.allSettled([...this.inFlight]), timeoutMs);
  }

  /**
   * Invalidate boot and wait for its actual settlement. Legacy onUnload hooks
   * rely on ModuleLoader for the bounded wait and quarantine; returning early
   * here would let old recovery work outlive its module generation.
   */
  async stopAndDrain(): Promise<true> {
    this.generation++;
    this.invalidateReadyListener();
    while (this.inFlight.size > 0) {
      await Promise.allSettled([...this.inFlight]);
    }
    return true;
  }

  private invalidateReadyListener(): void {
    if (this.readySource && this.readyListener) {
      this.readySource.off('ready', this.readyListener);
    }
    this.readySource = null;
    this.readyListener = null;
  }
}
