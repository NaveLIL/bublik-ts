import winston from 'winston';
import DailyRotateFile from 'winston-daily-rotate-file';
import path from 'path';
import fs from 'fs';
import { Config } from '../config';

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

  warn(message: string, meta?: Record<string, any>): void {
    baseLogger.warn(message, { module: this.moduleName, ...meta });
  }

  error(message: string, error?: Error | unknown, meta?: Record<string, any>): void {
    const stack = error instanceof Error ? error.stack : undefined;
    const errorMsg = error instanceof Error ? error.message : String(error ?? '');
    baseLogger.error(message + (errorMsg ? `: ${errorMsg}` : ''), {
      module: this.moduleName,
      stack,
      ...meta,
    });
  }

  debug(message: string, meta?: Record<string, any>): void {
    baseLogger.debug(message, { module: this.moduleName, ...meta });
  }

  verbose(message: string, meta?: Record<string, any>): void {
    baseLogger.verbose(message, { module: this.moduleName, ...meta });
  }

  /** Красивый баннер при старте */
  banner(): void {
    const lines = [
      '',
      `${colors.bold}${colors.green}  ╔══════════════════════════════════════╗${colors.reset}`,
      `${colors.bold}${colors.green}  ║         🥯  B U B L I K  Bot        ║${colors.reset}`,
      `${colors.bold}${colors.green}  ║      by NaveL  •  for EREZ          ║${colors.reset}`,
      `${colors.bold}${colors.green}  ╚══════════════════════════════════════╝${colors.reset}`,
      '',
    ];
    lines.forEach((l) => console.log(l));
  }
}

// ── Синглтон ─────────────────────────────────
export const logger = new Logger();
