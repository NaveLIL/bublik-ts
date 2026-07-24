import { randomUUID } from 'node:crypto';
import { getRedis } from '../../core/Redis';

const LOCK_PREFIX = 'welcome:member-lifecycle-lock';
const LOCK_TTL_MS = 60_000;
const LOCK_RENEW_MS = 20_000;
const LOCK_WAIT_MS = 120_000;

export interface WelcomeLifecycleLock {
  assertOwned(): Promise<void>;
}

function abortError(): Error {
  const error = new Error('Welcome module operation aborted');
  error.name = 'AbortError';
  return error;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  if (!signal) return new Promise((resolve) => setTimeout(resolve, ms));
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Orders gateway add/remove events for one membership across bot processes.
 * Role locks are deliberately separate: lifecycle fencing covers durable
 * onboarding cleanup, while the shared role lock covers Discord role writes.
 */
export async function withWelcomeLifecycleLock<T>(
  guildId: string,
  userId: string,
  task: (lock: WelcomeLifecycleLock) => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (!guildId || !userId) throw new Error('Welcome lifecycle lock requires guildId and userId');
  const redis = getRedis();
  const key = `${LOCK_PREFIX}:${guildId}:${userId}`;
  const token = randomUUID();
  const deadline = Date.now() + LOCK_WAIT_MS;

  while (true) {
    throwIfAborted(signal);
    const acquired = await redis.set(key, token, 'PX', LOCK_TTL_MS, 'NX');
    if (acquired === 'OK') break;
    if (Date.now() >= deadline) {
      throw new Error(`Welcome lifecycle mutation is busy for ${guildId}:${userId}`);
    }
    await wait(100, signal);
  }

  let lost = false;
  const renewalTimer = setInterval(() => {
    void redis.eval(
      'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("pexpire", KEYS[1], ARGV[2]) else return 0 end',
      1,
      key,
      token,
      String(LOCK_TTL_MS),
    ).then((renewed) => {
      if (Number(renewed) !== 1) lost = true;
    }).catch(() => {
      lost = true;
    });
  }, LOCK_RENEW_MS);
  renewalTimer.unref?.();

  const lock: WelcomeLifecycleLock = {
    async assertOwned(): Promise<void> {
      throwIfAborted(signal);
      if (lost || await redis.get(key) !== token) {
        lost = true;
        throw new Error(`Welcome lifecycle lock was lost for ${guildId}:${userId}`);
      }
    },
  };

  try {
    await lock.assertOwned();
    return await task(lock);
  } finally {
    clearInterval(renewalTimer);
    await redis.eval(
      'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end',
      1,
      key,
      token,
    ).catch(() => null);
  }
}
