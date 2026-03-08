import Redis from 'ioredis';
import { Config } from '../config';
import { logger } from './Logger';
import { errorReporter } from './ErrorReporter';

const log = logger.child('Redis');

let redis: Redis | null = null;

/** Подключение к Redis */
export async function connectRedis(): Promise<Redis> {
  if (redis) return redis;

  redis = new Redis(Config.redisUrl, {
    maxRetriesPerRequest: 3,
    retryStrategy(times: number) {
      const delay = Math.min(times * 500, 5000);
      log.warn(`Переподключение к Redis… попытка ${times}, задержка ${delay}мс`);
      return delay;
    },
    reconnectOnError(err: Error) {
      const targetErrors = ['READONLY', 'ECONNRESET', 'ECONNREFUSED'];
      return targetErrors.some((e) => err.message.includes(e));
    },
    lazyConnect: true,
  });

  redis.on('connect', () => log.info('Redis подключён ✓'));
  redis.on('error', (err) => {
    log.error('Redis ошибка', err);
    errorReporter.redisError(err, 'Redis connection error event');
  });
  redis.on('close', () => {
    log.warn('Redis соединение закрыто');
    errorReporter.redisError(new Error('Redis connection closed'), 'Соединение закрыто — ожидаем реконнект');
  });

  try {
    await redis.connect();
  } catch (err) {
    log.error('Не удалось подключиться к Redis', err);
    errorReporter.redisError(err, 'Подключение к Redis при старте');
    throw err;
  }

  return redis;
}

/** Получить активный клиент Redis */
export function getRedis(): Redis {
  if (!redis) {
    throw new Error('Redis не инициализирован. Вызовите connectRedis() сначала.');
  }
  return redis;
}

/** Корректное отключение */
export async function disconnectRedis(): Promise<void> {
  if (redis) {
    await redis.quit();
    redis = null;
    log.info('Redis отключён');
  }
}

// ── Вспомогательные функции кэша ─────────────

/** Кэш с TTL (в секундах) */
export async function cacheSet(key: string, value: unknown, ttl = 300): Promise<void> {
  const r = getRedis();
  await r.set(`bublik:${key}`, JSON.stringify(value), 'EX', ttl);
}

/** Получить из кэша */
export async function cacheGet<T = unknown>(key: string): Promise<T | null> {
  const r = getRedis();
  const raw = await r.get(`bublik:${key}`);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/** Удалить из кэша */
export async function cacheDel(key: string): Promise<void> {
  const r = getRedis();
  await r.del(`bublik:${key}`);
}
