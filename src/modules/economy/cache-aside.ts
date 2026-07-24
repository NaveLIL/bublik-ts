export type CacheFailurePhase = 'read' | 'decode' | 'write' | 'invalidate';

type CacheFailureHandler = (phase: CacheFailurePhase, error: unknown) => void;

interface JsonCacheAsideOptions<TSource, TResult> {
  coherenceKey?: string;
  readCache: () => Promise<string | null>;
  readSource: () => Promise<TSource | null>;
  serialize: (source: TSource) => TResult;
  writeCache: (encoded: string) => Promise<unknown>;
  validateCached?: (value: unknown) => boolean;
  onCacheFailure?: CacheFailureHandler;
}

// If invalidation fails after a committed DB write, this process must not read
// the old Redis value again. A successful source refill clears the bypass.
const DEFAULT_BYPASS_TTL_MS = 10 * 60_000;
const cacheBypassKeys = new Map<string, number>();

function pruneExpiredCacheBypasses(now = Date.now()): void {
  for (const [key, expiresAt] of cacheBypassKeys) {
    if (expiresAt <= now) cacheBypassKeys.delete(key);
  }
}

function markCacheBypassed(coherenceKey: string, ttlMs = DEFAULT_BYPASS_TTL_MS): void {
  pruneExpiredCacheBypasses();
  const safeTtl = Number.isSafeInteger(ttlMs) && ttlMs > 0 ? ttlMs : DEFAULT_BYPASS_TTL_MS;
  cacheBypassKeys.set(coherenceKey, Date.now() + safeTtl);
}

export function isCacheBypassed(coherenceKey: string): boolean {
  pruneExpiredCacheBypasses();
  return cacheBypassKeys.has(coherenceKey);
}

export function clearCacheBypassForTests(): void {
  cacheBypassKeys.clear();
}

function reportCacheFailure(
  handler: CacheFailureHandler | undefined,
  phase: CacheFailurePhase,
  error: unknown,
): void {
  try {
    handler?.(phase, error);
  } catch {
    // Cache observability must never become part of the durable operation.
  }
}

/**
 * Read-through JSON cache where the durable source is authoritative. Cache
 * connectivity, corrupt JSON and refill failures all degrade to the source.
 */
export async function readThroughJsonCache<TSource, TResult>(
  options: JsonCacheAsideOptions<TSource, TResult>,
): Promise<TResult | null> {
  let cached: string | null = null;
  const bypassCache = Boolean(options.coherenceKey && isCacheBypassed(options.coherenceKey));
  if (!bypassCache) {
    try {
      cached = await options.readCache();
    } catch (error) {
      reportCacheFailure(options.onCacheFailure, 'read', error);
    }
  }

  if (cached !== null) {
    try {
      const parsed: unknown = JSON.parse(cached);
      if (options.validateCached && !options.validateCached(parsed)) {
        throw new Error('invalid_cache_payload');
      }
      return parsed as TResult;
    } catch (error) {
      reportCacheFailure(options.onCacheFailure, 'decode', error);
    }
  }

  const source = await options.readSource();
  if (source === null) return null;

  const result = options.serialize(source);
  try {
    await options.writeCache(JSON.stringify(result));
    if (options.coherenceKey) cacheBypassKeys.delete(options.coherenceKey);
  } catch (error) {
    if (options.coherenceKey) markCacheBypassed(options.coherenceKey);
    reportCacheFailure(options.onCacheFailure, 'write', error);
  }
  return result;
}

/** A failed cache mutation must not turn a committed database write into an error. */
export async function mutateCacheBestEffort(
  operation: () => Promise<unknown>,
  onCacheFailure?: CacheFailureHandler,
  coherenceKey?: string,
  coherenceTtlMs?: number,
): Promise<void> {
  try {
    await operation();
    if (coherenceKey) cacheBypassKeys.delete(coherenceKey);
  } catch (error) {
    if (coherenceKey) markCacheBypassed(coherenceKey, coherenceTtlMs);
    reportCacheFailure(onCacheFailure, 'invalidate', error);
  }
}
