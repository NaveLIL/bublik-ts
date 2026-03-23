/**
 * Утилиты общего назначения
 */

/** Форматировать uptime в человеко-читаемый вид */
export function formatUptime(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  const parts: string[] = [];
  if (days > 0) parts.push(`${days}д`);
  if (hours % 24 > 0) parts.push(`${hours % 24}ч`);
  if (minutes % 60 > 0) parts.push(`${minutes % 60}м`);
  if (seconds % 60 > 0 || parts.length === 0) parts.push(`${seconds % 60}с`);

  return parts.join(' ');
}

/** Форматировать байты */
export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
}

/** Обрезать строку до maxLen с «…» */
export function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen - 1) + '…';
}

/** Задержка (async sleep) */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Безопасный JSON.parse */
export function safeParse<T>(json: string, fallback: T): T {
  try {
    return JSON.parse(json) as T;
  } catch {
    return fallback;
  }
}

/** Получить текущий год (для футера) */
export function currentYear(): number {
  return new Date().getFullYear();
}

/** Emoji для категорий */
export const categoryEmojis: Record<string, string> = {
  general: '🔧',
  moderation: '🛡️',
  utility: '⚙️',
  fun: '🎮',
  admin: '👑',
  info: 'ℹ️',
  music: '🎵',
  economy: '💰',
};

/**
 * Проверяет, является ли ошибка транзиентной ошибкой Discord-интеракции,
 * которую не нужно репортить как критическую (Unknown interaction, EAI_AGAIN).
 */
export function isTransientInteractionError(err: unknown): boolean {
  const anyErr = err as any;
  const code = anyErr?.code;
  const message = String(anyErr?.message ?? anyErr ?? '');

  return (
    code === 10062 ||  // Unknown interaction
    code === 40060 ||  // Interaction already acknowledged
    message.includes('Unknown interaction') ||
    message.includes('EAI_AGAIN') ||
    message.includes('ECONNRESET') ||
    message.includes('ETIMEDOUT') ||
    message.includes('ENOTFOUND') ||
    message.includes('getaddrinfo')
  );
}
