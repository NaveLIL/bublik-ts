import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const root = resolve(__dirname, '..');
const verifier = resolve(__dirname, 'verify-baseline-target.js');
const baseline = resolve(root, 'prisma', 'migrations', '20260719000000_baseline', 'migration.sql');
const hardening = resolve(root, 'prisma', 'migrations', '20260719010000_hardening', 'migration.sql');
const prismaCli = require.resolve('prisma/build/index.js');

type Result = ReturnType<typeof spawnSync>;

function guardDedicatedDatabase(): void {
  assert.equal(process.env.NODE_ENV, 'test', 'NODE_ENV=test is required');
  assert.equal(process.env.RUN_DB_BASELINE_INTEGRATION, '1', 'RUN_DB_BASELINE_INTEGRATION=1 is required');
  const url = new URL(process.env.DATABASE_URL || '');
  const database = decodeURIComponent(url.pathname.replace(/^\//, ''));
  assert.match(database, /(test|ci|audit)/i, `refusing destructive baseline tests on database ${database}`);
  const schemas = url.searchParams.getAll('schema');
  assert.ok(schemas.length <= 1, 'baseline integration test rejects duplicate schema parameters');
  assert.equal(schemas[0] || 'public', 'public', 'baseline integration test requires schema=public');
}

function runNode(script: string): Result {
  return spawnSync(process.execPath, [script], {
    cwd: root,
    env: process.env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function runPrisma(args: string[]): Result {
  return spawnSync(process.execPath, [prismaCli, ...args], {
    cwd: root,
    env: process.env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function expectState(state: string): void {
  const result = runNode(verifier);
  assert.equal(result.status, 0, `expected ${state}, verifier failed: ${result.stderr || result.stdout}`);
  assert.equal(String(result.stdout).trim(), state);
}

function expectRefusal(label: string): void {
  const result = runNode(verifier);
  assert.notEqual(result.status, 0, `${label}: unsafe schema was accepted as a legacy baseline`);
  assert.match(String(result.stderr), /automatic baseline is refused|schema has drifted/i, `${label}: unexpected error: ${result.stderr}`);
}

function executeMigration(file: string): void {
  const result = runPrisma(['db', 'execute', '--file', file]);
  assert.equal(result.status, 0, `cannot execute ${file}: ${result.stderr || result.stdout}`);
}

async function resetPublicSchema(): Promise<void> {
  await prisma.$executeRawUnsafe('DROP SCHEMA IF EXISTS public CASCADE');
  await prisma.$executeRawUnsafe('CREATE SCHEMA public');
}

async function main(): Promise<void> {
  guardDedicatedDatabase();

  try {
    await resetPublicSchema();
    expectState('fresh');

    executeMigration(baseline);
    expectState('needs-resolve');

    await prisma.$executeRawUnsafe('ALTER TABLE "guild_settings" ALTER COLUMN "locale" TYPE VARCHAR(191)');
    expectRefusal('wrong column type');

    await resetPublicSchema();
    executeMigration(baseline);
    await prisma.$executeRawUnsafe("ALTER TABLE \"team_polls\" ALTER COLUMN \"status\" SET DEFAULT 'ACTIVE'");
    expectRefusal('case-sensitive default drift');

    await resetPublicSchema();
    executeMigration(baseline);
    await prisma.$executeRawUnsafe('DROP INDEX "guild_settings_guildId_key"');
    await prisma.$executeRawUnsafe('CREATE INDEX "guild_settings_guildId_key" ON "guild_settings"("guildId")');
    expectRefusal('wrong index uniqueness');

    await resetPublicSchema();
    executeMigration(baseline);
    await prisma.$executeRawUnsafe('ALTER TABLE "vacation_requests" ADD COLUMN "activeKey" TEXT');
    expectRefusal('extra hardening column');

    await resetPublicSchema();
    executeMigration(baseline);
    executeMigration(hardening);
    expectRefusal('hardening schema without migration history');

    await resetPublicSchema();
    const deploy = runPrisma(['migrate', 'deploy']);
    assert.equal(deploy.status, 0, `cannot deploy migrations: ${deploy.stderr || deploy.stdout}`);
    expectState('already-applied');
    await prisma.$executeRawUnsafe('ALTER TABLE "guild_settings" ADD COLUMN "unexpectedDrift" TEXT');
    expectRefusal('schema drift after migration history');

    process.stdout.write('baseline verifier integration: fresh/exact/drift/history cases passed\n');
  } finally {
    await resetPublicSchema();
    await prisma.$disconnect();
  }
}

main().catch(async (error) => {
  console.error(error);
  await prisma.$disconnect().catch(() => undefined);
  process.exitCode = 1;
});
