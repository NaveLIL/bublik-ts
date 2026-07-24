import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  HealthHeartbeat,
  type HealthHeartbeatLogger,
  type HealthHeartbeatScheduler,
} from '../../src/core/HealthHeartbeat';
import {
  createHealthMarker,
  parseHealthMaxAge,
  resolveHealthMarkerPath,
  validateHealthMarker,
  validateMainProcessArgv,
  writeHealthMarkerAtomic,
} from '../../src/core/HealthMarker';

class MemoryLogger implements HealthHeartbeatLogger {
  readonly infoMessages: string[] = [];
  readonly warnings: { message: string; details?: unknown }[] = [];

  info(message: string): void {
    this.infoMessages.push(message);
  }

  warn(message: string, details?: unknown): void {
    this.warnings.push({ message, details });
  }
}

class MemoryScheduler implements HealthHeartbeatScheduler {
  handler: (() => Promise<void>) | null = null;
  scheduledName: string | null = null;
  scheduledOptions: { exclusive: boolean; immediate: boolean } | null = null;
  unscheduledName: string | null = null;
  drainedPrefix: string | null = null;
  drainTimeoutMs: number | null = null;
  drainError: Error | null = null;
  drainGate: Promise<boolean> | null = null;
  onDrain: (() => void) | null = null;

  schedule(
    name: string,
    _intervalMs: number,
    handler: () => Promise<void>,
    options: { exclusive: boolean; immediate: boolean },
  ): void {
    this.scheduledName = name;
    this.handler = handler;
    this.scheduledOptions = options;
  }

  unschedule(name: string): void {
    this.unscheduledName = name;
  }

  async drain(prefix: string, timeoutMs: number): Promise<boolean> {
    this.drainedPrefix = prefix;
    this.drainTimeoutMs = timeoutMs;
    this.onDrain?.();
    if (this.drainError) throw this.drainError;
    if (this.drainGate) return this.drainGate;
    return true;
  }
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

test('health marker validation is strict about process, readiness and freshness', () => {
  const now = 1_750_000_000_000;
  const marker = createHealthMarker(now, 42);
  const raw = JSON.stringify(marker);

  assert.equal(validateHealthMarker(raw, { now, expectedPid: 42, maxAgeMs: 75_000 }), true);
  assert.equal(validateHealthMarker(raw, { now: now + 75_001, expectedPid: 42, maxAgeMs: 75_000 }), false);
  assert.equal(validateHealthMarker(raw, { now: now - 5_001, expectedPid: 42 }), false);
  assert.equal(validateHealthMarker(raw, { now, expectedPid: 1 }), false);
  assert.equal(validateHealthMarker('{not-json', { now, expectedPid: 42 }), false);
  assert.equal(validateHealthMarker(JSON.stringify({ ...marker, ready: false }), { now, expectedPid: 42 }), false);
  assert.equal(validateHealthMarker(JSON.stringify({
    ...marker,
    checks: { ...marker.checks, redis: false },
  }), { now, expectedPid: 42 }), false);

  assert.equal(validateMainProcessArgv('/usr/local/bin/node\0dist/index.js\0'), true);
  assert.equal(validateMainProcessArgv('/usr/local/bin/node\0dist/index.js\0extra\0'), false);
  assert.equal(validateMainProcessArgv('/bin/sh\0./entrypoint.sh\0'), false);
  assert.equal(parseHealthMaxAge('75000'), 75_000);
  assert.throws(() => parseHealthMaxAge('0'), /positive integer/);
  assert.throws(() => resolveHealthMarkerPath('relative/health.json'), /absolute path/);
});

test('atomic marker writer leaves one complete private marker and no temporary files', async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'bublik-health-marker-'));
  context.after(async () => rm(directory, { recursive: true, force: true }));
  const markerPath = path.join(directory, 'health.json');
  const marker = createHealthMarker(1_750_000_000_000, 42);

  await writeHealthMarkerAtomic(markerPath, marker);

  assert.deepEqual(JSON.parse(await readFile(markerPath, 'utf8')), marker);
  assert.deepEqual(await readdir(directory), ['health.json']);
});

test('heartbeat refreshes only on complete probes, logs transitions once and fences shutdown', async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'bublik-heartbeat-'));
  context.after(async () => rm(directory, { recursive: true, force: true }));
  const markerPath = path.join(directory, 'health.json');
  const scheduler = new MemoryScheduler();
  const logger = new MemoryLogger();
  let now = 1_750_000_000_000;
  let databaseHealthy = true;
  let redisHealthy = true;
  let discordReady = true;
  let databaseCalls = 0;
  let redisCalls = 0;
  const heartbeat = new HealthHeartbeat({
    markerPath,
    intervalMs: 30_000,
    probeTimeoutMs: 100,
    stopTimeoutMs: 100,
    pid: 42,
    now: () => now,
    isDiscordReady: () => discordReady,
    probeDatabase: async () => {
      databaseCalls++;
      if (!databaseHealthy) throw new Error('database unavailable');
    },
    pingRedis: async () => {
      redisCalls++;
      return redisHealthy ? 'PONG' : 'NOT_PONG';
    },
    logger,
    scheduler,
  });

  await writeFile(markerPath, 'stale');
  await heartbeat.clearMarkerBeforeStartup();
  assert.equal(await pathExists(markerPath), false);

  await heartbeat.start();
  assert.deepEqual(scheduler.scheduledOptions, { exclusive: true, immediate: true });
  assert.ok(scheduler.handler);
  const scheduledProbe = scheduler.handler;

  await scheduledProbe();
  const firstMarker = await readFile(markerPath, 'utf8');
  assert.equal(validateHealthMarker(firstMarker, { now, expectedPid: 42 }), true);
  assert.equal(logger.infoMessages.length, 1);
  assert.equal(logger.warnings.length, 0);

  now += 30_000;
  await scheduledProbe();
  assert.equal(logger.infoMessages.length, 1, 'steady healthy probes must not repeat logs');

  databaseHealthy = false;
  now += 30_000;
  const beforeFailure = await readFile(markerPath, 'utf8');
  await scheduledProbe();
  assert.equal(await readFile(markerPath, 'utf8'), beforeFailure, 'failed probe must not refresh marker');
  assert.equal(logger.warnings.length, 1);
  await scheduledProbe();
  assert.equal(logger.warnings.length, 1, 'steady failures must not repeat logs');

  databaseHealthy = true;
  redisHealthy = false;
  await scheduledProbe();
  assert.equal(logger.warnings.length, 1);
  redisHealthy = true;
  await scheduledProbe();
  assert.equal(logger.infoMessages.length, 2, 'recovery must be logged once');

  discordReady = false;
  await scheduledProbe();
  assert.equal(logger.warnings.length, 2);
  assert.ok(databaseCalls >= 5);
  assert.ok(redisCalls >= 5);

  await heartbeat.stop();
  assert.equal(await pathExists(markerPath), false);
  assert.equal(heartbeat.getState().closed, true);
  assert.ok(scheduler.unscheduledName);
  assert.ok(scheduler.drainedPrefix);

  await scheduledProbe();
  assert.equal(await pathExists(markerPath), false, 'late old-generation probe must stay fenced');
  await assert.rejects(() => heartbeat.start(), /cannot restart/);
});

test('shutdown removes readiness even when scheduler drain fails', async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'bublik-heartbeat-stop-'));
  context.after(async () => rm(directory, { recursive: true, force: true }));
  const markerPath = path.join(directory, 'health.json');
  const scheduler = new MemoryScheduler();
  const heartbeat = new HealthHeartbeat({
    markerPath,
    pid: 42,
    isDiscordReady: () => true,
    probeDatabase: async () => undefined,
    pingRedis: async () => 'PONG',
    logger: new MemoryLogger(),
    scheduler,
  });

  await heartbeat.start();
  assert.ok(scheduler.handler);
  await scheduler.handler();
  assert.equal(await pathExists(markerPath), true);

  scheduler.drainError = new Error('scheduler unavailable');
  await assert.rejects(() => heartbeat.stop(), /scheduler unavailable/);
  assert.equal(await pathExists(markerPath), false);
});

test('shutdown invalidates readiness before waiting for a blocked scheduler drain', async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'bublik-heartbeat-drain-'));
  context.after(async () => rm(directory, { recursive: true, force: true }));
  const markerPath = path.join(directory, 'health.json');
  const scheduler = new MemoryScheduler();
  let releaseDrain!: (drained: boolean) => void;
  scheduler.drainGate = new Promise<boolean>((resolve) => { releaseDrain = resolve; });
  const drainStarted = new Promise<void>((resolve) => { scheduler.onDrain = resolve; });
  const heartbeat = new HealthHeartbeat({
    markerPath,
    pid: 42,
    isDiscordReady: () => true,
    probeDatabase: async () => undefined,
    pingRedis: async () => 'PONG',
    logger: new MemoryLogger(),
    scheduler,
  });

  await heartbeat.start();
  assert.ok(scheduler.handler);
  await scheduler.handler();
  assert.equal(await pathExists(markerPath), true);

  const stopping = heartbeat.stop();
  await drainStarted;
  assert.equal(await pathExists(markerPath), false, 'marker must be gone before drain resolves');
  assert.equal(scheduler.drainTimeoutMs, 2_000);

  releaseDrain(true);
  await stopping;
  assert.equal(await pathExists(markerPath), false);
});

test('dependency guard remains held until every dependency probe settles', async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'bublik-heartbeat-pending-'));
  context.after(async () => rm(directory, { recursive: true, force: true }));
  const scheduler = new MemoryScheduler();
  let databaseCalls = 0;
  let redisCalls = 0;
  let releaseRedis!: (value: string) => void;
  const redisResult = new Promise<string>((resolve) => { releaseRedis = resolve; });
  const heartbeat = new HealthHeartbeat({
    markerPath: path.join(directory, 'health.json'),
    pid: 42,
    isDiscordReady: () => true,
    probeDatabase: async () => {
      databaseCalls++;
      throw new Error('database unavailable');
    },
    pingRedis: async () => {
      redisCalls++;
      return redisResult;
    },
    logger: new MemoryLogger(),
    scheduler,
  });

  await heartbeat.start();
  assert.ok(scheduler.handler);
  await scheduler.handler();
  await scheduler.handler();

  assert.equal(databaseCalls, 1);
  assert.equal(redisCalls, 1, 'a hung peer probe must not be started again after fail-fast rejection');

  releaseRedis('PONG');
  await Promise.resolve();
  await heartbeat.stop();
});
