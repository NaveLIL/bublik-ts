import { logger } from './Logger';

const log = logger.child('Scheduler');

interface RegisteredTask {
  name: string;
  intervalMs: number;
  handler: () => Promise<void>;
  exclusive: boolean;
  timer: ReturnType<typeof setInterval>;
  runningCount: number;
  lastRunAt: number | null;
  runCount: number;
  errorCount: number;
}

const tasks = new Map<string, RegisteredTask>();
// Runs remain here after their task has been unscheduled, so shutdown cannot lose them.
const inFlightRuns = new Map<Promise<void>, string>();

/** Await a boot/recovery promise without allowing module unload to hang forever. */
export async function waitForPromiseWithin(
  promise: Promise<unknown> | null,
  timeoutMs = 15_000,
): Promise<boolean> {
  if (!promise) return true;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const completed = await Promise.race([
    promise.then(() => true, () => true),
    new Promise<boolean>((resolve) => {
      timeout = setTimeout(() => resolve(false), timeoutMs);
    }),
  ]);
  if (timeout) clearTimeout(timeout);
  return completed;
}

export function scheduleTask(
  name: string,
  intervalMs: number,
  handler: () => Promise<void>,
  options?: { exclusive?: boolean; immediate?: boolean },
): void {
  if (!name.trim()) throw new Error('Имя scheduled task не может быть пустым');
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    throw new Error(`Некорректный интервал задачи "${name}": ${intervalMs}`);
  }
  if (tasks.has(name)) {
    log.warn(`Задача "${name}" уже зарегистрирована — пропуск`);
    return;
  }

  const task: RegisteredTask = {
    name,
    intervalMs,
    handler,
    exclusive: options?.exclusive ?? true,
    timer: null!,
    runningCount: 0,
    lastRunAt: null,
    runCount: 0,
    errorCount: 0,
  };

  const tick = (): void => {
    if (task.exclusive && task.runningCount > 0) return;
    task.runningCount++;

    const run = (async () => {
      try {
        await task.handler();
        task.runCount++;
        task.lastRunAt = Date.now();
      } catch (err) {
        task.errorCount++;
        log.error(`Ошибка задачи "${name}"`, err);
      } finally {
        task.runningCount--;
      }
    })();

    inFlightRuns.set(run, name);
    void run.finally(() => inFlightRuns.delete(run));
  };

  task.timer = setInterval(tick, intervalMs);
  tasks.set(name, task);
  if (options?.immediate) tick();
}

export function unscheduleTask(name: string): void {
  const task = tasks.get(name);
  if (!task) return;
  clearInterval(task.timer);
  tasks.delete(name);
}

/** Wait for handlers that were already running, including handlers of removed tasks. */
export async function drainScheduledTasks(timeoutMs = 15_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;

  while (inFlightRuns.size > 0) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      log.warn(`Таймаут ожидания ${inFlightRuns.size} scheduled task`);
      return false;
    }

    const snapshot = Array.from(inFlightRuns.keys());
    let timedOut = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      Promise.allSettled(snapshot),
      new Promise<void>((resolve) => {
        timeout = setTimeout(() => {
          timedOut = true;
          resolve();
        }, remaining);
      }),
    ]);
    if (timeout) clearTimeout(timeout);
    if (timedOut) {
      log.warn(`Таймаут ожидания ${inFlightRuns.size} scheduled task`);
      return false;
    }
  }

  return true;
}

/**
 * Drain one scheduler namespace without waiting for unrelated modules. With no
 * timeout the returned promise deliberately remains pending: ModuleLoader can
 * then quarantine a legacy unload until every old task has really settled.
 */
export async function drainScheduledTasksByPrefix(
  prefix: string,
  timeoutMs?: number,
): Promise<boolean> {
  if (!prefix) throw new Error('Scheduler task prefix cannot be empty');
  const deadline = timeoutMs === undefined ? Number.POSITIVE_INFINITY : Date.now() + timeoutMs;

  while (true) {
    const snapshot = Array.from(inFlightRuns.entries())
      .filter(([, name]) => name.startsWith(prefix))
      .map(([run]) => run);
    if (snapshot.length === 0) return true;

    const remaining = deadline - Date.now();
    if (remaining <= 0) return false;
    if (!Number.isFinite(remaining)) {
      await Promise.allSettled(snapshot);
      continue;
    }

    let timeout: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    await Promise.race([
      Promise.allSettled(snapshot),
      new Promise<void>((resolve) => {
        timeout = setTimeout(() => {
          timedOut = true;
          resolve();
        }, remaining);
      }),
    ]);
    if (timeout) clearTimeout(timeout);
    if (timedOut) return false;
  }
}

/** Stop future ticks and drain all handlers that have already started. */
export async function unscheduleAll(timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  do {
    for (const [name, task] of tasks) {
      clearInterval(task.timer);
      log.debug(`Задача "${name}" остановлена`);
    }
    tasks.clear();
    await drainScheduledTasks(Math.max(0, deadline - Date.now()));
    // A running handler can register another task while it is winding down.
  } while (tasks.size > 0 && Date.now() < deadline);
}

export function getSchedulerStats(): {
  name: string;
  intervalMs: number;
  running: boolean;
  runningCount: number;
  lastRunAt: number | null;
  runCount: number;
  errorCount: number;
}[] {
  return Array.from(tasks.values()).map((task) => ({
    name: task.name,
    intervalMs: task.intervalMs,
    running: task.runningCount > 0,
    runningCount: task.runningCount,
    lastRunAt: task.lastRunAt,
    runCount: task.runCount,
    errorCount: task.errorCount,
  }));
}
