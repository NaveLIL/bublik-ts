import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const lifecycle = readFileSync(
  path.resolve(__dirname, '..', '..', 'src', 'modules', 'regbattle', 'lifecycle.ts'),
  'utf8',
);

test('empty squad cleanup retries every non-authoritative external failure', () => {
  assert.match(
    lifecycle,
    /if \(!airDeleted \|\| !mainDeleted\) \{[\s\S]*?scheduleSquadDeletion\(squad, guild, client\);[\s\S]*?return;/,
  );
  assert.match(
    lifecycle,
    /if \(!\(await teardownSquadIntegration\(squad, client\)\)\) \{[\s\S]*?scheduleSquadDeletion\(squad, guild, client\);[\s\S]*?return;/,
  );
});

test('startup recovery hands incomplete cleanup to the ordinary retry timer', () => {
  assert.match(
    lifecycle,
    /if \(!externalCleanupComplete\) \{[\s\S]*?scheduleSquadDeletion\(squad, guild, client\);[\s\S]*?continue;/,
  );
  assert.match(
    lifecycle,
    /if \(!\(await teardownSquadIntegration\(squad, client\)\)\) \{[\s\S]*?scheduleSquadDeletion\(squad, guild, client\);[\s\S]*?continue;/,
  );
});
