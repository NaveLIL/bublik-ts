import { BublikClient } from './bot';
import { logger } from './core/Logger';
import { errorReporter } from './core/ErrorReporter';

/**
 * ╔══════════════════════════════════════╗
 * ║        🥯  Bublik Bot Entry         ║
 * ║      © NaveL for EREZ 2024–2026     ║
 * ╚══════════════════════════════════════╝
 */

const client = new BublikClient();

// ── Запуск ───────────────────────────────────
client.start().catch((err) => {
  logger.error('Критическая ошибка при запуске бота', err);
  process.exit(1);
});

// ── Обработка завершения ─────────────────────
let shuttingDown = false;
const shutdown = async (signal: string) => {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info(`Получен сигнал ${signal} — завершаем…`);
  await client.shutdown();
  process.exit(0);
};

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// ── Обработка необработанных ошибок ──────────
process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled Rejection', reason as Error);
  errorReporter.systemError(reason, 'Unhandled Promise Rejection');
});

process.on('uncaughtException', (error) => {
  logger.error('Uncaught Exception', error);
  errorReporter.systemError(error, 'Uncaught Exception — перезапуск через 2с');
  // Даём логгеру и ErrorReporter записать, потом перезапуск через docker restart policy
  setTimeout(() => process.exit(1), 2000);
});

// Предотвращаем crash при разрыве pipe
process.on('SIGPIPE', () => {
  logger.warn('SIGPIPE получен — игнорируем');
});
