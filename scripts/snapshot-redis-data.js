const { createHash, randomUUID } = require('node:crypto');
const {
  chmod,
  link,
  lstat,
  open,
  readFile,
  unlink,
} = require('node:fs/promises');
const path = require('node:path');
const Redis = require('ioredis');

const SNAPSHOT_FORMAT = 'bublik-redis-data-snapshot/v1';
const SNAPSHOT_VERSION = 1;
const COMPARISON_FORMAT = 'bublik-redis-data-comparison/v1';
const FINGERPRINT_ALGORITHM = 'redis-dump-sha256/v1';
const KEY_ENCODING = 'base64';
const MAX_SNAPSHOT_BYTES = 64 * 1024 * 1024;
const SCAN_COUNT = 1_000;
const MAX_SCAN_ITERATIONS = 1_000_000;
const MAX_REDIS_EXPIRE_AT_MS = 9_223_372_036_854_775_807n;
const SNAPSHOT_CONSISTENCY = Object.freeze({
  keyCatalog: 'three complete SCAN passes with identical sorted binary key sets',
  keyState: 'TYPE, binary DUMP, and absolute PEXPIRETIME sampled twice and revalidated after the second SCAN',
  writerStateRequired: 'stopped',
});

class RedisSnapshotError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RedisSnapshotError';
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function compareText(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function safeErrorCode(error) {
  const code = error && typeof error === 'object' ? error.code : null;
  return typeof code === 'string' && /^[A-Z0-9_]{2,32}$/.test(code) ? code : null;
}

function safeCliErrorMessage(error) {
  if (error instanceof RedisSnapshotError) return error.message;
  const code = safeErrorCode(error);
  return `Redis snapshot utility failed${code ? ` (${code})` : ''}.`;
}

function parseRedisUrl(value = process.env.REDIS_URL) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 8_192) {
    throw new RedisSnapshotError('REDIS_URL must be a non-empty redis:// or rediss:// URL.');
  }
  if (/[\u0000-\u0020\u007f]/.test(value)) {
    throw new RedisSnapshotError('REDIS_URL contains forbidden whitespace or control characters.');
  }

  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new RedisSnapshotError('REDIS_URL is not a valid redis:// or rediss:// URL.');
  }
  if (parsed.protocol !== 'redis:' && parsed.protocol !== 'rediss:') {
    throw new RedisSnapshotError('REDIS_URL must use the redis:// or rediss:// protocol.');
  }
  if (!parsed.hostname) throw new RedisSnapshotError('REDIS_URL must include a hostname.');
  if (parsed.search || parsed.hash) {
    throw new RedisSnapshotError('REDIS_URL query strings and fragments are not allowed.');
  }
  if (parsed.port) {
    const port = Number(parsed.port);
    if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
      throw new RedisSnapshotError('REDIS_URL contains an invalid port.');
    }
  }
  try {
    decodeURIComponent(parsed.username);
    decodeURIComponent(parsed.password);
  } catch {
    throw new RedisSnapshotError('REDIS_URL contains invalid credential encoding.');
  }

  let database = 0;
  let databaseExplicit = false;
  if (parsed.pathname !== '' && parsed.pathname !== '/') {
    const match = parsed.pathname.match(/^\/(0|[1-9]\d*)$/);
    if (!match) {
      throw new RedisSnapshotError('REDIS_URL path must be empty, "/", or one explicit non-negative database number.');
    }
    database = Number(match[1]);
    if (!Number.isSafeInteger(database)) {
      throw new RedisSnapshotError('REDIS_URL database number is outside the safe integer range.');
    }
    databaseExplicit = true;
  }

  const result = {
    protocol: parsed.protocol.slice(0, -1),
    database,
    databaseExplicit,
  };
  Object.defineProperty(result, 'connectionUrl', {
    configurable: false,
    enumerable: false,
    writable: false,
    value,
  });
  return Object.freeze(result);
}

function parseNonNegativeSafeInteger(value, option) {
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d*)$/.test(value)) {
    throw new RedisSnapshotError(`${option} must be a non-negative integer.`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new RedisSnapshotError(`${option} is outside the safe integer range.`);
  }
  return parsed;
}

function parseArguments(argv) {
  let mode = null;
  let output = null;
  let before = null;
  let after = null;
  let expiryToleranceMs = 0;
  let expiryGraceMs = 0;
  let toleranceSpecified = false;
  let graceSpecified = false;

  const chooseMode = (nextMode) => {
    if (mode !== null) throw new RedisSnapshotError('Choose exactly one mode: --snapshot or --compare.');
    mode = nextMode;
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--snapshot') {
      chooseMode('snapshot');
    } else if (argument === '--compare') {
      chooseMode('compare');
      before = argv[++index];
      after = argv[++index];
      if (!before || !after || before.startsWith('--') || after.startsWith('--')
        || before === '-' || after === '-') {
        throw new RedisSnapshotError('--compare requires two snapshot JSON file paths.');
      }
    } else if (argument === '--output') {
      if (output !== null) throw new RedisSnapshotError('--output may be supplied only once.');
      output = argv[++index];
      if (!output || output.startsWith('--') || output === '-') {
        throw new RedisSnapshotError('--output requires a file path other than "-". Omit it to use stdout.');
      }
    } else if (argument === '--expiry-tolerance-ms') {
      if (toleranceSpecified) {
        throw new RedisSnapshotError('--expiry-tolerance-ms may be supplied only once.');
      }
      toleranceSpecified = true;
      expiryToleranceMs = parseNonNegativeSafeInteger(argv[++index], '--expiry-tolerance-ms');
    } else if (argument === '--expiry-grace-ms') {
      if (graceSpecified) {
        throw new RedisSnapshotError('--expiry-grace-ms may be supplied only once.');
      }
      graceSpecified = true;
      expiryGraceMs = parseNonNegativeSafeInteger(argv[++index], '--expiry-grace-ms');
    } else if (argument === '--help' || argument === '-h') {
      chooseMode('help');
    } else {
      throw new RedisSnapshotError('Unknown command-line argument.');
    }
  }

  if (mode === null) throw new RedisSnapshotError('Choose one mode: --snapshot or --compare.');
  if (mode !== 'compare' && (toleranceSpecified || graceSpecified)) {
    throw new RedisSnapshotError('Expiry tolerance and grace options are valid only with --compare.');
  }
  if (mode === 'help' && (output !== null || toleranceSpecified || graceSpecified)) {
    throw new RedisSnapshotError('--help cannot be combined with output or comparison options.');
  }
  return { mode, output, before, after, expiryToleranceMs, expiryGraceMs };
}

function canonicalBase64(value) {
  if (typeof value !== 'string') return null;
  const decoded = Buffer.from(value, 'base64');
  return decoded.toString('base64') === value ? decoded : null;
}

function assertExactFields(value, expected, description) {
  const actual = Object.keys(value).sort(compareText);
  const wanted = [...expected].sort(compareText);
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    throw new RedisSnapshotError(`${description} fields do not match the ${SNAPSHOT_FORMAT} contract.`);
  }
}

function assertIsoTimestamp(value) {
  if (typeof value !== 'string') return false;
  const timestamp = new Date(value);
  return !Number.isNaN(timestamp.getTime()) && timestamp.toISOString() === value;
}

function assertValidExpireAt(value, keyBase64) {
  if (value === null) return;
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d*)$/.test(value)) {
    throw new RedisSnapshotError(`Snapshot contains an invalid PEXPIRETIME for key ${keyBase64}.`);
  }
  if (BigInt(value) > MAX_REDIS_EXPIRE_AT_MS) {
    throw new RedisSnapshotError(`Snapshot PEXPIRETIME exceeds the Redis signed 64-bit range for key ${keyBase64}.`);
  }
}

function assertValidSnapshot(input) {
  if (!isPlainObject(input)) throw new RedisSnapshotError('Redis snapshot JSON must be an object.');
  assertExactFields(input, [
    'capturedAt',
    'consistency',
    'database',
    'fingerprintAlgorithm',
    'format',
    'keyCount',
    'keyEncoding',
    'keys',
    'protocol',
    'status',
    'version',
  ], 'Redis snapshot');
  if (input.format !== SNAPSHOT_FORMAT || input.version !== SNAPSHOT_VERSION || input.status !== 'ok') {
    throw new RedisSnapshotError(`Snapshot must use ${SNAPSHOT_FORMAT} version ${SNAPSHOT_VERSION} with status "ok".`);
  }
  if (input.fingerprintAlgorithm !== FINGERPRINT_ALGORITHM || input.keyEncoding !== KEY_ENCODING) {
    throw new RedisSnapshotError('Snapshot fingerprint or key encoding contract differs.');
  }
  if (input.protocol !== 'redis' && input.protocol !== 'rediss') {
    throw new RedisSnapshotError('Snapshot contains an invalid Redis protocol.');
  }
  if (!Number.isSafeInteger(input.database) || input.database < 0) {
    throw new RedisSnapshotError('Snapshot contains an invalid Redis database number.');
  }
  if (!assertIsoTimestamp(input.capturedAt)) {
    throw new RedisSnapshotError('Snapshot contains an invalid capturedAt timestamp.');
  }
  if (JSON.stringify(input.consistency) !== JSON.stringify(SNAPSHOT_CONSISTENCY)) {
    throw new RedisSnapshotError('Snapshot consistency metadata differs from the required contract.');
  }
  if (!Number.isSafeInteger(input.keyCount) || input.keyCount < 0
    || !Array.isArray(input.keys) || input.keys.length !== input.keyCount) {
    throw new RedisSnapshotError('Snapshot keyCount does not match its key catalog.');
  }

  let previousKey = null;
  for (const entry of input.keys) {
    if (!isPlainObject(entry)) throw new RedisSnapshotError('Snapshot key entries must be objects.');
    assertExactFields(entry, ['dumpSha256', 'keyBase64', 'pexpiretimeMs', 'type'], 'Redis key entry');
    const key = canonicalBase64(entry.keyBase64);
    if (!key) throw new RedisSnapshotError('Snapshot contains a non-canonical base64 Redis key.');
    if (previousKey && Buffer.compare(previousKey, key) >= 0) {
      throw new RedisSnapshotError('Snapshot Redis keys must be unique and sorted by their binary representation.');
    }
    previousKey = key;
    if (typeof entry.type !== 'string' || entry.type === 'none'
      || !/^[A-Za-z0-9_.:-]{1,128}$/.test(entry.type)) {
      throw new RedisSnapshotError(`Snapshot contains an invalid Redis type for key ${entry.keyBase64}.`);
    }
    if (typeof entry.dumpSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(entry.dumpSha256)) {
      throw new RedisSnapshotError(`Snapshot contains an invalid DUMP fingerprint for key ${entry.keyBase64}.`);
    }
    assertValidExpireAt(entry.pexpiretimeMs, entry.keyBase64);
  }
  return input;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function parseRedisIntegerReply(value, command) {
  let text;
  if (Buffer.isBuffer(value)) text = value.toString('ascii');
  else if (typeof value === 'number' || typeof value === 'string') text = String(value);
  else throw new RedisSnapshotError(`Redis ${command} returned an invalid integer reply.`);
  if (!/^-?(?:0|[1-9]\d*)$/.test(text)) {
    throw new RedisSnapshotError(`Redis ${command} returned an invalid integer reply.`);
  }
  return BigInt(text);
}

function keyReference(key) {
  return key.toString('base64');
}

async function scanAllKeys(redis) {
  let cursor = '0';
  let iterations = 0;
  const observedCursors = new Set();
  const keys = new Map();
  do {
    let reply;
    try {
      reply = await redis.scanBuffer(cursor, 'COUNT', SCAN_COUNT);
    } catch (error) {
      const code = safeErrorCode(error);
      throw new RedisSnapshotError(`Redis SCAN failed${code ? ` (${code})` : ''}.`);
    }
    if (!Array.isArray(reply) || reply.length !== 2 || !Array.isArray(reply[1])) {
      throw new RedisSnapshotError('Redis SCAN returned an invalid response.');
    }
    const nextCursor = Buffer.isBuffer(reply[0]) ? reply[0].toString('ascii') : String(reply[0]);
    if (!/^(?:0|[1-9]\d*)$/.test(nextCursor)) {
      throw new RedisSnapshotError('Redis SCAN returned an invalid cursor.');
    }
    if (nextCursor !== '0' && observedCursors.has(nextCursor)) {
      throw new RedisSnapshotError('Redis SCAN repeated a non-zero cursor.');
    }
    if (nextCursor !== '0') observedCursors.add(nextCursor);
    for (const key of reply[1]) {
      if (!Buffer.isBuffer(key)) throw new RedisSnapshotError('Redis SCAN did not return binary keys.');
      keys.set(key.toString('base64'), Buffer.from(key));
    }
    cursor = nextCursor;
    iterations += 1;
    if (iterations > MAX_SCAN_ITERATIONS) {
      throw new RedisSnapshotError('Redis SCAN exceeded the safety iteration limit.');
    }
  } while (cursor !== '0');
  return [...keys.values()].sort(Buffer.compare);
}

function assertSameKeyCatalog(expected, actual, phase) {
  if (expected.length === actual.length
    && expected.every((key, index) => key.equals(actual[index]))) return;
  let index = 0;
  while (index < expected.length && index < actual.length && expected[index].equals(actual[index])) index += 1;
  const before = index < expected.length ? keyReference(expected[index]) : '<end>';
  const after = index < actual.length ? keyReference(actual[index]) : '<end>';
  throw new RedisSnapshotError(
    `Redis key catalog changed during ${phase}: index ${index}, before=${before}, after=${after}.`,
  );
}

async function readKeyState(redis, key) {
  const reference = keyReference(key);
  let type;
  let dump;
  let expiryReply;
  try {
    type = await redis.type(key);
    dump = await redis.dumpBuffer(key);
    expiryReply = await redis.callBuffer('PEXPIRETIME', key);
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    if (/unknown command/i.test(message) && /pexpiretime/i.test(message)) {
      throw new RedisSnapshotError('Redis 7 or newer with PEXPIRETIME support is required.');
    }
    const code = safeErrorCode(error);
    throw new RedisSnapshotError(`Redis key inspection failed${code ? ` (${code})` : ''} for key ${reference}.`);
  }
  const expiry = parseRedisIntegerReply(expiryReply, 'PEXPIRETIME');
  if (type === 'none' || dump === null || expiry === -2n) {
    throw new RedisSnapshotError(`Redis key disappeared during snapshot: ${reference}.`);
  }
  if (typeof type !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(type)) {
    throw new RedisSnapshotError(`Redis TYPE returned an invalid value for key ${reference}.`);
  }
  if (!Buffer.isBuffer(dump)) {
    throw new RedisSnapshotError(`Redis DUMP returned an invalid binary value for key ${reference}.`);
  }
  let pexpiretimeMs;
  if (expiry === -1n) pexpiretimeMs = null;
  else if (expiry >= 0n && expiry <= MAX_REDIS_EXPIRE_AT_MS) pexpiretimeMs = expiry.toString();
  else throw new RedisSnapshotError(`Redis PEXPIRETIME returned an invalid value for key ${reference}.`);
  return {
    keyBase64: reference,
    type,
    dumpSha256: sha256(dump),
    pexpiretimeMs,
  };
}

function sameKeyState(left, right) {
  return left.keyBase64 === right.keyBase64
    && left.type === right.type
    && left.dumpSha256 === right.dumpSha256
    && left.pexpiretimeMs === right.pexpiretimeMs;
}

async function createSnapshotFromClient(redis, connection, now = Date.now) {
  if (!connection || (connection.protocol !== 'redis' && connection.protocol !== 'rediss')
    || !Number.isSafeInteger(connection.database) || connection.database < 0) {
    throw new RedisSnapshotError('Redis snapshot connection metadata is invalid.');
  }
  const initialKeys = await scanAllKeys(redis);
  const entries = [];
  for (const key of initialKeys) {
    const first = await readKeyState(redis, key);
    const second = await readKeyState(redis, key);
    if (!sameKeyState(first, second)) {
      throw new RedisSnapshotError(`Redis key changed during repeated sampling: ${keyReference(key)}.`);
    }
    entries.push(first);
  }

  const verificationKeys = await scanAllKeys(redis);
  assertSameKeyCatalog(initialKeys, verificationKeys, 'the second SCAN pass');
  for (let index = 0; index < initialKeys.length; index += 1) {
    const finalState = await readKeyState(redis, initialKeys[index]);
    if (!sameKeyState(entries[index], finalState)) {
      throw new RedisSnapshotError(`Redis key changed during final verification: ${keyReference(initialKeys[index])}.`);
    }
  }
  const finalKeys = await scanAllKeys(redis);
  assertSameKeyCatalog(initialKeys, finalKeys, 'the final SCAN pass');

  const capturedAt = new Date(now()).toISOString();
  const snapshot = {
    format: SNAPSHOT_FORMAT,
    version: SNAPSHOT_VERSION,
    status: 'ok',
    capturedAt,
    protocol: connection.protocol,
    database: connection.database,
    fingerprintAlgorithm: FINGERPRINT_ALGORITHM,
    keyEncoding: KEY_ENCODING,
    consistency: { ...SNAPSHOT_CONSISTENCY },
    keyCount: entries.length,
    keys: entries,
  };
  return assertValidSnapshot(snapshot);
}

async function snapshotRedisData(options = {}) {
  const connection = parseRedisUrl(options.redisUrl ?? process.env.REDIS_URL);
  const RedisConstructor = options.RedisConstructor ?? Redis;
  let redis;
  try {
    redis = new RedisConstructor(connection.connectionUrl, {
      lazyConnect: true,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
      connectTimeout: 5_000,
      commandTimeout: 10_000,
      disableClientInfo: true,
      retryStrategy: () => null,
      reconnectOnError: () => false,
      autoResubscribe: false,
      autoResendUnfulfilledCommands: false,
    });
    if (typeof redis.on === 'function') redis.on('error', () => {});
    await redis.connect();
    return await createSnapshotFromClient(redis, connection, options.now ?? Date.now);
  } catch (error) {
    if (error instanceof RedisSnapshotError) throw error;
    const code = safeErrorCode(error);
    throw new RedisSnapshotError(`Redis snapshot failed${code ? ` (${code})` : ''}.`);
  } finally {
    if (redis && typeof redis.disconnect === 'function') {
      try { redis.disconnect(false); } catch { /* best-effort socket close; never issue QUIT */ }
    }
  }
}

function compareSnapshots(beforeInput, afterInput, expiryToleranceMs = 0, expiryGraceMs = 0) {
  const before = assertValidSnapshot(beforeInput);
  const after = assertValidSnapshot(afterInput);
  if (!Number.isSafeInteger(expiryToleranceMs) || expiryToleranceMs < 0) {
    throw new RedisSnapshotError('Expiry tolerance must be a non-negative safe integer.');
  }
  if (!Number.isSafeInteger(expiryGraceMs) || expiryGraceMs < 0) {
    throw new RedisSnapshotError('Expiry grace must be a non-negative safe integer.');
  }
  const differences = [];
  const expectedExpired = [];
  if (before.database !== after.database) {
    differences.push({ field: 'database', before: before.database, after: after.database });
  }

  const beforeByKey = new Map(before.keys.map((entry) => [entry.keyBase64, entry]));
  const afterByKey = new Map(after.keys.map((entry) => [entry.keyBase64, entry]));
  const keyCatalog = [...new Set([...beforeByKey.keys(), ...afterByKey.keys()])]
    .sort((left, right) => Buffer.compare(Buffer.from(left, 'base64'), Buffer.from(right, 'base64')));
  const tolerance = BigInt(expiryToleranceMs);
  for (const keyBase64 of keyCatalog) {
    const beforeEntry = beforeByKey.get(keyBase64);
    const afterEntry = afterByKey.get(keyBase64);
    if (!beforeEntry || !afterEntry) {
      if (beforeEntry && !afterEntry && beforeEntry.pexpiretimeMs !== null) {
        const expiryBoundary = BigInt(new Date(after.capturedAt).getTime()) + BigInt(expiryGraceMs);
        if (BigInt(beforeEntry.pexpiretimeMs) <= expiryBoundary) {
          expectedExpired.push({
            keyBase64,
            expireAtMs: beforeEntry.pexpiretimeMs,
            afterCapturedAt: after.capturedAt,
          });
          continue;
        }
      }
      differences.push({
        keyBase64,
        field: 'presence',
        before: beforeEntry ? 'present' : 'missing',
        after: afterEntry ? 'present' : 'missing',
      });
      continue;
    }
    if (beforeEntry.type !== afterEntry.type) {
      differences.push({ keyBase64, field: 'type', before: beforeEntry.type, after: afterEntry.type });
    }
    if (beforeEntry.dumpSha256 !== afterEntry.dumpSha256) {
      differences.push({
        keyBase64,
        field: 'dumpSha256',
        before: beforeEntry.dumpSha256,
        after: afterEntry.dumpSha256,
      });
    }
    if (beforeEntry.pexpiretimeMs === afterEntry.pexpiretimeMs) continue;
    if (beforeEntry.pexpiretimeMs === null || afterEntry.pexpiretimeMs === null) {
      differences.push({
        keyBase64,
        field: 'pexpiretimeMs',
        before: beforeEntry.pexpiretimeMs,
        after: afterEntry.pexpiretimeMs,
        deltaMs: null,
      });
      continue;
    }
    const beforeExpiry = BigInt(beforeEntry.pexpiretimeMs);
    const afterExpiry = BigInt(afterEntry.pexpiretimeMs);
    const delta = beforeExpiry >= afterExpiry ? beforeExpiry - afterExpiry : afterExpiry - beforeExpiry;
    if (delta > tolerance) {
      differences.push({
        keyBase64,
        field: 'pexpiretimeMs',
        before: beforeEntry.pexpiretimeMs,
        after: afterEntry.pexpiretimeMs,
        deltaMs: delta.toString(),
      });
    }
  }

  return {
    format: COMPARISON_FORMAT,
    status: differences.length ? 'different' : 'identical',
    expiryToleranceMs,
    expiryGraceMs,
    beforeKeyCount: before.keyCount,
    afterKeyCount: after.keyCount,
    expectedExpired,
    differences,
  };
}

function serialize(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

async function assertNoSymlinkParents(absolutePath) {
  const parent = path.dirname(absolutePath);
  const root = path.parse(parent).root;
  const relative = parent.slice(root.length);
  const parts = relative.split(path.sep).filter(Boolean);
  let current = root;
  for (const part of parts) {
    current = path.join(current, part);
    let stat;
    try {
      stat = await lstat(current);
    } catch (error) {
      if (error && error.code === 'ENOENT') {
        throw new RedisSnapshotError('Snapshot path parent directory does not exist.');
      }
      throw new RedisSnapshotError('Cannot validate the snapshot path.');
    }
    if (stat.isSymbolicLink()) throw new RedisSnapshotError('Snapshot paths may not traverse symbolic links.');
    if (!stat.isDirectory()) throw new RedisSnapshotError('Snapshot path parent components must be directories.');
  }
}

async function atomicWritePrivate(output, content) {
  if (typeof output !== 'string' || output.length === 0 || output.includes('\0')) {
    throw new RedisSnapshotError('Snapshot output path is invalid.');
  }
  const target = path.resolve(output);
  await assertNoSymlinkParents(target);
  try {
    const existing = await lstat(target);
    if (existing.isSymbolicLink()) throw new RedisSnapshotError('Snapshot output may not be a symbolic link.');
    throw new RedisSnapshotError('Snapshot output already exists; refusing to overwrite it.');
  } catch (error) {
    if (error instanceof RedisSnapshotError) throw error;
    if (!error || error.code !== 'ENOENT') throw new RedisSnapshotError('Cannot validate the snapshot output path.');
  }

  const temporary = path.join(
    path.dirname(target),
    `.${path.basename(target)}.${process.pid}.${randomUUID()}.tmp`,
  );
  let handle;
  let published = false;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(content, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    await assertNoSymlinkParents(target);
    await link(temporary, target);
    published = true;
    await chmod(target, 0o600);
    const stat = await lstat(target);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new RedisSnapshotError('Published snapshot output is not a regular private file.');
    }
    await unlink(temporary);
    return target;
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    await unlink(temporary).catch(() => {});
    if (published) await unlink(target).catch(() => {});
    if (error instanceof RedisSnapshotError) throw error;
    const code = safeErrorCode(error);
    throw new RedisSnapshotError(`Atomic snapshot output failed${code ? ` (${code})` : ''}.`);
  }
}

async function assertRegularSnapshotInput(input) {
  if (typeof input !== 'string' || input.length === 0 || input.includes('\0')) {
    throw new RedisSnapshotError('Snapshot input path is invalid.');
  }
  const absolute = path.resolve(input);
  await assertNoSymlinkParents(absolute);
  let stat;
  try {
    stat = await lstat(absolute);
  } catch {
    throw new RedisSnapshotError('Cannot read snapshot input file.');
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new RedisSnapshotError('Snapshot input must be a regular file, not a symbolic link.');
  }
  if (stat.size <= 0 || stat.size > MAX_SNAPSHOT_BYTES) {
    throw new RedisSnapshotError('Snapshot input size is outside the allowed range.');
  }
  return absolute;
}

async function readSnapshotFile(input) {
  const absolute = await assertRegularSnapshotInput(input);
  let parsed;
  try {
    parsed = JSON.parse(await readFile(absolute, 'utf8'));
  } catch {
    throw new RedisSnapshotError('Snapshot input is not valid JSON.');
  }
  return assertValidSnapshot(parsed);
}

async function writeResult(value, output) {
  const content = serialize(value);
  if (output) await atomicWritePrivate(output, content);
  else process.stdout.write(content);
}

function printHelp() {
  process.stdout.write([
    'Usage:',
    '  node scripts/snapshot-redis-data.js --snapshot [--output snapshot.json]',
    '  node scripts/snapshot-redis-data.js --compare before.json after.json',
    '    [--expiry-tolerance-ms 0] [--expiry-grace-ms 0] [--output comparison.json]',
    '',
    'Safety:',
    '  Snapshot commands are SCAN, TYPE, DUMP, and Redis 7 PEXPIRETIME only.',
    '  Stop every Redis writer before both snapshots; live changes fail closed.',
    '',
  ].join('\n'));
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  if (options.mode === 'help') {
    printHelp();
    return 0;
  }
  if (options.mode === 'compare') {
    const comparison = compareSnapshots(
      await readSnapshotFile(options.before),
      await readSnapshotFile(options.after),
      options.expiryToleranceMs,
      options.expiryGraceMs,
    );
    await writeResult(comparison, options.output);
    return comparison.status === 'identical' ? 0 : 1;
  }
  const snapshot = await snapshotRedisData();
  await writeResult(snapshot, options.output);
  return 0;
}

if (require.main === module) {
  main()
    .then((exitCode) => { process.exitCode = exitCode; })
    .catch((error) => {
      console.error(safeCliErrorMessage(error));
      process.exitCode = 1;
    });
}

module.exports = {
  COMPARISON_FORMAT,
  FINGERPRINT_ALGORITHM,
  KEY_ENCODING,
  RedisSnapshotError,
  SNAPSHOT_CONSISTENCY,
  SNAPSHOT_FORMAT,
  SNAPSHOT_VERSION,
  assertSameKeyCatalog,
  assertValidSnapshot,
  atomicWritePrivate,
  compareSnapshots,
  createSnapshotFromClient,
  parseArguments,
  parseRedisUrl,
  readKeyState,
  readSnapshotFile,
  safeCliErrorMessage,
  scanAllKeys,
  serialize,
  snapshotRedisData,
};
