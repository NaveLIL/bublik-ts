import path from 'path';

/** Convert any thrown JavaScript value into an Error without losing useful context. */
export function normalizeError(value: unknown, fallbackMessage = 'Unknown error'): Error {
  if (value instanceof Error) return value;

  if (typeof value === 'string') {
    return new Error(value || fallbackMessage);
  }

  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const message = typeof record.message === 'string'
      ? record.message
      : safeStringify(value, fallbackMessage);
    const error = new Error(message || fallbackMessage);

    if (typeof record.name === 'string' && record.name) error.name = record.name;
    if (typeof record.stack === 'string' && record.stack) error.stack = record.stack;
    if ('cause' in record) (error as Error & { cause?: unknown }).cause = record.cause;

    return error;
  }

  return new Error(value == null ? fallbackMessage : String(value));
}

function safeStringify(value: unknown, fallback: string): string {
  try {
    const seen = new WeakSet<object>();
    return JSON.stringify(value, (_key, nested) => {
      if (typeof nested === 'bigint') return nested.toString();
      if (nested && typeof nested === 'object') {
        if (seen.has(nested)) return '[Circular]';
        seen.add(nested);
      }
      return nested;
    }) || fallback;
  } catch {
    return fallback;
  }
}

/** Module names are directory names, never paths. */
export function isValidModuleName(name: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(name);
}

/** True only when candidate resolves to parent itself or one of its descendants. */
export function isPathWithin(parent: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}
