import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolutePath = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(absolutePath);
    return entry.isFile() && entry.name.endsWith('.ts') ? [absolutePath] : [];
  });
}

test('PostgreSQL void advisory locks use executeRaw instead of queryRaw', () => {
  let lockCount = 0;

  for (const absolutePath of sourceFiles(join(process.cwd(), 'src'))) {
    const source = readFileSync(absolutePath, 'utf8');
    const statements = source.match(
      /\$(?:queryRaw|executeRaw)(?:Unsafe)?(?:<[^`]*>)?`[^;]*?pg_(?:try_)?advisory_(?:xact_)?lock[^;]*?;/gu,
    ) ?? [];
    lockCount += statements.length;
    for (const statement of statements) {
      assert.match(
        statement,
        /^\$executeRaw`/u,
        `${absolutePath} decodes a PostgreSQL void lock result`,
      );
    }
  }

  assert.equal(lockCount, 5, 'update the audited advisory-lock file list when adding a new lock');
});
