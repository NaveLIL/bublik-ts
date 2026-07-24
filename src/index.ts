import { BublikClient } from './bot';
import { logger } from './core/Logger';
import { errorReporter, normalizeError } from './core';

/**
 * ╔══════════════════════════════════════╗
 * ║        🥯  Bublik Bot Entry         ║
 * ║      © NaveLIL for EREZ 2024–2026   ║
 * ╚══════════════════════════════════════╝
 */

const client = new BublikClient();

// ── Обработка завершения ─────────────────────
let shuttingDown = false;
const shutdown = async (signal: string, exitCode = 0) => {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info(`Получен сигнал ${signal} — завершаем…`);

  const timeout = setTimeout(() => {
    logger.error('Graceful shutdown: таймаут 15с, принудительный выход');
    process.exit(1);
  }, 15_000);
  timeout.unref();

  try {
    await client.shutdown();
  } catch (error) {
    exitCode = 1;
    logger.error('Graceful shutdown завершился с ошибкой', normalizeError(error));
  } finally {
    clearTimeout(timeout);
  }
  process.exit(exitCode);
};

// ── Запуск ───────────────────────────────────
void client.start().catch(async (reason) => {
  const error = normalizeError(reason, 'Неизвестная ошибка запуска');
  logger.error('Критическая ошибка при запуске бота', error);
  errorReporter.systemError(error, 'startup');
  await shutdown('startupFailure', 1);
});

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

// ── Обработка необработанных ошибок ──────────
process.on('unhandledRejection', (reason) => {
  const error = normalizeError(reason, 'Unhandled rejection');
  logger.error('Unhandled Rejection', error);
  errorReporter.systemError(error, 'unhandledRejection');
  void shutdown('unhandledRejection', 1);
});

process.on('uncaughtException', (error) => {
  const normalized = normalizeError(error, 'Uncaught exception');
  logger.error('Uncaught Exception', normalized);
  errorReporter.systemError(normalized, 'uncaughtException');
  void shutdown('uncaughtException', 1);
});

// Предотвращаем crash при разрыве pipe
process.on('SIGPIPE', () => {
  logger.warn('SIGPIPE получен — игнорируем');
});
