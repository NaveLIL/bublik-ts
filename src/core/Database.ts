import { PrismaClient } from '@prisma/client';
import { Config } from '../config';
import { logger } from './Logger';

const log = logger.child('Database');

let prisma: PrismaClient | null = null;

/** Подключение к PostgreSQL через Prisma */
export async function connectDatabase(): Promise<PrismaClient> {
  if (prisma) return prisma;

  prisma = new PrismaClient({
    datasources: { db: { url: Config.databaseUrl } },
    log: Config.isDev
      ? [
          { emit: 'event', level: 'query' },
          { emit: 'event', level: 'error' },
          { emit: 'event', level: 'warn' },
        ]
      : [{ emit: 'event', level: 'error' }],
  });

  // Логируем запросы в dev-режиме
  if (Config.isDev) {
    (prisma.$on as any)('query', (e: any) => {
      log.debug(`Query: ${e.query}`, { duration: `${e.duration}ms` });
    });
  }

  (prisma.$on as any)('error', (e: any) => {
    log.error('Prisma error', new Error(e.message));
  });

  try {
    // Retry с backoff — DNS может не резолвиться сразу в Docker (EAI_AGAIN)
    const MAX_ATTEMPTS = 5;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        await prisma.$connect();
        break;
      } catch (connectErr) {
        if (attempt === MAX_ATTEMPTS) throw connectErr;
        const delay = 2000 * attempt;
        log.warn(`PostgreSQL: попытка ${attempt}/${MAX_ATTEMPTS} не удалась, повтор через ${delay}мс`);
        await new Promise(r => setTimeout(r, delay));
      }
    }
    log.info('PostgreSQL подключён ✓');
  } catch (err) {
    log.error('Не удалось подключиться к PostgreSQL', err);
    throw err;
  }

  return prisma;
}

/** Получить активный клиент Prisma */
export function getDatabase(): PrismaClient {
  if (!prisma) {
    throw new Error('Database не инициализирована. Вызовите connectDatabase() сначала.');
  }
  return prisma;
}

/** Корректное отключение */
export async function disconnectDatabase(): Promise<void> {
  if (prisma) {
    await prisma.$disconnect();
    prisma = null;
    log.info('PostgreSQL отключён');
  }
}
