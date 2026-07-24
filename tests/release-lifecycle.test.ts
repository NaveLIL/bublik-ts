import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  rmdirSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const repositoryRoot = path.resolve(__dirname, '..');
const composePath = path.join(repositoryRoot, 'docker-compose.yml');
const packagePath = path.join(repositoryRoot, 'package.json');
const dockerfilePath = path.join(repositoryRoot, 'Dockerfile');
const entrypointPath = path.join(repositoryRoot, 'scripts', 'entrypoint.sh');
const baselineVerifierPath = path.join(repositoryRoot, 'scripts', 'verify-baseline-target.js');
const exporterPath = path.join(repositoryRoot, 'scripts', 'export-public-distribution.js');
const publicVerifierPath = path.join(repositoryRoot, 'scripts', 'verify-public-distribution.js');

const { buildPrismaDiffArguments } = require('../scripts/verify-baseline-target.js') as {
  buildPrismaDiffArguments(): string[];
};
const exporterInternals = (require('../scripts/export-public-distribution.js') as {
  _internals: {
    applyStagedDistributionTransactional(
      targetContext: unknown,
      staged: unknown,
      workspaceRoot: string,
      assertMutationBoundary: () => void,
      verifyApplied: () => unknown,
    ): unknown;
    assertOwnedTargetClean(context: unknown): void;
    assertSafeTarget(target: string): unknown;
    createRootContext(root: string): unknown;
    fingerprintOwnedPayload(context: unknown): string;
    removeOwnedDirectory(
      context: unknown,
      relativePath: string,
      assertMutationBoundary?: () => void,
    ): void;
    withReleaseLock(
      context: unknown,
      metadata: { sourceRevision: string },
      callback: () => unknown,
    ): unknown;
  };
})._internals;
const publicVerifier = require('../scripts/verify-public-distribution.js') as {
  computeRuntimeDependencyClosure(
    root: string,
    options?: { allowDevelopmentEntries?: boolean },
  ): { canonical: string; count: number; sha256: string };
  discoverPublishableFiles(root: string): string[];
  requiredPublicFiles: readonly string[];
  sha256(content: Buffer): string;
  verifyDistribution(root: string): unknown;
};

test('owned directory cleanup works on the workspace filesystem', () => {
  const temporaryDirectory = mkdtempSync(
    path.join(path.dirname(repositoryRoot), '.bublik-owned-cleanup-'),
  );
  try {
    const ownedDirectory = path.join(temporaryDirectory, 'dist-protected');
    mkdirSync(path.join(ownedDirectory, 'nested'), { recursive: true });
    writeFileSync(path.join(ownedDirectory, 'index.js'), 'runtime\n');
    writeFileSync(path.join(ownedDirectory, 'nested', 'module.js'), 'module\n');
    exporterInternals.removeOwnedDirectory(
      exporterInternals.createRootContext(temporaryDirectory),
      'dist-protected',
    );
    assert.equal(existsSync(ownedDirectory), false);
  } finally {
    if (existsSync(temporaryDirectory)) rmdirSync(temporaryDirectory);
  }
});
const { verifyProtectedArtifact } = require('../scripts/verify-protected-artifact.js') as {
  verifyProtectedArtifact(expectedRoot: string, protectedRoot: string): string[];
};

test('compose and npm helpers pin the production project identity', () => {
  const compose = readFileSync(composePath, 'utf8');
  const packageJson = JSON.parse(readFileSync(packagePath, 'utf8')) as {
    scripts: Record<string, string>;
  };

  assert.match(compose, /^name: bublik-n$/m);
  assert.match(compose, /^\s+name: bublik-n_pg_data$/m);
  assert.match(compose, /^\s+name: bublik-n_redis_data$/m);
  assert.match(
    compose,
    /BUBLIK_POSTGRES_IMAGE:-postgres@sha256:[0-9a-f]{64}/,
  );
  assert.match(
    compose,
    /BUBLIK_REDIS_IMAGE:-redis@sha256:[0-9a-f]{64}/,
  );
  assert.match(compose, /^\s+PRISMA_BASELINE_EXISTING: "0"$/m);
  assert.doesNotMatch(compose, /PRISMA_BASELINE_EXISTING:\s*\$\{/);
  for (const script of ['docker:up', 'docker:down', 'docker:logs']) {
    assert.match(packageJson.scripts[script], /^docker compose -p bublik-n /);
  }
});

test('runtime migration controls fail closed and use only the vendored Prisma CLI', () => {
  const entrypoint = readFileSync(entrypointPath, 'utf8');
  const dockerfile = readFileSync(dockerfilePath, 'utf8');

  assert.match(entrypoint, /case "\$baseline_mode" in\s+0\|1\)/);
  assert.match(entrypoint, /case "\$migrate_only" in\s+0\|1\)/);
  assert.match(entrypoint, /prisma_cli="\.\/node_modules\/\.bin\/prisma"/);
  assert.doesNotMatch(entrypoint, /\bnpx\b/);
  assert.doesNotMatch(dockerfile, /\bRUN\s+npx\s+prisma\b/);
  assert.ok(entrypoint.indexOf('case "$baseline_mode"') < entrypoint.indexOf('applying db schema'));
  assert.ok(entrypoint.indexOf('case "$migrate_only"') < entrypoint.indexOf('applying db schema'));
});

test('Prisma drift verification keeps database credentials out of child argv and errors', () => {
  const sentinel = 'sentinel-password-must-not-enter-argv';
  const previous = process.env.DATABASE_URL;
  process.env.DATABASE_URL = `postgresql://bublik:${sentinel}@postgres:5432/bublik?schema=public`;
  try {
    const argumentsList = buildPrismaDiffArguments();
    assert.equal(argumentsList.includes('--from-schema-datasource'), true);
    assert.equal(argumentsList.includes('--from-url'), false);
    assert.equal(argumentsList.join('\0').includes(sentinel), false);
  } finally {
    if (previous === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previous;
  }

  const verifier = readFileSync(baselineVerifierPath, 'utf8');
  assert.doesNotMatch(verifier, /result\.(?:stderr|stdout)/);
  assert.doesNotMatch(verifier, /['"]--from-url['"]/);
});

test('public release export rebuilds a clean HEAD twice and never loads target-owned verifier code', () => {
  const exporter = readFileSync(exporterPath, 'utf8');

  assert.match(exporter, /git', \['clone', '--quiet', '--no-hardlinks', '--no-checkout'/);
  assert.match(exporter, /'config', '--local', 'core\.autocrlf', 'false'/);
  assert.match(exporter, /source tree contains a symlink, submodule or unsupported mode/);
  assert.match(exporter, /first clean protected build/);
  assert.match(exporter, /second clean protected build/);
  assert.match(exporter, /two clean protected builds are not reproducible/);
  assert.match(exporter, /clean checkout contains an unexpected ignored path/);
  assert.match(exporter, /node:24-alpine@sha256:[0-9a-f]{64}/);
  assert.match(exporter, /const gitleaksVersion = '8\.30\.1'/);
  assert.match(exporter, /551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb/);
  assert.match(exporter, /clean source secret scan/);
  assert.match(exporter, /staged public distribution secret scan/);
  assert.match(exporter, /public runtime dependency closure differs from the clean source release closure/);
  assert.match(exporter, /applyStagedDistributionTransactional/);
  assert.match(exporter, /withReleaseLock/);
  assert.doesNotMatch(exporter, /\bHOME\s*:/);
  assert.match(
    exporter,
    /npm ci --ignore-scripts --no-audit --no-fund && \.\/node_modules\/\.bin\/prisma generate/,
  );
  assert.match(
    exporter,
    /source: 'scripts\/verify-public-distribution\.js', target: 'scripts\/verify-distribution\.js'/,
  );
  assert.match(exporter, /const verifierPath = path\.join\(checkoutRoot, 'scripts', 'verify-public-distribution\.js'\)/);
  assert.match(exporter, /const verifier = require\(verifierPath\)/);
  assert.doesNotMatch(exporter, /require\(path\.join\([^\n]*(?:metadata\.)?target/);
  assert.doesNotMatch(exporter, /copyDirectory\(path\.join\(sourceRoot, relativePath/);
  assert.match(exporter, /copyDirectory\(path\.join\(build\.checkoutRoot, relativePath/);

  const stageIndex = exporter.indexOf('const staged = prepareStagedDistribution');
  const finalGateIndex = exporter.indexOf('// These are the last identity and boundary gates');
  const applyIndex = exporter.indexOf('applyStagedDistributionTransactional(', finalGateIndex);
  assert.ok(stageIndex >= 0 && finalGateIndex > stageIndex && applyIndex > finalGateIndex);
});

const gitAvailable = spawnSync(
  'git',
  ['--version'],
  { encoding: 'utf8', windowsHide: true },
).status === 0;

test('target preflight rejects an owned destination junction before touching its external target', {
  skip: !gitAvailable,
}, (context) => {
  const temporaryDirectory = mkdtempSync(path.join(os.tmpdir(), 'bublik-export-junction-'));
  const target = path.join(temporaryDirectory, 'public-target');
  const external = path.join(temporaryDirectory, 'external');
  const sentinel = path.join(external, 'sentinel.txt');
  mkdirSync(target);
  mkdirSync(external);
  writeFileSync(sentinel, 'must survive\n', 'utf8');
  execFileSync('git', ['init', '--quiet'], { cwd: target, stdio: 'ignore' });
  execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/NaveLIL/bublik-ts.git'], {
    cwd: target,
    stdio: 'ignore',
  });

  try {
    mkdirSync(path.join(target, 'artifact-manifest.json'));
    assert.throws(
      () => exporterInternals.assertSafeTarget(target),
      /expected a regular file: .*artifact-manifest\.json/,
    );
    assert.equal(existsSync(path.join(target, 'dist-protected')), false);
    rmSync(path.join(target, 'artifact-manifest.json'), { recursive: true, force: true });

    try {
      symlinkSync(external, path.join(target, 'scripts'), process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EPERM' || code === 'EACCES' || code === 'ENOTSUP') {
        context.skip(`filesystem cannot create a test junction: ${code}`);
        return;
      }
      throw error;
    }

    assert.throws(
      () => exporterInternals.assertSafeTarget(target),
      /symbolic link|junction|resolves through a link/,
    );
    assert.equal(readFileSync(sentinel, 'utf8'), 'must survive\n');
    assert.equal(existsSync(path.join(target, 'dist-protected')), false);
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test('schemaVersion 2 manifest covers the exact public repository tree', () => {
  const temporaryDirectory = mkdtempSync(path.join(os.tmpdir(), 'bublik-public-manifest-'));
  const writePublicFile = (relativePath: string, content: string) => {
    const absolutePath = path.join(temporaryDirectory, ...relativePath.split('/'));
    mkdirSync(path.dirname(absolutePath), { recursive: true });
    writeFileSync(absolutePath, content, 'utf8');
  };

  try {
    const packageJson = {
      name: 'bublik-bot',
      version: '1.0.0',
      dependencies: { 'runtime-package': '1.2.3' },
    };
    const packageLock = {
      name: 'bublik-bot',
      version: '1.0.0',
      lockfileVersion: 3,
      packages: {
        '': { version: '1.0.0', dependencies: { 'runtime-package': '1.2.3' } },
        'node_modules/runtime-package': {
          version: '1.2.3',
          resolved: 'https://registry.npmjs.org/runtime-package/-/runtime-package-1.2.3.tgz',
          integrity: 'sha512-release-test',
        },
      },
    };
    for (const relativePath of publicVerifier.requiredPublicFiles) {
      let content = 'release metadata\n';
      if (relativePath === 'package.json') content = `${JSON.stringify(packageJson)}\n`;
      else if (relativePath === 'package-lock.json') {
        content = `${JSON.stringify(packageLock)}\n`;
      } else if (relativePath.endsWith('.json')) content = '{}\n';
      else if (relativePath.endsWith('.js')) content = "'use strict';\n";
      writePublicFile(relativePath, content);
    }
    writePublicFile('prisma/migrations/20260719000000_baseline/migration.sql', '-- baseline\n');
    writePublicFile('dist-protected/index.js', "'use strict';\nprocess.exitCode = 0;\n");

    const writeManifest = (runtimeIdentity = publicVerifier.computeRuntimeDependencyClosure(temporaryDirectory)) => {
      const paths = publicVerifier.discoverPublishableFiles(temporaryDirectory);
      const files = paths.map((relativePath) => {
        const content = readFileSync(path.join(temporaryDirectory, ...relativePath.split('/')));
        return { path: relativePath, sha256: publicVerifier.sha256(content), bytes: content.length };
      });
      const publishableLines = files.map((entry) => `${entry.sha256}  ${entry.path}\n`).join('');
      const artifactFiles = files.filter((entry) => entry.path.startsWith('dist-protected/'));
      const artifactLines = artifactFiles.map((entry) => `${entry.sha256}  ${entry.path}\n`).join('');
      const manifest = {
        schemaVersion: 2,
        releaseVersion: '1.0.0',
        createdAt: '2026-07-20T00:00:00.000Z',
        sourceRevision: 'a'.repeat(40),
        sourceTree: 'b'.repeat(40),
        nodeMajor: 24,
        buildImage:
          'node:24-alpine@sha256:a0b9bf06e4e6193cf7a0f58816cc935ff8c2a908f81e6f1a95432d679c54fbfd',
        reproducibleBuildCount: 2,
        runtimeDependencyCount: runtimeIdentity.count,
        runtimeDependencyTreeSha256: runtimeIdentity.sha256,
        artifactRoot: 'dist-protected',
        publishableFileCount: files.length,
        publishableTreeSha256: publicVerifier.sha256(Buffer.from(publishableLines, 'utf8')),
        artifactFileCount: artifactFiles.length,
        artifactTreeSha256: publicVerifier.sha256(Buffer.from(artifactLines, 'utf8')),
        toolchain: {
          typescript: '5.9.3',
          javascriptObfuscator: '4.1.1',
          prisma: '6.19.2',
        },
        files,
      };
      writePublicFile('artifact-manifest.json', `${JSON.stringify(manifest, null, 2)}\n`);
      return { files, manifest };
    };
    const originalRuntimeIdentity = publicVerifier.computeRuntimeDependencyClosure(temporaryDirectory);
    const { files } = writeManifest(originalRuntimeIdentity);

    assert.ok(files.some((entry) => entry.path === 'README.md'));
    assert.ok(files.some((entry) => entry.path === '.github/workflows/distribution-ci.yml'));
    assert.equal(files.some((entry) => entry.path === 'artifact-manifest.json'), false);
    assert.doesNotThrow(() => publicVerifier.verifyDistribution(temporaryDirectory));

    writePublicFile('unreviewed.txt', 'not approved\n');
    assert.throws(
      () => publicVerifier.verifyDistribution(temporaryDirectory),
      /unapproved public file: unreviewed\.txt/,
    );
    rmSync(path.join(temporaryDirectory, 'unreviewed.txt'));

    writePublicFile('node_modules/leaked-source/index.ts', 'private source\n');
    assert.throws(
      () => publicVerifier.verifyDistribution(temporaryDirectory),
      /unapproved public directory: node_modules\//,
    );
    rmSync(path.join(temporaryDirectory, 'node_modules'), { recursive: true, force: true });

    writePublicFile('dist-protected/__tests__/leak.js', "'use strict';\n");
    assert.throws(
      () => publicVerifier.verifyDistribution(temporaryDirectory),
      /unapproved public file: dist-protected\/__tests__\/leak\.js/,
    );
    rmSync(path.join(temporaryDirectory, 'dist-protected', '__tests__'), { recursive: true, force: true });

    const privateKeyMarker = ['-----BEGIN', 'PRIVATE', 'KEY-----'].join(' ');
    writePublicFile('README.md', `${'x'.repeat(9 * 1024 * 1024)}\n${privateKeyMarker}\n`);
    writeManifest();
    assert.throws(
      () => publicVerifier.verifyDistribution(temporaryDirectory),
      /private key pattern found in README\.md/,
    );
    writePublicFile('README.md', 'release metadata\n');
    writeManifest();

    const driftedLock = structuredClone(packageLock);
    driftedLock.packages['node_modules/runtime-package'].version = '9.9.9';
    writePublicFile('package-lock.json', `${JSON.stringify(driftedLock)}\n`);
    writeManifest(originalRuntimeIdentity);
    assert.throws(
      () => publicVerifier.verifyDistribution(temporaryDirectory),
      /runtimeDependencyTreeSha256 differs from the public runtime dependency closure/,
    );
    writePublicFile('package-lock.json', `${JSON.stringify(packageLock)}\n`);
    writeManifest();

    writePublicFile(
      'package.json',
      `${JSON.stringify({ ...packageJson, scripts: { preinstall: 'node target-owned.js' } })}\n`,
    );
    writeManifest(originalRuntimeIdentity);
    assert.throws(
      () => publicVerifier.verifyDistribution(temporaryDirectory),
      /public package\.json must not define the preinstall lifecycle script/,
    );
    writePublicFile('package.json', `${JSON.stringify(packageJson)}\n`);
    writeManifest();

    writePublicFile('README.md', 'tampered after manifest\n');
    assert.throws(
      () => publicVerifier.verifyDistribution(temporaryDirectory),
      /(?:byte size|SHA-256) differs for README\.md/,
    );
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test('protected artifact verifier rejects declarations and declaration maps', () => {
  const temporaryDirectory = mkdtempSync(path.join(os.tmpdir(), 'bublik-protected-declaration-'));
  const expectedRoot = path.join(temporaryDirectory, 'dist');
  const protectedRoot = path.join(temporaryDirectory, 'dist-protected');
  try {
    mkdirSync(expectedRoot);
    mkdirSync(protectedRoot);
    writeFileSync(path.join(expectedRoot, 'index.js'), "'use strict';\n", 'utf8');
    writeFileSync(path.join(protectedRoot, 'index.js'), "'use strict';\n", 'utf8');
    writeFileSync(path.join(protectedRoot, 'leak.d.ts'), 'export interface SecretShape {}\n', 'utf8');
    assert.throws(
      () => verifyProtectedArtifact(expectedRoot, protectedRoot),
      /Protected artifact contains a type declaration: leak\.d\.ts/,
    );
    rmSync(path.join(protectedRoot, 'leak.d.ts'));
    writeFileSync(path.join(protectedRoot, 'leak.d.ts.map'), '{}\n', 'utf8');
    assert.throws(
      () => verifyProtectedArtifact(expectedRoot, protectedRoot),
      /Protected artifact contains a type declaration: leak\.d\.ts\.map/,
    );
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test('release exporter rejects dirty release-owned paths', {
  skip: !gitAvailable,
}, () => {
  const temporaryDirectory = mkdtempSync(path.join(os.tmpdir(), 'bublik-release-dirty-'));
  const dirtyTarget = path.join(temporaryDirectory, 'dirty-target');
  try {
    mkdirSync(dirtyTarget);
    execFileSync('git', ['init', '--quiet'], { cwd: dirtyTarget, stdio: 'ignore' });
    mkdirSync(path.join(dirtyTarget, 'dist-protected'));
    writeFileSync(
      path.join(dirtyTarget, 'dist-protected', 'index.js'),
      'uncommitted protected payload\n',
      'utf8',
    );
    const dirtyContext = exporterInternals.createRootContext(dirtyTarget);
    assert.throws(
      () => exporterInternals.assertOwnedTargetClean(dirtyContext),
      /target release-owned paths have uncommitted changes/,
    );
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test('failed release apply restores the exact previous owned payload', () => {
  const temporaryDirectory = mkdtempSync(path.join(os.tmpdir(), 'bublik-release-rollback-'));
  const target = path.join(temporaryDirectory, 'target');
  const stage = path.join(temporaryDirectory, 'stage');
  const workspace = path.join(temporaryDirectory, 'workspace');
  const ownedFiles = [
    'artifact-manifest.json',
    'scripts/entrypoint.sh',
    'scripts/snapshot-baseline-data.js',
    'scripts/snapshot-redis-data.js',
    'scripts/verify-baseline-target.js',
    'scripts/verify-pb-idle.js',
    'scripts/verify-distribution.js',
  ];
  const writeAt = (root: string, relativePath: string, content: string) => {
    const absolutePath = path.join(root, ...relativePath.split('/'));
    mkdirSync(path.dirname(absolutePath), { recursive: true });
    writeFileSync(absolutePath, content, 'utf8');
  };

  try {
    mkdirSync(target);
    mkdirSync(stage);
    mkdirSync(workspace);
    writeAt(target, 'dist-protected/index.js', 'old runtime\n');
    writeAt(target, 'locales/ru.json', '{"old":true}\n');
    writeAt(target, 'artifact-manifest.json', 'old manifest\n');
    for (const directory of ['dist-protected', 'locales', 'prisma']) {
      writeAt(stage, `${directory}/release.txt`, `new ${directory}\n`);
    }
    for (const relativePath of ownedFiles) writeAt(stage, relativePath, `new ${relativePath}\n`);

    const targetContext = exporterInternals.createRootContext(target);
    const stageContext = exporterInternals.createRootContext(stage);
    const lockMetadata = { sourceRevision: 'a'.repeat(40) };
    exporterInternals.withReleaseLock(targetContext, lockMetadata, () => {
      assert.throws(
        () => exporterInternals.withReleaseLock(targetContext, lockMetadata, () => undefined),
        /cannot acquire exclusive release lock/,
      );
      assert.equal(existsSync(path.join(target, '.bublik-release.lock')), true);
    });
    assert.equal(existsSync(path.join(target, '.bublik-release.lock')), false);
    const before = exporterInternals.fingerprintOwnedPayload(targetContext);
    assert.throws(
      () => exporterInternals.applyStagedDistributionTransactional(
        targetContext,
        { stageContext },
        workspace,
        () => undefined,
        () => {
          throw new Error('injected post-apply failure');
        },
      ),
      /injected post-apply failure/,
    );
    assert.equal(exporterInternals.fingerprintOwnedPayload(targetContext), before);
    assert.equal(readFileSync(path.join(target, 'dist-protected', 'index.js'), 'utf8'), 'old runtime\n');
    assert.equal(existsSync(path.join(target, 'prisma')), false);
    assert.equal(existsSync(path.join(target, 'scripts', 'entrypoint.sh')), false);

    const interruptedWorkspace = path.join(temporaryDirectory, 'interrupted-workspace');
    mkdirSync(interruptedWorkspace);
    let boundaryChecks = 0;
    let injected = false;
    assert.throws(
      () => exporterInternals.applyStagedDistributionTransactional(
        targetContext,
        { stageContext },
        interruptedWorkspace,
        () => {
          boundaryChecks += 1;
          if (!injected && boundaryChecks === 4) {
            injected = true;
            throw new Error('injected mid-apply failure');
          }
        },
        () => undefined,
      ),
      /injected mid-apply failure/,
    );
    assert.equal(injected, true);
    assert.equal(exporterInternals.fingerprintOwnedPayload(targetContext), before);
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

const shellAvailable = spawnSync(
  'sh',
  ['-c', 'exit 0'],
  { encoding: 'utf8', windowsHide: true },
).status === 0;

test('entrypoint control flags execute only their exact audited branches', {
  skip: !shellAvailable,
}, () => {
  const temporaryDirectory = mkdtempSync(path.join(os.tmpdir(), 'bublik-entrypoint-contract-'));
  const fakeBinaryDirectory = path.join(temporaryDirectory, 'fake-bin');
  const prismaDirectory = path.join(temporaryDirectory, 'node_modules', '.bin');
  const callsPath = path.join(temporaryDirectory, 'calls.log');
  mkdirSync(fakeBinaryDirectory, { recursive: true });
  mkdirSync(prismaDirectory, { recursive: true });

  const fakeNode = path.join(fakeBinaryDirectory, 'node');
  const fakePrisma = path.join(prismaDirectory, 'prisma');
  writeFileSync(fakeNode, [
    '#!/bin/sh',
    'printf "node %s\\n" "$*" >> "$BUBLIK_TEST_CALLS"',
    'if [ "$1" = "./scripts/verify-baseline-target.js" ]; then',
    '  printf "%s" "${BUBLIK_TEST_BASELINE_STATE:-fresh}"',
    'fi',
    '',
  ].join('\n'), 'utf8');
  writeFileSync(fakePrisma, [
    '#!/bin/sh',
    'printf "prisma %s\\n" "$*" >> "$BUBLIK_TEST_CALLS"',
    '',
  ].join('\n'), 'utf8');
  chmodSync(fakeNode, 0o755);
  chmodSync(fakePrisma, 0o755);

  const run = (overrides: Record<string, string>) => spawnSync('sh', [entrypointPath], {
    cwd: temporaryDirectory,
    encoding: 'utf8',
    windowsHide: true,
    env: {
      PATH: `${fakeBinaryDirectory}:${process.env.PATH ?? '/usr/bin:/bin'}`,
      BUBLIK_TEST_CALLS: callsPath,
      ...overrides,
    },
  });

  try {
    const migrationOnly = run({ MIGRATE_ONLY: '1', PRISMA_BASELINE_EXISTING: '0' });
    assert.equal(migrationOnly.status, 0);
    assert.deepEqual(readFileSync(callsPath, 'utf8').trim().split('\n'), [
      'prisma migrate deploy',
    ]);
    rmSync(callsPath);

    const baseline = run({
      MIGRATE_ONLY: '1',
      PRISMA_BASELINE_EXISTING: '1',
      BUBLIK_TEST_BASELINE_STATE: 'needs-resolve',
    });
    assert.equal(baseline.status, 0);
    assert.deepEqual(readFileSync(callsPath, 'utf8').trim().split('\n'), [
      'node ./scripts/verify-baseline-target.js',
      'prisma migrate resolve --applied 20260719000000_baseline',
      'prisma migrate deploy',
    ]);
    rmSync(callsPath);

    const ordinary = run({ MIGRATE_ONLY: '0', PRISMA_BASELINE_EXISTING: '0' });
    assert.equal(ordinary.status, 0);
    assert.deepEqual(readFileSync(callsPath, 'utf8').trim().split('\n'), [
      'prisma migrate deploy',
      'node dist/index.js',
    ]);
    rmSync(callsPath);

    for (const [name, value] of [
      ['MIGRATE_ONLY', 'true'],
      ['MIGRATE_ONLY', '01'],
      ['MIGRATE_ONLY', ' 1'],
      ['MIGRATE_ONLY', ''],
      ['PRISMA_BASELINE_EXISTING', 'true'],
      ['PRISMA_BASELINE_EXISTING', '01'],
      ['PRISMA_BASELINE_EXISTING', ' 1'],
      ['PRISMA_BASELINE_EXISTING', ''],
    ]) {
      const invalid = run({
        MIGRATE_ONLY: '0',
        PRISMA_BASELINE_EXISTING: '0',
        [name]: value,
      });
      assert.equal(invalid.status, 1, `${name}=${JSON.stringify(value)} must fail`);
      assert.equal(existsSync(callsPath), false, `${name} must fail before any child process`);
      // The generic guidance legitimately contains values such as "1". Prove
      // that the raw name/value pair is not reflected instead of matching a
      // one-character substring inside the safe error text.
      assert.equal(`${invalid.stdout}${invalid.stderr}`.includes(`${name}=${value}`), false);
      assert.doesNotMatch(invalid.stdout, /applying db schema/);
    }
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

const composeAvailable = spawnSync(
  'docker',
  ['compose', 'version'],
  { encoding: 'utf8', windowsHide: true },
).status === 0;

test('rendered dummy compose resolves only the audited project and volumes', {
  skip: !composeAvailable,
}, () => {
  const temporaryDirectory = mkdtempSync(path.join(os.tmpdir(), 'bublik-compose-contract-'));
  const temporaryCompose = path.join(temporaryDirectory, 'docker-compose.yml');
  const dummyEnvironment = path.join(temporaryDirectory, '.env');
  try {
    writeFileSync(temporaryCompose, readFileSync(composePath, 'utf8'), 'utf8');
    writeFileSync(dummyEnvironment, [
      'DISCORD_TOKEN=dummy-discord-token',
      'DISCORD_CLIENT_ID=100000000000000001',
      'DATABASE_URL=postgresql://bublik:dummy@postgres:5432/bublik?schema=public',
      'POSTGRES_USER=bublik',
      'POSTGRES_PASSWORD=dummy',
      'POSTGRES_DB=bublik',
      'NODE_ENV=production',
      '',
    ].join('\n'), 'utf8');

    const rendered = JSON.parse(execFileSync('docker', [
      'compose',
      '--env-file', dummyEnvironment,
      '-f', temporaryCompose,
      'config',
      '--format', 'json',
    ], {
      cwd: temporaryDirectory,
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })) as {
      name: string;
      volumes: Record<string, { name: string }>;
      services: Record<string, {
        image?: string;
        environment?: Record<string, string>;
      }>;
    };

    assert.equal(rendered.name, 'bublik-n');
    assert.equal(rendered.volumes.pg_data.name, 'bublik-n_pg_data');
    assert.equal(rendered.volumes.redis_data.name, 'bublik-n_redis_data');
    assert.match(rendered.services.postgres.image ?? '', /^postgres@sha256:[0-9a-f]{64}$/);
    assert.match(rendered.services.redis.image ?? '', /^redis@sha256:[0-9a-f]{64}$/);
    assert.equal(rendered.services.bot.environment?.PRISMA_BASELINE_EXISTING, '0');
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});
