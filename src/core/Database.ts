import { PrismaClient } from '@prisma/client';
import { Config } from '../config';
import { logger } from './Logger';
import { errorReporter } from './ErrorReporter';

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
    errorReporter.databaseError(new Error(e.message), 'Prisma $on error event');
  });

  try {
    await prisma.$connect();
    log.info('PostgreSQL подключён ✓');
  } catch (err) {
    log.error('Не удалось подключиться к PostgreSQL', err);
    errorReporter.databaseError(err, 'Подключение к PostgreSQL при старте');
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
