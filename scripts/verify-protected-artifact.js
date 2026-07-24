const fs = require('node:fs');
const path = require('node:path');
const { OBFUSCATOR_SEED, obfuscatorConfig } = require('./obfuscate');

const projectRoot = path.resolve(__dirname, '..');
const buildRoot = path.join(projectRoot, 'dist');
const protectedRoot = path.join(projectRoot, 'dist-protected');
const EXPECTED_OBFUSCATOR_SEED = 0x4255424c;

function toPosix(relativePath) {
  return relativePath.split(path.sep).join('/');
}

function comparePaths(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isTestPath(relativePath) {
  return (
    relativePath.includes('/__tests__/') ||
    relativePath.endsWith('.test.js') ||
    relativePath.endsWith('.spec.js')
  );
}

function collectRuntimeJavaScript(root, verifyProtectedContent) {
  if (!fs.existsSync(root)) throw new Error(`Required build directory is missing: ${root}`);
  const files = [];

  function visit(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const fullPath = path.join(directory, entry.name);
      const relativePath = toPosix(path.relative(root, fullPath));
      const stat = fs.lstatSync(fullPath);
      if (stat.isSymbolicLink()) throw new Error(`Build artifact contains a symlink: ${relativePath}`);
      if (stat.isDirectory()) {
        if (verifyProtectedContent && entry.name === '__tests__') {
          throw new Error(`Protected artifact contains tests: ${relativePath}`);
        }
        visit(fullPath);
        continue;
      }
      if (!stat.isFile()) throw new Error(`Unexpected build artifact entry: ${relativePath}`);

      if (relativePath.endsWith('.d.ts') || relativePath.endsWith('.d.ts.map')) {
        if (verifyProtectedContent) {
          throw new Error(`Protected artifact contains a type declaration: ${relativePath}`);
        }
        continue;
      }
      if (relativePath.endsWith('.map')) {
        if (verifyProtectedContent) {
          throw new Error(`Protected artifact contains a source map: ${relativePath}`);
        }
        continue;
      }
      if (!relativePath.endsWith('.js')) {
        throw new Error(`Unexpected non-JavaScript build artifact: ${relativePath}`);
      }
      if (isTestPath(relativePath)) {
        if (verifyProtectedContent) throw new Error(`Protected artifact contains tests: ${relativePath}`);
        continue;
      }

      if (verifyProtectedContent) {
        const source = fs.readFileSync(fullPath, 'utf8');
        if (source.includes('sourceMappingURL=')) {
          throw new Error(`Protected artifact contains a source-map reference: ${relativePath}`);
        }
        if (/C:\\\\[^'"`\r\n]+|\/home\/runner\/work\/|\/Users\/[^/]+\//.test(source)) {
          throw new Error(`Protected artifact contains an absolute build path: ${relativePath}`);
        }
      }
      files.push(relativePath);
    }
  }

  visit(root);
  return files.sort(comparePaths);
}

function verifyProtectedArtifact(expectedRoot = buildRoot, candidateRoot = protectedRoot) {
  if (OBFUSCATOR_SEED !== EXPECTED_OBFUSCATOR_SEED ||
      obfuscatorConfig.seed !== EXPECTED_OBFUSCATOR_SEED) {
    throw new Error(`Protected artifact must use the audited obfuscator seed ${EXPECTED_OBFUSCATOR_SEED}`);
  }

  const expectedFiles = collectRuntimeJavaScript(expectedRoot, false);
  const protectedFiles = collectRuntimeJavaScript(candidateRoot, true);
  if (!protectedFiles.includes('index.js')) throw new Error('dist-protected/index.js is missing');
  if (JSON.stringify(expectedFiles) !== JSON.stringify(protectedFiles)) {
    const expected = new Set(expectedFiles);
    const actual = new Set(protectedFiles);
    const missing = expectedFiles.filter((entry) => !actual.has(entry));
    const extra = protectedFiles.filter((entry) => !expected.has(entry));
    throw new Error(
      `Protected artifact file-set mismatch; missing=[${missing.join(', ')}], extra=[${extra.join(', ')}]`,
    );
  }
  return protectedFiles;
}

function main() {
  const protectedFiles = verifyProtectedArtifact();
  process.stdout.write(
    `protected artifact verified (${protectedFiles.length} runtime JS files, seed ${OBFUSCATOR_SEED})\n`,
  );
}

if (require.main === module) main();

module.exports = {
  collectRuntimeJavaScript,
  verifyProtectedArtifact,
};
