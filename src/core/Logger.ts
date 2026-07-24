import winston from 'winston';
import DailyRotateFile from 'winston-daily-rotate-file';
import fs from 'fs';
import { Config } from '../config';
import { normalizeError } from './Safety';

// ── Гарантируем, что папка логов существует ──
if (!fs.existsSync(Config.logsDir)) {
  fs.mkdirSync(Config.logsDir, { recursive: true });
}

// ── Цветовая палитра для консоли ─────────────
const colors: Record<string, string> = {
  error: '\x1b[31m',   // красный
  warn: '\x1b[33m',    // жёлтый
  info: '\x1b[36m',    // циан
  debug: '\x1b[35m',   // фиолетовый
  verbose: '\x1b[90m', // серый
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  green: '\x1b[32m',
  blue: '\x1b[34m',
};

// ── Красивый формат для консоли ──────────────
const consoleFormat = winston.format.printf(({ level, message, timestamp, module: mod, stack }) => {
  const ts = colors.dim + (timestamp as string) + colors.reset;
  const colorKey = level.replace(/\u001b\[\d+m/g, ''); // strip ANSI
  const col = colors[colorKey] || '';
  const lvl = col + level.toUpperCase().padEnd(7) + colors.reset;
  const src = mod ? colors.blue + `[${mod}]` + colors.reset + ' ' : '';
  const msg = stack ? `${message}\n${colors.dim}${stack}${colors.reset}` : message;
  return `${ts} ${lvl} ${src}${msg}`;
});

// ── Transport: консоль ───────────────────────
const consoleTransport = new winston.transports.Console({
  format: winston.format.combine(
    winston.format.timestamp({ format: 'HH:mm:ss' }),
    consoleFormat,
  ),
});

// ── Transport: ежедневный файл (все уровни) ──
const combinedFileTransport = new DailyRotateFile({
  dirname: Config.logsDir,
  filename: 'bublik-%DATE%.log',
  datePattern: 'YYYY-MM-DD',
  maxSize: '20m',
  maxFiles: '30d',
  format: winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }),
    winston.format.json(),
  ),
});

// ── Transport: только ошибки ─────────────────
const errorFileTransport = new DailyRotateFile({
  dirname: Config.logsDir,
  filename: 'errors-%DATE%.log',
  datePattern: 'YYYY-MM-DD',
  maxSize: '20m',
  maxFiles: '60d',
  level: 'error',
  format: winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }),
    winston.format.errors({ stack: true }),
    winston.format.json(),
  ),
});

// ── Основной логгер ──────────────────────────
const baseLogger = winston.createLogger({
  level: Config.logLevel,
  defaultMeta: { service: 'bublik' },
  transports: [
    consoleTransport,
    combinedFileTransport,
    errorFileTransport,
  ],
  // Не крашим процесс при ошибках логгера
  exitOnError: false,
});

// ── Типизированная обёртка ───────────────────
export class Logger {
  private moduleName?: string;

  constructor(moduleName?: string) {
    this.moduleName = moduleName;
  }

  /** Создать дочерний логгер для модуля */
  child(moduleName: string): Logger {
    return new Logger(moduleName);
  }

  info(message: string, meta?: Record<string, any>): void {
    baseLogger.info(message, { module: this.moduleName, ...meta });
  }

  warn(message: string, errorOrMeta?: unknown, meta?: Record<string, unknown>): void {
    const details = this.normalizeLogDetails(errorOrMeta, meta);
    baseLogger.warn(details.message ? `${message}: ${details.message}` : message, {
      module: this.moduleName,
      ...details.meta,
      stack: details.stack,
    });
  }

  error(message: string, error?: unknown, meta?: Record<string, unknown>): void {
    const details = this.normalizeLogDetails(error, meta);
    baseLogger.error(details.message ? `${message}: ${details.message}` : message, {
      module: this.moduleName,
      ...details.meta,
      stack: details.stack,
    });
  }

  debug(message: string, meta?: Record<string, any>): void {
    baseLogger.debug(message, { module: this.moduleName, ...meta });
  }

  verbose(message: string, meta?: Record<string, any>): void {
    baseLogger.verbose(message, { module: this.moduleName, ...meta });
  }

  private normalizeLogDetails(
    errorOrMeta?: unknown,
    explicitMeta?: Record<string, unknown>,
  ): { message?: string; stack?: string; meta?: Record<string, unknown> } {
    if (errorOrMeta === undefined) return { meta: explicitMeta };

    // Keep the long-standing logger.error(message, { ...meta }) API working.
    if (
      explicitMeta === undefined
      && errorOrMeta !== null
      && typeof errorOrMeta === 'object'
      && !(errorOrMeta instanceof Error)
      && !('message' in errorOrMeta)
      && !('stack' in errorOrMeta)
    ) {
      const record = errorOrMeta as Record<string, unknown>;
      if (record.error !== undefined) {
        const normalized = normalizeError(record.error);
        return { message: normalized.message, stack: normalized.stack, meta: record };
      }
      return { meta: record };
    }

    const normalized = normalizeError(errorOrMeta);
    return {
      message: normalized.message,
      stack: normalized.stack,
      meta: explicitMeta,
    };
  }

  /** Красивый баннер при старте */
  banner(): void {
    const lines = [
      '',
      `${colors.bold}${colors.green}  ╔══════════════════════════════════════╗${colors.reset}`,
      `${colors.bold}${colors.green}  ║         🥯  B U B L I K  Bot        ║${colors.reset}`,
      `${colors.bold}${colors.green}  ║        by NaveL  •  for EREZ        ║${colors.reset}`,
      `${colors.bold}${colors.green}  ╚══════════════════════════════════════╝${colors.reset}`,
      '',
    ];
    lines.forEach((l) => console.log(l));
  }
}

// ── Синглтон ─────────────────────────────────
export const logger = new Logger();
