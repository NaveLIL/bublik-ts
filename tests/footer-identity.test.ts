import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

type Locale = {
  economy: {
    leaderboard_footer: string;
    embed: { leaderboard: { footer: string } };
  };
};

const root = path.resolve(__dirname, '..');

test('Discord footers use NaveL while source authorship remains NaveLIL', () => {
  const configSource = readFileSync(path.join(root, 'src', 'config.ts'), 'utf8');
  const packageJson = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as {
    author?: string;
  };

  assert.match(configSource, /botAuthor:\s*'NaveLIL'/);
  assert.match(configSource, /footer:\s*'© NaveL for EREZ 2024–2026'/);
  assert.doesNotMatch(configSource, /footer:\s*'© NaveLIL for EREZ/);
  assert.equal(packageJson.author, 'NaveLIL');
});

for (const localeName of ['ru', 'en'] as const) {
  test(`${localeName} leaderboard footers use the Discord identity NaveL`, () => {
    const locale = JSON.parse(
      readFileSync(path.join(root, 'locales', `${localeName}.json`), 'utf8'),
    ) as Locale;

    assert.match(locale.economy.leaderboard_footer, /© NaveL for EREZ 2024–2026$/);
    assert.match(locale.economy.embed.leaderboard.footer, /© NaveL for EREZ 2024–2026$/);
  });
}
