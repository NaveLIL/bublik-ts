import Redis from 'ioredis';
import { Config } from '../config';
import { logger } from './Logger';

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
      const targetErrors = ['READONLY', 'ECONNRESET', 'ECONNREFUSED', 'EAI_AGAIN', 'ETIMEDOUT', 'ENOTFOUND'];
      return targetErrors.some((e) => err.message.includes(e));
    },
    lazyConnect: true,
  });

  redis.on('connect', () => log.info('Redis подключён ✓'));
  redis.on('error', (err) => log.error('Redis ошибка', err));
  redis.on('close', () => log.warn('Redis соединение закрыто'));

  try {
    // Retry с backoff — DNS может не резолвиться сразу в Docker (EAI_AGAIN)
    const MAX_ATTEMPTS = 5;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        await redis.connect();
        break;
      } catch (connectErr) {
        if (attempt === MAX_ATTEMPTS) throw connectErr;
        const delay = 1000 * attempt;
        log.warn(`Redis: попытка ${attempt}/${MAX_ATTEMPTS} не удалась, повтор через ${delay}мс`);
        await new Promise(r => setTimeout(r, delay));
      }
    }
  } catch (err) {
    log.error('Не удалось подключиться к Redis', err);
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
