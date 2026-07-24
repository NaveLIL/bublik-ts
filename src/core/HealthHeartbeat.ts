import {
  createHealthMarker,
  removeHealthMarker,
  resolveHealthMarkerPath,
  writeHealthMarkerAtomic,
} from './HealthMarker';
import {
  drainScheduledTasksByPrefix,
  scheduleTask,
  unscheduleTask,
} from './SchedulerManager';

export const HEALTH_HEARTBEAT_TASK_PREFIX = 'core:health-heartbeat:';
export const HEALTH_HEARTBEAT_TASK_NAME = `${HEALTH_HEARTBEAT_TASK_PREFIX}probe`;
export const DEFAULT_HEALTH_HEARTBEAT_INTERVAL_MS = 30_000;
export const DEFAULT_HEALTH_PROBE_TIMEOUT_MS = 5_000;
export const DEFAULT_HEALTH_STOP_TIMEOUT_MS = 2_000;

export interface HealthHeartbeatLogger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, errorOrMeta?: unknown, meta?: Record<string, unknown>): void;
}

export interface HealthHeartbeatScheduler {
  schedule(
    name: string,
    intervalMs: number,
    handler: () => Promise<void>,
    options: { exclusive: boolean; immediate: boolean },
  ): void;
  unschedule(name: string): void;
  drain(prefix: string, timeoutMs: number): Promise<boolean>;
}

export interface HealthHeartbeatOptions {
  markerPath?: string;
  intervalMs?: number;
  probeTimeoutMs?: number;
  stopTimeoutMs?: number;
  pid?: number;
  now?: () => number;
  isDiscordReady: () => boolean;
  probeDatabase: () => Promise<void>;
  pingRedis: () => Promise<string>;
  logger: HealthHeartbeatLogger;
  scheduler?: HealthHeartbeatScheduler;
}

const defaultScheduler: HealthHeartbeatScheduler = {
  schedule: scheduleTask,
  unschedule: unscheduleTask,
  drain: drainScheduledTasksByPrefix,
};

function positiveInterval(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer.`);
  return value;
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

export async function waitForHealthProbe<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  positiveInterval(timeoutMs, 'Health probe timeout');
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`Health probe timed out after ${timeoutMs}ms.`)), timeoutMs);
        timer.unref();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export class HealthHeartbeat {
  private readonly markerPath: string;
  private readonly intervalMs: number;
  private readonly probeTimeoutMs: number;
  private readonly stopTimeoutMs: number;
  private readonly pid: number;
  private readonly now: () => number;
  private readonly scheduler: HealthHeartbeatScheduler;
  private readonly logger: HealthHeartbeatLogger;
  private readonly isDiscordReady: () => boolean;
  private readonly probeDatabase: () => Promise<void>;
  private readonly pingRedis: () => Promise<string>;
  private running = false;
  private closed = false;
  private generation = 0;
  private lastHealthy: boolean | null = null;
  private pendingDependencyProbe: Promise<void> | null = null;

  constructor(options: HealthHeartbeatOptions) {
    this.markerPath = resolveHealthMarkerPath(options.markerPath);
    this.intervalMs = positiveInterval(
      options.intervalMs ?? DEFAULT_HEALTH_HEARTBEAT_INTERVAL_MS,
      'Health heartbeat interval',
    );
    this.probeTimeoutMs = positiveInterval(
      options.probeTimeoutMs ?? DEFAULT_HEALTH_PROBE_TIMEOUT_MS,
      'Health probe timeout',
    );
    this.stopTimeoutMs = positiveInterval(
      options.stopTimeoutMs ?? DEFAULT_HEALTH_STOP_TIMEOUT_MS,
      'Health stop timeout',
    );
    this.pid = positiveInterval(options.pid ?? process.pid, 'Health marker pid');
    this.now = options.now ?? Date.now;
    this.scheduler = options.scheduler ?? defaultScheduler;
    this.logger = options.logger;
    this.isDiscordReady = options.isDiscordReady;
    this.probeDatabase = options.probeDatabase;
    this.pingRedis = options.pingRedis;
  }

  async clearMarkerBeforeStartup(): Promise<void> {
    if (this.running) throw new Error('Cannot clear the health marker while heartbeat is running.');
    await removeHealthMarker(this.markerPath);
  }

  async start(): Promise<void> {
    if (this.closed) throw new Error('Health heartbeat cannot restart after shutdown.');
    if (this.running) return;

    const generation = ++this.generation;
    this.running = true;
    try {
      await removeHealthMarker(this.markerPath);
      if (!this.isActive(generation)) return;
      this.scheduler.schedule(
        HEALTH_HEARTBEAT_TASK_NAME,
        this.intervalMs,
        async () => this.runProbe(generation),
        { exclusive: true, immediate: true },
      );
    } catch (error) {
      if (this.generation === generation) {
        this.running = false;
        this.generation++;
      }
      throw error;
    }
  }

  async stop(): Promise<void> {
    this.closed = true;
    this.running = false;
    this.generation++;
    const errors: unknown[] = [];
    let drained = false;
    let drainFailed = false;

    try {
      this.scheduler.unschedule(HEALTH_HEARTBEAT_TASK_NAME);
    } catch (error) {
      errors.push(error);
    }

    // Readiness must disappear as soon as shutdown starts, before waiting for
    // an already-running probe. A second removal below closes the race with a
    // probe that had already passed its generation check and is writing now.
    try {
      await removeHealthMarker(this.markerPath);
    } catch (error) {
      errors.push(error);
    }

    try {
      drained = await this.scheduler.drain(HEALTH_HEARTBEAT_TASK_PREFIX, this.stopTimeoutMs);
    } catch (error) {
      drainFailed = true;
      errors.push(error);
    } finally {
      try {
        await removeHealthMarker(this.markerPath);
      } catch (error) {
        errors.push(error);
      }
      this.lastHealthy = null;
    }

    if (!drained && !drainFailed) {
      this.logger.warn('Health heartbeat shutdown timed out; marker was invalidated.');
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, 'Health heartbeat shutdown failed.');
  }

  getState(): { running: boolean; closed: boolean; healthy: boolean | null } {
    return { running: this.running, closed: this.closed, healthy: this.lastHealthy };
  }

  private isActive(generation: number): boolean {
    return this.running && !this.closed && this.generation === generation;
  }

  private async runDependencyProbe(): Promise<void> {
    if (this.pendingDependencyProbe) {
      throw new Error('Previous health dependency probe is still running.');
    }

    if (!this.isDiscordReady()) throw new Error('Discord client is not ready.');

    const databaseProbe = Promise.resolve().then(() => this.probeDatabase());
    const redisProbe = Promise.resolve().then(() => this.pingRedis());
    const operation = Promise.all([databaseProbe, redisProbe]).then(([, pong]) => {
      if (pong !== 'PONG') throw new Error(`Redis PING returned an unexpected response: ${pong}`);
    });
    const settlementBarrier = Promise.allSettled([databaseProbe, redisProbe]).then(() => undefined);
    this.pendingDependencyProbe = settlementBarrier;
    void settlementBarrier.then(() => {
      if (this.pendingDependencyProbe === settlementBarrier) this.pendingDependencyProbe = null;
    });
    await waitForHealthProbe(operation, this.probeTimeoutMs);
  }

  private async runProbe(generation: number): Promise<void> {
    if (!this.isActive(generation)) return;
    try {
      await this.runDependencyProbe();
      if (!this.isActive(generation)) return;
      await writeHealthMarkerAtomic(this.markerPath, createHealthMarker(this.now(), this.pid));
      if (!this.isActive(generation)) {
        await removeHealthMarker(this.markerPath);
        return;
      }
      this.transition(true);
    } catch (error) {
      if (this.isActive(generation)) this.transition(false, asError(error));
    }
  }

  private transition(healthy: boolean, error?: Error): void {
    if (this.lastHealthy === healthy) return;
    const previous = this.lastHealthy;
    this.lastHealthy = healthy;
    if (healthy) {
      this.logger.info(previous === false
        ? 'Production readiness recovered.'
        : 'Production readiness established.');
      return;
    }
    this.logger.warn('Production readiness lost; health marker will not be refreshed.', error);
  }
}
