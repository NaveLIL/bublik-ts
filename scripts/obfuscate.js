/**
 * Скрипт обфускации скомпилированного кода.
 * Запуск: node scripts/obfuscate.js
 *
 * Защищает dist/ от реверс-инжиниринга.
 */

const JavaScriptObfuscator = require('javascript-obfuscator');
const fs = require('fs');
const path = require('path');

const DIST_DIR = path.resolve(__dirname, '..', 'dist');
const OUTPUT_DIR = path.resolve(__dirname, '..', 'dist-protected');

// Конфигурация обфускатора
const obfuscatorConfig = {
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

    if (entry.isDirectory()) {
      processDirectory(srcPath, destPath);
    } else if (entry.name.endsWith('.js')) {
      const code = fs.readFileSync(srcPath, 'utf-8');

      try {
        const result = JavaScriptObfuscator.obfuscate(code, obfuscatorConfig);
        fs.writeFileSync(destPath, result.getObfuscatedCode());
        console.log(`✓ ${path.relative(DIST_DIR, srcPath)}`);
      } catch (err) {
        console.error(`✗ ${path.relative(DIST_DIR, srcPath)}: ${err.message}`);
        // Если обфускация не удалась — копируем как есть
        fs.copyFileSync(srcPath, destPath);
      }
    } else {
      // Копируем остальные файлы (JSON, .d.ts и т.д.)
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

console.log('🔒 Обфускация dist/ → dist-protected/\n');

if (!fs.existsSync(DIST_DIR)) {
  console.error('❌ Папка dist/ не найдена. Сначала выполните npm run build');
  process.exit(1);
}

// Очистка предыдущей сборки
if (fs.existsSync(OUTPUT_DIR)) {
  fs.rmSync(OUTPUT_DIR, { recursive: true });
}

processDirectory(DIST_DIR, OUTPUT_DIR);

console.log('\n✅ Обфускация завершена! Результат в dist-protected/');
console.log('   Используйте dist-protected/ для деплоя вместо dist/');
