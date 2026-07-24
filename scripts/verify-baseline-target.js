const { createHash } = require('node:crypto');
const { readFileSync, readdirSync } = require('node:fs');
const { join } = require('node:path');
const { spawnSync } = require('node:child_process');

let prisma = null;
function getPrisma() {
  if (!prisma) {
    // Keep pure policy imports platform-independent. Tests and release tooling
    // can inspect the verifier without loading a generated engine for the host.
    const { PrismaClient } = require('@prisma/client');
    prisma = new PrismaClient();
  }
  return prisma;
}
const BASELINE = '20260719000000_baseline';
const BASELINE_SHA256 = '747765d336220ebc34616d425f7566fba238c1ed7f5866c6f63d2f326bdb6d0a';
const migrationsDir = join(__dirname, '..', 'prisma', 'migrations');
const schemaPath = join(__dirname, '..', 'prisma', 'schema.prisma');

function targetSchema(databaseUrl = process.env.DATABASE_URL) {
  if (typeof databaseUrl !== 'string' || !databaseUrl.trim()) {
    throw new Error('DATABASE_URL is required for baseline verification.');
  }

  let url;
  try {
    url = new URL(databaseUrl);
  } catch {
    throw new Error('DATABASE_URL is not a valid PostgreSQL URL.');
  }
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) {
    throw new Error('DATABASE_URL must use the postgres: or postgresql: protocol.');
  }

  const schemaValues = url.searchParams.getAll('schema');
  if (schemaValues.length > 1) {
    throw new Error('DATABASE_URL contains more than one schema parameter.');
  }
  if (schemaValues.length === 1 && !schemaValues[0]) {
    throw new Error('DATABASE_URL contains an empty schema parameter.');
  }

  const schema = schemaValues[0] || 'public';
  if (schema.includes('\0')) {
    throw new Error('DATABASE_URL contains an invalid schema name.');
  }
  return schema;
}

function quoteIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function migrationDirectories() {
  return readdirSync(migrationsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

function migrationFile(name) {
  return join(migrationsDir, name, 'migration.sql');
}

function checksum(name) {
  return createHash('sha256').update(readFileSync(migrationFile(name))).digest('hex');
}

function protectQuotedSql(value) {
  const quoted = [];
  let protectedSql = '';

  const store = (text) => {
    const marker = `\0q${quoted.length}\0`;
    quoted.push({ marker, text });
    protectedSql += marker;
  };

  for (let index = 0; index < value.length;) {
    const quote = value[index];
    if (quote === "'" || quote === '"') {
      const start = index;
      const escapeBackslashes = quote === "'"
        && index > 0
        && /[eE]/.test(value[index - 1])
        && (index < 2 || !/[A-Za-z0-9_$]/.test(value[index - 2]));
      index += 1;
      let closed = false;
      while (index < value.length) {
        if (escapeBackslashes && value[index] === '\\') {
          index += Math.min(2, value.length - index);
          continue;
        }
        if (value[index] !== quote) {
          index += 1;
          continue;
        }
        if (value[index + 1] === quote) {
          index += 2;
          continue;
        }
        index += 1;
        closed = true;
        break;
      }
      if (!closed) throw new Error('Unterminated quoted literal in SQL default.');
      store(value.slice(start, index));
      continue;
    }

    if (quote === '$') {
      const delimiterMatch = value.slice(index).match(/^\$(?:(?:[A-Za-z_]|[^\x00-\x7F])(?:[A-Za-z0-9_]|[^\x00-\x7F])*)?\$/u);
      if (delimiterMatch) {
        const delimiter = delimiterMatch[0];
        const end = value.indexOf(delimiter, index + delimiter.length);
        if (end < 0) throw new Error('Unterminated dollar-quoted literal in SQL default.');
        const next = end + delimiter.length;
        store(value.slice(index, next));
        index = next;
        continue;
      }
    }

    protectedSql += quote;
    index += 1;
  }

  return { protectedSql, quoted };
}

function normalizeDefault(value) {
  if (value == null) return null;
  const protectedValue = protectQuotedSql(String(value));
  let normalized = protectedValue.protectedSql
    .trim()
    .replace(/[A-Z]/g, (character) => character.toLowerCase());

  const replaceScalarCast = (sql, marker, cast, replacement) => {
    const escapedMarker = marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const escapedCast = cast.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return sql.replace(
      new RegExp(`${escapedMarker}::${escapedCast}(?![a-z0-9_$]|[^\\x00-\\x7F]|\\s*[.\\[(])`, 'gu'),
      () => replacement,
    );
  };

  for (const token of protectedValue.quoted) {
    const numeric = token.text.match(/^'(-?\d+)'$/);
    if (numeric) {
      normalized = replaceScalarCast(normalized, token.marker, 'integer', numeric[1]);
      normalized = replaceScalarCast(normalized, token.marker, 'bigint', numeric[1]);
    }
    for (const cast of ['text', 'jsonb', 'character varying']) {
      normalized = replaceScalarCast(normalized, token.marker, cast, token.marker);
    }
  }

  normalized = normalized.replace(/\s+/g, ' ');
  for (const token of protectedValue.quoted) {
    normalized = normalized.replaceAll(token.marker, () => token.text);
  }
  return normalized;
}

function canonicalType(type) {
  const normalized = type.trim().toUpperCase();
  const mapping = {
    BIGINT: 'bigint',
    BOOLEAN: 'boolean',
    INTEGER: 'integer',
    JSONB: 'jsonb',
    SERIAL: 'integer',
    TEXT: 'text',
    'TEXT[]': 'text[]',
    'TIMESTAMP(3)': 'timestamp(3) without time zone',
    'VARCHAR(255)': 'character varying(255)',
  };
  const result = mapping[normalized];
  if (!result) throw new Error(`Unsupported SQL type in immutable baseline: ${type}`);
  return result;
}

function parseColumns(body, tableName) {
  const columns = [];
  const sequences = [];

  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trim().replace(/,$/, '');
    if (!line.startsWith('"')) continue;
    const match = line.match(/^"([^"]+)"\s+(.+)$/);
    if (!match) throw new Error(`Cannot parse baseline column: ${line}`);

    const [, name, definition] = match;
    const markers = [' NOT NULL', ' DEFAULT ']
      .map((marker) => definition.indexOf(marker))
      .filter((index) => index >= 0);
    const typeEnd = markers.length ? Math.min(...markers) : definition.length;
    const sqlType = definition.slice(0, typeEnd).trim();
    const defaultAt = definition.indexOf(' DEFAULT ');
    let defaultValue = defaultAt >= 0 ? definition.slice(defaultAt + ' DEFAULT '.length) : null;

    if (sqlType.toUpperCase() === 'SERIAL') {
      const sequence = `${tableName}_${name}_seq`;
      sequences.push(sequence);
      defaultValue = `nextval('${sequence}'::regclass)`;
    }

    columns.push({
      table: tableName,
      name,
      type: canonicalType(sqlType),
      notNull: definition.includes(' NOT NULL') || sqlType.toUpperCase() === 'SERIAL',
      default: normalizeDefault(defaultValue),
      identity: '',
      generated: '',
    });
  }

  return { columns, sequences };
}

function parseBaselineCatalog() {
  if (checksum(BASELINE) !== BASELINE_SHA256) {
    throw new Error('The immutable baseline migration differs from its audited checksum. Refusing verification.');
  }
  const sql = readFileSync(migrationFile(BASELINE), 'utf8').replace(/^\uFEFF/, '');
  const tables = [];
  const columns = [];
  const sequences = [];
  const constraints = [];
  const indexes = [];

  for (const match of sql.matchAll(/CREATE TABLE "([^"]+)" \(([\s\S]*?)\r?\n\);/g)) {
    const [, table, body] = match;
    tables.push({ name: table, kind: 'r' });
    const parsed = parseColumns(body, table);
    columns.push(...parsed.columns);
    sequences.push(...parsed.sequences);

    for (const primary of body.matchAll(/CONSTRAINT "([^"]+)" PRIMARY KEY \(([^)]+)\)/g)) {
      constraints.push({
        name: primary[1],
        table,
        type: 'p',
        columns: [...primary[2].matchAll(/"([^"]+)"/g)].map((part) => part[1]),
        referencedTable: null,
        referencedColumns: [],
        onUpdate: ' ',
        onDelete: ' ',
        deferrable: false,
        deferred: false,
        validated: true,
      });
    }
  }

  for (const match of sql.matchAll(/CREATE (UNIQUE )?INDEX "([^"]+)" ON "([^"]+)"\(([^)]+)\);/g)) {
    indexes.push({
      name: match[2],
      table: match[3],
      unique: Boolean(match[1]),
      method: 'btree',
      keys: [...match[4].matchAll(/"([^"]+)"/g)].map((part) => part[1]),
      included: [],
      predicate: null,
      valid: true,
      ready: true,
    });
  }

  const foreignKeyPattern = /ALTER TABLE "([^"]+)" ADD CONSTRAINT "([^"]+)" FOREIGN KEY \(([^)]+)\) REFERENCES "([^"]+)"\(([^)]+)\) ON DELETE ([A-Z ]+) ON UPDATE ([A-Z ]+);/g;
  const actionCodes = { CASCADE: 'c', 'NO ACTION': 'a', RESTRICT: 'r', 'SET NULL': 'n', 'SET DEFAULT': 'd' };
  for (const match of sql.matchAll(foreignKeyPattern)) {
    const onDelete = actionCodes[match[6]];
    const onUpdate = actionCodes[match[7]];
    if (!onDelete || !onUpdate) throw new Error(`Unsupported foreign-key action in immutable baseline: ${match[0]}`);
    constraints.push({
      name: match[2],
      table: match[1],
      type: 'f',
      columns: [...match[3].matchAll(/"([^"]+)"/g)].map((part) => part[1]),
      referencedTable: match[4],
      referencedColumns: [...match[5].matchAll(/"([^"]+)"/g)].map((part) => part[1]),
      onUpdate,
      onDelete,
      deferrable: false,
      deferred: false,
      validated: true,
    });
  }

  return {
    tables: tables.sort(byName),
    sequences: sequences.sort(),
    columns: columns.sort(byTableAndName),
    constraints: constraints.sort(byTableAndName),
    indexes: indexes.sort(byTableAndName),
    types: [],
    routines: [],
  };
}

function byName(left, right) {
  return left.name.localeCompare(right.name);
}

function byTableAndName(left, right) {
  return `${left.table}.${left.name}`.localeCompare(`${right.table}.${right.name}`);
}

async function readActualCatalog(schema) {
  const relations = await getPrisma().$queryRawUnsafe(`
    SELECT c.relname AS name, c.relkind AS kind
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = $1
      AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
      AND c.relname <> '_prisma_migrations'
    ORDER BY c.relname
  `, schema);

  const columnRows = await getPrisma().$queryRawUnsafe(`
    SELECT table_rel.relname AS table_name,
           attribute.attname AS name,
           format_type(attribute.atttypid, attribute.atttypmod) AS type,
           attribute.attnotnull AS not_null,
           pg_get_expr(default_value.adbin, default_value.adrelid) AS default_value,
           attribute.attidentity AS identity,
           attribute.attgenerated AS generated
    FROM pg_attribute attribute
    JOIN pg_class table_rel ON table_rel.oid = attribute.attrelid
    JOIN pg_namespace namespace ON namespace.oid = table_rel.relnamespace
    LEFT JOIN pg_attrdef default_value
      ON default_value.adrelid = attribute.attrelid AND default_value.adnum = attribute.attnum
    WHERE namespace.nspname = $1
      AND table_rel.relkind IN ('r', 'p')
      AND table_rel.relname <> '_prisma_migrations'
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
    ORDER BY table_rel.relname, attribute.attname
  `, schema);

  const constraintRows = await getPrisma().$queryRawUnsafe(`
    SELECT constraint_rel.conname AS name,
           table_rel.relname AS table_name,
           constraint_rel.contype AS type,
           referenced_rel.relname AS referenced_table,
           ARRAY(
             SELECT attribute.attname
             FROM unnest(constraint_rel.conkey) WITH ORDINALITY AS key(attnum, position)
             JOIN pg_attribute attribute
               ON attribute.attrelid = constraint_rel.conrelid AND attribute.attnum = key.attnum
             ORDER BY key.position
           ) AS columns,
           CASE WHEN constraint_rel.confkey IS NULL THEN ARRAY[]::name[] ELSE ARRAY(
             SELECT attribute.attname
             FROM unnest(constraint_rel.confkey) WITH ORDINALITY AS key(attnum, position)
             JOIN pg_attribute attribute
               ON attribute.attrelid = constraint_rel.confrelid AND attribute.attnum = key.attnum
             ORDER BY key.position
           ) END AS referenced_columns,
           constraint_rel.confupdtype AS on_update,
           constraint_rel.confdeltype AS on_delete,
           constraint_rel.condeferrable AS deferrable,
           constraint_rel.condeferred AS deferred,
           constraint_rel.convalidated AS validated
    FROM pg_constraint constraint_rel
    JOIN pg_class table_rel ON table_rel.oid = constraint_rel.conrelid
    JOIN pg_namespace namespace ON namespace.oid = table_rel.relnamespace
    LEFT JOIN pg_class referenced_rel ON referenced_rel.oid = constraint_rel.confrelid
    WHERE namespace.nspname = $1
      AND table_rel.relname <> '_prisma_migrations'
      AND constraint_rel.contype IN ('p', 'f', 'u', 'c', 'x')
    ORDER BY table_rel.relname, constraint_rel.conname
  `, schema);

  const indexRows = await getPrisma().$queryRawUnsafe(`
    SELECT index_rel.relname AS name,
           table_rel.relname AS table_name,
           index_data.indisunique AS unique,
           access_method.amname AS method,
           index_data.indisvalid AS valid,
           index_data.indisready AS ready,
           index_data.indnkeyatts AS key_count,
           key.position,
           CASE WHEN key.attnum = 0
             THEN pg_get_indexdef(index_data.indexrelid, key.position::integer, true)
             ELSE attribute.attname
           END AS key_value,
           pg_get_expr(index_data.indpred, index_data.indrelid) AS predicate
    FROM pg_index index_data
    JOIN pg_class index_rel ON index_rel.oid = index_data.indexrelid
    JOIN pg_class table_rel ON table_rel.oid = index_data.indrelid
    JOIN pg_namespace namespace ON namespace.oid = table_rel.relnamespace
    JOIN pg_am access_method ON access_method.oid = index_rel.relam
    JOIN LATERAL unnest(index_data.indkey) WITH ORDINALITY AS key(attnum, position) ON true
    LEFT JOIN pg_attribute attribute
      ON attribute.attrelid = table_rel.oid AND attribute.attnum = key.attnum
    WHERE namespace.nspname = $1
      AND table_rel.relname <> '_prisma_migrations'
      AND NOT index_data.indisprimary
    ORDER BY table_rel.relname, index_rel.relname, key.position
  `, schema);

  const typeRows = await getPrisma().$queryRawUnsafe(`
    SELECT type_rel.typname AS name, type_rel.typtype AS kind
    FROM pg_type type_rel
    JOIN pg_namespace namespace ON namespace.oid = type_rel.typnamespace
    WHERE namespace.nspname = $1 AND type_rel.typtype IN ('d', 'e')
    ORDER BY type_rel.typname
  `, schema);

  const routineRows = await getPrisma().$queryRawUnsafe(`
    SELECT routine.proname AS name,
           routine.prokind AS kind,
           pg_get_function_identity_arguments(routine.oid) AS arguments
    FROM pg_proc routine
    JOIN pg_namespace namespace ON namespace.oid = routine.pronamespace
    WHERE namespace.nspname = $1
    ORDER BY routine.proname, arguments
  `, schema);

  const indexMap = new Map();
  for (const row of indexRows) {
    const key = `${row.table_name}.${row.name}`;
    const index = indexMap.get(key) || {
      name: row.name,
      table: row.table_name,
      unique: row.unique,
      method: row.method,
      keys: [],
      included: [],
      predicate: row.predicate ? String(row.predicate).replace(/\s+/g, ' ').trim() : null,
      valid: row.valid,
      ready: row.ready,
    };
    if (Number(row.position) <= Number(row.key_count)) index.keys.push(row.key_value);
    else index.included.push(row.key_value);
    indexMap.set(key, index);
  }

  return {
    tables: relations.filter((row) => row.kind !== 'S').map((row) => ({ name: row.name, kind: row.kind })).sort(byName),
    sequences: relations.filter((row) => row.kind === 'S').map((row) => row.name).sort(),
    columns: columnRows.map((row) => ({
      table: row.table_name,
      name: row.name,
      type: row.type,
      notNull: row.not_null,
      default: normalizeDefault(row.default_value),
      identity: row.identity === '\0' ? '' : row.identity,
      generated: row.generated === '\0' ? '' : row.generated,
    })).sort(byTableAndName),
    constraints: constraintRows.map((row) => ({
      name: row.name,
      table: row.table_name,
      type: row.type,
      columns: row.columns,
      referencedTable: row.referenced_table || null,
      referencedColumns: row.referenced_columns,
      onUpdate: row.on_update,
      onDelete: row.on_delete,
      deferrable: row.deferrable,
      deferred: row.deferred,
      validated: row.validated,
    })).sort(byTableAndName),
    indexes: [...indexMap.values()].sort(byTableAndName),
    types: typeRows.map((row) => ({ name: row.name, kind: row.kind })),
    routines: routineRows.map((row) => ({ name: row.name, kind: row.kind, arguments: row.arguments })),
  };
}

function stable(value) {
  return JSON.stringify(value);
}

function summarizeDifference(label, expected, actual) {
  const expectedByKey = new Map(expected.map((item) => [typeof item === 'string' ? item : `${item.table || ''}.${item.name}`, item]));
  const actualByKey = new Map(actual.map((item) => [typeof item === 'string' ? item : `${item.table || ''}.${item.name}`, item]));
  const missing = [...expectedByKey.keys()].filter((key) => !actualByKey.has(key));
  const extra = [...actualByKey.keys()].filter((key) => !expectedByKey.has(key));
  const changed = [...expectedByKey.keys()].filter((key) => actualByKey.has(key)
    && stable(expectedByKey.get(key)) !== stable(actualByKey.get(key)));
  if (!missing.length && !extra.length && !changed.length) return null;
  return `${label} (missing: ${missing.slice(0, 8).join(', ') || '-'}; extra: ${extra.slice(0, 8).join(', ') || '-'}; changed: ${changed.slice(0, 8).join(', ') || '-'})`;
}

function compareCatalog(expected, actual) {
  return [
    summarizeDifference('tables', expected.tables, actual.tables),
    summarizeDifference('sequences', expected.sequences, actual.sequences),
    summarizeDifference('columns', expected.columns, actual.columns),
    summarizeDifference('constraints', expected.constraints, actual.constraints),
    summarizeDifference('indexes', expected.indexes, actual.indexes),
    summarizeDifference('types', expected.types, actual.types),
    summarizeDifference('routines', expected.routines, actual.routines),
  ].filter(Boolean);
}

function isFresh(catalog) {
  return Object.values(catalog).every((items) => items.length === 0);
}

function buildPrismaDiffArguments() {
  const prismaCli = require.resolve('prisma/build/index.js');
  return [
    prismaCli,
    'migrate',
    'diff',
    '--from-schema-datasource',
    schemaPath,
    '--to-schema-datamodel',
    schemaPath,
    '--exit-code',
  ];
}

function verifyCurrentDatamodel() {
  const result = spawnSync(process.execPath, buildPrismaDiffArguments(), {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  if (result.status === 0) return;
  if (result.status === 2) {
    throw new Error('Database migration history is complete, but its schema has drifted from prisma/schema.prisma.');
  }
  const status = Number.isInteger(result.status) ? String(result.status) : 'unavailable';
  throw new Error(`Could not verify the migrated schema with Prisma migrate diff (exit status ${status}).`);
}

async function migrationHistory(schema) {
  const exists = await getPrisma().$queryRawUnsafe(`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = $1 AND table_name = '_prisma_migrations'
    ) AS exists
  `, schema);
  if (!exists[0]?.exists) return [];
  return getPrisma().$queryRawUnsafe(`
    SELECT migration_name, checksum, finished_at, rolled_back_at
    FROM ${quoteIdentifier(schema)}."_prisma_migrations"
    ORDER BY started_at, id
  `);
}

async function verifyAppliedHistory(rows, expectedCatalog, actualCatalog) {
  const local = migrationDirectories();
  const localSet = new Set(local);
  const unknown = rows.filter((row) => !localSet.has(row.migration_name));
  if (unknown.length) {
    throw new Error(`Database contains migration history absent from this image: ${[...new Set(unknown.map((row) => row.migration_name))].join(', ')}`);
  }

  const failed = rows.filter((row) => !row.finished_at && !row.rolled_back_at);
  if (failed.length) {
    throw new Error(`Database contains failed migrations that require explicit recovery: ${[...new Set(failed.map((row) => row.migration_name))].join(', ')}`);
  }

  const applied = rows.filter((row) => row.finished_at && !row.rolled_back_at);
  const duplicates = applied.filter((row, index) => applied.findIndex((candidate) => candidate.migration_name === row.migration_name) !== index);
  if (duplicates.length) throw new Error(`Database contains duplicate successful migration records: ${[...new Set(duplicates.map((row) => row.migration_name))].join(', ')}`);

  for (const row of applied) {
    if (row.checksum !== checksum(row.migration_name)) {
      throw new Error(`Applied migration checksum does not match this image: ${row.migration_name}`);
    }
  }

  const appliedNames = applied.map((row) => row.migration_name).sort();
  const expectedPrefix = local.slice(0, appliedNames.length);
  if (stable(appliedNames) !== stable(expectedPrefix)) {
    throw new Error(`Successful migrations are not an exact prefix of this image: ${appliedNames.join(', ') || '(none)'}`);
  }
  if (!appliedNames.includes(BASELINE)) return false;

  if (appliedNames.length === 1) {
    const differences = compareCatalog(expectedCatalog, actualCatalog);
    if (differences.length) throw new Error(`Baseline is recorded as applied, but its schema has drifted: ${differences.join('; ')}`);
  } else if (appliedNames.length === local.length) {
    verifyCurrentDatamodel();
  } else {
    throw new Error('Cannot safely verify an intermediate migrated schema. Finish migration recovery without automatic baseline mode.');
  }

  process.stdout.write('already-applied');
  return true;
}

async function main() {
  const schema = targetSchema();
  const expectedCatalog = parseBaselineCatalog();
  const actualCatalog = await readActualCatalog(schema);
  const history = await migrationHistory(schema);

  if (await verifyAppliedHistory(history, expectedCatalog, actualCatalog)) return;
  if (history.length) {
    throw new Error('Database has migration history but the Bublik baseline is not successfully applied. Refusing automatic resolve.');
  }
  if (isFresh(actualCatalog)) {
    process.stdout.write('fresh');
    return;
  }

  const differences = compareCatalog(expectedCatalog, actualCatalog);
  if (differences.length) {
    throw new Error(`Database is not the exact legacy Bublik db-push schema; automatic baseline is refused: ${differences.join('; ')}`);
  }
  process.stdout.write('needs-resolve');
}

if (require.main === module) {
  main()
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    })
    .finally(async () => {
      if (prisma) await prisma.$disconnect();
    });
}

module.exports = {
  BASELINE,
  BASELINE_SHA256,
  buildPrismaDiffArguments,
  compareCatalog,
  normalizeDefault,
  parseBaselineCatalog,
  readActualCatalog,
  targetSchema,
};
