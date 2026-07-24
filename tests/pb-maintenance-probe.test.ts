import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const probe = require('../scripts/verify-pb-idle.js') as {
  parseIsoInstant(value: string): Date;
  parseProbeArguments(argv: string[], options?: { allowFixedTime?: boolean }): { now: Date | null };
  moscowMinuteOfDay(value: Date): number;
  isWithinMaintenanceWindow(value: Date): boolean;
  allowsFixedProbeTime(environment: Record<string, string>): boolean;
  parseLegacyDatabaseTarget(value: string): Record<string, unknown>;
  parseLegacyRedisTarget(value: string): Record<string, unknown>;
  parsePbChannelRows(rows: unknown[]): {
    configCount: number;
    squadCount: number;
    guildIds: readonly string[];
    channels: readonly { guildId: string; channelId: string }[];
  };
  parseRedisScanReply(reply: unknown): { cursor: string; matchCount: number };
  countOccupants(counts: number[]): number;
  formatSuccessCounts(counts: Record<string, number>): string;
};

const GUILD_A = '100000000000000001';
const GUILD_B = '100000000000000002';
const MASTER_A = '200000000000000001';
const RESERVE_A = '200000000000000002';
const SQUAD_A = '200000000000000003';
const AIR_A = '200000000000000004';
const MASTER_B = '200000000000000005';

function validRows(): unknown[] {
  return [
    { guildId: GUILD_A, channelId: MASTER_A, kind: 'master' },
    { guildId: GUILD_A, channelId: RESERVE_A, kind: 'reserve' },
    { guildId: GUILD_A, channelId: SQUAD_A, kind: 'squad_voice' },
    { guildId: GUILD_A, channelId: AIR_A, kind: 'squad_air' },
    { guildId: GUILD_B, channelId: MASTER_B, kind: 'master' },
    { guildId: GUILD_B, channelId: null, kind: 'reserve' },
  ];
}

test('Moscow maintenance window is half-open from 10:15 through 16:15', () => {
  assert.equal(probe.moscowMinuteOfDay(new Date('2026-07-20T07:15:00Z')), 10 * 60 + 15);
  assert.equal(probe.isWithinMaintenanceWindow(new Date('2026-07-20T07:14:59Z')), false);
  assert.equal(probe.isWithinMaintenanceWindow(new Date('2026-07-20T07:15:00Z')), true);
  assert.equal(probe.isWithinMaintenanceWindow(new Date('2026-07-20T13:14:59Z')), true);
  assert.equal(probe.isWithinMaintenanceWindow(new Date('2026-07-20T13:15:00Z')), false);
});

test('--now parser accepts one real zoned instant and otherwise fails closed', () => {
  assert.equal(probe.parseProbeArguments([]).now, null);
  assert.throws(() => probe.parseProbeArguments(['--now', '2026-07-20T10:15:00+03:00']));
  assert.equal(
    probe.parseProbeArguments(
      ['--now', '2026-07-20T10:15:00+03:00'],
      { allowFixedTime: true },
    ).now?.toISOString(),
    '2026-07-20T07:15:00.000Z',
  );
  assert.equal(
    probe.parseProbeArguments(
      ['--now=2026-07-20T07:15:00Z'],
      { allowFixedTime: true },
    ).now?.toISOString(),
    '2026-07-20T07:15:00.000Z',
  );
  assert.throws(() => probe.parseIsoInstant('2026-02-30T10:15:00+03:00'));
  assert.throws(() => probe.parseProbeArguments(['--other', 'value'], { allowFixedTime: true }));
  assert.throws(() => probe.parseProbeArguments(
    ['--now', '2026-07-20T10:15:00'],
    { allowFixedTime: true },
  ));
  assert.equal(probe.allowsFixedProbeTime({
    NODE_ENV: 'test',
    BUBLIK_PB_PROBE_ALLOW_FIXED_TIME: '1',
  }), true);
  assert.equal(probe.allowsFixedProbeTime({
    NODE_ENV: 'production',
    BUBLIK_PB_PROBE_ALLOW_FIXED_TIME: '1',
  }), false);
  assert.equal(probe.allowsFixedProbeTime({ NODE_ENV: 'test' }), false);
});

test('legacy connection parsers accept only audited internal targets and never return secrets', () => {
  const database = probe.parseLegacyDatabaseTarget(
    'postgresql://bublik:secret@postgres:5432/bublik?schema=public',
  );
  assert.deepEqual(database, {
    protocol: 'postgresql',
    host: 'postgres',
    port: 5432,
    database: 'bublik',
    schema: 'public',
    hasCredentials: true,
  });
  assert.equal(JSON.stringify(database).includes('secret'), false);
  assert.deepEqual(probe.parseLegacyRedisTarget('redis://redis:6379'), {
    protocol: 'redis', host: 'redis', port: 6379, database: 0,
  });

  assert.throws(() => probe.parseLegacyDatabaseTarget(
    'postgresql://bublik:secret@localhost:5432/bublik?schema=public',
  ));
  assert.throws(() => probe.parseLegacyDatabaseTarget(
    'postgresql://bublik:secret@postgres:5432/other?schema=public',
  ));
  assert.throws(() => probe.parseLegacyRedisTarget('redis://localhost:6379'));
  assert.throws(() => probe.parseLegacyRedisTarget('redis://redis:6379/1'));
});

test('PB row parser returns a deduplicated catalog and strict counts', () => {
  const catalog = probe.parsePbChannelRows(validRows());
  assert.equal(catalog.configCount, 2);
  assert.equal(catalog.squadCount, 1);
  assert.deepEqual(catalog.guildIds, [GUILD_A, GUILD_B]);
  assert.equal(catalog.channels.length, 5);
  assert.equal(catalog.channels.some((entry) => entry.channelId === MASTER_A), true);
});

test('PB row parser rejects unknown, incomplete, cross-linked and duplicate data', () => {
  assert.throws(() => probe.parsePbChannelRows([]));
  assert.throws(() => probe.parsePbChannelRows([
    { guildId: GUILD_A, channelId: MASTER_A, kind: 'unknown' },
  ]));
  assert.throws(() => probe.parsePbChannelRows(validRows().map((row) => (
    (row as { kind?: string }).kind === 'master' && (row as { guildId?: string }).guildId === GUILD_A
      ? { ...row as object, channelId: null }
      : row
  ))));
  assert.throws(() => probe.parsePbChannelRows([
    ...validRows(),
    { guildId: GUILD_B, channelId: MASTER_A, kind: 'squad_voice' },
    { guildId: GUILD_B, channelId: null, kind: 'squad_air' },
  ]));
  assert.throws(() => probe.parsePbChannelRows([
    ...validRows(),
    { guildId: 'not-a-snowflake', channelId: SQUAD_A, kind: 'squad_voice' },
  ]));
});

test('Redis reply and occupant counters reject malformed or unsafe counts', () => {
  assert.deepEqual(probe.parseRedisScanReply(['0', []]), { cursor: '0', matchCount: 0 });
  assert.deepEqual(probe.parseRedisScanReply(['42', ['opaque']]), { cursor: '42', matchCount: 1 });
  assert.throws(() => probe.parseRedisScanReply(['invalid', []]));
  assert.throws(() => probe.parseRedisScanReply(['0', [42]]));
  assert.equal(probe.countOccupants([0, 0, 0]), 0);
  assert.equal(probe.countOccupants([1, 2, 3]), 6);
  assert.throws(() => probe.countOccupants([0, -1]));
  assert.throws(() => probe.countOccupants([Number.MAX_SAFE_INTEGER, 1]));
});

test('success output contains counts only and Docker image includes the probe', () => {
  const output = probe.formatSuccessCounts({
    configCount: 2,
    squadCount: 1,
    guildCount: 2,
    channelCount: 5,
    redisSessionCount: 0,
    occupantCount: 0,
  });
  assert.match(output, /^PB idle verified: configs=2 squads=1 guilds=2 channels=5 redisSessions=0 occupants=0\.\n$/);
  for (const id of [GUILD_A, GUILD_B, MASTER_A, RESERVE_A, SQUAD_A, AIR_A, MASTER_B]) {
    assert.equal(output.includes(id), false);
  }
  assert.throws(() => probe.formatSuccessCounts({
    configCount: Number(GUILD_A),
    squadCount: 1,
    guildCount: 2,
    channelCount: 5,
    redisSessionCount: 0,
    occupantCount: 0,
  }));

  const dockerfile = readFileSync(path.resolve(__dirname, '..', 'Dockerfile'), 'utf8');
  assert.ok(dockerfile.includes(
    'COPY scripts/verify-pb-idle.js ./scripts/verify-pb-idle.js',
  ));
  assert.ok(dockerfile.includes(
    'COPY scripts/snapshot-redis-data.js ./scripts/snapshot-redis-data.js',
  ));
});
