import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const {
  COMPARISON_FORMAT,
  FINGERPRINT_ALGORITHM,
  KEY_ENCODING,
  SNAPSHOT_CONSISTENCY,
  SNAPSHOT_FORMAT,
  SNAPSHOT_VERSION,
  assertValidSnapshot,
  atomicWritePrivate,
  compareSnapshots,
  createSnapshotFromClient,
  parseArguments,
  parseRedisUrl,
  safeCliErrorMessage,
  scanAllKeys,
  serialize,
  snapshotRedisData,
} = require('../scripts/snapshot-redis-data');

type SnapshotKey = {
  keyBase64: string;
  type: string;
  dumpSha256: string;
  pexpiretimeMs: string | null;
};

function key(value: string | Buffer, overrides: Partial<SnapshotKey> = {}): SnapshotKey {
  return {
    keyBase64: Buffer.from(value).toString('base64'),
    type: 'string',
    dumpSha256: 'a'.repeat(64),
    pexpiretimeMs: null,
    ...overrides,
  };
}

function snapshot(keys: SnapshotKey[] = [], database = 0) {
  return {
    format: SNAPSHOT_FORMAT,
    version: SNAPSHOT_VERSION,
    status: 'ok',
    capturedAt: '2026-07-20T03:00:00.000Z',
    protocol: 'redis',
    database,
    fingerprintAlgorithm: FINGERPRINT_ALGORITHM,
    keyEncoding: KEY_ENCODING,
    consistency: { ...SNAPSHOT_CONSISTENCY },
    keyCount: keys.length,
    keys,
  };
}

test('strict Redis URL parser accepts only unambiguous redis/rediss database paths', () => {
  const implicit = parseRedisUrl('redis://localhost');
  assert.deepEqual({ ...implicit }, { protocol: 'redis', database: 0, databaseExplicit: false });
  assert.equal(implicit.connectionUrl, 'redis://localhost');
  assert.equal(JSON.stringify(implicit).includes('localhost'), false, 'connection URL must stay non-enumerable');

  assert.deepEqual({ ...parseRedisUrl('redis://user:p%40ss@[::1]:6380/') }, {
    protocol: 'redis', database: 0, databaseExplicit: false,
  });
  assert.deepEqual({ ...parseRedisUrl('rediss://cache.example.test/0') }, {
    protocol: 'rediss', database: 0, databaseExplicit: true,
  });
  assert.deepEqual({ ...parseRedisUrl('redis://cache.example.test/12') }, {
    protocol: 'redis', database: 12, databaseExplicit: true,
  });

  for (const invalid of [
    '',
    'http://localhost/0',
    'redis:///0',
    'redis://localhost/foo',
    'redis://localhost/01',
    'redis://localhost/1/',
    'redis://localhost/%31',
    'redis://localhost/0?db=1',
    'redis://localhost/0#fragment',
    'redis://localhost:0/0',
    'redis://local host/0',
  ]) {
    assert.throws(() => parseRedisUrl(invalid), /REDIS_URL/);
  }
});

test('CLI parser requires an explicit exclusive mode and validates expiry tolerance', () => {
  assert.deepEqual(parseArguments(['--snapshot', '--output', 'redis.json']), {
    mode: 'snapshot', output: 'redis.json', before: null, after: null, expiryToleranceMs: 0, expiryGraceMs: 0,
  });
  assert.deepEqual(parseArguments([
    '--compare', 'before.json', 'after.json', '--expiry-tolerance-ms', '25',
    '--expiry-grace-ms', '500', '--output', 'result.json',
  ]), {
    mode: 'compare', output: 'result.json', before: 'before.json', after: 'after.json',
    expiryToleranceMs: 25, expiryGraceMs: 500,
  });
  assert.throws(() => parseArguments([]), /Choose one mode/);
  assert.throws(() => parseArguments(['--snapshot', '--compare', 'a', 'b']), /exactly one mode/);
  assert.throws(() => parseArguments(['--snapshot', '--expiry-tolerance-ms', '1']), /only with --compare/);
  assert.throws(() => parseArguments(['--snapshot', '--expiry-grace-ms', '1']), /only with --compare/);
  assert.throws(() => parseArguments(['--compare', 'a', 'b', '--expiry-tolerance-ms', '-1']), /non-negative/);
  assert.throws(() => parseArguments(['--compare', 'a']), /requires two snapshot/);
  assert.throws(() => parseArguments(['--snapshot', '--output', '-']), /other than/);
  assert.throws(
    () => parseArguments(['--snapshot', 'redis://user:secret@example.test/0']),
    (error: Error) => !error.message.includes('secret') && /Unknown command-line argument/.test(error.message),
  );
});

test('snapshot validator requires canonical binary ordering, metadata and fingerprints', () => {
  const valid = snapshot([
    key(Buffer.alloc(0)),
    key('a', { pexpiretimeMs: '1784515899000' }),
    key(Buffer.from([0xff]), { type: 'hash', dumpSha256: 'b'.repeat(64) }),
  ]);
  assert.equal(assertValidSnapshot(valid), valid);

  const unsorted = structuredClone(valid);
  [unsorted.keys[0], unsorted.keys[1]] = [unsorted.keys[1], unsorted.keys[0]];
  assert.throws(() => assertValidSnapshot(unsorted), /sorted/);

  const duplicate = structuredClone(valid);
  duplicate.keys[1] = structuredClone(duplicate.keys[0]);
  assert.throws(() => assertValidSnapshot(duplicate), /unique and sorted/);

  const malformed = structuredClone(valid);
  malformed.keys[1].dumpSha256 = 'not-a-digest';
  assert.throws(() => assertValidSnapshot(malformed), /DUMP fingerprint/);

  const extraField = structuredClone(valid) as Record<string, unknown>;
  extraField.url = 'redis://must-not-be-accepted';
  assert.throws(() => assertValidSnapshot(extraField), /fields do not match/);
});

test('comparator reports every deterministic key, value, type, database and expiry difference', () => {
  const before = snapshot([
    key('a', { pexpiretimeMs: '1000' }),
    key(Buffer.from([0xff]), { type: 'set', dumpSha256: 'b'.repeat(64) }),
  ], 0);
  const after = snapshot([
    key(Buffer.alloc(0), { dumpSha256: 'c'.repeat(64) }),
    key('a', { type: 'hash', dumpSha256: 'd'.repeat(64), pexpiretimeMs: '1003' }),
  ], 1);

  assert.deepEqual(compareSnapshots(before, after, 2), {
    format: COMPARISON_FORMAT,
    status: 'different',
    expiryToleranceMs: 2,
    expiryGraceMs: 0,
    beforeKeyCount: 2,
    afterKeyCount: 2,
    expectedExpired: [],
    differences: [
      { field: 'database', before: 0, after: 1 },
      { keyBase64: '', field: 'presence', before: 'missing', after: 'present' },
      { keyBase64: Buffer.from('a').toString('base64'), field: 'type', before: 'string', after: 'hash' },
      {
        keyBase64: Buffer.from('a').toString('base64'),
        field: 'dumpSha256', before: 'a'.repeat(64), after: 'd'.repeat(64),
      },
      {
        keyBase64: Buffer.from('a').toString('base64'),
        field: 'pexpiretimeMs', before: '1000', after: '1003', deltaMs: '3',
      },
      {
        keyBase64: Buffer.from([0xff]).toString('base64'),
        field: 'presence', before: 'present', after: 'missing',
      },
    ],
  });

  const withinTolerance = snapshot([key('a', { pexpiretimeMs: '1002' })]);
  assert.equal(compareSnapshots(snapshot([key('a', { pexpiretimeMs: '1000' })]), withinTolerance, 2).status, 'identical');
  assert.equal(compareSnapshots(snapshot([key('a', { pexpiretimeMs: '1000' })]), withinTolerance).status, 'different');

  const persistent = snapshot([key('a')]);
  assert.equal(compareSnapshots(persistent, snapshot([key('a', { pexpiretimeMs: '1000' })]), 10_000).status, 'different');
});

test('comparator allows only expirations due by after capture plus explicit grace', () => {
  const before = snapshot([
    key('expired', { pexpiretimeMs: String(Date.parse('2026-07-20T02:59:59.999Z')) }),
    key('grace', { pexpiretimeMs: String(Date.parse('2026-07-20T03:00:00.250Z')) }),
    key('live', { pexpiretimeMs: String(Date.parse('2026-07-20T03:00:00.251Z')) }),
    key('persistent'),
  ]);
  const after = snapshot([]);
  const result = compareSnapshots(before, after, 0, 250);

  assert.equal(result.status, 'different');
  assert.deepEqual(result.expectedExpired, [
    {
      keyBase64: Buffer.from('expired').toString('base64'),
      expireAtMs: String(Date.parse('2026-07-20T02:59:59.999Z')),
      afterCapturedAt: '2026-07-20T03:00:00.000Z',
    },
    {
      keyBase64: Buffer.from('grace').toString('base64'),
      expireAtMs: String(Date.parse('2026-07-20T03:00:00.250Z')),
      afterCapturedAt: '2026-07-20T03:00:00.000Z',
    },
  ]);
  assert.deepEqual(result.differences, [
    {
      keyBase64: Buffer.from('live').toString('base64'),
      field: 'presence', before: 'present', after: 'missing',
    },
    {
      keyBase64: Buffer.from('persistent').toString('base64'),
      field: 'presence', before: 'present', after: 'missing',
    },
  ]);

  const onlyExpiredBefore = snapshot([key('expired', {
    pexpiretimeMs: String(Date.parse('2026-07-20T02:59:59.999Z')),
  })]);
  const onlyExpiredResult = compareSnapshots(onlyExpiredBefore, after);
  assert.equal(onlyExpiredResult.status, 'identical');
  assert.equal(onlyExpiredResult.expectedExpired.length, 1);
  assert.equal(onlyExpiredResult.differences.length, 0);
});

class FakeRedis {
  readonly keys: Buffer[];
  readonly values: Map<string, { type: string; dump: Buffer; expiry: string }>;
  scanCalls = 0;
  stateCalls = 0;
  mutateDump = false;

  constructor(entries: Array<{ key: Buffer; type?: string; dump?: Buffer; expiry?: string }>) {
    this.keys = entries.map((entry) => Buffer.from(entry.key));
    this.values = new Map(entries.map((entry) => [entry.key.toString('base64'), {
      type: entry.type ?? 'string',
      dump: entry.dump ?? Buffer.from(`dump:${entry.key.toString('base64')}`),
      expiry: entry.expiry ?? '-1',
    }]));
  }

  async scanBuffer() {
    this.scanCalls++;
    return [Buffer.from('0'), [...this.keys].reverse().concat(this.keys[0] ? [this.keys[0]] : [])];
  }

  async type(redisKey: Buffer) {
    this.stateCalls++;
    return this.values.get(redisKey.toString('base64'))?.type ?? 'none';
  }

  async dumpBuffer(redisKey: Buffer) {
    const value = this.values.get(redisKey.toString('base64'));
    if (!value) return null;
    if (!this.mutateDump) return Buffer.from(value.dump);
    return Buffer.concat([value.dump, Buffer.from(String(this.stateCalls))]);
  }

  async callBuffer(_command: string, redisKey: Buffer) {
    return Buffer.from(this.values.get(redisKey.toString('base64'))?.expiry ?? '-2');
  }
}

test('read-only snapshot engine de-duplicates and binary-sorts SCAN while verifying stable state', async () => {
  const redis = new FakeRedis([
    { key: Buffer.from([0xff]), type: 'hash', expiry: '1784515899000' },
    { key: Buffer.alloc(0) },
    { key: Buffer.from('a') },
  ]);
  const scanned = await scanAllKeys(redis);
  assert.deepEqual(scanned, [Buffer.alloc(0), Buffer.from('a'), Buffer.from([0xff])]);

  const result = await createSnapshotFromClient(
    redis,
    { protocol: 'redis', database: 0 },
    () => Date.parse('2026-07-20T03:00:00.000Z'),
  );
  assert.equal(result.keyCount, 3);
  assert.deepEqual(result.keys.map((entry: SnapshotKey) => entry.keyBase64), ['', 'YQ==', '/w==']);
  assert.equal(redis.scanCalls, 4, 'one direct scan plus three snapshot consistency scans');
});

test('snapshot engine fails closed when a key value changes between samples', async () => {
  const redis = new FakeRedis([{ key: Buffer.from('race') }]);
  redis.mutateDump = true;
  await assert.rejects(
    () => createSnapshotFromClient(redis, { protocol: 'redis', database: 0 }),
    /changed during repeated sampling/,
  );
});

test('snapshot engine fails closed when a scanned key disappears', async () => {
  class DisappearingRedis extends FakeRedis {
    override async type(redisKey: Buffer) {
      this.values.delete(redisKey.toString('base64'));
      return 'none';
    }
  }
  const redis = new DisappearingRedis([{ key: Buffer.from('gone') }]);
  await assert.rejects(
    () => createSnapshotFromClient(redis, { protocol: 'redis', database: 0 }),
    /disappeared during snapshot/,
  );
});

test('snapshot engine fails closed when the key catalog changes between SCAN passes', async () => {
  class CatalogRaceRedis extends FakeRedis {
    override async scanBuffer() {
      this.scanCalls++;
      return this.scanCalls === 1
        ? [Buffer.from('0'), [Buffer.from('present')]]
        : [Buffer.from('0'), []];
    }
  }
  const redis = new CatalogRaceRedis([{ key: Buffer.from('present') }]);
  await assert.rejects(
    () => createSnapshotFromClient(redis, { protocol: 'redis', database: 0 }),
    /key catalog changed/,
  );
});

test('atomic private output refuses overwrite and symbolic-link parents', async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'bublik-redis-snapshot-'));
  context.after(async () => rm(directory, { recursive: true, force: true }));
  const output = path.join(directory, 'snapshot.json');
  const content = serialize(snapshot());

  await atomicWritePrivate(output, content);
  assert.equal(await readFile(output, 'utf8'), content);
  if (process.platform !== 'win32') {
    assert.equal((await stat(output)).mode & 0o077, 0);
  }
  await assert.rejects(() => atomicWritePrivate(output, content), /refusing to overwrite/);

  const realParent = path.join(directory, 'real');
  await import('node:fs/promises').then(({ mkdir }) => mkdir(realParent));
  const linkedParent = path.join(directory, 'linked');
  try {
    await symlink(realParent, linkedParent, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EPERM') return;
    throw error;
  }
  await assert.rejects(
    () => atomicWritePrivate(path.join(linkedParent, 'snapshot.json'), content),
    /symbolic links/,
  );
});

test('unexpected errors are redacted instead of echoing Redis URLs or credentials', () => {
  const secret = 'redis://user:super-secret@example.test/0';
  const message = safeCliErrorMessage(new Error(`connection failed for ${secret}`));
  assert.equal(message, 'Redis snapshot utility failed.');
  assert.equal(message.includes(secret), false);
  assert.equal(message.includes('super-secret'), false);
});

const integrationEnabled = process.env.RUN_REDIS_SNAPSHOT_INTEGRATION === '1';
test('optional read-only Redis integration snapshot validates its own contract', {
  skip: integrationEnabled ? false : 'set RUN_REDIS_SNAPSHOT_INTEGRATION=1 with BUBLIK_REDIS_SNAPSHOT_TEST_URL',
}, async () => {
  const redisUrl = process.env.BUBLIK_REDIS_SNAPSHOT_TEST_URL;
  assert.ok(redisUrl, 'BUBLIK_REDIS_SNAPSHOT_TEST_URL is required for the explicit integration run');
  const result = await snapshotRedisData({ redisUrl });
  assert.equal(assertValidSnapshot(result), result);
  assert.equal(compareSnapshots(result, structuredClone(result)).status, 'identical');
});
