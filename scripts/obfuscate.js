// обфускация dist/ -> dist-protected/

const JavaScriptObfuscator = require('javascript-obfuscator');
const fs = require('fs');
const path = require('path');

const DIST_DIR = path.resolve(__dirname, '..', 'dist');
const OUTPUT_DIR = path.resolve(__dirname, '..', 'dist-protected');
// javascript-obfuscator documents seed=0 as unseeded. Keep this non-zero
// value stable so identical source and toolchain inputs produce identical JS.
const OBFUSCATOR_SEED = 0x4255424c;

function removeTree(target) {
  if (!fs.existsSync(target)) return;
  const stat = fs.lstatSync(target);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    fs.unlinkSync(target);
    return;
  }
  for (const entry of fs.readdirSync(target)) {
    removeTree(path.join(target, entry));
  }
  fs.rmdirSync(target);
}


const obfuscatorConfig = {
  seed: OBFUSCATOR_SEED,
  compact: true,
  controlFlowFlattening: true,
  controlFlowFlatteningThreshold: 0.5,
  deadCodeInjection: true,
  deadCodeInjectionThreshold: 0.2,
  debugProtection: false,
  disableConsoleOutput: false,
  identifierNamesGenerator: 'hexadecimal',
  log: false,
  numbersToExpressions: true,
  renameGlobals: false,
  selfDefending: false,
  simplify: true,
  splitStrings: true,
  splitStringsChunkLength: 10,
  stringArray: true,
  stringArrayCallsTransform: true,
  stringArrayEncoding: ['base64'],
  stringArrayIndexShift: true,
  stringArrayRotate: true,
  stringArrayShuffle: true,
  stringArrayWrappersCount: 2,
  stringArrayWrappersChainedCalls: true,
  stringArrayWrappersType: 'function',
  stringArrayThreshold: 0.75,
  transformObjectKeys: true,
  unicodeEscapeSequence: false,
};

function processDirectory(dir, outDir) {
  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
  }

  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const srcPath = path.join(dir, entry.name);
    const destPath = path.join(outDir, entry.name);

    if (entry.isDirectory() && entry.name === '__tests__') {
      continue;
    } else if (entry.isDirectory()) {
      processDirectory(srcPath, destPath);
    } else if (entry.name.endsWith('.test.js') || entry.name.endsWith('.spec.js')) {
      continue;
    } else if (entry.name.endsWith('.js')) {
      const code = fs.readFileSync(srcPath, 'utf-8');

      try {
        const result = JavaScriptObfuscator.obfuscate(code, obfuscatorConfig);
        fs.writeFileSync(destPath, result.getObfuscatedCode());
        console.log(`✓ ${path.relative(DIST_DIR, srcPath)}`);
      } catch (err) {
        console.error(`✗ ${path.relative(DIST_DIR, srcPath)}: ${err.message}`);
        throw err;
      }
    } else if (entry.name.endsWith('.d.ts') || entry.name.endsWith('.map')) {
      // Type declarations and source/declaration maps are build-time metadata.
      // Shipping them defeats the purpose of the protected runtime artifact.
      continue;
    } else {
      throw new Error(
        `Unexpected non-runtime build artifact: ${path.relative(DIST_DIR, srcPath)}`,
      );
    }
  }
}

function main() {
  console.log('obfuscating dist/ -> dist-protected/\n');

  if (!fs.existsSync(DIST_DIR)) {
    console.error('dist/ not found, run npm run build first');
    process.exitCode = 1;
    return;
  }

  if (fs.existsSync(OUTPUT_DIR)) {
    removeTree(OUTPUT_DIR);
    if (fs.existsSync(OUTPUT_DIR)) {
      throw new Error(`Protected output cleanup failed: ${OUTPUT_DIR}`);
    }
  }

  try {
    processDirectory(DIST_DIR, OUTPUT_DIR);
  } catch (err) {
    console.error(`\nobfuscation failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
    return;
  }

  console.log('\ndone, output in dist-protected/');
}

if (require.main === module) main();

module.exports = {
  OBFUSCATOR_SEED,
  obfuscatorConfig,
};
