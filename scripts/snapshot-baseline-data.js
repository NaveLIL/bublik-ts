const { createHash } = require('node:crypto');
const { readFileSync, readdirSync, writeFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { spawnSync } = require('node:child_process');
const { PrismaClient } = require('@prisma/client');
const {
  BASELINE,
  BASELINE_SHA256,
  normalizeDefault,
  parseBaselineCatalog,
  targetSchema,
} = require('./verify-baseline-target');

const SNAPSHOT_FORMAT = 'bublik-baseline-data-snapshot/v2';
const PREFLIGHT_FORMAT = 'bublik-baseline-data-preflight/v1';
const POSTFLIGHT_FORMAT = 'bublik-hardening-data-postflight/v1';
const POSTFLIGHT_PROFILE = Object.freeze({
  MIGRATION: 'migration',
  OPERATIONAL: 'operational',
});
const COMPARISON_FORMAT = 'bublik-baseline-data-comparison/v1';
const FINGERPRINT_ALGORITHM = 'postgres-sha256-canonical-json/v1';
const SNAPSHOT_CONSISTENCY = Object.freeze({
  tableData: 'read-only repeatable-read transaction',
  sequences: 'PostgreSQL sequences are non-MVCC; all database writers must remain stopped for the entire snapshot',
  writerStateRequired: 'stopped',
});

class InvariantViolationError extends Error {
  constructor(report) {
    const failed = report.checks
      .filter((check) => check.violations !== '0')
      .map((check) => `${check.id}=${check.violations}`)
      .join(', ');
    super(`Baseline-data preflight is blocked: ${failed}`);
    this.name = 'InvariantViolationError';
    this.report = report;
  }
}

function quoteIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function quoteLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function targetSchemaFromDatabaseUrl(databaseUrl) {
  return targetSchema(databaseUrl);
}

function baselineMetadata() {
  return { migration: BASELINE, sha256: BASELINE_SHA256 };
}

function compareText(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function tableColumnsFromCatalog(catalog) {
  const result = new Map(catalog.tables
    .map((table) => table.name)
    .sort(compareText)
    .map((table) => [table, []]));
  for (const column of catalog.columns) {
    const columns = result.get(column.table);
    if (!columns) {
      throw new Error(`Immutable baseline column refers to an unknown table: ${column.table}.${column.name}`);
    }
    columns.push(column.name);
  }
  for (const [table, columns] of result) {
    if (!columns.length) throw new Error(`Immutable baseline table has no columns: ${table}`);
    columns.sort(compareText);
    if (new Set(columns).size !== columns.length) {
      throw new Error(`Immutable baseline table has duplicate columns: ${table}`);
    }
  }
  return result;
}

async function assertBaselineProjection(tx, schema, catalog) {
  const schemaRows = await tx.$queryRawUnsafe(`
    SELECT EXISTS (
      SELECT 1 FROM pg_namespace WHERE nspname = $1
    ) AS exists
  `, schema);
  if (schemaRows.length !== 1 || schemaRows[0].exists !== true) {
    throw new Error(`Target PostgreSQL schema does not exist: ${schema}`);
  }

  const tableNames = catalog.tables.map((table) => table.name);
  const tableList = tableNames.map(quoteLiteral).join(', ');
  const relationRows = await tx.$queryRawUnsafe(`
    SELECT relation.relname AS table_name, relation.relkind AS kind
    FROM pg_class AS relation
    JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname = $1
      AND relation.relname IN (${tableList})
    ORDER BY relation.relname
  `, schema);

  const columnRows = await tx.$queryRawUnsafe(`
    SELECT relation.relname AS table_name,
           attribute.attname AS name,
           format_type(attribute.atttypid, attribute.atttypmod) AS type,
           attribute.attnotnull AS not_null,
           pg_get_expr(default_value.adbin, default_value.adrelid) AS default_value,
           attribute.attidentity AS identity,
           attribute.attgenerated AS generated
    FROM pg_attribute AS attribute
    JOIN pg_class AS relation ON relation.oid = attribute.attrelid
    JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
    LEFT JOIN pg_attrdef AS default_value
      ON default_value.adrelid = attribute.attrelid
      AND default_value.adnum = attribute.attnum
    WHERE namespace.nspname = $1
      AND relation.relname IN (${tableList})
      AND relation.relkind IN ('r', 'p')
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
    ORDER BY relation.relname, attribute.attname
  `, schema);

  const actualRelations = new Map(relationRows.map((row) => [row.table_name, row.kind]));
  const actualColumns = new Map(columnRows.map((row) => [`${row.table_name}.${row.name}`, {
    table: row.table_name,
    name: row.name,
    type: row.type,
    notNull: row.not_null,
    default: normalizeDefault(row.default_value),
    identity: row.identity === '\0' ? '' : row.identity,
    generated: row.generated === '\0' ? '' : row.generated,
  }]));

  const differences = [];
  for (const table of catalog.tables) {
    const actualKind = actualRelations.get(table.name);
    if (actualKind == null) differences.push(`missing table ${table.name}`);
    else if (actualKind !== table.kind) {
      differences.push(`table ${table.name} has relkind ${actualKind}, expected ${table.kind}`);
    }
  }

  for (const expected of catalog.columns) {
    const key = `${expected.table}.${expected.name}`;
    const actual = actualColumns.get(key);
    if (!actual) {
      differences.push(`missing column ${key}`);
      continue;
    }
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      differences.push(`column definition differs for ${key}`);
    }
  }

  if (differences.length) {
    const suffix = differences.length > 16 ? `; and ${differences.length - 16} more` : '';
    throw new Error(`Database does not preserve the immutable baseline data projection: ${differences.slice(0, 16).join('; ')}${suffix}`);
  }
}

function preflightCheckDefinitions(schema, profile = POSTFLIGHT_PROFILE.MIGRATION) {
  if (!Object.values(POSTFLIGHT_PROFILE).includes(profile)) {
    throw new Error(`Unsupported preflight profile: ${String(profile)}`);
  }
  const table = (name) => `${quoteIdentifier(schema)}.${quoteIdentifier(name)}`;
  const migrationChecks = [
    {
      id: 'team_members_orphans',
      query: `
        SELECT COUNT(*)::text AS violations
        FROM ${table('team_members')} AS member
        LEFT JOIN ${table('teams')} AS team ON team."id" = member."teamId"
        WHERE team."id" IS NULL
      `,
    },
    {
      id: 'team_members_duplicate_guild_user',
      query: `
        SELECT COUNT(*)::text AS violations FROM (
          SELECT team."guildId", member."userId"
          FROM ${table('team_members')} AS member
          JOIN ${table('teams')} AS team ON team."id" = member."teamId"
          GROUP BY team."guildId", member."userId"
          HAVING COUNT(*) > 1
        ) AS duplicate_groups
      `,
    },
    {
      id: 'regbattle_squads_duplicate_guild_number',
      query: `
        SELECT COUNT(*)::text AS violations FROM (
          SELECT "guildId", "number"
          FROM ${table('regbattle_squads')}
          GROUP BY "guildId", "number"
          HAVING COUNT(*) > 1
        ) AS duplicate_groups
      `,
    },
    {
      id: 'regbattle_squads_duplicate_guild_owner',
      query: `
        SELECT COUNT(*)::text AS violations FROM (
          SELECT "guildId", "ownerId"
          FROM ${table('regbattle_squads')}
          GROUP BY "guildId", "ownerId"
          HAVING COUNT(*) > 1
        ) AS duplicate_groups
      `,
    },
    {
      id: 'vacation_requests_duplicate_live',
      query: `
        SELECT COUNT(*)::text AS violations FROM (
          SELECT "guildId", "userId"
          FROM ${table('vacation_requests')}
          WHERE "status" IN ('pending', 'activating', 'active', 'restoring')
          GROUP BY "guildId", "userId"
          HAVING COUNT(*) > 1
        ) AS duplicate_groups
      `,
    },
    {
      id: 'ns_vacations_duplicate_live_slot',
      query: `
        SELECT COUNT(*)::text AS violations FROM (
          SELECT "guildId", "userId",
                 CASE WHEN "type" = 'vacation' THEN 'vacation' ELSE 'roles' END AS slot
          FROM ${table('ns_vacations')}
          WHERE "status" IN ('activating', 'active', 'restoring')
          GROUP BY "guildId", "userId",
                   CASE WHEN "type" = 'vacation' THEN 'vacation' ELSE 'roles' END
          HAVING COUNT(*) > 1
        ) AS duplicate_groups
      `,
    },
    {
      id: 'vacations_cross_table_live_role_overlap',
      query: `
        SELECT COUNT(*)::text AS violations FROM (
          SELECT DISTINCT request."guildId", request."userId"
          FROM ${table('vacation_requests')} AS request
          JOIN ${table('ns_vacations')} AS ns
            ON ns."guildId" = request."guildId"
           AND ns."userId" = request."userId"
          WHERE request."status" IN ('pending', 'activating', 'active', 'restoring')
            AND ns."type" IN ('shield', 'troll')
            AND ns."status" IN ('activating', 'active', 'restoring')
        ) AS overlapping_members
      `,
    },
    {
      id: 'vacation_requests_noncanonical_saved_roles',
      query: `
        SELECT COUNT(*)::text AS violations
        FROM ${table('vacation_requests')} AS request
        WHERE request."status" IN ('pending', 'activating', 'active', 'restoring')
          AND request."savedRoleIds" IS DISTINCT FROM ARRAY(
            SELECT DISTINCT role_id
            FROM unnest(COALESCE(request."savedRoleIds", ARRAY[]::TEXT[])) AS roles(role_id)
            WHERE role_id IS NOT NULL
            ORDER BY role_id
          )
      `,
    },
    {
      id: 'ns_vacations_noncanonical_saved_roles',
      query: `
        SELECT COUNT(*)::text AS violations
        FROM ${table('ns_vacations')} AS record
        WHERE record."status" IN ('activating', 'active', 'restoring')
          AND record."savedRoleIds" IS DISTINCT FROM ARRAY(
            SELECT DISTINCT role_id
            FROM unnest(COALESCE(record."savedRoleIds", ARRAY[]::TEXT[])) AS roles(role_id)
            WHERE role_id IS NOT NULL
            ORDER BY role_id
          )
      `,
    },
    {
      id: 'team_applications_duplicate_actionable',
      query: `
        SELECT COUNT(*)::text AS violations FROM (
          SELECT "teamId"
          FROM ${table('team_applications')}
          WHERE "status" IN ('pending', 'reviewing_approve', 'reviewing_reject')
          GROUP BY "teamId"
          HAVING COUNT(*) > 1
        ) AS duplicate_groups
      `,
    },
    {
      id: 'team_polls_duplicate_active',
      query: `
        SELECT COUNT(*)::text AS violations FROM (
          SELECT "teamId"
          FROM ${table('team_polls')}
          WHERE "status" = 'active'
          GROUP BY "teamId"
          HAVING COUNT(*) > 1
        ) AS duplicate_groups
      `,
    },
    {
      id: 'economy_raids_duplicate_live',
      query: `
        SELECT COUNT(*)::text AS violations FROM (
          SELECT "guildId"
          FROM ${table('economy_raids')}
          WHERE "status" IN ('pending', 'active')
          GROUP BY "guildId"
          HAVING COUNT(*) > 1
        ) AS duplicate_groups
      `,
    },
  ];
  if (profile === POSTFLIGHT_PROFILE.MIGRATION) return migrationChecks;

  const operationalCheckIds = new Set([
    'team_members_orphans',
    'team_members_duplicate_guild_user',
    'regbattle_squads_duplicate_guild_number',
    'regbattle_squads_duplicate_guild_owner',
    'vacation_requests_duplicate_live',
    'ns_vacations_duplicate_live_slot',
    'team_applications_duplicate_actionable',
    'team_polls_duplicate_active',
    'economy_raids_duplicate_live',
  ]);
  return migrationChecks.filter(({ id }) => operationalCheckIds.has(id));
}

const HARDENING_MIGRATION = '20260719010000_hardening';
const HARDENING_SHA256 = '84f224d922659e966ce1d7cde0cc5aae9327743a8c5b21e3a67cbea624ea0007';
const VACATION_ROLE_SNAPSHOT_MIGRATION = '20260721000000_vacation_role_snapshot_seal';
const VACATION_ROLE_SNAPSHOT_SHA256 = '341fab363c466627b908648181245fa24eea8dcd2325f7b5eee253dc50ff0772';
const MINECRAFT_FOUNDATION_MIGRATION = '20260724180000_minecraft_foundation';
const MINECRAFT_FOUNDATION_SHA256 = '927706176c284d3c55e6381cfc4d6be27617dc50924134bc3486c7da4fc72531';
const MINECRAFT_CHAT_MIGRATION = '20260724183500_add_chat_channel_id';
const MINECRAFT_CHAT_SHA256 = '874634c6be9c31e01328825b691fd339f0dd346f7225662c6eff4e4e0bfa8140';
const RUNTIME_SCHEMA_RECONCILIATION_MIGRATION = '20260727000000_reconcile_runtime_schema';
const RUNTIME_SCHEMA_RECONCILIATION_SHA256 = '8b681f2fe62227e7b6c5a45761e87b6d4460f8fe25061e4195400843e815495a';
const PRISMA_SCHEMA_PATH = resolve(__dirname, '..', 'prisma', 'schema.prisma');
const MIGRATIONS_PATH = resolve(__dirname, '..', 'prisma', 'migrations');

function migrationSpecs() {
  return [
    {
      name: BASELINE,
      sha256: BASELINE_SHA256,
      // Production adopts the immutable db-push baseline with `migrate resolve`
      // (zero SQL steps), while a fresh CI/rehearsal applies its SQL (one step).
      appliedStepsCounts: [0, 1],
    },
    {
      name: HARDENING_MIGRATION,
      sha256: HARDENING_SHA256,
      appliedStepsCounts: [1],
    },
    {
      name: VACATION_ROLE_SNAPSHOT_MIGRATION,
      sha256: VACATION_ROLE_SNAPSHOT_SHA256,
      appliedStepsCounts: [1],
    },
    {
      name: MINECRAFT_FOUNDATION_MIGRATION,
      sha256: MINECRAFT_FOUNDATION_SHA256,
      appliedStepsCounts: [1],
    },
    {
      name: MINECRAFT_CHAT_MIGRATION,
      sha256: MINECRAFT_CHAT_SHA256,
      appliedStepsCounts: [1],
    },
    {
      name: RUNTIME_SCHEMA_RECONCILIATION_MIGRATION,
      sha256: RUNTIME_SCHEMA_RECONCILIATION_SHA256,
      appliedStepsCounts: [1],
    },
  ];
}

function fileSha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function validateLocalMigrationFiles() {
  const specs = migrationSpecs();
  const expectedNames = specs.map((spec) => spec.name);
  const differences = [];
  let localNames;
  try {
    localNames = readdirSync(MIGRATIONS_PATH, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort(compareText);
  } catch {
    return ['cannot read local migration directory'];
  }
  if (JSON.stringify(localNames) !== JSON.stringify(expectedNames)) {
    differences.push(`local migration directories are not the exact audited prefix: ${localNames.join(', ') || '(none)'}`);
  }
  for (const spec of specs) {
    if (!/^\d{14}_[a-z0-9_]+$/.test(spec.name)) {
      differences.push(`local migration name has an invalid timestamp prefix: ${spec.name}`);
      continue;
    }
    let actualHash;
    try {
      actualHash = fileSha256(resolve(MIGRATIONS_PATH, spec.name, 'migration.sql'));
    } catch {
      differences.push(`cannot read local migration SQL: ${spec.name}`);
      continue;
    }
    if (actualHash !== spec.sha256) differences.push(`local migration checksum differs: ${spec.name}`);
  }
  return differences;
}

function validateMigrationHistoryRows(rows) {
  const specs = migrationSpecs();
  const differences = [...validateLocalMigrationFiles()];
  if (!Array.isArray(rows)) return [...differences, 'migration history query did not return rows'];

  if (rows.length !== specs.length) {
    differences.push(`migration history has ${rows.length} rows, expected exactly ${specs.length}`);
  }
  const knownNames = new Set(specs.map((spec) => spec.name));
  for (const row of rows) {
    if (!row || typeof row !== 'object') {
      differences.push('migration history contains a malformed row');
      continue;
    }
    if (!knownNames.has(row.migration_name)) differences.push(`unknown migration history row: ${String(row.migration_name)}`);
    if (row.rolled_back_at != null) differences.push(`rolled-back migration history row is forbidden: ${String(row.migration_name)}`);
    if (row.finished_at == null) differences.push(`unfinished migration history row: ${String(row.migration_name)}`);
    if (row.logs != null && String(row.logs).trim() !== '') {
      differences.push(`migration history row contains failure logs: ${String(row.migration_name)}`);
    }
  }

  for (let index = 0; index < specs.length; index += 1) {
    const spec = specs[index];
    const row = rows[index];
    if (!row || typeof row !== 'object') {
      differences.push(`missing migration history row at prefix position ${index}: ${spec.name}`);
      continue;
    }
    if (row.migration_name !== spec.name) {
      differences.push(`migration history prefix differs at position ${index}: expected ${spec.name}`);
      continue;
    }
    if (row.checksum !== spec.sha256) differences.push(`migration history checksum differs: ${spec.name}`);
    const steps = typeof row.applied_steps_count === 'bigint'
      ? Number(row.applied_steps_count)
      : row.applied_steps_count;
    if (typeof steps !== 'number'
      || !Number.isSafeInteger(steps)
      || !spec.appliedStepsCounts.includes(steps)) {
      differences.push(`migration history applied_steps_count differs: ${spec.name}`);
    }
    if (row.started_at == null) differences.push(`migration history started_at is missing: ${spec.name}`);
    const startedAt = new Date(row.started_at).getTime();
    const finishedAt = new Date(row.finished_at).getTime();
    if (!Number.isFinite(startedAt) || !Number.isFinite(finishedAt)) {
      differences.push(`migration history timestamps are invalid: ${spec.name}`);
    } else if (finishedAt < startedAt) {
      differences.push(`migration history finished before it started: ${spec.name}`);
    }
  }

  for (let index = 1; index < rows.length; index += 1) {
    const previous = rows[index - 1];
    const current = rows[index];
    if (previous?.finished_at == null || current?.started_at == null) continue;
    const previousFinished = new Date(previous.finished_at).getTime();
    const currentStarted = new Date(current.started_at).getTime();
    const isRetrospectiveMinecraftAdoption = (
      previous.migration_name === MINECRAFT_FOUNDATION_MIGRATION
      && current.migration_name === MINECRAFT_CHAT_MIGRATION
    );
    if (!Number.isFinite(previousFinished)
      || !Number.isFinite(currentStarted)
      || (previousFinished > currentStarted && !isRetrospectiveMinecraftAdoption)) {
      differences.push(`migration history is not chronological at prefix position ${index}`);
    }
  }
  return differences;
}

function prismaDiffArguments() {
  return [
    require.resolve('prisma/build/index.js'),
    'migrate',
    'diff',
    '--from-schema-datasource',
    PRISMA_SCHEMA_PATH,
    '--to-schema-datamodel',
    PRISMA_SCHEMA_PATH,
    '--exit-code',
  ];
}

function prismaDiffResultCheck(result) {
  if (!result.error && result.status === 0) {
    return { id: 'current_prisma_schema_exact', violations: '0', details: [] };
  }
  if (!result.error && result.status === 2) {
    return {
      id: 'current_prisma_schema_exact',
      violations: '1',
      details: ['database schema differs from the exact prisma/schema.prisma datamodel'],
    };
  }
  return {
    id: 'current_prisma_schema_exact',
    violations: '1',
    details: [`Prisma schema comparison could not complete (exit ${String(result.status)})`],
  };
}

function readExactPrismaSchemaCheck(databaseUrl) {
  return prismaDiffResultCheck(spawnSync(process.execPath, prismaDiffArguments(), {
    encoding: 'utf8',
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 120_000,
    maxBuffer: 1024 * 1024,
    windowsHide: true,
  }));
}

function requiredColumn(table, name, type, notNull, defaultValue = null) {
  return { table, name, type, notNull, default: normalizeDefault(defaultValue) };
}

function hardeningSchemaRequirements() {
  const columns = [
    requiredColumn('vacation_requests', 'activeKey', 'text', false),
    requiredColumn('vacation_requests', 'roleSnapshotAt', 'timestamp(3) without time zone', false),
    requiredColumn('ns_vacations', 'activeKey', 'text', false),
    requiredColumn('team_members', 'guildId', 'text', true),
    requiredColumn('team_invites', 'processingAt', 'timestamp(3) without time zone', false),
    requiredColumn('team_applications', 'activeKey', 'text', false),
    requiredColumn('team_applications', 'channelId', 'text', false),
    requiredColumn('team_applications', 'processingAt', 'timestamp(3) without time zone', false),
    requiredColumn('team_sessions', 'reportReminderAt', 'timestamp(3) without time zone', false),
    requiredColumn('team_sessions', 'squadVoiceId', 'text', false),
    requiredColumn('team_polls', 'activeKey', 'text', false),
    requiredColumn('team_polls', 'closedAt', 'timestamp(3) without time zone', false),
    requiredColumn('team_polls', 'dedupKey', 'text', false),
    requiredColumn('team_polls', 'notifiedKeys', 'text[]', true, 'ARRAY[]::TEXT[]'),
    requiredColumn('team_polls', 'uiClosedAt', 'timestamp(3) without time zone', false),
    requiredColumn('economy_raids', 'activeKey', 'text', false),
    requiredColumn('economy_black_market_listings', 'creatorId', 'text', false),

    requiredColumn('operation_claims', 'key', 'text', true),
    requiredColumn('operation_claims', 'scope', 'text', true),
    requiredColumn('operation_claims', 'guildId', 'text', false),
    requiredColumn('operation_claims', 'userId', 'text', false),
    requiredColumn('operation_claims', 'metadata', 'jsonb', false),
    requiredColumn('operation_claims', 'createdAt', 'timestamp(3) without time zone', true, 'CURRENT_TIMESTAMP'),
    requiredColumn('operation_claims', 'expiresAt', 'timestamp(3) without time zone', false),

    requiredColumn('team_poll_votes', 'id', 'text', true),
    requiredColumn('team_poll_votes', 'pollId', 'text', true),
    requiredColumn('team_poll_votes', 'userId', 'text', true),
    requiredColumn('team_poll_votes', 'vote', 'text', true),
    requiredColumn('team_poll_votes', 'readyTime', 'text', false),
    requiredColumn('team_poll_votes', 'createdAt', 'timestamp(3) without time zone', true, 'CURRENT_TIMESTAMP'),
    requiredColumn('team_poll_votes', 'updatedAt', 'timestamp(3) without time zone', true),

    requiredColumn('economy_black_market_deals', 'id', 'text', true),
    requiredColumn('economy_black_market_deals', 'listingId', 'text', true),
    requiredColumn('economy_black_market_deals', 'guildId', 'text', true),
    requiredColumn('economy_black_market_deals', 'sellerId', 'text', true),
    requiredColumn('economy_black_market_deals', 'buyerId', 'text', true),
    requiredColumn('economy_black_market_deals', 'itemKey', 'text', true),
    requiredColumn('economy_black_market_deals', 'name', 'text', true),
    requiredColumn('economy_black_market_deals', 'type', 'text', true),
    requiredColumn('economy_black_market_deals', 'quantity', 'integer', true),
    requiredColumn('economy_black_market_deals', 'unitPrice', 'integer', true),
    requiredColumn('economy_black_market_deals', 'totalPrice', 'integer', true),
    requiredColumn('economy_black_market_deals', 'description', 'character varying(255)', false),
    requiredColumn('economy_black_market_deals', 'perks', 'jsonb', false),
    requiredColumn('economy_black_market_deals', 'isCustom', 'boolean', true, 'false'),
    requiredColumn('economy_black_market_deals', 'creatorId', 'text', false),
    requiredColumn('economy_black_market_deals', 'status', 'text', true, "'pending'::TEXT"),
    requiredColumn('economy_black_market_deals', 'expiresAt', 'timestamp(3) without time zone', true),
    requiredColumn('economy_black_market_deals', 'createdAt', 'timestamp(3) without time zone', true, 'CURRENT_TIMESTAMP'),
    requiredColumn('economy_black_market_deals', 'updatedAt', 'timestamp(3) without time zone', true),
  ].sort((left, right) => compareText(`${left.table}.${left.name}`, `${right.table}.${right.name}`));

  const columnTypes = new Map(parseBaselineCatalog().columns.map((column) => (
    [`${column.table}.${column.name}`, column.type]
  )));
  for (const column of columns) columnTypes.set(`${column.table}.${column.name}`, column.type);
  const indexTypeMetadata = (table, keys) => {
    const opclasses = [];
    const collations = [];
    for (const key of keys) {
      const type = columnTypes.get(`${table}.${key}`);
      if (type === 'text') {
        opclasses.push('text_ops');
        collations.push('default');
      } else if (type === 'integer') {
        opclasses.push('int4_ops');
        collations.push(null);
      } else if (type === 'timestamp(3) without time zone') {
        opclasses.push('timestamp_ops');
        collations.push(null);
      } else {
        throw new Error(`Unsupported indexed column type in hardening projection: ${table}.${key} (${String(type)})`);
      }
    }
    return { opclasses, collations };
  };

  const indexes = [
    ['operation_claims_scope_guildId_userId_idx', 'operation_claims', false, ['scope', 'guildId', 'userId']],
    ['operation_claims_expiresAt_idx', 'operation_claims', false, ['expiresAt']],
    ['team_members_guildId_userId_key', 'team_members', true, ['guildId', 'userId']],
    ['regbattle_squads_guildId_number_key', 'regbattle_squads', true, ['guildId', 'number']],
    ['regbattle_squads_guildId_ownerId_key', 'regbattle_squads', true, ['guildId', 'ownerId']],
    ['vacation_requests_activeKey_key', 'vacation_requests', true, ['activeKey']],
    ['ns_vacations_activeKey_key', 'ns_vacations', true, ['activeKey']],
    ['team_applications_activeKey_key', 'team_applications', true, ['activeKey']],
    ['team_poll_votes_pollId_vote_idx', 'team_poll_votes', false, ['pollId', 'vote']],
    ['team_poll_votes_pollId_userId_key', 'team_poll_votes', true, ['pollId', 'userId']],
    ['team_polls_activeKey_key', 'team_polls', true, ['activeKey']],
    ['team_polls_dedupKey_key', 'team_polls', true, ['dedupKey']],
    ['team_sessions_squadVoiceId_key', 'team_sessions', true, ['squadVoiceId']],
    ['economy_raids_activeKey_key', 'economy_raids', true, ['activeKey']],
    ['economy_black_market_deals_listingId_key', 'economy_black_market_deals', true, ['listingId']],
    ['economy_black_market_deals_guildId_status_idx', 'economy_black_market_deals', false, ['guildId', 'status']],
    ['economy_black_market_deals_buyerId_status_idx', 'economy_black_market_deals', false, ['buyerId', 'status']],
    ['economy_black_market_deals_expiresAt_idx', 'economy_black_market_deals', false, ['expiresAt']],
  ].map(([name, table, unique, keys]) => ({
    name,
    table,
    unique,
    keys,
    included: [],
    nullsNotDistinct: false,
    options: keys.map(() => 0),
    ...indexTypeMetadata(table, keys),
  }))
    .sort((left, right) => compareText(left.name, right.name));

  return {
    relations: ['economy_black_market_deals', 'operation_claims', 'team_poll_votes'],
    columns,
    indexes,
    forbiddenIndexes: ['team_members_userId_key'],
    constraints: [
      { name: 'operation_claims_pkey', table: 'operation_claims', type: 'p', columns: ['key'], referencedTable: null, referencedColumns: [], onUpdate: ' ', onDelete: ' ' },
      { name: 'team_poll_votes_pkey', table: 'team_poll_votes', type: 'p', columns: ['id'], referencedTable: null, referencedColumns: [], onUpdate: ' ', onDelete: ' ' },
      { name: 'team_poll_votes_pollId_fkey', table: 'team_poll_votes', type: 'f', columns: ['pollId'], referencedTable: 'team_polls', referencedColumns: ['id'], onUpdate: 'c', onDelete: 'c' },
      { name: 'economy_black_market_deals_pkey', table: 'economy_black_market_deals', type: 'p', columns: ['id'], referencedTable: null, referencedColumns: [], onUpdate: ' ', onDelete: ' ' },
    ].sort((left, right) => compareText(left.name, right.name)),
  };
}

async function readHardeningSchemaCheck(tx, schema) {
  const requirements = hardeningSchemaRequirements();
  const requiredTables = [...new Set(requirements.columns.map((column) => column.table))];
  const relationRows = await tx.$queryRawUnsafe(`
    SELECT relation.relname AS name, relation.relkind AS kind
    FROM pg_class AS relation
    JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname = $1
      AND relation.relname IN (${requirements.relations.map(quoteLiteral).join(', ')})
    ORDER BY relation.relname
  `, schema);
  const columnRows = await tx.$queryRawUnsafe(`
    SELECT relation.relname AS table_name,
           attribute.attname AS name,
           format_type(attribute.atttypid, attribute.atttypmod) AS type,
           attribute.attnotnull AS not_null,
           pg_get_expr(default_value.adbin, default_value.adrelid) AS default_value
    FROM pg_attribute AS attribute
    JOIN pg_class AS relation ON relation.oid = attribute.attrelid
    JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
    LEFT JOIN pg_attrdef AS default_value
      ON default_value.adrelid = attribute.attrelid
      AND default_value.adnum = attribute.attnum
    WHERE namespace.nspname = $1
      AND relation.relname IN (${requiredTables.map(quoteLiteral).join(', ')})
      AND relation.relkind IN ('r', 'p')
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
    ORDER BY relation.relname, attribute.attname
  `, schema);
  const indexNames = [...requirements.indexes.map((index) => index.name), ...requirements.forbiddenIndexes];
  const indexRows = await tx.$queryRawUnsafe(`
    SELECT index_relation.relname AS name,
           table_relation.relname AS table_name,
           definition.indisunique AS is_unique,
           definition.indisvalid AS is_valid,
           definition.indisready AS is_ready,
           definition.indnullsnotdistinct AS nulls_not_distinct,
           access_method.amname AS method,
           pg_get_expr(definition.indpred, definition.indrelid) AS predicate,
           ARRAY(
             SELECT attribute.attname
             FROM unnest(definition.indkey::SMALLINT[]) WITH ORDINALITY AS key_column(attnum, ordinal)
             JOIN pg_attribute AS attribute
               ON attribute.attrelid = definition.indrelid AND attribute.attnum = key_column.attnum
             WHERE key_column.ordinal <= definition.indnkeyatts
             ORDER BY key_column.ordinal
           ) AS keys,
           ARRAY(
             SELECT attribute.attname
             FROM unnest(definition.indkey::SMALLINT[]) WITH ORDINALITY AS key_column(attnum, ordinal)
             JOIN pg_attribute AS attribute
               ON attribute.attrelid = definition.indrelid AND attribute.attnum = key_column.attnum
             WHERE key_column.ordinal > definition.indnkeyatts
             ORDER BY key_column.ordinal
           ) AS included,
           ARRAY(
             SELECT operator_class.opcname
             FROM unnest(definition.indclass::OID[]) WITH ORDINALITY AS operator_oid(oid, ordinal)
             JOIN pg_opclass AS operator_class ON operator_class.oid = operator_oid.oid
             ORDER BY operator_oid.ordinal
           ) AS opclasses,
           ARRAY(
             SELECT CASE WHEN collation_oid.oid = 0 THEN NULL ELSE collation_record.collname END
             FROM unnest(definition.indcollation::OID[]) WITH ORDINALITY AS collation_oid(oid, ordinal)
             LEFT JOIN pg_collation AS collation_record ON collation_record.oid = collation_oid.oid
             ORDER BY collation_oid.ordinal
           ) AS collations,
           definition.indoption::SMALLINT[] AS options
    FROM pg_index AS definition
    JOIN pg_class AS index_relation ON index_relation.oid = definition.indexrelid
    JOIN pg_class AS table_relation ON table_relation.oid = definition.indrelid
    JOIN pg_namespace AS namespace ON namespace.oid = index_relation.relnamespace
    JOIN pg_am AS access_method ON access_method.oid = index_relation.relam
    WHERE namespace.nspname = $1
      AND index_relation.relname IN (${indexNames.map(quoteLiteral).join(', ')})
    ORDER BY index_relation.relname
  `, schema);
  const constraintRows = await tx.$queryRawUnsafe(`
    SELECT constraint_record.conname AS name,
           relation.relname AS table_name,
           constraint_record.contype AS type,
           constraint_record.convalidated AS validated,
           constraint_record.condeferrable AS deferrable,
           constraint_record.condeferred AS deferred,
           referenced_relation.relname AS referenced_table,
           referenced_namespace.nspname AS referenced_schema,
           constraint_record.confupdtype AS on_update,
           constraint_record.confdeltype AS on_delete,
           ARRAY(
             SELECT attribute.attname
             FROM unnest(constraint_record.conkey) WITH ORDINALITY AS key_column(attnum, ordinal)
             JOIN pg_attribute AS attribute
               ON attribute.attrelid = constraint_record.conrelid AND attribute.attnum = key_column.attnum
             ORDER BY key_column.ordinal
           ) AS columns,
           ARRAY(
             SELECT attribute.attname
             FROM unnest(constraint_record.confkey) WITH ORDINALITY AS key_column(attnum, ordinal)
             JOIN pg_attribute AS attribute
               ON attribute.attrelid = constraint_record.confrelid AND attribute.attnum = key_column.attnum
             ORDER BY key_column.ordinal
           ) AS referenced_columns
    FROM pg_constraint AS constraint_record
    JOIN pg_class AS relation ON relation.oid = constraint_record.conrelid
    JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
    LEFT JOIN pg_class AS referenced_relation ON referenced_relation.oid = constraint_record.confrelid
    LEFT JOIN pg_namespace AS referenced_namespace ON referenced_namespace.oid = referenced_relation.relnamespace
    WHERE namespace.nspname = $1
      AND constraint_record.conname IN (${requirements.constraints.map((constraint) => quoteLiteral(constraint.name)).join(', ')})
    ORDER BY constraint_record.conname
  `, schema);

  const relationMap = new Map(relationRows.map((row) => [row.name, row.kind]));
  const columnMap = new Map(columnRows.map((row) => [`${row.table_name}.${row.name}`, {
    table: row.table_name,
    name: row.name,
    type: row.type,
    notNull: row.not_null,
    default: normalizeDefault(row.default_value),
  }]));
  const indexMap = new Map(indexRows.map((row) => [row.name, {
    name: row.name,
    table: row.table_name,
    unique: row.is_unique,
    valid: row.is_valid,
    ready: row.is_ready,
    method: row.method,
    predicate: row.predicate,
    keys: row.keys,
    included: row.included,
    opclasses: row.opclasses,
    collations: row.collations,
    options: row.options,
    nullsNotDistinct: row.nulls_not_distinct,
  }]));
  const constraintMap = new Map(constraintRows.map((row) => [row.name, {
    name: row.name,
    table: row.table_name,
    type: row.type,
    validated: row.validated,
    deferrable: row.deferrable,
    deferred: row.deferred,
    columns: row.columns,
    referencedTable: row.referenced_table,
    referencedSchema: row.referenced_schema,
    referencedColumns: row.referenced_columns,
    onUpdate: row.type === 'f' ? row.on_update : ' ',
    onDelete: row.type === 'f' ? row.on_delete : ' ',
  }]));

  const differences = [];
  for (const relation of requirements.relations) {
    const actualKind = relationMap.get(relation);
    if (actualKind == null) differences.push(`missing relation ${relation}`);
    else if (actualKind !== 'r') differences.push(`relation ${relation} has relkind ${actualKind}, expected r`);
  }
  for (const expected of requirements.columns) {
    const key = `${expected.table}.${expected.name}`;
    const actual = columnMap.get(key);
    if (!actual) differences.push(`missing column ${key}`);
    else if (JSON.stringify(actual) !== JSON.stringify(expected)) differences.push(`column definition differs for ${key}`);
  }
  for (const expected of requirements.indexes) {
    const actual = indexMap.get(expected.name);
    if (!actual) differences.push(`missing index ${expected.name}`);
    else if (actual.table !== expected.table
      || actual.unique !== expected.unique
      || actual.valid !== true
      || actual.ready !== true
      || actual.method !== 'btree'
      || actual.predicate !== null
      || JSON.stringify(actual.keys) !== JSON.stringify(expected.keys)
      || JSON.stringify(actual.included) !== JSON.stringify(expected.included)
      || JSON.stringify(actual.opclasses) !== JSON.stringify(expected.opclasses)
      || JSON.stringify(actual.collations) !== JSON.stringify(expected.collations)
      || JSON.stringify(actual.options) !== JSON.stringify(expected.options)
      || actual.nullsNotDistinct !== expected.nullsNotDistinct) {
      differences.push(`index definition differs for ${expected.name}`);
    }
  }
  for (const forbidden of requirements.forbiddenIndexes) {
    if (indexMap.has(forbidden)) differences.push(`obsolete index still exists: ${forbidden}`);
  }
  for (const expected of requirements.constraints) {
    const actual = constraintMap.get(expected.name);
    if (!actual) differences.push(`missing constraint ${expected.name}`);
    else if (actual.table !== expected.table
      || actual.type !== expected.type
      || actual.validated !== true
      || actual.deferrable !== false
      || actual.deferred !== false
      || JSON.stringify(actual.columns) !== JSON.stringify(expected.columns)
      || actual.referencedTable !== expected.referencedTable
      || actual.referencedSchema !== (expected.type === 'f' ? schema : null)
      || JSON.stringify(actual.referencedColumns) !== JSON.stringify(expected.referencedColumns)
      || actual.onUpdate !== expected.onUpdate
      || actual.onDelete !== expected.onDelete) {
      differences.push(`constraint definition differs for ${expected.name}`);
    }
  }

  const migrationTableExists = await tx.$queryRawUnsafe(`
    SELECT EXISTS (
      SELECT 1
      FROM pg_class AS relation
      JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = $1
        AND relation.relname = '_prisma_migrations'
        AND relation.relkind = 'r'
    ) AS exists
  `, schema);
  const localMigrationDifferences = validateLocalMigrationFiles();
  differences.push(...localMigrationDifferences);
  if (migrationTableExists.length !== 1 || migrationTableExists[0].exists !== true) {
    differences.push('missing Prisma migration history table');
  } else {
    const migrationRows = await tx.$queryRawUnsafe(`
      SELECT migration_name, checksum, started_at, finished_at, rolled_back_at, logs,
             applied_steps_count
      FROM ${quoteIdentifier(schema)}.${quoteIdentifier('_prisma_migrations')}
      ORDER BY migration_name, started_at, id
    `);
    differences.push(...validateMigrationHistoryRows(migrationRows)
      .filter((difference) => !localMigrationDifferences.includes(difference)));
  }

  return {
    id: 'hardening_schema_projection',
    violations: String(differences.length),
    details: differences,
  };
}

function postflightCheckDefinitions(schema, profile = POSTFLIGHT_PROFILE.MIGRATION) {
  if (!Object.values(POSTFLIGHT_PROFILE).includes(profile)) {
    throw new Error(`Unsupported postflight profile: ${String(profile)}`);
  }
  const table = (name) => `${quoteIdentifier(schema)}.${quoteIdentifier(name)}`;
  const operationClaimsCheck = profile === POSTFLIGHT_PROFILE.MIGRATION
    ? {
      id: 'operation_claims_initially_empty',
      query: `SELECT COUNT(*)::text AS violations FROM ${table('operation_claims')}`,
    }
    : {
      id: 'operation_claims_runtime_integrity',
      query: `
        SELECT COUNT(*)::text AS violations
        FROM ${table('operation_claims')}
        WHERE btrim("key") = ''
           OR btrim("scope") = ''
           OR ("guildId" IS NOT NULL AND btrim("guildId") = '')
           OR ("userId" IS NOT NULL AND btrim("userId") = '')
           OR ("expiresAt" IS NOT NULL AND "expiresAt" < "createdAt")
      `,
    };
  const migrationChecks = [
    {
      id: 'team_members_parent_guild_backfill',
      query: `
        SELECT COUNT(*)::text AS violations
        FROM ${table('team_members')} AS member
        LEFT JOIN ${table('teams')} AS team ON team."id" = member."teamId"
        WHERE team."id" IS NULL OR member."guildId" IS DISTINCT FROM team."guildId"
      `,
    },
    {
      id: 'vacation_requests_active_key_semantics',
      query: `
        SELECT COUNT(*)::text AS violations
        FROM ${table('vacation_requests')}
        WHERE "activeKey" IS DISTINCT FROM CASE
          WHEN "status" IN ('pending', 'activating', 'active', 'restoring')
            THEN "guildId" || ':' || "userId"
          ELSE NULL
        END
      `,
    },
    {
      id: 'vacation_requests_live_role_snapshot_sealed',
      query: `
        SELECT COUNT(*)::text AS violations
        FROM ${table('vacation_requests')}
        WHERE "status" IN ('activating', 'active', 'restoring')
          AND "roleSnapshotAt" IS NULL
      `,
    },
    {
      id: 'ns_vacations_active_key_semantics',
      query: `
        SELECT COUNT(*)::text AS violations
        FROM ${table('ns_vacations')}
        WHERE "activeKey" IS DISTINCT FROM CASE
          WHEN "status" IN ('activating', 'active', 'restoring')
            THEN "guildId" || ':' || "userId" || ':' ||
              CASE WHEN "type" = 'vacation' THEN 'vacation' ELSE 'roles' END
          ELSE NULL
        END
      `,
    },
    {
      id: 'team_applications_active_key_semantics',
      query: `
        SELECT COUNT(*)::text AS violations
        FROM ${table('team_applications')}
        WHERE "activeKey" IS DISTINCT FROM CASE
          WHEN "status" IN ('pending', 'reviewing_approve', 'reviewing_reject')
            THEN "teamId"
          ELSE NULL
        END
      `,
    },
    {
      id: 'team_polls_active_key_semantics',
      query: `
        SELECT COUNT(*)::text AS violations
        FROM ${table('team_polls')}
        WHERE "activeKey" IS DISTINCT FROM CASE WHEN "status" = 'active' THEN "teamId" ELSE NULL END
      `,
    },
    {
      id: 'economy_raids_active_key_semantics',
      query: `
        SELECT COUNT(*)::text AS violations
        FROM ${table('economy_raids')}
        WHERE "activeKey" IS DISTINCT FROM CASE
          WHEN "status" IN ('pending', 'active') THEN "guildId"
          ELSE NULL
        END
      `,
    },
    operationClaimsCheck,
    {
      id: 'economy_black_market_deals_initially_empty',
      query: `SELECT COUNT(*)::text AS violations FROM ${table('economy_black_market_deals')}`,
    },
    {
      id: 'team_invites_processing_at_initially_null',
      query: `
        SELECT COUNT(*)::text AS violations
        FROM ${table('team_invites')}
        WHERE "processingAt" IS NOT NULL
      `,
    },
    {
      id: 'team_applications_new_columns_initially_null',
      query: `
        SELECT COUNT(*)::text AS violations
        FROM ${table('team_applications')}
        WHERE "channelId" IS NOT NULL OR "processingAt" IS NOT NULL
      `,
    },
    {
      id: 'team_sessions_report_reminder_initially_null',
      query: `
        SELECT COUNT(*)::text AS violations
        FROM ${table('team_sessions')}
        WHERE "reportReminderAt" IS NOT NULL
      `,
    },
    {
      id: 'team_polls_new_columns_initial_values',
      query: `
        SELECT COUNT(*)::text AS violations
        FROM ${table('team_polls')}
        WHERE "notifiedKeys" IS DISTINCT FROM ARRAY[]::TEXT[] OR "uiClosedAt" IS NOT NULL
      `,
    },
    {
      id: 'black_market_listing_creator_initially_null',
      query: `
        SELECT COUNT(*)::text AS violations
        FROM ${table('economy_black_market_listings')}
        WHERE "creatorId" IS NOT NULL
      `,
    },
    {
      id: 'team_polls_closed_at_backfill',
      query: `
        WITH original_active AS (
          SELECT poll.*,
            ROW_NUMBER() OVER (
              PARTITION BY poll."teamId"
              ORDER BY (poll."messageId" IS NOT NULL) DESC, poll."createdAt" DESC, poll."id"
            ) AS expected_rank
          FROM ${table('team_polls')} AS poll
          WHERE poll."status" = 'active'
             OR (poll."status" = 'closed' AND poll."closedAt" IS DISTINCT FROM poll."createdAt")
        ), invalid_rows AS (
          SELECT poll."id"
          FROM ${table('team_polls')} AS poll
          WHERE poll."status" NOT IN ('active', 'closed')
             OR (poll."status" = 'active' AND poll."closedAt" IS NOT NULL)
             OR (poll."status" = 'closed' AND poll."closedAt" IS NULL)
          UNION ALL
          SELECT candidate."id"
          FROM original_active AS candidate
          WHERE (candidate.expected_rank = 1 AND candidate."status" <> 'active')
             OR (candidate.expected_rank > 1 AND (
               candidate."status" <> 'closed'
               OR candidate."closedAt" IS NOT DISTINCT FROM candidate."createdAt"
             ))
        ), loser_timestamp_groups AS (
          SELECT "teamId"
          FROM original_active
          WHERE expected_rank > 1
          GROUP BY "teamId"
          HAVING COUNT(DISTINCT "closedAt") <> 1
        )
        SELECT (
          (SELECT COUNT(*) FROM invalid_rows) +
          (SELECT COUNT(*) FROM loser_timestamp_groups)
        )::text AS violations
      `,
    },
    {
      id: 'team_polls_dedup_key_backfill',
      query: `
        WITH ranked AS (
          SELECT poll."id", poll."teamId", poll."createdAt", ROW_NUMBER() OVER (
            PARTITION BY poll."teamId", (poll."createdAt" + INTERVAL '3 hours')::DATE
            ORDER BY poll."createdAt" DESC, poll."id"
          ) AS rn
          FROM ${table('team_polls')} AS poll
          WHERE poll."type" = 'auto'
        ), expected AS (
          SELECT poll."id", CASE WHEN ranked.rn = 1
            THEN 'auto:' || ranked."teamId" || ':' ||
              to_char(ranked."createdAt" + INTERVAL '3 hours', 'YYYY-MM-DD')
            ELSE NULL
          END AS "dedupKey"
          FROM ${table('team_polls')} AS poll
          LEFT JOIN ranked ON ranked."id" = poll."id"
        )
        SELECT COUNT(*)::text AS violations
        FROM ${table('team_polls')} AS poll
        JOIN expected ON expected."id" = poll."id"
        WHERE poll."dedupKey" IS DISTINCT FROM expected."dedupKey"
      `,
    },
    {
      id: 'team_poll_votes_legacy_normalization',
      query: `
        WITH expected_yes AS (
          SELECT DISTINCT poll."id" AS "pollId", vote."userId", 'yes'::TEXT AS vote,
            CASE WHEN jsonb_typeof(poll."voteTimes") = 'object'
              THEN poll."voteTimes" ->> vote."userId" ELSE NULL END AS "readyTime",
            'legacy_yes_' || md5(poll."id" || ':' || vote."userId") AS id
          FROM ${table('team_polls')} AS poll
          CROSS JOIN LATERAL unnest(COALESCE(poll."yesUserIds", ARRAY[]::TEXT[])) AS vote("userId")
        ), expected_no AS (
          SELECT DISTINCT poll."id" AS "pollId", vote."userId", 'no'::TEXT AS vote,
            NULL::TEXT AS "readyTime",
            'legacy_no_' || md5(poll."id" || ':' || vote."userId") AS id
          FROM ${table('team_polls')} AS poll
          CROSS JOIN LATERAL unnest(COALESCE(poll."noUserIds", ARRAY[]::TEXT[])) AS vote("userId")
          WHERE NOT (vote."userId" = ANY(COALESCE(poll."yesUserIds", ARRAY[]::TEXT[])))
        ), expected AS (
          SELECT * FROM expected_yes UNION ALL SELECT * FROM expected_no
        ), missing_or_changed AS (
          SELECT expected."pollId", expected."userId"
          FROM expected
          LEFT JOIN ${table('team_poll_votes')} AS actual
            ON actual."pollId" = expected."pollId" AND actual."userId" = expected."userId"
          WHERE actual."id" IS NULL
            OR actual."id" IS DISTINCT FROM expected.id
            OR actual."vote" IS DISTINCT FROM expected.vote
            OR actual."readyTime" IS DISTINCT FROM expected."readyTime"
            OR actual."createdAt" IS DISTINCT FROM (
              SELECT poll."createdAt" FROM ${table('team_polls')} AS poll WHERE poll."id" = expected."pollId"
            )
        ), unexpected AS (
          SELECT actual."pollId", actual."userId"
          FROM ${table('team_poll_votes')} AS actual
          LEFT JOIN expected
            ON expected."pollId" = actual."pollId" AND expected."userId" = actual."userId"
          WHERE expected."pollId" IS NULL
        )
        SELECT COUNT(*)::text AS violations FROM (
          SELECT * FROM missing_or_changed UNION ALL SELECT * FROM unexpected
        ) AS differences
      `,
    },
    {
      id: 'team_sessions_squad_voice_backfill',
      query: `
        WITH candidates AS (
          SELECT session."id", squad."voiceChannelId", ROW_NUMBER() OVER (
            PARTITION BY squad."voiceChannelId"
            ORDER BY session."startedAt" DESC, session."id"
          ) AS rn
          FROM ${table('team_sessions')} AS session
          JOIN ${table('regbattle_squads')} AS squad
            ON squad."guildId" = session."guildId" AND squad."number" = session."squadNumber"
          WHERE session."endedAt" IS NULL
        ), expected AS (
          SELECT "id", "voiceChannelId" FROM candidates WHERE rn = 1
        )
        SELECT COUNT(*)::text AS violations
        FROM ${table('team_sessions')} AS session
        LEFT JOIN expected ON expected."id" = session."id"
        WHERE session."squadVoiceId" IS DISTINCT FROM expected."voiceChannelId"
      `,
    },
  ];

  if (profile === POSTFLIGHT_PROFILE.MIGRATION) return migrationChecks;

  // One-time initial/backfill assertions cannot be replayed after normal bot
  // activity. Keep only invariants that every supported runtime transition
  // preserves, and validate the operational claims table structurally.
  const durableCheckIds = new Set([
    'team_members_parent_guild_backfill',
    'vacation_requests_active_key_semantics',
    'ns_vacations_active_key_semantics',
    'team_polls_active_key_semantics',
    'economy_raids_active_key_semantics',
    'operation_claims_runtime_integrity',
    'team_polls_dedup_key_backfill',
  ]);
  const durableChecks = migrationChecks.filter(({ id }) => durableCheckIds.has(id));
  durableChecks.splice(2, 0, {
    id: 'vacation_requests_live_role_snapshot_runtime_integrity',
    query: `
      SELECT COUNT(*)::text AS violations
      FROM ${table('vacation_requests')}
      WHERE "status" IN ('active', 'restoring')
        AND "roleSnapshotAt" IS NULL
    `,
  });
  return durableChecks;
}

function expectedPostflightCheckIds(schema, profile = POSTFLIGHT_PROFILE.MIGRATION) {
  return [
    'hardening_schema_projection',
    'current_prisma_schema_exact',
    ...preflightCheckDefinitions(schema, profile).map(({ id }) => id),
    ...postflightCheckDefinitions(schema, profile).map(({ id }) => id),
  ];
}

function postflightCountDefinitions(schema) {
  const table = (name) => `${quoteIdentifier(schema)}.${quoteIdentifier(name)}`;
  return ['operation_claims', 'team_poll_votes', 'economy_black_market_deals'].map((name) => ({
    id: `${name}_rows`,
    query: `SELECT COUNT(*)::text AS count FROM ${table(name)}`,
  }));
}

async function readPreflightChecks(tx, schema, profile = POSTFLIGHT_PROFILE.MIGRATION) {
  const checks = [];
  for (const definition of preflightCheckDefinitions(schema, profile)) {
    const rows = await tx.$queryRawUnsafe(definition.query);
    const violations = rows[0]?.violations;
    if (rows.length !== 1 || typeof violations !== 'string' || !/^(0|[1-9]\d*)$/.test(violations)) {
      throw new Error(`Preflight check returned an invalid result: ${definition.id}`);
    }
    checks.push({ id: definition.id, violations });
  }
  return checks;
}

async function readCountChecks(tx, definitions, field = 'violations') {
  const checks = [];
  for (const definition of definitions) {
    const rows = await tx.$queryRawUnsafe(definition.query);
    const count = rows[0]?.[field];
    if (rows.length !== 1 || typeof count !== 'string' || !/^(0|[1-9]\d*)$/.test(count)) {
      throw new Error(`Postflight query returned an invalid ${field}: ${definition.id}`);
    }
    checks.push({ id: definition.id, [field]: count });
  }
  return checks;
}

async function inspectPostflightDatabase(
  databaseUrl,
  profile = POSTFLIGHT_PROFILE.MIGRATION,
) {
  const schema = targetSchemaFromDatabaseUrl(databaseUrl);
  const catalog = parseBaselineCatalog();
  const tableColumns = tableColumnsFromCatalog(catalog);
  // Validate the profile before opening a database connection.
  postflightCheckDefinitions(schema, profile);
  const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });

  try {
    return await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
      await assertBaselineProjection(tx, schema, catalog);
      const schemaCheck = await readHardeningSchemaCheck(tx, schema);
      const semanticDefinitions = postflightCheckDefinitions(schema, profile);
      if (schemaCheck.violations !== '0') {
        return {
          format: POSTFLIGHT_FORMAT,
          profile,
          status: 'blocked',
          baseline: baselineMetadata(),
          hardeningMigration: HARDENING_MIGRATION,
          schema,
          tableCount: tableColumns.size,
          checks: [schemaCheck],
          counts: [],
          skippedChecks: semanticDefinitions.map(({ id }) => id),
        };
      }
      const exactSchemaCheck = readExactPrismaSchemaCheck(databaseUrl);
      if (exactSchemaCheck.violations !== '0') {
        return {
          format: POSTFLIGHT_FORMAT,
          profile,
          status: 'blocked',
          baseline: baselineMetadata(),
          hardeningMigration: HARDENING_MIGRATION,
          schema,
          tableCount: tableColumns.size,
          checks: [schemaCheck, exactSchemaCheck],
          counts: [],
          skippedChecks: semanticDefinitions.map(({ id }) => id),
        };
      }

      const baselineChecks = await readPreflightChecks(tx, schema, profile);
      const semanticChecks = await readCountChecks(tx, semanticDefinitions);
      const counts = await readCountChecks(tx, postflightCountDefinitions(schema), 'count');
      const checks = [schemaCheck, exactSchemaCheck, ...baselineChecks, ...semanticChecks];
      return {
        format: POSTFLIGHT_FORMAT,
        profile,
        status: checks.every((check) => check.violations === '0') ? 'ok' : 'blocked',
        baseline: baselineMetadata(),
        hardeningMigration: HARDENING_MIGRATION,
        schema,
        tableCount: tableColumns.size,
        checks,
        counts,
        skippedChecks: [],
      };
    }, {
      isolationLevel: 'RepeatableRead',
      maxWait: 10_000,
      timeout: 900_000,
    });
  } finally {
    await prisma.$disconnect();
  }
}

async function createPostflightReport(
  databaseUrl = process.env.DATABASE_URL,
  profile = POSTFLIGHT_PROFILE.MIGRATION,
) {
  return inspectPostflightDatabase(databaseUrl, profile);
}

function buildFingerprintQuery(schema, table, columns) {
  if (!Array.isArray(columns) || !columns.length) {
    throw new Error(`Cannot fingerprint a table without baseline columns: ${table}`);
  }
  const values = columns.map((column) => `source.${quoteIdentifier(column)}`).join(', ');
  return `
    WITH canonical_rows AS MATERIALIZED (
      SELECT jsonb_build_array(${values})::text COLLATE "C" AS payload
      FROM ${quoteIdentifier(schema)}.${quoteIdentifier(table)} AS source
    ), row_hashes AS MATERIALIZED (
      SELECT payload,
             encode(sha256(convert_to(payload, 'UTF8')), 'hex') AS row_hash
      FROM canonical_rows
    )
    SELECT COUNT(*)::text AS row_count,
           encode(sha256(convert_to(
             COALESCE(string_agg(row_hash, '' ORDER BY payload), ''),
             'UTF8'
           )), 'hex') AS fingerprint
    FROM row_hashes
  `;
}

async function readTableFingerprints(tx, schema, tableColumns) {
  const tables = [];
  for (const [table, columns] of tableColumns) {
    const rows = await tx.$queryRawUnsafe(buildFingerprintQuery(schema, table, columns));
    const rowCount = rows[0]?.row_count;
    const fingerprint = rows[0]?.fingerprint;
    if (rows.length !== 1
      || typeof rowCount !== 'string'
      || !/^(0|[1-9]\d*)$/.test(rowCount)
      || typeof fingerprint !== 'string'
      || !/^[0-9a-f]{64}$/.test(fingerprint)) {
      throw new Error(`PostgreSQL returned an invalid fingerprint for baseline table: ${table}`);
    }
    tables.push({ table, columns: [...columns], rowCount, fingerprint });
  }
  return tables;
}

async function readSequenceStates(tx, schema, sequenceNames) {
  const sequences = [];
  for (const sequence of sequenceNames) {
    const rows = await tx.$queryRawUnsafe(`
      SELECT last_value::text AS last_value, is_called
      FROM ${quoteIdentifier(schema)}.${quoteIdentifier(sequence)}
    `);
    const lastValue = rows[0]?.last_value;
    const isCalled = rows[0]?.is_called;
    if (rows.length !== 1
      || typeof lastValue !== 'string'
      || !/^-?(?:0|[1-9]\d*)$/.test(lastValue)
      || typeof isCalled !== 'boolean') {
      throw new Error(`PostgreSQL returned an invalid state for baseline sequence: ${sequence}`);
    }
    sequences.push({ sequence, lastValue, isCalled });
  }
  return sequences;
}

function makePreflightReport(schema, tableCount, checks, profile) {
  return {
    format: PREFLIGHT_FORMAT,
    profile,
    status: checks.every((check) => check.violations === '0') ? 'ok' : 'blocked',
    baseline: baselineMetadata(),
    schema,
    tableCount,
    checks,
  };
}

async function inspectDatabase(
  databaseUrl,
  includeFingerprints,
  profile = POSTFLIGHT_PROFILE.MIGRATION,
) {
  const schema = targetSchemaFromDatabaseUrl(databaseUrl);
  const catalog = parseBaselineCatalog();
  const tableColumns = tableColumnsFromCatalog(catalog);
  // Validate the selected profile before opening a database connection.
  preflightCheckDefinitions(schema, profile);
  const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });

  try {
    return await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
      await assertBaselineProjection(tx, schema, catalog);
      const checks = await readPreflightChecks(tx, schema, profile);
      const report = makePreflightReport(schema, tableColumns.size, checks, profile);
      if (!includeFingerprints || report.status !== 'ok') return { report, snapshot: null };

      const tables = await readTableFingerprints(tx, schema, tableColumns);
      // Sequence state is deliberately captured last. PostgreSQL sequences are
      // not MVCC objects, so the release runbook must keep every writer stopped
      // for the full snapshot (including this read) to make the pair coherent.
      const sequences = await readSequenceStates(tx, schema, catalog.sequences);
      return {
        report,
        snapshot: {
          format: SNAPSHOT_FORMAT,
          profile,
          status: 'ok',
          baseline: baselineMetadata(),
          schema,
          fingerprintAlgorithm: FINGERPRINT_ALGORITHM,
          consistency: { ...SNAPSHOT_CONSISTENCY },
          tableCount: tables.length,
          sequenceCount: sequences.length,
          invariants: checks,
          tables,
          sequences,
        },
      };
    }, {
      isolationLevel: 'RepeatableRead',
      maxWait: 10_000,
      timeout: 900_000,
    });
  } finally {
    await prisma.$disconnect();
  }
}

async function createPreflightReport(
  databaseUrl = process.env.DATABASE_URL,
  profile = POSTFLIGHT_PROFILE.MIGRATION,
) {
  const result = await inspectDatabase(databaseUrl, false, profile);
  return result.report;
}

async function createSnapshot(
  databaseUrl = process.env.DATABASE_URL,
  profile = POSTFLIGHT_PROFILE.MIGRATION,
) {
  const result = await inspectDatabase(databaseUrl, true, profile);
  if (!result.snapshot) throw new InvariantViolationError(result.report);
  return result.snapshot;
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function assertValidSnapshot(snapshot) {
  if (!isPlainObject(snapshot) || snapshot.format !== SNAPSHOT_FORMAT || snapshot.status !== 'ok') {
    throw new Error(`Snapshot must use ${SNAPSHOT_FORMAT} with status=ok.`);
  }
  // v2 snapshots created before profiles existed are strict migration
  // snapshots. Normalize by copying so callers' evidence objects stay intact.
  if (!Object.prototype.hasOwnProperty.call(snapshot, 'profile')) {
    snapshot = { ...snapshot, profile: POSTFLIGHT_PROFILE.MIGRATION };
  }
  if (!Object.values(POSTFLIGHT_PROFILE).includes(snapshot.profile)) {
    throw new Error(`Snapshot contains an unsupported data-gate profile: ${String(snapshot.profile)}`);
  }
  if (!isPlainObject(snapshot.baseline)
    || snapshot.baseline.migration !== BASELINE
    || snapshot.baseline.sha256 !== BASELINE_SHA256) {
    throw new Error('Snapshot does not match the immutable baseline migration in this image.');
  }
  if (typeof snapshot.schema !== 'string' || !snapshot.schema || snapshot.schema.includes('\0')) {
    throw new Error('Snapshot contains an invalid schema name.');
  }
  if (snapshot.fingerprintAlgorithm !== FINGERPRINT_ALGORITHM) {
    throw new Error(`Snapshot uses an unsupported fingerprint algorithm: ${String(snapshot.fingerprintAlgorithm)}`);
  }
  if (!isPlainObject(snapshot.consistency)
    || snapshot.consistency.tableData !== SNAPSHOT_CONSISTENCY.tableData
    || snapshot.consistency.sequences !== SNAPSHOT_CONSISTENCY.sequences
    || snapshot.consistency.writerStateRequired !== SNAPSHOT_CONSISTENCY.writerStateRequired) {
    throw new Error('Snapshot does not state the required table/sequence consistency assumptions.');
  }

  const catalog = parseBaselineCatalog();
  const expectedTables = tableColumnsFromCatalog(catalog);
  if (snapshot.tableCount !== expectedTables.size
    || !Array.isArray(snapshot.tables)
    || snapshot.tables.length !== expectedTables.size) {
    throw new Error(`Snapshot must contain exactly ${expectedTables.size} immutable baseline tables.`);
  }

  const expectedChecks = preflightCheckDefinitions(snapshot.schema, snapshot.profile)
    .map((check) => check.id);
  if (!Array.isArray(snapshot.invariants)
    || snapshot.invariants.length !== expectedChecks.length
    || snapshot.invariants.some((check, index) => !isPlainObject(check)
      || check.id !== expectedChecks[index]
      || check.violations !== '0')) {
    throw new Error('Snapshot does not contain a passing, complete baseline-data preflight.');
  }

  const expectedEntries = [...expectedTables.entries()];
  for (let index = 0; index < expectedEntries.length; index += 1) {
    const [expectedTable, expectedColumns] = expectedEntries[index];
    const actual = snapshot.tables[index];
    if (!isPlainObject(actual)
      || actual.table !== expectedTable
      || JSON.stringify(actual.columns) !== JSON.stringify(expectedColumns)) {
      throw new Error(`Snapshot baseline table catalog differs at position ${index}: expected ${expectedTable}.`);
    }
    if (typeof actual.rowCount !== 'string' || !/^(0|[1-9]\d*)$/.test(actual.rowCount)) {
      throw new Error(`Snapshot contains an invalid row count for table: ${expectedTable}`);
    }
    if (typeof actual.fingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(actual.fingerprint)) {
      throw new Error(`Snapshot contains an invalid fingerprint for table: ${expectedTable}`);
    }
  }

  if (snapshot.sequenceCount !== catalog.sequences.length
    || !Array.isArray(snapshot.sequences)
    || snapshot.sequences.length !== catalog.sequences.length) {
    throw new Error(`Snapshot must contain exactly ${catalog.sequences.length} immutable baseline sequences.`);
  }
  for (let index = 0; index < catalog.sequences.length; index += 1) {
    const expectedSequence = catalog.sequences[index];
    const actual = snapshot.sequences[index];
    if (!isPlainObject(actual) || actual.sequence !== expectedSequence) {
      throw new Error(`Snapshot baseline sequence catalog differs at position ${index}: expected ${expectedSequence}.`);
    }
    if (typeof actual.lastValue !== 'string' || !/^-?(?:0|[1-9]\d*)$/.test(actual.lastValue)) {
      throw new Error(`Snapshot contains an invalid last_value for sequence: ${expectedSequence}`);
    }
    if (typeof actual.isCalled !== 'boolean') {
      throw new Error(`Snapshot contains an invalid is_called for sequence: ${expectedSequence}`);
    }
  }
  return snapshot;
}

function compareSnapshots(beforeInput, afterInput) {
  const before = assertValidSnapshot(beforeInput);
  const after = assertValidSnapshot(afterInput);
  const differences = [];

  if (before.schema !== after.schema) {
    differences.push({ field: 'schema', before: before.schema, after: after.schema });
  }
  if (before.profile !== after.profile) {
    differences.push({ field: 'profile', before: before.profile, after: after.profile });
  }
  for (let index = 0; index < before.tables.length; index += 1) {
    const beforeTable = before.tables[index];
    const afterTable = after.tables[index];
    if (beforeTable.rowCount !== afterTable.rowCount) {
      differences.push({
        table: beforeTable.table,
        field: 'rowCount',
        before: beforeTable.rowCount,
        after: afterTable.rowCount,
      });
    }
    if (beforeTable.fingerprint !== afterTable.fingerprint) {
      differences.push({
        table: beforeTable.table,
        field: 'fingerprint',
        before: beforeTable.fingerprint,
        after: afterTable.fingerprint,
      });
    }
  }
  for (let index = 0; index < before.sequences.length; index += 1) {
    const beforeSequence = before.sequences[index];
    const afterSequence = after.sequences[index];
    if (beforeSequence.lastValue !== afterSequence.lastValue) {
      differences.push({
        sequence: beforeSequence.sequence,
        field: 'lastValue',
        before: beforeSequence.lastValue,
        after: afterSequence.lastValue,
      });
    }
    if (beforeSequence.isCalled !== afterSequence.isCalled) {
      differences.push({
        sequence: beforeSequence.sequence,
        field: 'isCalled',
        before: beforeSequence.isCalled,
        after: afterSequence.isCalled,
      });
    }
  }

  return {
    format: COMPARISON_FORMAT,
    status: differences.length ? 'different' : 'identical',
    baseline: baselineMetadata(),
    profile: before.profile,
    schema: before.schema,
    tableCount: before.tableCount,
    sequenceCount: before.sequenceCount,
    differences,
  };
}

function parseArguments(argv) {
  let mode = 'snapshot';
  let explicitMode = false;
  let output = null;
  let before = null;
  let after = null;

  const chooseMode = (nextMode) => {
    if (explicitMode) {
      throw new Error(
        'Choose exactly one mode: --snapshot, --preflight, --postflight, '
          + '--snapshot-operational, --preflight-operational, '
          + '--postflight-operational, or --compare.',
      );
    }
    mode = nextMode;
    explicitMode = true;
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--snapshot') {
      chooseMode('snapshot');
    } else if (argument === '--snapshot-operational') {
      chooseMode('snapshot-operational');
    } else if (argument === '--preflight') {
      chooseMode('preflight');
    } else if (argument === '--preflight-operational') {
      chooseMode('preflight-operational');
    } else if (argument === '--postflight') {
      chooseMode('postflight');
    } else if (argument === '--postflight-operational') {
      chooseMode('postflight-operational');
    } else if (argument === '--compare') {
      chooseMode('compare');
      before = argv[++index];
      after = argv[++index];
      if (!before || !after || before.startsWith('--') || after.startsWith('--')) {
        throw new Error('--compare requires two snapshot JSON file paths.');
      }
    } else if (argument === '--output') {
      output = argv[++index];
      if (!output || output.startsWith('--') || output === '-') {
        throw new Error('--output requires a file path other than "-". Omit it to use stdout.');
      }
    } else if (argument === '--help' || argument === '-h') {
      chooseMode('help');
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  return { mode, output, before, after };
}

function serialize(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function writeResult(value, output) {
  const content = serialize(value);
  if (output) {
    writeFileSync(resolve(output), content, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  } else {
    process.stdout.write(content);
  }
}

function readSnapshotFile(path) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(resolve(path), 'utf8'));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Cannot read snapshot JSON ${path}: ${reason}`);
  }
  return assertValidSnapshot(parsed);
}

function printHelp() {
  process.stdout.write([
    'Usage:',
    '  node scripts/snapshot-baseline-data.js [--snapshot] [--output snapshot.json]',
    '  node scripts/snapshot-baseline-data.js --snapshot-operational [--output snapshot.json]',
    '  node scripts/snapshot-baseline-data.js --preflight [--output report.json]',
    '  node scripts/snapshot-baseline-data.js --preflight-operational [--output report.json]',
    '  node scripts/snapshot-baseline-data.js --postflight [--output report.json]',
    '  node scripts/snapshot-baseline-data.js --postflight-operational [--output report.json]',
    '  node scripts/snapshot-baseline-data.js --compare before.json after.json [--output comparison.json]',
    '',
    'Snapshot consistency requirement:',
    '  PostgreSQL sequences are non-MVCC. Stop every database writer for the entire',
    '  before/after snapshot so table fingerprints and sequence state are coherent.',
    '  Run --postflight once after the hardening migration and before starting the bot.',
    '  Use the explicit *-operational modes only for an already-running migrated',
    '  database. They retain durable invariants while excluding one-time migration',
    '  assertions; runtime operation claims remain structurally validated.',
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
      readSnapshotFile(options.before),
      readSnapshotFile(options.after),
    );
    writeResult(comparison, options.output);
    return comparison.status === 'identical' ? 0 : 1;
  }
  if (options.mode === 'preflight') {
    const report = await createPreflightReport();
    writeResult(report, options.output);
    return report.status === 'ok' ? 0 : 1;
  }
  if (options.mode === 'preflight-operational') {
    const report = await createPreflightReport(
      process.env.DATABASE_URL,
      POSTFLIGHT_PROFILE.OPERATIONAL,
    );
    writeResult(report, options.output);
    return report.status === 'ok' ? 0 : 1;
  }
  if (options.mode === 'postflight') {
    const report = await createPostflightReport();
    writeResult(report, options.output);
    return report.status === 'ok' ? 0 : 1;
  }
  if (options.mode === 'postflight-operational') {
    const report = await createPostflightReport(
      process.env.DATABASE_URL,
      POSTFLIGHT_PROFILE.OPERATIONAL,
    );
    writeResult(report, options.output);
    return report.status === 'ok' ? 0 : 1;
  }

  try {
    const profile = options.mode === 'snapshot-operational'
      ? POSTFLIGHT_PROFILE.OPERATIONAL
      : POSTFLIGHT_PROFILE.MIGRATION;
    const snapshot = await createSnapshot(process.env.DATABASE_URL, profile);
    writeResult(snapshot, options.output);
    return 0;
  } catch (error) {
    if (error instanceof InvariantViolationError) {
      process.stdout.write(serialize(error.report));
    }
    throw error;
  }
}

if (require.main === module) {
  main()
    .then((exitCode) => {
      process.exitCode = exitCode;
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}

module.exports = {
  COMPARISON_FORMAT,
  FINGERPRINT_ALGORITHM,
  HARDENING_MIGRATION,
  HARDENING_SHA256,
  InvariantViolationError,
  POSTFLIGHT_FORMAT,
  POSTFLIGHT_PROFILE,
  PREFLIGHT_FORMAT,
  SNAPSHOT_CONSISTENCY,
  SNAPSHOT_FORMAT,
  assertValidSnapshot,
  buildFingerprintQuery,
  compareSnapshots,
  createPreflightReport,
  createPostflightReport,
  createSnapshot,
  expectedPostflightCheckIds,
  hardeningSchemaRequirements,
  migrationSpecs,
  parseArguments,
  postflightCheckDefinitions,
  prismaDiffArguments,
  prismaDiffResultCheck,
  preflightCheckDefinitions,
  quoteIdentifier,
  serialize,
  tableColumnsFromCatalog,
  targetSchemaFromDatabaseUrl,
  validateLocalMigrationFiles,
  validateMigrationHistoryRows,
};
