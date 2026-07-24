'use strict';

const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const artifactRoot = 'dist-protected';
const manifestFile = 'artifact-manifest.json';
const releaseNodeImage =
  'node:24-alpine@sha256:a0b9bf06e4e6193cf7a0f58816cc935ff8c2a908f81e6f1a95432d679c54fbfd';
const ignoredRoots = new Set(['.git']);
const releaseLockFile = '.bublik-release.lock';
const requiredPublicFiles = new Set([
  '.dockerignore',
  '.env.example',
  '.gitattributes',
  '.gitleaks.toml',
  '.github/CODEOWNERS',
  '.github/ISSUE_TEMPLATE/bug.yml',
  '.github/ISSUE_TEMPLATE/config.yml',
  '.github/ISSUE_TEMPLATE/feature.yml',
  '.github/PULL_REQUEST_TEMPLATE.md',
  '.github/dependabot.yml',
  '.github/workflows/distribution-ci.yml',
  '.gitignore',
  'CHANGELOG.md',
  'CONTRIBUTING.md',
  'Dockerfile',
  'README.md',
  'SECURITY.md',
  'SUPPORT.md',
  'docker-compose.yml',
  'locales/en.json',
  'locales/ru.json',
  'package-lock.json',
  'package.json',
  'prisma/migrations/migration_lock.toml',
  'prisma/schema.prisma',
  'scripts/entrypoint.sh',
  'scripts/snapshot-baseline-data.js',
  'scripts/snapshot-redis-data.js',
  'scripts/verify-baseline-target.js',
  'scripts/verify-distribution.js',
  'scripts/verify-pb-idle.js',
]);
const allowedDirectoryPatterns = [
  /^\.github$/,
  /^\.github\/ISSUE_TEMPLATE$/,
  /^\.github\/workflows$/,
  /^dist-protected(?:\/.*)?$/,
  /^docs$/,
  /^locales$/,
  /^prisma$/,
  /^prisma\/migrations$/,
  /^prisma\/migrations\/[0-9]{14}_[a-z0-9_]+$/,
  /^scripts$/,
];
const secretPatterns = [
  { name: 'private key', pattern: /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/ },
  { name: 'GitHub token', pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/ },
  { name: 'Discord MFA token', pattern: /\bmfa\.[A-Za-z0-9_-]{40,}\b/ },
  {
    name: 'Discord bot token',
    pattern: /\b[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{20,}\b/,
  },
];

function fail(message) {
  throw new Error(`distribution verification failed: ${message}`);
}

function comparePaths(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function toPosix(relativePath) {
  return relativePath.split(path.sep).join('/');
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort(comparePaths)
        .map((key) => [key, stableValue(value[key])]),
    );
  }
  return value;
}

function readJsonFile(filePath, label) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    fail(`${label} is invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function computeRuntimeDependencyClosure(repositoryRoot, options = {}) {
  const root = path.resolve(repositoryRoot);
  const packageJson = readJsonFile(path.join(root, 'package.json'), 'package.json');
  const packageLock = readJsonFile(path.join(root, 'package-lock.json'), 'package-lock.json');
  if (!packageJson || typeof packageJson !== 'object' || Array.isArray(packageJson)) {
    fail('package.json root must be an object');
  }
  if (
    !packageLock ||
    typeof packageLock !== 'object' ||
    Array.isArray(packageLock) ||
    packageLock.lockfileVersion !== 3 ||
    !packageLock.packages ||
    typeof packageLock.packages !== 'object' ||
    Array.isArray(packageLock.packages)
  ) {
    fail('package-lock.json must use lockfileVersion 3 and contain packages');
  }

  const rootLock = packageLock.packages[''];
  if (!rootLock || typeof rootLock !== 'object' || Array.isArray(rootLock)) {
    fail('package-lock.json root package record is missing');
  }
  const runtimeRequirements = {};
  for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies', 'peerDependenciesMeta']) {
    const packageValue = packageJson[field] ?? {};
    const lockValue = rootLock[field] ?? {};
    if (!packageValue || typeof packageValue !== 'object' || Array.isArray(packageValue)) {
      fail(`package.json ${field} must be an object when present`);
    }
    if (!lockValue || typeof lockValue !== 'object' || Array.isArray(lockValue)) {
      fail(`package-lock.json root ${field} must be an object when present`);
    }
    if (JSON.stringify(stableValue(lockValue)) !== JSON.stringify(stableValue(packageValue))) {
      fail(`package-lock.json root ${field} differ from package.json`);
    }
    runtimeRequirements[field] = packageValue;
  }

  const allowDevelopmentEntries = options.allowDevelopmentEntries === true;
  const developmentDependencies = packageJson.devDependencies ?? {};
  if (
    !developmentDependencies ||
    typeof developmentDependencies !== 'object' ||
    Array.isArray(developmentDependencies)
  ) {
    fail('package.json devDependencies must be an object when present');
  }
  const rootDevelopmentDependencies = rootLock.devDependencies ?? {};
  if (
    !rootDevelopmentDependencies ||
    typeof rootDevelopmentDependencies !== 'object' ||
    Array.isArray(rootDevelopmentDependencies)
  ) {
    fail('package-lock.json root devDependencies must be an object when present');
  }
  if (!allowDevelopmentEntries && Object.keys(developmentDependencies).length > 0) {
    fail('public package.json must not expose development dependencies');
  }
  if (!allowDevelopmentEntries && Object.keys(rootDevelopmentDependencies).length > 0) {
    fail('public package-lock.json root must not expose development dependencies');
  }
  const scripts = packageJson.scripts ?? {};
  if (!scripts || typeof scripts !== 'object' || Array.isArray(scripts)) {
    fail('package.json scripts must be an object when present');
  }
  if (!allowDevelopmentEntries) {
    for (const lifecycleName of ['preinstall', 'install', 'postinstall', 'preprepare', 'prepare', 'postprepare']) {
      if (Object.hasOwn(scripts, lifecycleName)) {
        fail(`public package.json must not define the ${lifecycleName} lifecycle script`);
      }
    }
  }

  const records = [];
  for (const [packagePath, descriptor] of Object.entries(packageLock.packages)) {
    if (packagePath === '') continue;
    if (
      typeof packagePath !== 'string' ||
      !packagePath.startsWith('node_modules/') ||
      packagePath.includes('\\') ||
      path.posix.normalize(packagePath) !== packagePath ||
      packagePath.split('/').includes('..')
    ) {
      fail(`unsafe package-lock package path: ${String(packagePath)}`);
    }
    if (!descriptor || typeof descriptor !== 'object' || Array.isArray(descriptor)) {
      fail(`invalid package-lock descriptor: ${packagePath}`);
    }
    if (descriptor.dev === true) {
      if (allowDevelopmentEntries) continue;
      fail(`public package-lock.json contains a development-only package: ${packagePath}`);
    }
    records.push({ path: packagePath, descriptor: stableValue(descriptor) });
  }
  records.sort((left, right) => comparePaths(left.path, right.path));
  const closure = stableValue({ packages: records, requirements: runtimeRequirements, schemaVersion: 1 });
  const canonical = `${JSON.stringify(closure)}\n`;
  return {
    canonical,
    count: records.length,
    sha256: sha256(Buffer.from(canonical, 'utf8')),
  };
}

function isInside(candidate, parent) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function normalizedPathKey(value) {
  const resolved = path.resolve(value).replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function assertSafeRelativePath(relativePath) {
  if (
    typeof relativePath !== 'string' ||
    relativePath.length === 0 ||
    relativePath.includes('\\') ||
    path.posix.isAbsolute(relativePath) ||
    path.posix.normalize(relativePath) !== relativePath ||
    relativePath === '..' ||
    relativePath.startsWith('../')
  ) {
    fail(`unsafe relative path: ${String(relativePath)}`);
  }
}

function isApprovedPublicFile(relativePath) {
  if (requiredPublicFiles.has(relativePath)) return true;
  if (relativePath.startsWith(`${artifactRoot}/`)) {
    const artifactPath = relativePath.slice(artifactRoot.length + 1);
    const segments = artifactPath.split('/');
    return (
      artifactPath.endsWith('.js') &&
      !segments.includes('__tests__') &&
      !artifactPath.endsWith('.test.js') &&
      !artifactPath.endsWith('.spec.js')
    );
  }
  if (/^prisma\/migrations\/[0-9]{14}_[a-z0-9_]+\/migration\.sql$/.test(relativePath)) {
    return true;
  }
  return false;
}

function isApprovedPublicDirectory(relativePath) {
  return allowedDirectoryPatterns.some((pattern) => pattern.test(relativePath));
}

function inspectPublishableTree(repositoryRoot, options = {}) {
  const root = path.resolve(repositoryRoot);
  if (!fs.existsSync(root)) fail(`repository root is missing: ${root}`);
  const rootStat = fs.lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    fail(`repository root is not a regular directory: ${root}`);
  }
  const realRoot = fs.realpathSync.native(root);
  if (normalizedPathKey(realRoot) !== normalizedPathKey(root)) {
    fail(`repository root resolves through a symbolic link or junction: ${root}`);
  }
  const files = [];
  const directories = [];

  function visit(current) {
    const entries = fs.readdirSync(current, { withFileTypes: true })
      .sort((left, right) => comparePaths(left.name, right.name));
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      const relativePath = toPosix(path.relative(root, fullPath));
      const topLevel = relativePath.split('/')[0];
      const stat = fs.lstatSync(fullPath);

      if (relativePath === releaseLockFile && options.allowReleaseLock === true) {
        if (!stat.isFile() || stat.isSymbolicLink()) fail(`${releaseLockFile} is not a regular file`);
        const resolved = fs.realpathSync.native(fullPath);
        if (!isInside(resolved, realRoot) || normalizedPathKey(resolved) !== normalizedPathKey(fullPath)) {
          fail(`${releaseLockFile} resolves through a link or outside the repository`);
        }
        continue;
      }
      if (ignoredRoots.has(topLevel)) {
        if (stat.isSymbolicLink()) fail(`ignored root must not be a symbolic link: ${relativePath}`);
        if (relativePath === topLevel && !stat.isDirectory() && !stat.isFile()) {
          fail(`ignored root has an unsupported type: ${relativePath}`);
        }
        const resolved = fs.realpathSync.native(fullPath);
        if (!isInside(resolved, realRoot) || normalizedPathKey(resolved) !== normalizedPathKey(fullPath)) {
          fail(`ignored root resolves through a link or outside the repository: ${relativePath}`);
        }
        continue;
      }
      if (stat.isSymbolicLink()) fail(`symbolic links and junctions are forbidden: ${relativePath}`);
      const resolved = fs.realpathSync.native(fullPath);
      if (!isInside(resolved, realRoot) || normalizedPathKey(resolved) !== normalizedPathKey(fullPath)) {
        fail(`filesystem entry resolves through a link or outside the repository: ${relativePath}`);
      }

      if (stat.isDirectory()) {
        if (!isApprovedPublicDirectory(relativePath)) {
          fail(`unapproved public directory: ${relativePath}/`);
        }
        directories.push(relativePath);
        visit(fullPath);
      } else if (stat.isFile()) {
        if (relativePath === manifestFile) continue;
        if (!isApprovedPublicFile(relativePath)) fail(`unapproved public file: ${relativePath}`);
        files.push(relativePath);
      } else {
        fail(`unsupported filesystem entry: ${relativePath}`);
      }
    }
  }

  visit(root);
  files.sort(comparePaths);
  directories.sort(comparePaths);

  if (options.requireRequiredFiles !== false) {
    const actual = new Set(files);
    const missing = [...requiredPublicFiles].filter((entry) => !actual.has(entry)).sort(comparePaths);
    if (missing.length > 0) fail(`required public files are missing: ${missing.join(', ')}`);
    if (!files.some((entry) => /^prisma\/migrations\/[0-9]{14}_[a-z0-9_]+\/migration\.sql$/.test(entry))) {
      fail('at least one Prisma migration is required');
    }
  }

  return { root, realRoot, files, directories };
}

function discoverPublishableFiles(repositoryRoot) {
  return inspectPublishableTree(repositoryRoot).files;
}

function readManifest(repositoryRoot) {
  const manifestPath = path.join(repositoryRoot, manifestFile);
  if (!fs.existsSync(manifestPath)) fail(`${manifestFile} is missing`);
  const stat = fs.lstatSync(manifestPath);
  if (!stat.isFile() || stat.isSymbolicLink()) fail(`${manifestFile} is not a regular file`);
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    fail(`${manifestFile} is invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) fail('manifest root must be an object');
  const expectedKeys = [
    'artifactFileCount',
    'artifactRoot',
    'artifactTreeSha256',
    'buildImage',
    'createdAt',
    'files',
    'nodeMajor',
    'publishableFileCount',
    'publishableTreeSha256',
    'releaseVersion',
    'reproducibleBuildCount',
    'runtimeDependencyCount',
    'runtimeDependencyTreeSha256',
    'schemaVersion',
    'sourceRevision',
    'sourceTree',
    'toolchain',
  ].sort(comparePaths);
  const actualKeys = Object.keys(manifest).sort(comparePaths);
  if (JSON.stringify(actualKeys) !== JSON.stringify(expectedKeys)) fail('manifest fields differ from schemaVersion 2');
  if (manifest.schemaVersion !== 2) fail('unsupported manifest schemaVersion (expected 2)');
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(manifest.releaseVersion ?? '')) {
    fail('releaseVersion must be a semantic version without a leading v');
  }
  if (!/^[0-9a-f]{40}$/.test(manifest.sourceRevision ?? '')) fail('sourceRevision must be a full Git SHA-1');
  if (!/^[0-9a-f]{40}$/.test(manifest.sourceTree ?? '')) fail('sourceTree must be a full Git tree SHA-1');
  const created = new Date(manifest.createdAt);
  if (!Number.isFinite(created.getTime()) || created.toISOString() !== manifest.createdAt) {
    fail('createdAt must be a canonical UTC ISO timestamp');
  }
  if (manifest.nodeMajor !== 24) fail('nodeMajor must be 24');
  if (manifest.buildImage !== releaseNodeImage) fail('buildImage differs from the audited Node 24 image');
  if (manifest.reproducibleBuildCount !== 2) fail('reproducibleBuildCount must be 2');
  if (manifest.artifactRoot !== artifactRoot) fail(`artifactRoot must be ${artifactRoot}`);
  for (const field of ['artifactFileCount', 'publishableFileCount']) {
    if (!Number.isSafeInteger(manifest[field]) || manifest[field] < 1) fail(`${field} must be a positive integer`);
  }
  if (!Number.isSafeInteger(manifest.runtimeDependencyCount) || manifest.runtimeDependencyCount < 0) {
    fail('runtimeDependencyCount must be a non-negative integer');
  }
  for (const field of ['artifactTreeSha256', 'publishableTreeSha256', 'runtimeDependencyTreeSha256']) {
    if (!/^[0-9a-f]{64}$/.test(manifest[field] ?? '')) fail(`${field} must be a SHA-256 digest`);
  }
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) fail('manifest files must be non-empty');
  if (!manifest.toolchain || typeof manifest.toolchain !== 'object' || Array.isArray(manifest.toolchain)) {
    fail('toolchain must be an object');
  }
  const toolchainKeys = Object.keys(manifest.toolchain).sort(comparePaths);
  const expectedToolchainKeys = ['javascriptObfuscator', 'prisma', 'typescript'];
  if (JSON.stringify(toolchainKeys) !== JSON.stringify(expectedToolchainKeys)) fail('toolchain fields differ from schema');
  for (const [name, version] of Object.entries(manifest.toolchain)) {
    if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) fail(`invalid ${name} toolchain version`);
  }
  return manifest;
}

function verifyManifestFiles(repositoryRoot, manifest, actualPaths) {
  const manifestPaths = [];
  const publishableLines = [];
  const artifactLines = [];
  let previousPath = null;

  for (const record of manifest.files) {
    if (!record || typeof record !== 'object' || Array.isArray(record)) fail('each manifest file must be an object');
    const recordKeys = Object.keys(record).sort(comparePaths);
    if (JSON.stringify(recordKeys) !== JSON.stringify(['bytes', 'path', 'sha256'])) {
      fail('manifest file records must contain only bytes, path and sha256');
    }
    assertSafeRelativePath(record.path);
    if (!isApprovedPublicFile(record.path)) fail(`manifest contains an unapproved file: ${record.path}`);
    if (previousPath !== null && comparePaths(previousPath, record.path) >= 0) {
      fail('manifest files must be unique and sorted by path');
    }
    previousPath = record.path;
    if (!/^[0-9a-f]{64}$/.test(record.sha256 ?? '')) fail(`invalid sha256 for ${record.path}`);
    if (!Number.isSafeInteger(record.bytes) || record.bytes < 0) fail(`invalid byte size for ${record.path}`);

    const absolutePath = path.join(repositoryRoot, ...record.path.split('/'));
    if (!fs.existsSync(absolutePath)) fail(`manifest file is missing: ${record.path}`);
    const stat = fs.lstatSync(absolutePath);
    if (!stat.isFile() || stat.isSymbolicLink()) fail(`manifest entry is not a regular file: ${record.path}`);
    const content = fs.readFileSync(absolutePath);
    if (content.length !== record.bytes) fail(`byte size differs for ${record.path}`);
    const actualHash = sha256(content);
    if (actualHash !== record.sha256) fail(`SHA-256 differs for ${record.path}`);
    manifestPaths.push(record.path);
    const line = `${actualHash}  ${record.path}\n`;
    publishableLines.push(line);
    if (record.path.startsWith(`${artifactRoot}/`)) artifactLines.push(line);
  }

  if (JSON.stringify(manifestPaths) !== JSON.stringify(actualPaths)) {
    const manifestSet = new Set(manifestPaths);
    const actualSet = new Set(actualPaths);
    const missing = actualPaths.filter((entry) => !manifestSet.has(entry));
    const extra = manifestPaths.filter((entry) => !actualSet.has(entry));
    fail(`manifest tree mismatch; missing=[${missing.join(', ')}], extra=[${extra.join(', ')}]`);
  }
  if (manifest.publishableFileCount !== manifestPaths.length) fail('publishableFileCount differs from manifest files');
  if (sha256(Buffer.from(publishableLines.join(''), 'utf8')) !== manifest.publishableTreeSha256) {
    fail('publishableTreeSha256 differs from the public tree');
  }

  const artifactFiles = manifestPaths.filter((entry) => entry.startsWith(`${artifactRoot}/`));
  if (artifactFiles.length !== manifest.artifactFileCount) fail('artifactFileCount differs from manifest files');
  if (sha256(Buffer.from(artifactLines.join(''), 'utf8')) !== manifest.artifactTreeSha256) {
    fail('artifactTreeSha256 differs from the protected runtime tree');
  }
}

function verifyRepositoryContent(repositoryRoot, files) {
  for (const relativePath of files) {
    const absolutePath = path.join(repositoryRoot, ...relativePath.split('/'));
    const content = fs.readFileSync(absolutePath, 'utf8');
    for (const candidate of secretPatterns) {
      if (candidate.pattern.test(content)) fail(`${candidate.name} pattern found in ${relativePath}`);
    }
  }
}

function verifyPublicJavaScript(repositoryRoot, files) {
  const artifactFiles = files.filter((entry) => entry.startsWith(`${artifactRoot}/`));
  if (!artifactFiles.includes(`${artifactRoot}/index.js`)) fail(`${artifactRoot}/index.js is missing`);

  for (const relativePath of files.filter((entry) => entry.endsWith('.js'))) {
    const absolutePath = path.join(repositoryRoot, ...relativePath.split('/'));
    if (relativePath.startsWith(`${artifactRoot}/`)) {
      const source = fs.readFileSync(absolutePath, 'utf8');
      if (source.includes('sourceMappingURL=')) fail(`source-map reference found in ${relativePath}`);
      if (/C:\\\\[^'"`\r\n]+|\/home\/runner\/work\/|\/Users\/[^/]+\//.test(source)) {
        fail(`absolute build path marker found in ${relativePath}`);
      }
    }
    const syntax = spawnSync(process.execPath, ['--check', absolutePath], {
      encoding: 'utf8',
      windowsHide: true,
    });
    if (syntax.status !== 0) fail(`JavaScript syntax check failed for ${relativePath}: ${syntax.stderr.trim()}`);
  }
}

function verifyPackageVersion(repositoryRoot, releaseVersion) {
  let packageJson;
  let packageLock;
  try {
    packageJson = JSON.parse(fs.readFileSync(path.join(repositoryRoot, 'package.json'), 'utf8'));
    packageLock = JSON.parse(fs.readFileSync(path.join(repositoryRoot, 'package-lock.json'), 'utf8'));
  } catch (error) {
    fail(`package manifest is invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (packageJson.version !== releaseVersion) {
    fail(`package.json version ${String(packageJson.version)} differs from releaseVersion ${releaseVersion}`);
  }
  if (
    packageLock.lockfileVersion !== 3 ||
    packageLock.version !== releaseVersion ||
    packageLock.packages?.['']?.version !== releaseVersion
  ) {
    fail('package-lock.json root version or lockfileVersion differs from the release');
  }
}

function verifyRuntimeDependencyClosure(repositoryRoot, manifest) {
  const closure = computeRuntimeDependencyClosure(repositoryRoot);
  if (closure.count !== manifest.runtimeDependencyCount) {
    fail('runtimeDependencyCount differs from the public runtime dependency closure');
  }
  if (closure.sha256 !== manifest.runtimeDependencyTreeSha256) {
    fail('runtimeDependencyTreeSha256 differs from the public runtime dependency closure');
  }
  return closure;
}

function verifyDistribution(repositoryRoot, options = {}) {
  const inspected = inspectPublishableTree(repositoryRoot, options);
  const manifest = readManifest(inspected.root);
  verifyManifestFiles(inspected.root, manifest, inspected.files);
  verifyRepositoryContent(inspected.root, inspected.files);
  verifyPublicJavaScript(inspected.root, inspected.files);
  verifyPackageVersion(inspected.root, manifest.releaseVersion);
  verifyRuntimeDependencyClosure(inspected.root, manifest);
  return manifest;
}

function main() {
  const repositoryRoot = path.resolve(__dirname, '..');
  const manifest = verifyDistribution(repositoryRoot);
  process.stdout.write(
    `distribution verified: ${manifest.releaseVersion}, ${manifest.publishableFileCount} public files, ` +
      `${manifest.artifactFileCount} protected runtime files\n`,
  );
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

module.exports = {
  artifactRoot,
  computeRuntimeDependencyClosure,
  discoverPublishableFiles,
  inspectPublishableTree,
  requiredPublicFiles: Object.freeze([...requiredPublicFiles].sort(comparePaths)),
  sha256,
  verifyDistribution,
};
