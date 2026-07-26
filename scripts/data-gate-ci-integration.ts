import assert from 'node:assert/strict';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { resolve } from 'node:path';
import { PrismaClient } from '@prisma/client';

const {
  compareSnapshots,
  expectedPostflightCheckIds,
  POSTFLIGHT_PROFILE,
} = require('./snapshot-baseline-data') as {
  compareSnapshots: (before: unknown, after: unknown) => {
    status: string;
    differences: unknown[];
    tableCount: number;
    sequenceCount: number;
  };
  expectedPostflightCheckIds: (schema: string, profile?: string) => string[];
  POSTFLIGHT_PROFILE: {
    MIGRATION: 'migration';
    OPERATIONAL: 'operational';
  };
};

const root = resolve(__dirname, '..');
const prismaCli = require.resolve('prisma/build/index.js');
const tsxCli = require.resolve('tsx/cli');
const dataGateScript = resolve(__dirname, 'snapshot-baseline-data.js');
const dataGateTests = resolve(root, 'tests', 'baseline-data-snapshot.test.ts');
const baselineMigration = resolve(
  root,
  'prisma',
  'migrations',
  '20260719000000_baseline',
  'migration.sql',
);
const populatedFixture = resolve(root, 'tests', 'fixtures', 'postflight-legacy.sql');

const OWNED_DATABASES = Object.freeze({
  legacy: 'bublik_data_gate_ci_legacy',
  resolved: 'bublik_data_gate_ci_resolved',
  fresh: 'bublik_data_gate_ci_fresh',
  fixture: 'bublik_data_gate_ci_fixture',
});
const OWNED_DATABASE_NAMES = Object.freeze(Object.values(OWNED_DATABASES));
const BASELINE = '20260719000000_baseline';
const HARDENING = '20260719010000_hardening';
const VACATION_ROLE_SNAPSHOT = '20260721000000_vacation_role_snapshot_seal';
const MINECRAFT_FOUNDATION = '20260724180000_minecraft_foundation';
const MINECRAFT_CHAT = '20260724183500_add_chat_channel_id';
const RUNTIME_SCHEMA_RECONCILIATION = '20260727000000_reconcile_runtime_schema';
type CommandResult = SpawnSyncReturns<string>;
type PostflightReport = {
  profile: 'migration' | 'operational';
  status: string;
  checks: Array<{ id: string; violations: string }>;
  counts: Array<{ id: string; count: string }>;
  skippedChecks: string[];
};
type PreflightReport = {
  profile: 'migration' | 'operational';
  status: string;
  checks: Array<{ id: string; violations: string }>;
};
type SnapshotReport = {
  profile: 'migration' | 'operational';
  status: string;
  invariants: Array<{ id: string; violations: string }>;
};

function guardDedicatedServer(databaseUrl: string): URL {
  assert.equal(process.env.NODE_ENV, 'test', 'NODE_ENV=test is required');
  assert.equal(
    process.env.RUN_DATA_GATE_INTEGRATION,
    '1',
    'RUN_DATA_GATE_INTEGRATION=1 is required',
  );
  const url = new URL(databaseUrl);
  assert.ok(
    ['postgres:', 'postgresql:'].includes(url.protocol),
    'data-gate integration requires PostgreSQL',
  );
  assert.ok(
    ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname.toLowerCase()),
    `refusing destructive data-gate integration against non-loopback host ${url.hostname}`,
  );
  const database = decodeURIComponent(url.pathname.replace(/^\//, ''));
  assert.match(
    database,
    /(test|ci|audit)/i,
    `refusing destructive data-gate integration against database ${database}`,
  );
  assert.ok(!OWNED_DATABASE_NAMES.includes(database), 'admin database must not be an owned target');
  const schemas = url.searchParams.getAll('schema');
  assert.ok(schemas.length <= 1, 'data-gate integration rejects duplicate schema parameters');
  assert.equal(schemas[0] || 'public', 'public', 'data-gate integration requires schema=public');
  for (const name of OWNED_DATABASE_NAMES) {
    assert.match(name, /^bublik_data_gate_ci_[a-z]+$/);
    assert.ok(name.length <= 63);
  }
  return url;
}

function databaseUrl(baseUrl: URL, name: string): string {
  assert.ok(OWNED_DATABASE_NAMES.includes(name), `refusing unowned database URL: ${name}`);
  const target = new URL(baseUrl.toString());
  target.pathname = `/${name}`;
  target.searchParams.set('schema', 'public');
  return target.toString();
}

function quoteIdentifier(value: string): string {
  assert.ok(OWNED_DATABASE_NAMES.includes(value), `refusing unowned database identifier: ${value}`);
  return `"${value.replaceAll('"', '""')}"`;
}

function redact(text: string, urls: string[]): string {
  let result = text;
  for (const databaseUrlValue of urls) {
    result = result.replaceAll(databaseUrlValue, '[DATABASE_URL]');
    try {
      const parsed = new URL(databaseUrlValue);
      if (parsed.password) {
        result = result
          .replaceAll(parsed.password, '[DB_PASSWORD]')
          .replaceAll(decodeURIComponent(parsed.password), '[DB_PASSWORD]');
      }
    } catch {
      // The URL is validated before any child process is started.
    }
  }
  return result;
}

function commandDetails(result: CommandResult, urls: string[]): string {
  return redact(
    [result.error?.message, result.stderr, result.stdout].filter(Boolean).join('\n'),
    urls,
  );
}

function runNode(
  args: string[],
  env: NodeJS.ProcessEnv,
  urls: string[],
): CommandResult {
  const result = spawnSync(process.execPath, args, {
    cwd: root,
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 180_000,
    maxBuffer: 20 * 1024 * 1024,
    windowsHide: true,
  });
  assert.equal(
    result.signal,
    null,
    `child process was terminated: ${commandDetails(result, urls)}`,
  );
  return result;
}

function runPrisma(
  args: string[],
  targetUrl: string,
  urls: string[],
  expectedStatus = 0,
): CommandResult {
  const result = runNode(
    [prismaCli, ...args],
    { ...process.env, DATABASE_URL: targetUrl },
    urls,
  );
  assert.equal(
    result.status,
    expectedStatus,
    `Prisma ${args.join(' ')} exited ${String(result.status)}: ${commandDetails(result, urls)}`,
  );
  return result;
}

function executeSqlFile(path: string, targetUrl: string, urls: string[]): void {
  runPrisma(['db', 'execute', '--file', path], targetUrl, urls);
}

function migrateDeploy(targetUrl: string, urls: string[]): void {
  runPrisma(['migrate', 'deploy'], targetUrl, urls);
}

function resolveBaseline(targetUrl: string, urls: string[]): void {
  runPrisma(['migrate', 'resolve', '--applied', BASELINE], targetUrl, urls);
}

function parseJsonOutput<T>(result: CommandResult, label: string, urls: string[]): T {
  try {
    return JSON.parse(result.stdout) as T;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`${label} returned invalid JSON (${reason}): ${commandDetails(result, urls)}`);
  }
}

function runSnapshot(
  targetUrl: string,
  urls: string[],
  profile: 'migration' | 'operational' = POSTFLIGHT_PROFILE.MIGRATION,
): unknown {
  const result = runNode(
    [
      dataGateScript,
      profile === POSTFLIGHT_PROFILE.MIGRATION
        ? '--snapshot'
        : '--snapshot-operational',
    ],
    { ...process.env, DATABASE_URL: targetUrl },
    urls,
  );
  assert.equal(result.status, 0, `snapshot failed: ${commandDetails(result, urls)}`);
  return parseJsonOutput(result, 'snapshot', urls);
}

function runOperationalPreflight(targetUrl: string, urls: string[]): PreflightReport {
  const result = runNode(
    [dataGateScript, '--preflight-operational'],
    { ...process.env, DATABASE_URL: targetUrl },
    urls,
  );
  assert.equal(result.status, 0, `operational preflight failed: ${commandDetails(result, urls)}`);
  const report = parseJsonOutput<PreflightReport>(result, 'operational preflight', urls);
  assert.equal(report.profile, POSTFLIGHT_PROFILE.OPERATIONAL);
  assert.equal(report.status, 'ok');
  assert.deepEqual(
    report.checks.map(check => check.id),
    [
      'team_members_orphans',
      'team_members_duplicate_guild_user',
      'regbattle_squads_duplicate_guild_number',
      'regbattle_squads_duplicate_guild_owner',
      'vacation_requests_duplicate_live',
      'ns_vacations_duplicate_live_slot',
      'team_applications_duplicate_actionable',
      'team_polls_duplicate_active',
      'economy_raids_duplicate_live',
    ],
  );
  assert.ok(report.checks.every(check => check.violations === '0'));
  return report;
}

function runPostflight(
  targetUrl: string,
  urls: string[],
  expectedStatus: 'ok' | 'blocked',
  profile: 'migration' | 'operational' = POSTFLIGHT_PROFILE.MIGRATION,
): PostflightReport {
  const result = runNode(
    [
      dataGateScript,
      profile === POSTFLIGHT_PROFILE.MIGRATION
        ? '--postflight'
        : '--postflight-operational',
    ],
    { ...process.env, DATABASE_URL: targetUrl },
    urls,
  );
  assert.equal(
    result.status,
    expectedStatus === 'ok' ? 0 : 1,
    `postflight had an unexpected exit: ${commandDetails(result, urls)}`,
  );
  const report = parseJsonOutput<PostflightReport>(result, 'postflight', urls);
  assert.equal(report.status, expectedStatus);
  assert.equal(report.profile, profile);
  if (expectedStatus === 'ok') {
    assert.deepEqual(
      report.checks.map(check => check.id),
      expectedPostflightCheckIds('public', profile),
    );
    assert.ok(report.checks.every(check => check.violations === '0'));
    assert.deepEqual(report.skippedChecks, []);
  } else {
    assert.ok(report.checks.some(check => check.violations !== '0'));
  }
  return report;
}

async function seedOperationalClaims(targetUrl: string, count: number): Promise<void> {
  const client = new PrismaClient({ datasources: { db: { url: targetUrl } } });
  try {
    const createdAt = new Date(Date.now() - 60_000);
    const expiresAt = new Date(Date.now() + 60 * 60_000);
    const result = await client.operationClaim.createMany({
      data: Array.from({ length: count }, (_, index) => ({
        key: `data_gate_operational_${String(index).padStart(3, '0')}`,
        scope: 'data_gate_operational',
        guildId: 'integration-guild',
        userId: `integration-user-${index}`,
        metadata: { fixture: true, index },
        createdAt,
        expiresAt,
      })),
    });
    assert.equal(result.count, count);
  } finally {
    await client.$disconnect();
  }
}

async function corruptOperationalClaim(targetUrl: string): Promise<void> {
  const client = new PrismaClient({ datasources: { db: { url: targetUrl } } });
  try {
    await client.operationClaim.update({
      where: { key: 'data_gate_operational_000' },
      data: { scope: ' ' },
    });
  } finally {
    await client.$disconnect();
  }
}

async function readMigrationSteps(targetUrl: string): Promise<Array<[string, number]>> {
  const client = new PrismaClient({ datasources: { db: { url: targetUrl } } });
  try {
    const rows = await client.$queryRawUnsafe<Array<{
      migration_name: string;
      applied_steps_count: number;
    }>>(`
      SELECT migration_name, applied_steps_count
      FROM "public"."_prisma_migrations"
      ORDER BY migration_name, started_at, id
    `);
    return rows.map(row => [row.migration_name, Number(row.applied_steps_count)]);
  } finally {
    await client.$disconnect();
  }
}

async function assertMigrationSteps(
  targetUrl: string,
  baselineSteps: 0 | 1,
): Promise<void> {
  assert.deepEqual(await readMigrationSteps(targetUrl), [
    [BASELINE, baselineSteps],
    [HARDENING, 1],
    [VACATION_ROLE_SNAPSHOT, 1],
    [MINECRAFT_FOUNDATION, 1],
    [MINECRAFT_CHAT, 1],
    [RUNTIME_SCHEMA_RECONCILIATION, 1],
  ]);
}

function runRequiredDataGateTests(
  urlsByPurpose: Record<keyof typeof OWNED_DATABASES, string>,
  urls: string[],
): number {
  const result = runNode(
    [tsxCli, '--test', '--test-reporter=tap', dataGateTests],
    {
      ...process.env,
      REQUIRE_DATA_GATE_INTEGRATION: '1',
      BUBLIK_SNAPSHOT_TEST_DATABASE_URL: urlsByPurpose.legacy,
      BUBLIK_LEGACY_POSTFLIGHT_TEST_DATABASE_URL: urlsByPurpose.legacy,
      BUBLIK_POSTFLIGHT_TEST_DATABASE_URL: urlsByPurpose.resolved,
      BUBLIK_POSTFLIGHT_FRESH_DATABASE_URL: urlsByPurpose.fresh,
      BUBLIK_POSTFLIGHT_FIXTURE_DATABASE_URL: urlsByPurpose.fixture,
    },
    urls,
  );
  assert.equal(
    result.status,
    0,
    `required data-gate tests failed: ${commandDetails(result, urls)}`,
  );
  const summaryValue = (label: 'tests' | 'pass' | 'fail' | 'skipped'): number => {
    const match = result.stdout.match(new RegExp(`(?:^|\\n)# ${label} (\\d+)(?:\\r?\\n|$)`));
    assert.ok(match, `TAP summary is missing # ${label}: ${commandDetails(result, urls)}`);
    return Number(match[1]);
  };
  const tests = summaryValue('tests');
  const passed = summaryValue('pass');
  assert.ok(tests > 0, 'required data-gate test suite must contain tests');
  assert.equal(passed, tests, 'every required data-gate test must pass');
  assert.equal(summaryValue('fail'), 0);
  assert.equal(summaryValue('skipped'), 0);
  return passed;
}

async function dropOwnedDatabase(admin: PrismaClient, name: string): Promise<void> {
  assert.ok(OWNED_DATABASE_NAMES.includes(name), `refusing to drop unowned database: ${name}`);
  await admin.$queryRawUnsafe(`
    SELECT pg_terminate_backend(pid)
    FROM pg_stat_activity
    WHERE datname = $1 AND pid <> pg_backend_pid()
  `, name);
  await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS ${quoteIdentifier(name)}`);
}

async function resetOwnedDatabases(admin: PrismaClient): Promise<void> {
  for (const name of [...OWNED_DATABASE_NAMES].reverse()) {
    await dropOwnedDatabase(admin, name);
  }
}

async function createOwnedDatabases(admin: PrismaClient): Promise<void> {
  for (const name of OWNED_DATABASE_NAMES) {
    await admin.$executeRawUnsafe(`CREATE DATABASE ${quoteIdentifier(name)}`);
  }
}

async function main(): Promise<void> {
  const rawAdminUrl = process.env.DATABASE_URL || '';
  const parsedAdminUrl = guardDedicatedServer(rawAdminUrl);
  const urlsByPurpose = Object.fromEntries(
    Object.entries(OWNED_DATABASES).map(([purpose, name]) => (
      [purpose, databaseUrl(parsedAdminUrl, name)]
    )),
  ) as Record<keyof typeof OWNED_DATABASES, string>;
  const sensitiveUrls = [rawAdminUrl, ...Object.values(urlsByPurpose)];
  const admin = new PrismaClient({ datasources: { db: { url: rawAdminUrl } } });

  await admin.$connect();
  let primaryError: unknown = null;
  try {
    await resetOwnedDatabases(admin);
    await createOwnedDatabases(admin);

    executeSqlFile(baselineMigration, urlsByPurpose.legacy, sensitiveUrls);
    const legacyReport = runPostflight(urlsByPurpose.legacy, sensitiveUrls, 'blocked');
    assert.equal(legacyReport.checks[0]?.id, 'hardening_schema_projection');

    executeSqlFile(baselineMigration, urlsByPurpose.resolved, sensitiveUrls);
    const before = runSnapshot(urlsByPurpose.resolved, sensitiveUrls);
    resolveBaseline(urlsByPurpose.resolved, sensitiveUrls);
    migrateDeploy(urlsByPurpose.resolved, sensitiveUrls);
    const after = runSnapshot(urlsByPurpose.resolved, sensitiveUrls);
    const comparison = compareSnapshots(before, after);
    assert.equal(comparison.status, 'identical');
    assert.deepEqual(comparison.differences, []);
    assert.equal(comparison.tableCount, 40);
    assert.equal(comparison.sequenceCount, 1);
    await assertMigrationSteps(urlsByPurpose.resolved, 0);
    runPostflight(urlsByPurpose.resolved, sensitiveUrls, 'ok');

    migrateDeploy(urlsByPurpose.fresh, sensitiveUrls);
    await assertMigrationSteps(urlsByPurpose.fresh, 1);
    runPostflight(urlsByPurpose.fresh, sensitiveUrls, 'ok');

    executeSqlFile(baselineMigration, urlsByPurpose.fixture, sensitiveUrls);
    resolveBaseline(urlsByPurpose.fixture, sensitiveUrls);
    executeSqlFile(populatedFixture, urlsByPurpose.fixture, sensitiveUrls);
    migrateDeploy(urlsByPurpose.fixture, sensitiveUrls);
    await assertMigrationSteps(urlsByPurpose.fixture, 0);
    const fixtureReport = runPostflight(urlsByPurpose.fixture, sensitiveUrls, 'ok');
    const voteCount = fixtureReport.counts.find(count => count.id === 'team_poll_votes_rows');
    assert.equal(voteCount?.count, '6');

    const passedTests = runRequiredDataGateTests(urlsByPurpose, sensitiveUrls);
    await seedOperationalClaims(urlsByPurpose.resolved, 342);
    runOperationalPreflight(urlsByPurpose.resolved, sensitiveUrls);
    const operationalSnapshot = runSnapshot(
      urlsByPurpose.resolved,
      sensitiveUrls,
      POSTFLIGHT_PROFILE.OPERATIONAL,
    ) as SnapshotReport;
    assert.equal(operationalSnapshot.profile, POSTFLIGHT_PROFILE.OPERATIONAL);
    assert.equal(operationalSnapshot.status, 'ok');
    assert.deepEqual(
      operationalSnapshot.invariants.map(check => check.id),
      [
        'team_members_orphans',
        'team_members_duplicate_guild_user',
        'regbattle_squads_duplicate_guild_number',
        'regbattle_squads_duplicate_guild_owner',
        'vacation_requests_duplicate_live',
        'ns_vacations_duplicate_live_slot',
        'team_applications_duplicate_actionable',
        'team_polls_duplicate_active',
        'economy_raids_duplicate_live',
      ],
    );
    const strictOperationalDataReport = runPostflight(
      urlsByPurpose.resolved,
      sensitiveUrls,
      'blocked',
    );
    assert.deepEqual(
      strictOperationalDataReport.checks
        .filter(check => check.violations !== '0')
        .map(check => [check.id, check.violations]),
      [['operation_claims_initially_empty', '342']],
    );
    const operationalReport = runPostflight(
      urlsByPurpose.resolved,
      sensitiveUrls,
      'ok',
      POSTFLIGHT_PROFILE.OPERATIONAL,
    );
    assert.equal(
      operationalReport.counts.find(count => count.id === 'operation_claims_rows')?.count,
      '342',
    );
    await corruptOperationalClaim(urlsByPurpose.resolved);
    const corruptOperationalReport = runPostflight(
      urlsByPurpose.resolved,
      sensitiveUrls,
      'blocked',
      POSTFLIGHT_PROFILE.OPERATIONAL,
    );
    assert.deepEqual(
      corruptOperationalReport.checks
        .filter(check => check.violations !== '0')
        .map(check => [check.id, check.violations]),
      [['operation_claims_runtime_integrity', '1']],
    );
    process.stdout.write(
      'data-gate integration: legacy blocked; resolved(0), fresh(1), populated backfills; '
        + `operational claims 342 accepted and malformed claim blocked; TAP pass=${passedTests}, `
        + 'fail=0, skipped=0\n',
    );
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    try {
      await resetOwnedDatabases(admin);
    } catch (cleanupError) {
      if (!primaryError) throw cleanupError;
      console.error(`data-gate cleanup also failed: ${redact(String(cleanupError), sensitiveUrls)}`);
    } finally {
      await admin.$disconnect();
    }
  }
}

main().catch((error: unknown) => {
  const rawAdminUrl = process.env.DATABASE_URL || '';
  console.error(redact(error instanceof Error ? error.stack || error.message : String(error), [rawAdminUrl]));
  process.exitCode = 1;
});
