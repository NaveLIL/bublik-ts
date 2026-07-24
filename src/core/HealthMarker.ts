import { randomUUID } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const HEALTH_MARKER_VERSION = 1 as const;
export const DEFAULT_HEALTH_MARKER_PATH = '/tmp/bublik-health.json';
export const DEFAULT_HEALTH_MAX_AGE_MS = 75_000;
export const DEFAULT_HEALTH_FUTURE_TOLERANCE_MS = 5_000;
export const MAX_HEALTH_MARKER_BYTES = 4_096;

export interface HealthMarker {
  version: typeof HEALTH_MARKER_VERSION;
  pid: number;
  checkedAt: number;
  ready: true;
  checks: {
    discord: true;
    database: true;
    redis: true;
  };
}

export interface HealthMarkerValidationOptions {
  now?: number;
  maxAgeMs?: number;
  futureToleranceMs?: number;
  expectedPid?: number;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

export function resolveHealthMarkerPath(value = process.env.BUBLIK_HEALTH_FILE): string {
  const markerPath = value === undefined || value === '' ? DEFAULT_HEALTH_MARKER_PATH : value;
  if (markerPath.includes('\0') || !path.isAbsolute(markerPath)) {
    throw new Error('BUBLIK_HEALTH_FILE must be an absolute path without NUL bytes.');
  }
  return markerPath;
}

export function createHealthMarker(
  checkedAt = Date.now(),
  pid = process.pid,
): HealthMarker {
  if (!isPositiveSafeInteger(checkedAt)) throw new Error('Health marker time must be a positive safe integer.');
  if (!isPositiveSafeInteger(pid)) throw new Error('Health marker pid must be a positive safe integer.');
  return {
    version: HEALTH_MARKER_VERSION,
    pid,
    checkedAt,
    ready: true,
    checks: {
      discord: true,
      database: true,
      redis: true,
    },
  };
}

export function validateHealthMarker(
  raw: string | Buffer,
  options: HealthMarkerValidationOptions = {},
): boolean {
  const now = options.now ?? Date.now();
  const maxAgeMs = options.maxAgeMs ?? DEFAULT_HEALTH_MAX_AGE_MS;
  const futureToleranceMs = options.futureToleranceMs ?? DEFAULT_HEALTH_FUTURE_TOLERANCE_MS;
  const expectedPid = options.expectedPid ?? 1;
  if (!isPositiveSafeInteger(now)
    || !isPositiveSafeInteger(maxAgeMs)
    || !Number.isSafeInteger(futureToleranceMs)
    || futureToleranceMs < 0
    || !isPositiveSafeInteger(expectedPid)) {
    return false;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString());
  } catch {
    return false;
  }

  const marker = asRecord(parsed);
  const checks = asRecord(marker?.checks);
  if (!marker
    || marker.version !== HEALTH_MARKER_VERSION
    || marker.ready !== true
    || marker.pid !== expectedPid
    || !isPositiveSafeInteger(marker.checkedAt)
    || checks?.discord !== true
    || checks.database !== true
    || checks.redis !== true) {
    return false;
  }

  const ageMs = now - marker.checkedAt;
  return ageMs >= -futureToleranceMs && ageMs <= maxAgeMs;
}

export function validateMainProcessArgv(raw: string | Buffer): boolean {
  const argv = raw.toString().split(String.fromCharCode(0)).filter(Boolean);
  return argv.length === 2
    && path.basename(argv[0]) === 'node'
    && argv[1] === 'dist/index.js';
}

export async function writeHealthMarkerAtomic(markerPath: string, marker: HealthMarker): Promise<void> {
  const target = resolveHealthMarkerPath(markerPath);
  const temporary = path.join(
    path.dirname(target),
    `.${path.basename(target)}.${process.pid}.${randomUUID()}.tmp`,
  );

  try {
    await writeFile(temporary, `${JSON.stringify(marker)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
    await rename(temporary, target);
  } catch (error) {
    await unlink(temporary).catch((cleanupError: NodeJS.ErrnoException) => {
      if (cleanupError.code !== 'ENOENT') throw cleanupError;
    });
    throw error;
  }
}

export async function removeHealthMarker(markerPath: string): Promise<void> {
  const target = resolveHealthMarkerPath(markerPath);
  await unlink(target).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error;
  });
}

export function parseHealthMaxAge(value = process.env.BUBLIK_HEALTH_MAX_AGE_MS): number {
  if (value === undefined || value === '') return DEFAULT_HEALTH_MAX_AGE_MS;
  if (!/^[1-9]\d*$/.test(value)) throw new Error('BUBLIK_HEALTH_MAX_AGE_MS must be a positive integer.');
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error('BUBLIK_HEALTH_MAX_AGE_MS is outside the safe range.');
  return parsed;
}

export function runContainerHealthcheck(): boolean {
  try {
    if (!validateMainProcessArgv(readFileSync('/proc/1/cmdline'))) return false;

    const markerPath = resolveHealthMarkerPath();
    const stat = lstatSync(markerPath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > MAX_HEALTH_MARKER_BYTES) {
      return false;
    }
    if ((stat.mode & 0o077) !== 0) return false;

    return validateHealthMarker(readFileSync(markerPath), {
      expectedPid: 1,
      maxAgeMs: parseHealthMaxAge(),
    });
  } catch {
    return false;
  }
}

if (require.main === module) {
  process.exitCode = process.argv[2] === '--check' && runContainerHealthcheck() ? 0 : 1;
}
