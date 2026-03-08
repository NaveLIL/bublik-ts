import { config as dotenvConfig } from 'dotenv';
import path from 'path';

dotenvConfig();

function env(key: string, fallback?: string): string {
  const value = process.env[key] ?? fallback;
  if (value === undefined) {
    throw new Error(`[Config] Обязательная переменная окружения "${key}" не задана`);
  }
  return value;
}

export const Config = {
  // ── Discord ────────────────────────────────
  token: env('DISCORD_TOKEN'),
  clientId: env('DISCORD_CLIENT_ID'),
  devGuildId: process.env.DEV_GUILD_ID || null,

  // ── Database ───────────────────────────────
  databaseUrl: env('DATABASE_URL'),

  // ── Redis ──────────────────────────────────
  redisUrl: env('REDIS_URL', 'redis://localhost:6379'),

  // ── Bot ────────────────────────────────────
  defaultLocale: env('DEFAULT_LOCALE', 'ru'),
  botColor: parseInt(env('BOT_COLOR', '#5865F2').replace('#', ''), 16) as number,
  logLevel: env('LOG_LEVEL', 'info'),

  // ── Paths ──────────────────────────────────
  root: path.resolve(__dirname, '..'),
  srcDir: path.resolve(__dirname),
  modulesDir: path.resolve(__dirname, 'modules'),
  localesDir: path.resolve(__dirname, '..', 'locales'),
  logsDir: path.resolve(__dirname, '..', 'logs'),

  // ── Meta ───────────────────────────────────
  botName: 'Bublik',
  botAuthor: 'NaveL',
  footer: '© NaveL for EREZ 2024–2026',
  nodeEnv: env('NODE_ENV', 'development'),

  get isDev(): boolean {
    return this.nodeEnv === 'development';
  },

  // ── Error Reporting ───────────────────────
  errorChannelId: process.env.ERROR_CHANNEL_ID || null,

  // ── Welcome Module ───────────────────────
  welcomeChannelId: process.env.WELCOME_CHANNEL_ID || null,
  ticketChannelId: process.env.TICKET_CHANNEL_ID || null,
  recruitRoleId: process.env.RECRUIT_ROLE_ID || null,
} as const;
