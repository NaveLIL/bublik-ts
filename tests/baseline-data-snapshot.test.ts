import assert from 'node:assert/strict';
import test from 'node:test';

const {
  FINGERPRINT_ALGORITHM,
  POSTFLIGHT_FORMAT,
  SNAPSHOT_CONSISTENCY,
  SNAPSHOT_FORMAT,
  assertValidSnapshot,
  buildFingerprintQuery,
  compareSnapshots,
  createSnapshot,
  createPostflightReport,
  hardeningSchemaRequirements,
  migrationSpecs,
  parseArguments,
  postflightCheckDefinitions,
  prismaDiffArguments,
  prismaDiffResultCheck,
  preflightCheckDefinitions,
  tableColumnsFromCatalog,
  targetSchemaFromDatabaseUrl,
  validateLocalMigrationFiles,
  validateMigrationHistoryRows,
} = require('../scripts/snapshot-baseline-data');
const {
  BASELINE,
  BASELINE_SHA256,
  parseBaselineCatalog,
} = require('../scripts/verify-baseline-target');

function validSnapshot(schema = 'public') {
  const tableColumns = tableColumnsFromCatalog(parseBaselineCatalog());
  return {
    format: SNAPSHOT_FORMAT,
    status: 'ok',
    baseline: { migration: BASELINE, sha256: BASELINE_SHA256 },
    schema,
    fingerprintAlgorithm: FINGERPRINT_ALGORITHM,
    consistency: { ...SNAPSHOT_CONSISTENCY },
    tableCount: tableColumns.size,
    sequenceCount: parseBaselineCatalog().sequences.length,
    invariants: preflightCheckDefinitions(schema).map(({ id }: { id: string }) => ({
      id,
      violations: '0',
    })),
    tables: [...tableColumns].map(([table, columns]) => ({
      table,
      columns,
      rowCount: '0',
      fingerprint: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    })),
    sequences: parseBaselineCatalog().sequences.map((sequence: string) => ({
      sequence,
      lastValue: '1',
      isCalled: false,
    })),
  };
}

test('pure snapshot comparator accepts identical complete baseline snapshots', () => {
  const snapshot = validSnapshot();
  assert.equal(assertValidSnapshot(snapshot), snapshot);
  assert.deepEqual(compareSnapshots(snapshot, structuredClone(snapshot)), {
    format: 'bublik-baseline-data-comparison/v1',
    status: 'identical',
    baseline: { migration: BASELINE, sha256: BASELINE_SHA256 },
    schema: 'public',
    tableCount: 40,
    sequenceCount: 1,
    differences: [],
  });
});

test('snapshot comparator includes strict ordered non-MVCC sequence state', () => {
  const before = validSnapshot();
  const after = structuredClone(before);
  assert.equal(before.sequences.length, 1);
  assert.equal(before.sequences[0].sequence, 'br_tech_entries_id_seq');
  after.sequences[0].lastValue = '42';
  after.sequences[0].isCalled = true;

  assert.deepEqual(compareSnapshots(before, after).differences, [
    {
      sequence: 'br_tech_entries_id_seq',
      field: 'lastValue',
      before: '1',
      after: '42',
    },
    {
      sequence: 'br_tech_entries_id_seq',
      field: 'isCalled',
      before: false,
      after: true,
    },
  ]);

  const missing = validSnapshot();
  missing.sequences = [];
  assert.throws(() => assertValidSnapshot(missing), /exactly 1 immutable baseline sequences/);
  const reordered = validSnapshot();
  reordered.sequences[0].sequence = 'wrong_sequence';
  assert.throws(() => assertValidSnapshot(reordered), /sequence catalog differs at position 0/);
  const missingAssumption = validSnapshot();
  delete missingAssumption.consistency;
  assert.throws(() => assertValidSnapshot(missingAssumption), /consistency assumptions/);
});

test('pure snapshot comparator reports every row-count and fingerprint change', () => {
  const before = validSnapshot();
  const after = structuredClone(before);
  after.tables[0].rowCount = '1';
  after.tables[0].fingerprint = '0'.repeat(64);

  assert.deepEqual(compareSnapshots(before, after).differences, [
    {
      table: before.tables[0].table,
      field: 'rowCount',
      before: '0',
      after: '1',
    },
    {
      table: before.tables[0].table,
      field: 'fingerprint',
      before: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      after: '0'.repeat(64),
    },
  ]);
  assert.equal(compareSnapshots(before, after).status, 'different');
});

test('snapshot validation fails closed for missing tables or failed invariants', () => {
  const missingTable = validSnapshot();
  missingTable.tables.pop();
  assert.throws(
    () => assertValidSnapshot(missingTable),
    /exactly 40 immutable baseline tables/,
  );

  const failedInvariant = validSnapshot();
  failedInvariant.invariants[0].violations = '1';
  assert.throws(
    () => assertValidSnapshot(failedInvariant),
    /passing, complete baseline-data preflight/,
  );
});

test('fingerprint SQL quotes every identifier and aggregates canonical JSON in PostgreSQL', () => {
  const query = buildFingerprintQuery('odd"schema', 'table"name', ['z"column', 'a']);
  assert.match(query, /"odd""schema"\."table""name"/);
  assert.match(query, /source\."z""column"/);
  assert.match(query, /jsonb_build_array/);
  assert.match(query, /string_agg\(row_hash, '' ORDER BY payload\)/);
  assert.match(query, /COUNT\(\*\)::text/);
});

test('saved-role preflight rejects null elements that hardening migrations remove', () => {
  const checks = preflightCheckDefinitions('public').filter(({ id }: { id: string }) => (
    id.endsWith('_noncanonical_saved_roles')
  ));
  assert.equal(checks.length, 2);
  for (const check of checks) {
    assert.match(check.query, /WHERE role_id IS NOT NULL/);
  }
});

test('CLI parser has exclusive snapshot, preflight, postflight and compare modes', () => {
  assert.deepEqual(parseArguments([]), {
    mode: 'snapshot', output: null, before: null, after: null,
  });
  assert.deepEqual(parseArguments(['--preflight', '--output', 'report.json']), {
    mode: 'preflight', output: 'report.json', before: null, after: null,
  });
  assert.deepEqual(parseArguments(['--postflight', '--output', 'postflight.json']), {
    mode: 'postflight', output: 'postflight.json', before: null, after: null,
  });
  assert.deepEqual(parseArguments(['--compare', 'before.json', 'after.json']), {
    mode: 'compare', output: null, before: 'before.json', after: 'after.json',
  });
  assert.throws(() => parseArguments(['--preflight', '--snapshot']), /exactly one mode/);
  assert.throws(() => parseArguments(['--compare', 'before.json']), /requires two snapshot/);
});

test('postflight schema requirements cover every hardening relation and critical index', () => {
  const requirements = hardeningSchemaRequirements();
  assert.deepEqual(requirements.relations, [
    'economy_black_market_deals',
    'operation_claims',
    'team_poll_votes',
  ]);
  const columnNames = new Set(requirements.columns.map((column: { table: string; name: string }) => (
    `${column.table}.${column.name}`
  )));
  for (const key of [
    'team_members.guildId',
    'vacation_requests.activeKey',
    'ns_vacations.activeKey',
    'team_applications.activeKey',
    'team_sessions.squadVoiceId',
    'team_polls.activeKey',
    'economy_raids.activeKey',
    'team_poll_votes.pollId',
  ]) assert.ok(columnNames.has(key), `missing hardening column requirement ${key}`);
  assert.ok(requirements.forbiddenIndexes.includes('team_members_userId_key'));
  assert.ok(requirements.indexes.some((index: { name: string; unique: boolean }) => (
    index.name === 'team_poll_votes_pollId_userId_key' && index.unique
  )));
  assert.ok(requirements.indexes.every((index: {
    included: string[];
    nullsNotDistinct: boolean;
    opclasses: string[];
    collations: Array<string | null>;
    options: number[];
    keys: string[];
  }) => (
    index.included.length === 0
    && index.nullsNotDistinct === false
    && index.opclasses.length === index.keys.length
    && index.collations.length === index.keys.length
    && index.options.length === index.keys.length
    && index.options.every((option) => option === 0)
  )));
});

function validMigrationHistory(baselineSteps: 0 | 1) {
  const specs = migrationSpecs();
  return specs.map((spec: { name: string; sha256: string }, index: number) => ({
    migration_name: spec.name,
    checksum: spec.sha256,
    started_at: new Date(`2026-07-19T22:54:${index ? '29' : '26'}.000Z`),
    finished_at: new Date(`2026-07-19T22:54:${index ? '30' : '27'}.000Z`),
    rolled_back_at: null,
    logs: null,
    applied_steps_count: index === 0 ? baselineSteps : 1,
  }));
}

test('postflight accepts both resolved and freshly-applied baseline history, with hardening at one step', () => {
  assert.deepEqual(validateLocalMigrationFiles(), []);
  assert.deepEqual(validateMigrationHistoryRows(validMigrationHistory(0)), []);
  assert.deepEqual(validateMigrationHistoryRows(validMigrationHistory(1)), []);
});

test('postflight migration history rejects unknown, reordered, rolled-back and modified rows', () => {
  const damaged = validMigrationHistory(0);
  damaged[0].checksum = '0'.repeat(64);
  damaged[0].rolled_back_at = new Date('2026-07-19T22:55:00.000Z');
  damaged[1].applied_steps_count = 0;
  damaged[1].logs = 'database error';
  damaged.push({
    migration_name: '20260719020000_unknown',
    checksum: '1'.repeat(64),
    started_at: new Date('2026-07-19T22:55:01.000Z'),
    finished_at: null,
    rolled_back_at: null,
    logs: null,
    applied_steps_count: 0,
  });
  const differences = validateMigrationHistoryRows(damaged).join('\n');
  assert.match(differences, /expected exactly 2/);
  assert.match(differences, /unknown migration history row/);
  assert.match(differences, /rolled-back migration history row is forbidden/);
  assert.match(differences, /unfinished migration history row/);
  assert.match(differences, /contains failure logs/);
  assert.match(differences, /checksum differs/);
  assert.match(differences, /applied_steps_count differs/);

  const reordered = validMigrationHistory(1).reverse();
  assert.match(validateMigrationHistoryRows(reordered).join('\n'), /prefix differs at position 0/);
});

test('exact Prisma schema diff is embedded without putting DATABASE_URL in argv', () => {
  const argumentsList = prismaDiffArguments();
  assert.ok(argumentsList.includes('--from-schema-datasource'));
  assert.ok(argumentsList.includes('--to-schema-datamodel'));
  assert.ok(argumentsList.includes('--exit-code'));
  assert.ok(!argumentsList.includes('--from-url'));
  assert.deepEqual(prismaDiffResultCheck({ status: 0, error: null }), {
    id: 'current_prisma_schema_exact', violations: '0', details: [],
  });
  assert.equal(prismaDiffResultCheck({ status: 2, error: null }).violations, '1');
  assert.equal(prismaDiffResultCheck({ status: 1, error: null }).violations, '1');
});

test('postflight semantic checks are schema-qualified and cover every critical backfill', () => {
  const checks = postflightCheckDefinitions('odd"schema');
  assert.deepEqual(checks.map(({ id }: { id: string }) => id), [
    'team_members_parent_guild_backfill',
    'vacation_requests_active_key_semantics',
    'ns_vacations_active_key_semantics',
    'team_applications_active_key_semantics',
    'team_polls_active_key_semantics',
    'economy_raids_active_key_semantics',
    'operation_claims_initially_empty',
    'economy_black_market_deals_initially_empty',
    'team_invites_processing_at_initially_null',
    'team_applications_new_columns_initially_null',
    'team_sessions_report_reminder_initially_null',
    'team_polls_new_columns_initial_values',
    'black_market_listing_creator_initially_null',
    'team_polls_closed_at_backfill',
    'team_polls_dedup_key_backfill',
    'team_poll_votes_legacy_normalization',
    'team_sessions_squad_voice_backfill',
  ]);
  for (const check of checks) assert.match(check.query, /"odd""schema"\./);
  const votes = checks.find(({ id }: { id: string }) => id === 'team_poll_votes_legacy_normalization');
  assert.match(votes.query, /legacy_yes_/);
  assert.match(votes.query, /legacy_no_/);
  assert.match(votes.query, /IS DISTINCT FROM expected\."readyTime"/);
  assert.match(votes.query, /actual\."createdAt" IS DISTINCT FROM/);
  const sessions = checks.find(({ id }: { id: string }) => id === 'team_sessions_squad_voice_backfill');
  assert.match(sessions.query, /ROW_NUMBER\(\) OVER/);
  assert.match(sessions.query, /"squadVoiceId" IS DISTINCT FROM/);
  const applications = checks.find(({ id }: { id: string }) => id === 'team_applications_active_key_semantics');
  assert.doesNotMatch(applications.query, /creation_cleanup/);
  const initialPolls = checks.find(({ id }: { id: string }) => id === 'team_polls_new_columns_initial_values');
  assert.match(initialPolls.query, /"notifiedKeys" IS DISTINCT FROM ARRAY\[\]::TEXT\[\]/);
  assert.match(initialPolls.query, /"uiClosedAt" IS NOT NULL/);
});

test('database URL parsing is strict and never guesses after malformed input', () => {
  assert.equal(targetSchemaFromDatabaseUrl('postgresql://db.invalid/bublik'), 'public');
  assert.equal(
    targetSchemaFromDatabaseUrl('postgres://db.invalid/bublik?schema=tenant%20one'),
    'tenant one',
  );
  assert.throws(() => targetSchemaFromDatabaseUrl(''), /DATABASE_URL is required/);
  assert.throws(() => targetSchemaFromDatabaseUrl('redis://db.invalid/0'), /postgres/);
  assert.throws(
    () => targetSchemaFromDatabaseUrl('postgresql://db.invalid/bublik?schema='),
    /empty schema/,
  );
  assert.throws(
    () => targetSchemaFromDatabaseUrl('postgresql://db.invalid/bublik?schema=public&schema=shadow'),
    /more than one schema parameter/,
  );
});

const requireDataGateIntegration = process.env.REQUIRE_DATA_GATE_INTEGRATION === '1';
function integrationUrl(name: string): string | undefined {
  const value = process.env[name];
  if (requireDataGateIntegration) {
    assert.ok(value, `${name} is required when REQUIRE_DATA_GATE_INTEGRATION=1`);
  }
  return value;
}

const integrationDatabaseUrl = integrationUrl('BUBLIK_SNAPSHOT_TEST_DATABASE_URL');
test('integration snapshot fingerprints the restored database without loading rows into Node', {
  skip: integrationDatabaseUrl ? false : 'set BUBLIK_SNAPSHOT_TEST_DATABASE_URL to run',
}, async () => {
  const snapshot = await createSnapshot(integrationDatabaseUrl);
  assert.equal(snapshot.status, 'ok');
  assert.equal(snapshot.tableCount, 40);
  assert.equal(snapshot.tables.length, 40);
  assert.equal(snapshot.sequenceCount, 1);
  assert.deepEqual(snapshot.sequences.map((sequence: { sequence: string }) => sequence.sequence), [
    'br_tech_entries_id_seq',
  ]);
  assert.ok(snapshot.tables.every((table: { fingerprint: string }) => (
    /^[0-9a-f]{64}$/.test(table.fingerprint)
  )));
});

const legacyPostflightIntegrationDatabaseUrl = integrationUrl(
  'BUBLIK_LEGACY_POSTFLIGHT_TEST_DATABASE_URL',
);
test('integration postflight fails closed on the restored legacy baseline', {
  skip: legacyPostflightIntegrationDatabaseUrl
    ? false
    : 'set BUBLIK_LEGACY_POSTFLIGHT_TEST_DATABASE_URL to run',
}, async () => {
  const report = await createPostflightReport(legacyPostflightIntegrationDatabaseUrl);
  assert.equal(report.format, POSTFLIGHT_FORMAT);
  assert.equal(report.status, 'blocked');
  assert.notEqual(report.checks[0]?.violations, '0');
  assert.ok(report.skippedChecks.includes('team_members_parent_guild_backfill'));
});

const postflightIntegrationDatabaseUrl = integrationUrl('BUBLIK_POSTFLIGHT_TEST_DATABASE_URL');
test('integration postflight validates the migrated restored database before bot startup', {
  skip: postflightIntegrationDatabaseUrl ? false : 'set BUBLIK_POSTFLIGHT_TEST_DATABASE_URL to run',
}, async () => {
  const report = await createPostflightReport(postflightIntegrationDatabaseUrl);
  assert.equal(report.format, POSTFLIGHT_FORMAT);
  assert.equal(report.status, 'ok');
  assert.ok(report.checks.every((check: { violations: string }) => check.violations === '0'));
  assert.deepEqual(report.skippedChecks, []);
  assert.deepEqual(report.counts.map((count: { id: string }) => count.id), [
    'operation_claims_rows',
    'team_poll_votes_rows',
    'economy_black_market_deals_rows',
  ]);
});

const freshPostflightIntegrationDatabaseUrl = integrationUrl(
  'BUBLIK_POSTFLIGHT_FRESH_DATABASE_URL',
);
test('integration postflight accepts a fresh migrate-deploy baseline with applied_steps_count=1', {
  skip: freshPostflightIntegrationDatabaseUrl
    ? false
    : 'set BUBLIK_POSTFLIGHT_FRESH_DATABASE_URL to run',
}, async () => {
  const report = await createPostflightReport(freshPostflightIntegrationDatabaseUrl);
  assert.equal(report.format, POSTFLIGHT_FORMAT);
  assert.equal(report.status, 'ok');
  assert.ok(report.checks.every((check: { violations: string }) => check.violations === '0'));
});

const fixturePostflightIntegrationDatabaseUrl = integrationUrl(
  'BUBLIK_POSTFLIGHT_FIXTURE_DATABASE_URL',
);
test('integration postflight validates non-empty legacy poll/session backfills', {
  skip: fixturePostflightIntegrationDatabaseUrl
    ? false
    : 'set BUBLIK_POSTFLIGHT_FIXTURE_DATABASE_URL to run',
}, async () => {
  const report = await createPostflightReport(fixturePostflightIntegrationDatabaseUrl);
  assert.equal(report.status, 'ok');
  assert.ok(report.checks.every((check: { violations: string }) => check.violations === '0'));
  const voteCount = report.counts.find(({ id }: { id: string }) => id === 'team_poll_votes_rows');
  assert.equal(voteCount?.count, '6');
});
