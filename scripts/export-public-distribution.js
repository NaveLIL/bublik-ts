'use strict';

const { createHash, randomBytes } = require('node:crypto');
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const sourceRoot = path.resolve(__dirname, '..');
const artifactRoot = 'dist-protected';
const manifestFile = 'artifact-manifest.json';
const releaseLockFile = '.bublik-release.lock';
const expectedRemote = 'https://github.com/NaveLIL/bublik-ts-release.git';
const gitleaksVersion = '8.30.1';
const gitleaksLinuxX64Sha256 = '551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb';
const releaseNodeImage =
  'node:24-alpine@sha256:a0b9bf06e4e6193cf7a0f58816cc935ff8c2a908f81e6f1a95432d679c54fbfd';
const copiedDirectories = ['dist-protected', 'locales', 'prisma'];
const copiedFiles = [
  { source: 'scripts/entrypoint.sh', target: 'scripts/entrypoint.sh' },
  { source: 'scripts/snapshot-baseline-data.js', target: 'scripts/snapshot-baseline-data.js' },
  { source: 'scripts/snapshot-redis-data.js', target: 'scripts/snapshot-redis-data.js' },
  { source: 'scripts/verify-baseline-target.js', target: 'scripts/verify-baseline-target.js' },
  { source: 'scripts/verify-pb-idle.js', target: 'scripts/verify-pb-idle.js' },
  { source: 'scripts/verify-public-distribution.js', target: 'scripts/verify-distribution.js' },
];
const ownedFilePaths = [manifestFile, ...copiedFiles.map((mapping) => mapping.target)];

function fail(message) {
  throw new Error(`public distribution export failed: ${message}`);
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

function parseArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name?.startsWith('--') || value === undefined) fail(`invalid argument near ${name ?? '<end>'}`);
    if (values.has(name)) fail(`duplicate argument: ${name}`);
    values.set(name, value);
  }
  const allowed = new Set(['--target', '--version', '--source-revision', '--source-tree', '--created-at']);
  for (const name of values.keys()) {
    if (!allowed.has(name)) fail(`unknown argument: ${name}`);
  }
  for (const name of allowed) {
    if (!values.has(name)) fail(`missing required argument: ${name}`);
  }
  return {
    target: path.resolve(values.get('--target')),
    version: values.get('--version'),
    sourceRevision: values.get('--source-revision'),
    sourceTree: values.get('--source-tree'),
    createdAt: values.get('--created-at'),
  };
}

function git(args, cwd) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  }).trim();
}

function normalizeRemote(remote) {
  const trimmed = remote.trim().replace(/\\/g, '/');
  if (trimmed.startsWith('git@github.com:')) return `https://github.com/${trimmed.slice(15)}`;
  return trimmed.endsWith('.git') ? trimmed : `${trimmed}.git`;
}

function redactRemote(remote) {
  return remote.replace(/(https?:\/\/)[^/@\s]+@/gi, '$1<redacted>@');
}

function normalizedPathKey(value) {
  const resolved = path.resolve(value).replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function isInside(candidate, parent) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
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

function assertNoLinkedPathComponents(absolutePath) {
  const resolved = path.resolve(absolutePath);
  const parsed = path.parse(resolved);
  const components = path.relative(parsed.root, resolved).split(path.sep).filter(Boolean);
  let current = parsed.root;
  for (const component of components) {
    current = path.join(current, component);
    if (!fs.existsSync(current)) fail(`path component is missing: ${current}`);
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) fail(`path component is a symbolic link or junction: ${current}`);
    const real = fs.realpathSync.native(current);
    if (normalizedPathKey(real) !== normalizedPathKey(current)) {
      fail(`path component resolves through a link or junction: ${current}`);
    }
  }
}

function createRootContext(root) {
  const lexicalRoot = path.resolve(root);
  if (!fs.existsSync(lexicalRoot)) fail(`directory is missing: ${lexicalRoot}`);
  const stat = fs.lstatSync(lexicalRoot);
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail(`not a regular directory: ${lexicalRoot}`);
  const realRoot = fs.realpathSync.native(lexicalRoot);
  if (normalizedPathKey(realRoot) !== normalizedPathKey(lexicalRoot)) {
    fail(`directory resolves through a link or junction: ${lexicalRoot}`);
  }
  return { lexicalRoot, realRoot };
}

function assertEntryWithinRoot(context, absolutePath, expectedType) {
  const resolvedPath = path.resolve(absolutePath);
  if (!isInside(resolvedPath, context.lexicalRoot)) fail(`path escapes its root: ${resolvedPath}`);
  const stat = fs.lstatSync(resolvedPath);
  if (stat.isSymbolicLink()) fail(`symbolic links and junctions are forbidden: ${resolvedPath}`);
  if (expectedType === 'directory' && !stat.isDirectory()) fail(`expected a directory: ${resolvedPath}`);
  if (expectedType === 'file' && !stat.isFile()) fail(`expected a regular file: ${resolvedPath}`);
  if (!stat.isDirectory() && !stat.isFile()) fail(`unsupported filesystem entry: ${resolvedPath}`);
  const real = fs.realpathSync.native(resolvedPath);
  if (!isInside(real, context.realRoot) || normalizedPathKey(real) !== normalizedPathKey(resolvedPath)) {
    fail(`filesystem entry resolves outside its root: ${resolvedPath}`);
  }
  return stat;
}

function scanTargetWorktree(context) {
  function visit(current, relativeDirectory) {
    const entries = fs.readdirSync(current, { withFileTypes: true })
      .sort((left, right) => comparePaths(left.name, right.name));
    for (const entry of entries) {
      const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      const absolutePath = path.join(current, entry.name);
      const stat = fs.lstatSync(absolutePath);
      if (stat.isSymbolicLink()) fail(`target contains a symbolic link or junction: ${relativePath}`);
      if (relativePath === '.git') {
        if (!stat.isDirectory() && !stat.isFile()) fail('target .git entry has an unsupported type');
        assertEntryWithinRoot(context, absolutePath, stat.isDirectory() ? 'directory' : 'file');
        continue;
      }
      if (relativePath === 'node_modules' || relativePath.startsWith('node_modules/')) {
        fail('target node_modules/ must be absent during export');
      }
      if (stat.isDirectory()) {
        assertEntryWithinRoot(context, absolutePath, 'directory');
        visit(absolutePath, relativePath);
      } else if (stat.isFile()) {
        assertEntryWithinRoot(context, absolutePath, 'file');
      } else {
        fail(`target contains an unsupported filesystem entry: ${relativePath}`);
      }
    }
  }
  visit(context.lexicalRoot, '');
}

function assertOwnedDestinationShape(context) {
  for (const relativePath of copiedDirectories) {
    const absolutePath = absoluteFor(context, relativePath);
    if (fs.existsSync(absolutePath)) assertEntryWithinRoot(context, absolutePath, 'directory');
  }
  for (const relativePath of [manifestFile, ...copiedFiles.map((mapping) => mapping.target)]) {
    const parent = path.posix.dirname(relativePath);
    if (parent !== '.') {
      const parentPath = absoluteFor(context, parent);
      if (fs.existsSync(parentPath)) assertEntryWithinRoot(context, parentPath, 'directory');
    }
    const absolutePath = absoluteFor(context, relativePath);
    if (fs.existsSync(absolutePath)) assertEntryWithinRoot(context, absolutePath, 'file');
  }
}

function assertSafeTarget(target) {
  assertNoLinkedPathComponents(target);
  const context = createRootContext(target);
  const realSourceRoot = fs.realpathSync.native(sourceRoot);
  if (isInside(context.realRoot, realSourceRoot) || isInside(realSourceRoot, context.realRoot)) {
    fail('source and target repositories must not contain one another');
  }
  if (!fs.existsSync(path.join(context.lexicalRoot, '.git'))) fail('target is not a Git worktree');
  scanTargetWorktree(context);
  assertOwnedDestinationShape(context);

  let remote;
  try {
    remote = normalizeRemote(git(['remote', 'get-url', 'origin'], context.lexicalRoot));
  } catch (error) {
    fail(`cannot resolve target origin: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (remote.toLowerCase() !== expectedRemote.toLowerCase()) {
    fail(`unexpected target origin: ${redactRemote(remote)}`);
  }
  for (const forbidden of ['dist', 'src', 'tests']) {
    if (fs.existsSync(path.join(context.lexicalRoot, forbidden))) {
      fail(`target contains forbidden ${forbidden}/ directory`);
    }
  }
  return context;
}

function assertOwnedTargetClean(context) {
  const output = git(
    ['status', '--porcelain', '--untracked-files=all', '--', ...copiedDirectories, ...ownedFilePaths],
    context.lexicalRoot,
  );
  if (output !== '') fail(`target release-owned paths have uncommitted changes:\n${output}`);
}

function readTargetRevision(context) {
  const revision = git(['rev-parse', 'HEAD'], context.lexicalRoot);
  if (!/^[0-9a-f]{40}$/.test(revision)) fail('target HEAD must be a full Git SHA-1');
  return revision;
}

function assertTargetRevision(context, expectedRevision) {
  if (readTargetRevision(context) !== expectedRevision) fail('target HEAD changed during export');
}

function assertSourceIdentity(metadata) {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(metadata.version)) {
    fail('version must be semantic without a leading v');
  }
  if (!/^[0-9a-f]{40}$/.test(metadata.sourceRevision)) fail('source revision must be a full Git SHA-1');
  if (!/^[0-9a-f]{40}$/.test(metadata.sourceTree)) fail('source tree must be a full Git tree SHA-1');
  const created = new Date(metadata.createdAt);
  if (!Number.isFinite(created.getTime()) || created.toISOString() !== metadata.createdAt) {
    fail('created-at must be a canonical UTC ISO timestamp');
  }
  if (git(['rev-parse', 'HEAD'], sourceRoot) !== metadata.sourceRevision) fail('source revision differs from HEAD');
  if (git(['rev-parse', 'HEAD^{tree}'], sourceRoot) !== metadata.sourceTree) fail('source tree differs from HEAD tree');
  if (git(['status', '--porcelain', '--untracked-files=all'], sourceRoot) !== '') {
    fail('source repository has tracked or untracked changes');
  }
}

function absoluteFor(context, relativePath) {
  assertSafeRelativePath(relativePath);
  const absolutePath = path.resolve(context.lexicalRoot, ...relativePath.split('/'));
  if (!isInside(absolutePath, context.lexicalRoot) || absolutePath === context.lexicalRoot) {
    fail(`destination escapes its root: ${relativePath}`);
  }
  return absolutePath;
}

function assertTargetContextStable(context) {
  assertNoLinkedPathComponents(context.lexicalRoot);
  const fresh = createRootContext(context.lexicalRoot);
  if (normalizedPathKey(fresh.realRoot) !== normalizedPathKey(context.realRoot)) {
    fail('target repository root changed or was replaced during export');
  }
}

function assertReleaseLockOwned(context, lock) {
  assertTargetContextStable(context);
  const lockPath = absoluteFor(context, releaseLockFile);
  if (!fs.existsSync(lockPath)) fail('exclusive release lock disappeared during export');
  assertEntryWithinRoot(context, lockPath, 'file');
  const content = fs.readFileSync(lockPath, 'utf8');
  if (content !== lock.content) fail('exclusive release lock ownership changed during export');
}

function withReleaseLock(context, metadata, callback) {
  assertTargetContextStable(context);
  const lockPath = absoluteFor(context, releaseLockFile);
  const lock = {
    content: `${JSON.stringify({
      createdAt: new Date().toISOString(),
      pid: process.pid,
      sourceRevision: metadata.sourceRevision,
      token: randomBytes(24).toString('hex'),
    })}\n`,
  };
  let descriptor;
  let acquireError;
  try {
    descriptor = fs.openSync(lockPath, 'wx', 0o600);
    fs.writeFileSync(descriptor, lock.content, 'utf8');
    fs.fsyncSync(descriptor);
  } catch (error) {
    acquireError = error;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
  if (acquireError) {
    if (descriptor !== undefined && fs.existsSync(lockPath)) {
      try {
        assertEntryWithinRoot(context, lockPath, 'file');
        if (fs.readFileSync(lockPath, 'utf8') === lock.content) fs.unlinkSync(lockPath);
      } catch {
        // A partial or replaced lock is intentionally retained for manual inspection.
      }
    }
    fail(
      `cannot acquire exclusive release lock: ` +
      `${acquireError instanceof Error ? acquireError.message : String(acquireError)}`,
    );
  }
  assertReleaseLockOwned(context, lock);

  let callbackError;
  try {
    return callback(lock);
  } catch (error) {
    callbackError = error;
    throw error;
  } finally {
    try {
      assertReleaseLockOwned(context, lock);
      fs.unlinkSync(lockPath);
    } catch (cleanupError) {
      if (!callbackError) throw cleanupError;
      console.error(`exclusive release lock cleanup also failed: ${String(cleanupError)}`);
    }
  }
}

function ensureDirectory(context, relativeDirectory, assertMutationBoundary) {
  if (relativeDirectory === '' || relativeDirectory === '.') return context.lexicalRoot;
  assertSafeRelativePath(relativeDirectory);
  let current = context.lexicalRoot;
  for (const component of relativeDirectory.split('/')) {
    current = path.join(current, component);
    if (!fs.existsSync(current)) {
      assertMutationBoundary?.();
      try {
        fs.mkdirSync(current);
      } catch (error) {
        if (!fs.existsSync(current)) throw error;
      }
    }
    assertEntryWithinRoot(context, current, 'directory');
  }
  return current;
}

function temporarySiblingPath(destination) {
  const random = randomBytes(12).toString('hex');
  return path.join(path.dirname(destination), `.bublik-release-${process.pid}-${random}.tmp`);
}

function replaceRegularFile(source, context, relativePath, assertMutationBoundary) {
  const sourceStat = fs.lstatSync(source);
  if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) fail(`source is not a regular file: ${source}`);
  const destination = absoluteFor(context, relativePath);
  ensureDirectory(context, path.posix.dirname(relativePath), assertMutationBoundary);
  if (fs.existsSync(destination)) assertEntryWithinRoot(context, destination, 'file');
  const temporary = temporarySiblingPath(destination);
  if (!isInside(temporary, context.lexicalRoot) || fs.existsSync(temporary)) fail(`unsafe temporary path: ${temporary}`);
  try {
    assertMutationBoundary?.();
    fs.copyFileSync(source, temporary, fs.constants.COPYFILE_EXCL | fs.constants.COPYFILE_FICLONE);
    fs.chmodSync(temporary, sourceStat.mode & 0o777);
    assertEntryWithinRoot(context, temporary, 'file');
    if (fs.existsSync(destination)) {
      assertMutationBoundary?.();
      assertEntryWithinRoot(context, destination, 'file');
      fs.unlinkSync(destination);
    }
    assertMutationBoundary?.();
    fs.renameSync(temporary, destination);
    assertEntryWithinRoot(context, destination, 'file');
  } finally {
    if (fs.existsSync(temporary)) {
      const stat = fs.lstatSync(temporary);
      if (!stat.isFile() || stat.isSymbolicLink()) fail(`temporary path was replaced unsafely: ${temporary}`);
      fs.unlinkSync(temporary);
    }
  }
}

function replaceRegularFileContent(content, context, relativePath, assertMutationBoundary) {
  const destination = absoluteFor(context, relativePath);
  ensureDirectory(context, path.posix.dirname(relativePath), assertMutationBoundary);
  if (fs.existsSync(destination)) assertEntryWithinRoot(context, destination, 'file');
  const temporary = temporarySiblingPath(destination);
  if (!isInside(temporary, context.lexicalRoot) || fs.existsSync(temporary)) fail(`unsafe temporary path: ${temporary}`);
  try {
    assertMutationBoundary?.();
    fs.writeFileSync(temporary, content, { flag: 'wx', mode: 0o644 });
    assertEntryWithinRoot(context, temporary, 'file');
    if (fs.existsSync(destination)) {
      assertMutationBoundary?.();
      assertEntryWithinRoot(context, destination, 'file');
      fs.unlinkSync(destination);
    }
    assertMutationBoundary?.();
    fs.renameSync(temporary, destination);
    assertEntryWithinRoot(context, destination, 'file');
  } finally {
    if (fs.existsSync(temporary)) {
      const stat = fs.lstatSync(temporary);
      if (!stat.isFile() || stat.isSymbolicLink()) fail(`temporary path was replaced unsafely: ${temporary}`);
      fs.unlinkSync(temporary);
    }
  }
}

function removeRegularDirectoryTree(context, absolutePath, assertMutationBoundary) {
  assertEntryWithinRoot(context, absolutePath, 'directory');
  const entries = fs.readdirSync(absolutePath, { withFileTypes: true })
    .sort((left, right) => comparePaths(left.name, right.name));
  for (const entry of entries) {
    const child = path.join(absolutePath, entry.name);
    const stat = fs.lstatSync(child);
    if (stat.isSymbolicLink()) fail(`refusing to remove linked release path: ${child}`);
    if (stat.isDirectory()) {
      removeRegularDirectoryTree(context, child, assertMutationBoundary);
    } else if (stat.isFile()) {
      assertEntryWithinRoot(context, child, 'file');
      assertMutationBoundary?.();
      fs.unlinkSync(child);
      if (fs.existsSync(child)) fail(`release cleanup did not remove file: ${child}`);
    } else {
      fail(`refusing to remove unsupported release path: ${child}`);
    }
  }
  assertMutationBoundary?.();
  fs.rmdirSync(absolutePath);
  if (fs.existsSync(absolutePath)) fail(`release cleanup did not remove directory: ${absolutePath}`);
}

function removeOwnedDirectory(context, relativePath, assertMutationBoundary) {
  assertSafeRelativePath(relativePath);
  if (path.posix.dirname(relativePath) !== '.') fail(`owned directory must be top-level: ${relativePath}`);
  const absolutePath = absoluteFor(context, relativePath);
  if (!fs.existsSync(absolutePath)) return;
  assertEntryWithinRoot(context, absolutePath, 'directory');
  removeRegularDirectoryTree(context, absolutePath, assertMutationBoundary);
  if (fs.existsSync(absolutePath)) fail(`target cleanup did not remove ${relativePath}`);
}

function copyDirectory(source, context, relativeDestination, assertMutationBoundary) {
  const stat = fs.lstatSync(source);
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail(`source is not a regular directory: ${source}`);
  const destination = ensureDirectory(context, relativeDestination, assertMutationBoundary);
  assertMutationBoundary?.();
  fs.chmodSync(destination, stat.mode & 0o777);
  const entries = fs.readdirSync(source, { withFileTypes: true })
    .sort((left, right) => comparePaths(left.name, right.name));
  for (const entry of entries) {
    const sourcePath = path.join(source, entry.name);
    const destinationPath = `${relativeDestination}/${entry.name}`;
    const entryStat = fs.lstatSync(sourcePath);
    if (entryStat.isSymbolicLink()) fail(`source contains a symbolic link or junction: ${sourcePath}`);
    if (entryStat.isDirectory()) copyDirectory(sourcePath, context, destinationPath, assertMutationBoundary);
    else if (entryStat.isFile()) replaceRegularFile(sourcePath, context, destinationPath, assertMutationBoundary);
    else fail(`unsupported source entry: ${sourcePath}`);
  }
}

function isOwnedTargetPath(relativePath) {
  if (relativePath === manifestFile) return true;
  if (copiedFiles.some((mapping) => mapping.target === relativePath)) return true;
  return copiedDirectories.some(
    (directory) => relativePath === directory || relativePath.startsWith(`${directory}/`),
  );
}

function copyPreservedTargetTree(targetContext, stageContext) {
  function visit(sourceDirectory, relativeDirectory) {
    const entries = fs.readdirSync(sourceDirectory, { withFileTypes: true })
      .sort((left, right) => comparePaths(left.name, right.name));
    for (const entry of entries) {
      const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      if (
        relativePath === '.git' ||
        relativePath === 'node_modules' ||
        relativePath === releaseLockFile ||
        isOwnedTargetPath(relativePath)
      ) continue;
      const sourcePath = path.join(sourceDirectory, entry.name);
      const stat = fs.lstatSync(sourcePath);
      if (stat.isSymbolicLink()) fail(`target metadata contains a symbolic link or junction: ${relativePath}`);
      if (stat.isDirectory()) {
        assertEntryWithinRoot(targetContext, sourcePath, 'directory');
        ensureDirectory(stageContext, relativePath);
        visit(sourcePath, relativePath);
      } else if (stat.isFile()) {
        assertEntryWithinRoot(targetContext, sourcePath, 'file');
        replaceRegularFile(sourcePath, stageContext, relativePath);
      } else {
        fail(`target metadata contains an unsupported entry: ${relativePath}`);
      }
    }
  }
  visit(targetContext.lexicalRoot, '');
}

function fingerprintPreservedTarget(context) {
  const lines = [];
  function visit(current, relativeDirectory) {
    const entries = fs.readdirSync(current, { withFileTypes: true })
      .sort((left, right) => comparePaths(left.name, right.name));
    for (const entry of entries) {
      const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      if (
        relativePath === '.git' ||
        relativePath === 'node_modules' ||
        relativePath === releaseLockFile ||
        isOwnedTargetPath(relativePath)
      ) continue;
      const absolutePath = path.join(current, entry.name);
      const stat = fs.lstatSync(absolutePath);
      if (stat.isSymbolicLink()) fail(`target metadata contains a symbolic link or junction: ${relativePath}`);
      if (stat.isDirectory()) {
        assertEntryWithinRoot(context, absolutePath, 'directory');
        lines.push(`D ${relativePath}\n`);
        visit(absolutePath, relativePath);
      } else if (stat.isFile()) {
        assertEntryWithinRoot(context, absolutePath, 'file');
        const content = fs.readFileSync(absolutePath);
        lines.push(`F ${sha256(content)} ${content.length} ${relativePath}\n`);
      } else {
        fail(`target metadata contains an unsupported entry: ${relativePath}`);
      }
    }
  }
  visit(context.lexicalRoot, '');
  return sha256(Buffer.from(lines.join(''), 'utf8'));
}

function fingerprintOwnedPayload(context) {
  const lines = [];
  function visitDirectory(current, relativeDirectory) {
    const directoryStat = fs.lstatSync(current);
    lines.push(`D ${directoryStat.mode & 0o777} ${relativeDirectory}\n`);
    const entries = fs.readdirSync(current, { withFileTypes: true })
      .sort((left, right) => comparePaths(left.name, right.name));
    for (const entry of entries) {
      const relativePath = `${relativeDirectory}/${entry.name}`;
      const absolutePath = path.join(current, entry.name);
      const stat = fs.lstatSync(absolutePath);
      if (stat.isSymbolicLink()) fail(`release-owned payload contains a symbolic link: ${relativePath}`);
      if (stat.isDirectory()) {
        assertEntryWithinRoot(context, absolutePath, 'directory');
        visitDirectory(absolutePath, relativePath);
      } else if (stat.isFile()) {
        assertEntryWithinRoot(context, absolutePath, 'file');
        const content = fs.readFileSync(absolutePath);
        lines.push(`F ${stat.mode & 0o777} ${sha256(content)} ${content.length} ${relativePath}\n`);
      } else {
        fail(`release-owned payload contains an unsupported entry: ${relativePath}`);
      }
    }
  }

  for (const relativePath of copiedDirectories) {
    const absolutePath = absoluteFor(context, relativePath);
    if (!fs.existsSync(absolutePath)) lines.push(`M D ${relativePath}\n`);
    else {
      assertEntryWithinRoot(context, absolutePath, 'directory');
      visitDirectory(absolutePath, relativePath);
    }
  }
  for (const relativePath of ownedFilePaths) {
    const absolutePath = absoluteFor(context, relativePath);
    if (!fs.existsSync(absolutePath)) lines.push(`M F ${relativePath}\n`);
    else {
      assertEntryWithinRoot(context, absolutePath, 'file');
      const stat = fs.lstatSync(absolutePath);
      const content = fs.readFileSync(absolutePath);
      lines.push(`F ${stat.mode & 0o777} ${sha256(content)} ${content.length} ${relativePath}\n`);
    }
  }
  return sha256(Buffer.from(lines.join(''), 'utf8'));
}

function removeOwnedFile(context, relativePath, assertMutationBoundary) {
  const absolutePath = absoluteFor(context, relativePath);
  if (!fs.existsSync(absolutePath)) return;
  assertEntryWithinRoot(context, absolutePath, 'file');
  assertMutationBoundary?.();
  fs.unlinkSync(absolutePath);
  if (fs.existsSync(absolutePath)) fail(`target cleanup did not remove ${relativePath}`);
}

function clearOwnedPayload(context, assertMutationBoundary) {
  for (const relativePath of copiedDirectories) {
    removeOwnedDirectory(context, relativePath, assertMutationBoundary);
  }
  for (const relativePath of ownedFilePaths) {
    removeOwnedFile(context, relativePath, assertMutationBoundary);
  }
}

function backupOwnedPayload(targetContext, workspaceRoot, assertMutationBoundary) {
  assertMutationBoundary();
  const originalFingerprint = fingerprintOwnedPayload(targetContext);
  const backupRoot = path.join(workspaceRoot, 'target-owned-backup');
  fs.mkdirSync(backupRoot);
  const backupContext = createRootContext(backupRoot);
  for (const relativePath of copiedDirectories) {
    const source = absoluteFor(targetContext, relativePath);
    if (fs.existsSync(source)) copyDirectory(source, backupContext, relativePath);
  }
  for (const relativePath of ownedFilePaths) {
    const source = absoluteFor(targetContext, relativePath);
    if (fs.existsSync(source)) replaceRegularFile(source, backupContext, relativePath);
  }
  assertMutationBoundary();
  if (fingerprintOwnedPayload(targetContext) !== originalFingerprint) {
    fail('target release-owned payload changed while its rollback backup was created');
  }
  if (fingerprintOwnedPayload(backupContext) !== originalFingerprint) {
    fail('rollback backup differs from the target release-owned payload');
  }
  return { backupContext, originalFingerprint };
}

function restoreOwnedPayload(targetContext, backup, assertMutationBoundary) {
  clearOwnedPayload(targetContext, assertMutationBoundary);
  for (const relativePath of copiedDirectories) {
    const source = absoluteFor(backup.backupContext, relativePath);
    if (fs.existsSync(source)) {
      copyDirectory(source, targetContext, relativePath, assertMutationBoundary);
    }
  }
  for (const relativePath of ownedFilePaths) {
    const source = absoluteFor(backup.backupContext, relativePath);
    if (fs.existsSync(source)) {
      replaceRegularFile(source, targetContext, relativePath, assertMutationBoundary);
    }
  }
  if (fingerprintOwnedPayload(targetContext) !== backup.originalFingerprint) {
    fail('rollback did not restore the exact release-owned payload');
  }
}

function runChecked(command, args, options) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    stdio: 'inherit',
    windowsHide: true,
  });
  if (result.error) fail(`${options.label} could not start: ${result.error.message}`);
  if (result.status !== 0) fail(`${options.label} exited with status ${String(result.status)}`);
}

function dockerArguments(checkoutRoot, environment, network, command) {
  const args = ['run', '--rm'];
  if (typeof process.getuid === 'function' && typeof process.getgid === 'function') {
    args.push('--user', `${process.getuid()}:${process.getgid()}`);
  }
  args.push(
    '--network', network,
    '--mount', `type=bind,source=${checkoutRoot},target=/workspace`,
    '--workdir', '/workspace',
  );
  for (const [name, value] of Object.entries(environment)) args.push('--env', `${name}=${value}`);
  args.push(releaseNodeImage, ...command);
  return args;
}

function runReleaseContainer(checkoutRoot, environment, network, command, label) {
  runChecked('docker', dockerArguments(checkoutRoot, environment, network, command), {
    cwd: checkoutRoot,
    label,
  });
}

function scanTreeForSecrets(treeRoot, environment, label) {
  const archiveUrl =
    `https://github.com/gitleaks/gitleaks/releases/download/v${gitleaksVersion}/` +
    `gitleaks_${gitleaksVersion}_linux_x64.tar.gz`;
  const command = [
    'sh',
    '-ec',
    [
      'archive=/tmp/bublik-gitleaks.tar.gz',
      'binary_dir=/tmp/bublik-gitleaks-bin',
      `wget --quiet --output-document "$archive" ${archiveUrl}`,
      `printf '%s  %s\\n' ${gitleaksLinuxX64Sha256} "$archive" | sha256sum -c -`,
      'mkdir "$binary_dir"',
      'tar --extract --gzip --file "$archive" --directory "$binary_dir" gitleaks',
      'chmod 0755 "$binary_dir/gitleaks"',
      '"$binary_dir/gitleaks" dir --no-banner --redact --verbose /workspace',
    ].join('\n'),
  ];
  runReleaseContainer(treeRoot, environment, 'bridge', command, label);
}

function collectArtifactRecords(checkoutRoot) {
  const root = path.join(checkoutRoot, artifactRoot);
  if (!fs.existsSync(root)) fail(`clean build did not create ${artifactRoot}/`);
  const files = [];
  function visit(current) {
    const entries = fs.readdirSync(current, { withFileTypes: true })
      .sort((left, right) => comparePaths(left.name, right.name));
    for (const entry of entries) {
      const absolutePath = path.join(current, entry.name);
      const relativePath = toPosix(path.relative(checkoutRoot, absolutePath));
      const stat = fs.lstatSync(absolutePath);
      if (stat.isSymbolicLink()) fail(`clean artifact contains a symbolic link: ${relativePath}`);
      if (stat.isDirectory()) visit(absolutePath);
      else if (stat.isFile()) {
        const content = fs.readFileSync(absolutePath);
        files.push({ path: relativePath, sha256: sha256(content), bytes: content.length });
      } else fail(`clean artifact contains an unsupported entry: ${relativePath}`);
    }
  }
  visit(root);
  return files.sort((left, right) => comparePaths(left.path, right.path));
}

function artifactTreeDigest(records) {
  const lines = records.map((entry) => `${entry.sha256}  ${entry.path}\n`).join('');
  return sha256(Buffer.from(lines, 'utf8'));
}

function assertCleanCheckoutIdentity(checkoutRoot, metadata) {
  if (git(['rev-parse', 'HEAD'], checkoutRoot) !== metadata.sourceRevision) fail('clean checkout revision differs');
  if (git(['rev-parse', 'HEAD^{tree}'], checkoutRoot) !== metadata.sourceTree) fail('clean checkout tree differs');
  if (git(['status', '--porcelain', '--untracked-files=all'], checkoutRoot) !== '') {
    fail('clean checkout has tracked or untracked source changes');
  }
}

function assertSourceTreeModes(checkoutRoot, sourceRevision) {
  const tree = git(['ls-tree', '-r', '--full-tree', sourceRevision], checkoutRoot);
  for (const line of tree.split(/\r?\n/)) {
    if (line === '') continue;
    const mode = line.slice(0, line.indexOf(' '));
    if (mode !== '100644' && mode !== '100755') {
      fail(`source tree contains a symlink, submodule or unsupported mode: ${line}`);
    }
  }
}

function assertExpectedIgnoredOutputs(checkoutRoot, allowedRoots) {
  const output = git(
    ['status', '--porcelain', '--ignored=matching', '--untracked-files=all'],
    checkoutRoot,
  );
  if (output === '') return;
  for (const line of output.split(/\r?\n/)) {
    if (!line.startsWith('!! ')) continue;
    const relativePath = line.slice(3).replace(/\\/g, '/').replace(/\/$/, '');
    const allowed = allowedRoots.some(
      (root) => relativePath === root || relativePath.startsWith(`${root}/`),
    );
    if (!allowed) fail(`clean checkout contains an unexpected ignored path: ${relativePath}`);
  }
}

function buildCleanReleaseCheckout(workspaceRoot, metadata) {
  const checkoutRoot = path.join(workspaceRoot, 'source');
  runChecked('git', ['clone', '--quiet', '--no-hardlinks', '--no-checkout', sourceRoot, checkoutRoot], {
    cwd: workspaceRoot,
    label: 'clean source clone',
  });
  runChecked('git', ['config', '--local', 'core.autocrlf', 'false'], {
    cwd: checkoutRoot,
    label: 'clean checkout line-ending policy',
  });
  runChecked('git', ['config', '--local', 'core.eol', 'lf'], {
    cwd: checkoutRoot,
    label: 'clean checkout line-ending policy',
  });
  assertSourceTreeModes(checkoutRoot, metadata.sourceRevision);
  runChecked('git', ['checkout', '--quiet', '--detach', metadata.sourceRevision], {
    cwd: checkoutRoot,
    label: 'clean source checkout',
  });
  assertCleanCheckoutIdentity(checkoutRoot, metadata);

  const packageJson = JSON.parse(fs.readFileSync(path.join(checkoutRoot, 'package.json'), 'utf8'));
  if (packageJson.version !== metadata.version) {
    fail(`release version ${metadata.version} differs from clean package.json version ${String(packageJson.version)}`);
  }
  const sourceDateEpoch = git(['show', '-s', '--format=%ct', metadata.sourceRevision], checkoutRoot);
  const containerEnvironment = {
    CI: '1',
    npm_config_cache: '/tmp/bublik-release-npm-cache',
    SOURCE_DATE_EPOCH: sourceDateEpoch,
    TZ: 'UTC',
  };
  scanTreeForSecrets(checkoutRoot, containerEnvironment, 'clean source secret scan');
  assertCleanCheckoutIdentity(checkoutRoot, metadata);
  runReleaseContainer(
    checkoutRoot,
    containerEnvironment,
    'bridge',
    [
      'sh',
      '-ec',
      'npm ci --ignore-scripts --no-audit --no-fund && ./node_modules/.bin/prisma generate',
    ],
    'clean Node 24 dependency installation',
  );
  assertCleanCheckoutIdentity(checkoutRoot, metadata);
  assertExpectedIgnoredOutputs(checkoutRoot, ['node_modules']);

  const buildCommand = [
    'sh',
    '-ec',
    'npm run build && node scripts/obfuscate.js && node scripts/verify-protected-artifact.js',
  ];
  runReleaseContainer(checkoutRoot, containerEnvironment, 'none', buildCommand, 'first clean protected build');
  assertCleanCheckoutIdentity(checkoutRoot, metadata);
  assertExpectedIgnoredOutputs(checkoutRoot, ['dist', 'dist-protected', 'node_modules']);
  const firstRecords = collectArtifactRecords(checkoutRoot);
  const firstDigest = artifactTreeDigest(firstRecords);
  runReleaseContainer(checkoutRoot, containerEnvironment, 'none', buildCommand, 'second clean protected build');
  assertCleanCheckoutIdentity(checkoutRoot, metadata);
  assertExpectedIgnoredOutputs(checkoutRoot, ['dist', 'dist-protected', 'node_modules']);
  const secondRecords = collectArtifactRecords(checkoutRoot);
  const secondDigest = artifactTreeDigest(secondRecords);
  if (firstDigest !== secondDigest || JSON.stringify(firstRecords) !== JSON.stringify(secondRecords)) {
    fail('two clean protected builds are not reproducible');
  }
  assertCleanCheckoutIdentity(checkoutRoot, metadata);
  return {
    checkoutRoot,
    artifactFileCount: secondRecords.length,
    artifactTreeSha256: secondDigest,
  };
}

function packageVersion(buildRoot, name) {
  const packagePath = path.join(buildRoot, 'node_modules', name, 'package.json');
  if (!fs.existsSync(packagePath)) fail(`toolchain package is missing after clean install: ${name}`);
  return JSON.parse(fs.readFileSync(packagePath, 'utf8')).version;
}

function createManifest(stageRoot, build, metadata, canonicalVerifier, runtimeDependencyClosure) {
  const paths = canonicalVerifier.discoverPublishableFiles(stageRoot);
  const files = paths.map((relativePath) => {
    const absolutePath = path.join(stageRoot, ...relativePath.split('/'));
    const stat = fs.lstatSync(absolutePath);
    if (!stat.isFile() || stat.isSymbolicLink()) fail(`staged public file is not regular: ${relativePath}`);
    const content = fs.readFileSync(absolutePath);
    return { path: relativePath, sha256: sha256(content), bytes: content.length };
  });
  const publishableLines = files.map((entry) => `${entry.sha256}  ${entry.path}\n`).join('');
  const artifactFiles = files.filter((entry) => entry.path.startsWith(`${artifactRoot}/`));
  const artifactLines = artifactFiles.map((entry) => `${entry.sha256}  ${entry.path}\n`).join('');
  const artifactDigest = sha256(Buffer.from(artifactLines, 'utf8'));
  if (artifactFiles.length !== build.artifactFileCount || artifactDigest !== build.artifactTreeSha256) {
    fail('staged protected artifact differs from the reproducible clean build attestation');
  }
  return {
    schemaVersion: 2,
    releaseVersion: metadata.version,
    createdAt: metadata.createdAt,
    sourceRevision: metadata.sourceRevision,
    sourceTree: metadata.sourceTree,
    nodeMajor: 24,
    buildImage: releaseNodeImage,
    reproducibleBuildCount: 2,
    runtimeDependencyCount: runtimeDependencyClosure.count,
    runtimeDependencyTreeSha256: runtimeDependencyClosure.sha256,
    artifactRoot,
    publishableFileCount: files.length,
    publishableTreeSha256: sha256(Buffer.from(publishableLines, 'utf8')),
    artifactFileCount: artifactFiles.length,
    artifactTreeSha256: artifactDigest,
    toolchain: {
      typescript: packageVersion(build.checkoutRoot, 'typescript'),
      javascriptObfuscator: packageVersion(build.checkoutRoot, 'javascript-obfuscator'),
      prisma: packageVersion(build.checkoutRoot, 'prisma'),
    },
    files,
  };
}

function loadCanonicalVerifier(checkoutRoot) {
  const verifierPath = path.join(checkoutRoot, 'scripts', 'verify-public-distribution.js');
  if (!fs.existsSync(verifierPath)) fail('clean source checkout lacks the canonical distribution verifier');
  const verifier = require(verifierPath);
  if (
    typeof verifier.computeRuntimeDependencyClosure !== 'function' ||
    typeof verifier.discoverPublishableFiles !== 'function' ||
    typeof verifier.verifyDistribution !== 'function'
  ) {
    fail('canonical distribution verifier has an invalid module interface');
  }
  return verifier;
}

function prepareStagedDistribution(workspaceRoot, targetContext, build, metadata) {
  const stageRoot = path.join(workspaceRoot, 'public-stage');
  fs.mkdirSync(stageRoot);
  const stageContext = createRootContext(stageRoot);
  copyPreservedTargetTree(targetContext, stageContext);

  for (const relativePath of copiedDirectories) {
    copyDirectory(path.join(build.checkoutRoot, relativePath), stageContext, relativePath);
  }
  for (const mapping of copiedFiles) {
    replaceRegularFile(
      path.join(build.checkoutRoot, ...mapping.source.split('/')),
      stageContext,
      mapping.target,
    );
  }

  const canonicalVerifier = loadCanonicalVerifier(build.checkoutRoot);
  const sourceRuntimeDependencyClosure = canonicalVerifier.computeRuntimeDependencyClosure(
    build.checkoutRoot,
    { allowDevelopmentEntries: true },
  );
  const publicRuntimeDependencyClosure = canonicalVerifier.computeRuntimeDependencyClosure(stageRoot);
  if (
    sourceRuntimeDependencyClosure.canonical !== publicRuntimeDependencyClosure.canonical ||
    sourceRuntimeDependencyClosure.sha256 !== publicRuntimeDependencyClosure.sha256
  ) {
    fail('public runtime dependency closure differs from the clean source release closure');
  }
  scanTreeForSecrets(
    stageRoot,
    { CI: '1', npm_config_cache: '/tmp/bublik-release-npm-cache', TZ: 'UTC' },
    'staged public distribution secret scan',
  );
  const manifest = createManifest(
    stageRoot,
    build,
    metadata,
    canonicalVerifier,
    sourceRuntimeDependencyClosure,
  );
  replaceRegularFileContent(`${JSON.stringify(manifest, null, 2)}\n`, stageContext, manifestFile);
  canonicalVerifier.verifyDistribution(stageRoot);
  return { stageContext, canonicalVerifier, manifest };
}

function applyStagedDistribution(targetContext, staged, assertMutationBoundary) {
  for (const relativePath of copiedDirectories) {
    removeOwnedDirectory(targetContext, relativePath, assertMutationBoundary);
    copyDirectory(
      path.join(staged.stageContext.lexicalRoot, relativePath),
      targetContext,
      relativePath,
      assertMutationBoundary,
    );
  }
  for (const mapping of copiedFiles) {
    replaceRegularFile(
      path.join(staged.stageContext.lexicalRoot, ...mapping.target.split('/')),
      targetContext,
      mapping.target,
      assertMutationBoundary,
    );
  }
  replaceRegularFile(
    path.join(staged.stageContext.lexicalRoot, manifestFile),
    targetContext,
    manifestFile,
    assertMutationBoundary,
  );
}

function applyStagedDistributionTransactional(
  targetContext,
  staged,
  workspaceRoot,
  assertMutationBoundary,
  verifyApplied,
) {
  const backup = backupOwnedPayload(targetContext, workspaceRoot, assertMutationBoundary);
  try {
    applyStagedDistribution(targetContext, staged, assertMutationBoundary);
    return verifyApplied();
  } catch (applyError) {
    try {
      restoreOwnedPayload(targetContext, backup, assertMutationBoundary);
    } catch (rollbackError) {
      const applyMessage = applyError instanceof Error ? applyError.message : String(applyError);
      const rollbackMessage = rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
      throw new Error(
        `release apply failed (${applyMessage}) and rollback also failed (${rollbackMessage}); ` +
        'the target requires manual recovery from its Git worktree',
      );
    }
    throw applyError;
  }
}

function withTemporaryWorkspace(callback) {
  const tempBase = fs.realpathSync.native(os.tmpdir());
  const workspaceRoot = fs.mkdtempSync(path.join(tempBase, 'bublik-public-release-'));
  if (!isInside(workspaceRoot, tempBase) || path.dirname(workspaceRoot) !== tempBase) {
    fail(`temporary workspace escaped the OS temp directory: ${workspaceRoot}`);
  }
  let callbackError;
  try {
    return callback(workspaceRoot);
  } catch (error) {
    callbackError = error;
    throw error;
  } finally {
    try {
      const stat = fs.lstatSync(workspaceRoot);
      if (!stat.isDirectory() || stat.isSymbolicLink() || !isInside(workspaceRoot, tempBase)) {
        fail(`refusing to clean unexpected temporary workspace: ${workspaceRoot}`);
      }
      fs.rmSync(workspaceRoot, { recursive: true, force: false });
    } catch (cleanupError) {
      if (!callbackError) throw cleanupError;
      console.error(`temporary release workspace cleanup also failed: ${String(cleanupError)}`);
    }
  }
}

function exportDistribution(metadata) {
  assertSourceIdentity(metadata);
  let targetContext = assertSafeTarget(metadata.target);
  assertOwnedTargetClean(targetContext);
  const targetRevision = readTargetRevision(targetContext);

  const verified = withReleaseLock(targetContext, metadata, (lock) => {
    const preservedFingerprint = fingerprintPreservedTarget(targetContext);
    return withTemporaryWorkspace((workspaceRoot) => {
      const build = buildCleanReleaseCheckout(workspaceRoot, metadata);
      assertSourceIdentity(metadata);

      targetContext = assertSafeTarget(metadata.target);
      assertReleaseLockOwned(targetContext, lock);
      assertTargetRevision(targetContext, targetRevision);
      assertOwnedTargetClean(targetContext);
      if (fingerprintPreservedTarget(targetContext) !== preservedFingerprint) {
        fail('target repository metadata changed while the clean artifact was built');
      }
      const staged = prepareStagedDistribution(workspaceRoot, targetContext, build, metadata);

      // These are the last identity and boundary gates before the first target write.
      assertSourceIdentity(metadata);
      targetContext = assertSafeTarget(metadata.target);
      assertReleaseLockOwned(targetContext, lock);
      assertTargetRevision(targetContext, targetRevision);
      assertOwnedTargetClean(targetContext);
      if (fingerprintPreservedTarget(targetContext) !== preservedFingerprint) {
        fail('target repository metadata changed while export metadata was prepared');
      }

      const assertMutationBoundary = () => assertReleaseLockOwned(targetContext, lock);
      const verified = applyStagedDistributionTransactional(
        targetContext,
        staged,
        workspaceRoot,
        assertMutationBoundary,
        () => {
          const applied = staged.canonicalVerifier.verifyDistribution(
            targetContext.lexicalRoot,
            { allowReleaseLock: true },
          );
          if (applied.publishableTreeSha256 !== staged.manifest.publishableTreeSha256) {
            fail('applied target differs from the verified staging tree');
          }
          if (fingerprintPreservedTarget(targetContext) !== preservedFingerprint) {
            fail('export changed repository-owned metadata outside the release payload');
          }
          assertTargetRevision(targetContext, targetRevision);
          assertSourceIdentity(metadata);
          return applied;
        },
      );
      return verified;
    });
  });
  process.stdout.write(
    `distribution exported and verified: ${verified.releaseVersion}, ` +
      `${verified.publishableFileCount} public files, ${verified.artifactFileCount} protected runtime files\n`,
  );
  return verified;
}

if (require.main === module) {
  try {
    exportDistribution(parseArguments(process.argv.slice(2)));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

module.exports = {
  _internals: {
    applyStagedDistributionTransactional,
    assertNoLinkedPathComponents,
    assertOwnedTargetClean,
    assertSafeTarget,
    createRootContext,
    fingerprintOwnedPayload,
    fingerprintPreservedTarget,
    isOwnedTargetPath,
    removeOwnedDirectory,
    withReleaseLock,
  },
  exportDistribution,
  parseArguments,
};
