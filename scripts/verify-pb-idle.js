'use strict';

const MAINTENANCE_TIME_ZONE = 'Europe/Moscow';
const MAINTENANCE_START_MINUTE = 10 * 60 + 15;
const MAINTENANCE_END_MINUTE = 16 * 60 + 15;
const REDIS_SESSION_PATTERN = 'rb:voice:session:*';
const EXTERNAL_TIMEOUT_MS = 10_000;
const DISCORD_READY_TIMEOUT_MS = 15_000;
const CLEANUP_TIMEOUT_MS = 5_000;
const MAX_SCAN_ITERATIONS = 100_000;
const SNOWFLAKE_PATTERN = /^[1-9][0-9]{16,19}$/;
const ISO_INSTANT_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|([+-])(\d{2}):(\d{2}))$/;
const CHANNEL_KINDS = new Set(['master', 'reserve', 'squad_voice', 'squad_air']);

class MaintenanceProbeError extends Error {
  constructor(message) {
    super(message);
    this.name = 'MaintenanceProbeError';
  }
}

function fail(message) {
  throw new MaintenanceProbeError(message);
}

function parseIsoInstant(value) {
  if (typeof value !== 'string') fail('Maintenance time must be a zoned ISO instant.');
  const match = ISO_INSTANT_PATTERN.exec(value);
  if (!match) fail('Maintenance time must be a zoned ISO instant.');

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const millisecond = Number((match[7] ?? '').padEnd(3, '0'));
  const offsetHour = match[8] === 'Z' ? 0 : Number(match[10]);
  const offsetMinute = match[8] === 'Z' ? 0 : Number(match[11]);
  if (year < 2000 || month < 1 || month > 12 || day < 1 || day > 31 ||
      hour > 23 || minute > 59 || second > 59 || offsetHour > 14 || offsetMinute > 59 ||
      (offsetHour === 14 && offsetMinute !== 0)) {
    fail('Maintenance time is outside the supported range.');
  }

  const unsignedOffset = offsetHour * 60 + offsetMinute;
  const offset = match[8] === 'Z' || match[9] === '+' ? unsignedOffset : -unsignedOffset;
  const wallClock = Date.UTC(year, month - 1, day, hour, minute, second, millisecond);
  const verification = new Date(wallClock);
  if (verification.getUTCFullYear() !== year || verification.getUTCMonth() !== month - 1 ||
      verification.getUTCDate() !== day || verification.getUTCHours() !== hour ||
      verification.getUTCMinutes() !== minute || verification.getUTCSeconds() !== second ||
      verification.getUTCMilliseconds() !== millisecond) {
    fail('Maintenance time is not a real calendar instant.');
  }

  const instant = new Date(wallClock - offset * 60_000);
  if (!Number.isFinite(instant.getTime())) fail('Maintenance time is invalid.');
  return instant;
}

function parseProbeArguments(argv, options = {}) {
  if (!Array.isArray(argv)) fail('Probe arguments are invalid.');
  if (argv.length === 0) return { now: null };
  if (!options || options.allowFixedTime !== true) {
    fail('Fixed maintenance time is available only to tests.');
  }
  if (argv.length === 1 && typeof argv[0] === 'string' && argv[0].startsWith('--now=')) {
    return { now: parseIsoInstant(argv[0].slice('--now='.length)) };
  }
  if (argv.length === 2 && argv[0] === '--now') {
    return { now: parseIsoInstant(argv[1]) };
  }
  fail('Only one optional --now argument is supported.');
}

function moscowMinuteOfDay(value) {
  const instant = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(instant.getTime())) fail('Maintenance time is invalid.');
  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone: MAINTENANCE_TIME_ZONE,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  const parts = Object.fromEntries(
    formatter.formatToParts(instant)
      .filter((part) => part.type === 'hour' || part.type === 'minute')
      .map((part) => [part.type, Number(part.value)]),
  );
  if (!Number.isInteger(parts.hour) || !Number.isInteger(parts.minute)) {
    fail('Maintenance timezone conversion failed.');
  }
  return parts.hour * 60 + parts.minute;
}

function isWithinMaintenanceWindow(value) {
  const minute = moscowMinuteOfDay(value);
  return minute >= MAINTENANCE_START_MINUTE && minute < MAINTENANCE_END_MINUTE;
}

function allowsFixedProbeTime(environment) {
  return Boolean(environment && environment.NODE_ENV === 'test' &&
    environment.BUBLIK_PB_PROBE_ALLOW_FIXED_TIME === '1');
}

function assertMaintenanceWindow(value) {
  if (!isWithinMaintenanceWindow(value)) {
    fail('PB maintenance is outside the permitted window.');
  }
}

function parseLegacyDatabaseTarget(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4_096 || /[\s\0]/.test(value)) {
    fail('Legacy PostgreSQL target is invalid.');
  }
  let target;
  try {
    target = new URL(value);
  } catch {
    fail('Legacy PostgreSQL target is invalid.');
  }
  const query = [...target.searchParams.entries()];
  if (target.protocol !== 'postgresql:' || target.username !== 'bublik' || !target.password ||
      target.hostname !== 'postgres' || target.port !== '5432' || target.pathname !== '/bublik' ||
      target.hash !== '' || query.length !== 1 || query[0][0] !== 'schema' || query[0][1] !== 'public') {
    fail('Legacy PostgreSQL target does not match the audited deployment.');
  }
  return Object.freeze({
    protocol: 'postgresql',
    host: 'postgres',
    port: 5432,
    database: 'bublik',
    schema: 'public',
    hasCredentials: true,
  });
}

function parseLegacyRedisTarget(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4_096 || /[\s\0]/.test(value)) {
    fail('Legacy Redis target is invalid.');
  }
  let target;
  try {
    target = new URL(value);
  } catch {
    fail('Legacy Redis target is invalid.');
  }
  if (target.protocol !== 'redis:' || target.username || target.password || target.hostname !== 'redis' ||
      target.port !== '6379' || target.pathname !== '' || target.search !== '' || target.hash !== '') {
    fail('Legacy Redis target does not match the audited deployment.');
  }
  return Object.freeze({ protocol: 'redis', host: 'redis', port: 6379, database: 0 });
}

function isSnowflake(value) {
  return typeof value === 'string' && SNOWFLAKE_PATTERN.test(value);
}

function parsePbChannelRows(rows) {
  if (!Array.isArray(rows) || rows.length === 0) fail('PB channel catalog is empty.');
  const guilds = new Map();
  const channelOwners = new Map();
  let configCount = 0;
  let squadCount = 0;

  for (const row of rows) {
    if (!row || typeof row !== 'object' || Array.isArray(row) ||
        !isSnowflake(row.guildId) || !CHANNEL_KINDS.has(row.kind) ||
        !(row.channelId === null || isSnowflake(row.channelId))) {
      fail('PB channel catalog contains an invalid row.');
    }
    const required = row.kind === 'master' || row.kind === 'squad_voice';
    if (required && row.channelId === null) fail('PB channel catalog is incomplete.');

    const state = guilds.get(row.guildId) ?? {
      guildId: row.guildId,
      master: 0,
      reserve: 0,
      squadVoice: 0,
      squadAir: 0,
    };
    if (row.kind === 'master') {
      state.master++;
      configCount++;
    } else if (row.kind === 'reserve') {
      state.reserve++;
    } else if (row.kind === 'squad_voice') {
      state.squadVoice++;
      squadCount++;
    } else {
      state.squadAir++;
    }
    guilds.set(row.guildId, state);

    if (row.channelId !== null) {
      if (channelOwners.has(row.channelId)) fail('PB channel catalog contains a duplicate channel.');
      channelOwners.set(row.channelId, row.guildId);
    }
  }

  for (const state of guilds.values()) {
    if (state.master !== 1 || state.reserve !== 1 || state.squadVoice !== state.squadAir) {
      fail('PB channel catalog is structurally incomplete.');
    }
  }
  if (configCount === 0 || channelOwners.size === 0) fail('PB channel catalog is empty.');

  const channels = [...channelOwners.entries()]
    .map(([channelId, guildId]) => ({ guildId, channelId }))
    .sort((left, right) => left.guildId.localeCompare(right.guildId) ||
      left.channelId.localeCompare(right.channelId));
  return Object.freeze({
    configCount,
    squadCount,
    guildIds: Object.freeze([...guilds.keys()].sort()),
    channels: Object.freeze(channels),
  });
}

function parseRedisScanReply(reply) {
  if (!Array.isArray(reply) || reply.length !== 2 || typeof reply[0] !== 'string' ||
      !/^(0|[1-9][0-9]*)$/.test(reply[0]) || !Array.isArray(reply[1]) ||
      reply[1].some((key) => typeof key !== 'string')) {
    fail('Redis SCAN returned an invalid response.');
  }
  return { cursor: reply[0], matchCount: reply[1].length };
}

function countOccupants(counts) {
  if (!Array.isArray(counts)) fail('Discord occupant counts are invalid.');
  let total = 0;
  for (const count of counts) {
    if (!Number.isSafeInteger(count) || count < 0) fail('Discord occupant counts are invalid.');
    total += count;
    if (!Number.isSafeInteger(total)) fail('Discord occupant count overflowed.');
  }
  return total;
}

async function withTimeout(promise, timeoutMs, message) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new MaintenanceProbeError(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function requireSecret(value, name) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4_096 || /[\s\0]/.test(value)) {
    fail(`${name} is unavailable.`);
  }
  return value;
}

function buildProbeDatabaseUrl(databaseUrl) {
  const target = new URL(databaseUrl);
  target.searchParams.set('connection_limit', '1');
  target.searchParams.set('connect_timeout', '5');
  target.searchParams.set('pool_timeout', '5');
  return target.toString();
}

async function loadPbChannelCatalog(databaseUrl) {
  const { PrismaClient } = require('@prisma/client');
  const prisma = new PrismaClient({
    datasources: { db: { url: buildProbeDatabaseUrl(databaseUrl) } },
    errorFormat: 'minimal',
    log: [],
  });
  let result;
  let failure = null;
  try {
    await withTimeout(prisma.$connect(), EXTERNAL_TIMEOUT_MS, 'PostgreSQL connection timed out.');
    const rows = await withTimeout(prisma.$transaction(async (transaction) => {
      await transaction.$executeRaw`SET TRANSACTION READ ONLY`;
      return transaction.$queryRaw`
        SELECT config."guildId" AS "guildId",
               config."masterChannelId" AS "channelId",
               ${'master'}::text AS "kind"
          FROM "regbattle_configs" AS config
        UNION ALL
        SELECT config."guildId", config."reserveChannelId", ${'reserve'}::text
          FROM "regbattle_configs" AS config
        UNION ALL
        SELECT squad."guildId", squad."voiceChannelId", ${'squad_voice'}::text
          FROM "regbattle_squads" AS squad
        UNION ALL
        SELECT squad."guildId", squad."airChannelId", ${'squad_air'}::text
          FROM "regbattle_squads" AS squad
      `;
    }, { maxWait: 2_000, timeout: EXTERNAL_TIMEOUT_MS }), EXTERNAL_TIMEOUT_MS + 1_000,
    'PostgreSQL PB query timed out.');
    result = parsePbChannelRows(rows);
  } catch {
    failure = new MaintenanceProbeError('PostgreSQL PB verification failed.');
  } finally {
    try {
      await withTimeout(prisma.$disconnect(), CLEANUP_TIMEOUT_MS, 'PostgreSQL cleanup timed out.');
    } catch {
      failure ??= new MaintenanceProbeError('PostgreSQL cleanup failed.');
    }
  }
  if (failure) throw failure;
  return result;
}

async function countRedisSessions(redisUrl) {
  const Redis = require('ioredis');
  const redis = new Redis(redisUrl, {
    lazyConnect: true,
    enableOfflineQueue: false,
    connectTimeout: 5_000,
    commandTimeout: EXTERNAL_TIMEOUT_MS,
    disableClientInfo: true,
    maxRetriesPerRequest: 1,
    enableReadyCheck: true,
    retryStrategy: () => null,
    reconnectOnError: () => false,
    autoResubscribe: false,
    autoResendUnfulfilledCommands: false,
  });
  redis.on('error', () => undefined);
  let matchCount = 0;
  let failure = null;
  try {
    await withTimeout(redis.connect(), EXTERNAL_TIMEOUT_MS, 'Redis connection timed out.');
    let cursor = '0';
    let iterations = 0;
    const seen = new Set();
    do {
      const parsed = parseRedisScanReply(await withTimeout(
        redis.scan(cursor, 'MATCH', REDIS_SESSION_PATTERN, 'COUNT', 1_000),
        EXTERNAL_TIMEOUT_MS,
        'Redis SCAN timed out.',
      ));
      matchCount += parsed.matchCount;
      if (!Number.isSafeInteger(matchCount) || matchCount > 0) {
        fail('Redis contains active PB voice sessions.');
      }
      cursor = parsed.cursor;
      iterations++;
      if (iterations > MAX_SCAN_ITERATIONS || (cursor !== '0' && seen.has(cursor))) {
        fail('Redis SCAN did not converge.');
      }
      if (cursor !== '0') seen.add(cursor);
    } while (cursor !== '0');
  } catch {
    failure = new MaintenanceProbeError('Redis PB verification failed.');
  } finally {
    try {
      redis.disconnect(false);
    } catch {
      failure ??= new MaintenanceProbeError('Redis cleanup failed.');
    }
    redis.removeAllListeners();
  }
  if (failure) throw failure;
  return matchCount;
}

async function countDiscordOccupants(token, catalog) {
  const { ChannelType, Client, Events, GatewayIntentBits } = require('discord.js');
  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
  });
  const swallowError = () => undefined;
  client.on(Events.Error, swallowError);
  client.on(Events.ShardError, swallowError);
  let occupantCount = 0;
  let failure = null;
  try {
    const ready = new Promise((resolve) => client.once(Events.ClientReady, resolve));
    await withTimeout(Promise.all([client.login(token), ready]), DISCORD_READY_TIMEOUT_MS,
      'Discord readiness timed out.');
    if (!client.isReady()) fail('Discord client is not ready.');

    const guilds = new Map();
    for (const guildId of catalog.guildIds) {
      const guild = client.guilds.cache.get(guildId);
      if (!guild || !guild.available) fail('A configured Discord guild is unavailable.');
      guilds.set(guildId, guild);
    }

    const counts = [];
    for (const entry of catalog.channels) {
      const guild = guilds.get(entry.guildId);
      const channel = guild?.channels.cache.get(entry.channelId);
      if (!channel || channel.type !== ChannelType.GuildVoice || channel.guildId !== entry.guildId) {
        fail('A configured PB voice channel is unavailable.');
      }
      counts.push(guild.voiceStates.cache.filter((state) => state.channelId === entry.channelId).size);
    }
    occupantCount = countOccupants(counts);
    if (occupantCount !== 0) fail('PB voice channels still have occupants.');
  } catch {
    failure = new MaintenanceProbeError('Discord PB verification failed.');
  } finally {
    try {
      await withTimeout(Promise.resolve(client.destroy()), CLEANUP_TIMEOUT_MS,
        'Discord cleanup timed out.');
    } catch {
      failure ??= new MaintenanceProbeError('Discord cleanup failed.');
    }
    client.removeAllListeners();
  }
  if (failure) throw failure;
  return occupantCount;
}

async function runMaintenanceProbe(options = {}) {
  const environment = options.environment ?? process.env;
  const clock = options.clock ?? (() => new Date());
  assertMaintenanceWindow(clock());

  const databaseUrl = requireSecret(environment.DATABASE_URL, 'PostgreSQL credentials');
  const redisUrl = requireSecret(environment.REDIS_URL, 'Redis target');
  const discordToken = requireSecret(environment.DISCORD_TOKEN, 'Discord credentials');
  parseLegacyDatabaseTarget(databaseUrl);
  parseLegacyRedisTarget(redisUrl);

  const catalog = await loadPbChannelCatalog(databaseUrl);
  const redisSessionCount = await countRedisSessions(redisUrl);
  const occupantCount = await countDiscordOccupants(discordToken, catalog);
  assertMaintenanceWindow(clock());

  return Object.freeze({
    configCount: catalog.configCount,
    squadCount: catalog.squadCount,
    guildCount: catalog.guildIds.length,
    channelCount: catalog.channels.length,
    redisSessionCount,
    occupantCount,
  });
}

function formatSuccessCounts(counts) {
  const keys = [
    'configCount',
    'squadCount',
    'guildCount',
    'channelCount',
    'redisSessionCount',
    'occupantCount',
  ];
  if (!counts || typeof counts !== 'object' || keys.some((key) =>
    !Number.isSafeInteger(counts[key]) || counts[key] < 0)) {
    fail('PB verification counts are invalid.');
  }
  return `PB idle verified: configs=${counts.configCount} squads=${counts.squadCount} ` +
    `guilds=${counts.guildCount} channels=${counts.channelCount} ` +
    `redisSessions=${counts.redisSessionCount} occupants=${counts.occupantCount}.\n`;
}

async function main(argv = process.argv.slice(2), environment = process.env) {
  try {
    const parsed = parseProbeArguments(argv, {
      allowFixedTime: allowsFixedProbeTime(environment),
    });
    const fixedNow = parsed.now ? new Date(parsed.now.getTime()) : null;
    const clock = fixedNow ? () => new Date(fixedNow.getTime()) : () => new Date();
    const counts = await runMaintenanceProbe({ environment, clock });
    process.stdout.write(formatSuccessCounts(counts));
    return 0;
  } catch {
    process.stderr.write('PB idle verification failed.\n');
    return 1;
  }
}

if (require.main === module) {
  void main().then(
    (code) => { process.exitCode = code; },
    () => {
      process.stderr.write('PB idle verification failed.\n');
      process.exitCode = 1;
    },
  );
}

module.exports = {
  MAINTENANCE_TIME_ZONE,
  MAINTENANCE_START_MINUTE,
  MAINTENANCE_END_MINUTE,
  REDIS_SESSION_PATTERN,
  parseIsoInstant,
  parseProbeArguments,
  moscowMinuteOfDay,
  isWithinMaintenanceWindow,
  allowsFixedProbeTime,
  parseLegacyDatabaseTarget,
  parseLegacyRedisTarget,
  parsePbChannelRows,
  parseRedisScanReply,
  countOccupants,
  formatSuccessCounts,
  runMaintenanceProbe,
  main,
};
