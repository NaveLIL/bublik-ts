import { randomUUID } from 'node:crypto';
import { getRedis } from './Redis';

const LOCK_PREFIX = 'core:member-role-lock';
const LOCK_TTL_MS = 60_000;
const LOCK_RENEW_MS = 20_000;
const LOCK_WAIT_MS = 15_000;

export interface MemberRoleLock {
  assertOwned(): Promise<void>;
  /** Atomically set a Redis value only while this exact lease token is current. */
  setRedisValue(key: string, value: string): Promise<void>;
  /** Atomically delete a Redis key only while this exact lease token is current. */
  deleteRedisKey(key: string): Promise<void>;
  /** Atomically delete related Redis keys while this exact lease token is current. */
  deleteRedisKeys(keys: readonly string[]): Promise<void>;
}

function memberRoleAbortError(): Error {
  const error = new Error('Member role mutation aborted');
  error.name = 'AbortError';
  return error;
}

function throwIfMemberRoleAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw memberRoleAbortError();
}

function waitForMemberRoleLock(ms: number, signal?: AbortSignal): Promise<void> {
  throwIfMemberRoleAborted(signal);
  if (!signal) return new Promise((resolve) => setTimeout(resolve, ms));
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(memberRoleAbortError());
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function memberRoleLockKey(guildId: string, userId: string): string {
  return `${LOCK_PREFIX}:${guildId}:${userId}`;
}

/**
 * Serialize cross-module Discord role mutations for one guild member across
 * every bot process. The database/Redis sagas remain the source of crash
 * recovery; this lock only prevents two live workers from applying opposite
 * role end states at the same time.
 */
export async function withMemberRoleLock<T>(
  guildId: string,
  userId: string,
  task: (lock: MemberRoleLock) => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (!guildId || !userId) throw new Error('Member role lock requires guildId and userId');

  const redis = getRedis();
  const key = memberRoleLockKey(guildId, userId);
  const token = randomUUID();
  const deadline = Date.now() + LOCK_WAIT_MS;

  while (true) {
    throwIfMemberRoleAborted(signal);
    const acquired = await redis.set(key, token, 'PX', LOCK_TTL_MS, 'NX');
    if (acquired === 'OK') break;
    if (Date.now() >= deadline) {
      throw new Error(`Member role mutation is busy for ${guildId}:${userId}`);
    }
    await waitForMemberRoleLock(100, signal);
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

  const deleteRedisKeys = async (targetKeys: readonly string[]): Promise<void> => {
    throwIfMemberRoleAborted(signal);
    if (targetKeys.length === 0 || targetKeys.some((targetKey) => !targetKey)) {
      throw new Error('Member role lock target keys are required');
    }
    const deleted = await redis.eval(
      'if redis.call("get", KEYS[1]) ~= ARGV[1] then return 0 end; for i = 2, #KEYS do redis.call("del", KEYS[i]) end; return 1',
      targetKeys.length + 1,
      key,
      ...targetKeys,
      token,
    );
    if (Number(deleted) !== 1) {
      lost = true;
      throw new Error(`Member role lock was lost for ${guildId}:${userId}`);
    }
  };

  const lock: MemberRoleLock = {
    async assertOwned(): Promise<void> {
      throwIfMemberRoleAborted(signal);
      if (lost || await redis.get(key) !== token) {
        lost = true;
        throw new Error(`Member role lock was lost for ${guildId}:${userId}`);
      }
    },
    async setRedisValue(targetKey: string, value: string): Promise<void> {
      throwIfMemberRoleAborted(signal);
      if (!targetKey) throw new Error('Member role lock target key is required');
      const written = await redis.eval(
        'if redis.call("get", KEYS[1]) == ARGV[1] then redis.call("set", KEYS[2], ARGV[2]); return 1 else return 0 end',
        2,
        key,
        targetKey,
        token,
        value,
      );
      if (Number(written) !== 1) {
        lost = true;
        throw new Error(`Member role lock was lost for ${guildId}:${userId}`);
      }
    },
    async deleteRedisKey(targetKey: string): Promise<void> {
      await deleteRedisKeys([targetKey]);
    },
    deleteRedisKeys,
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
