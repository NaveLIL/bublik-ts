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

// Конфигурация обфускатора (оптимизирована для Node.js серверного бота)
const obfuscatorConfig = {
  // ── Общее ──────────────────────────────
  target: 'node',                              // КРИТИЧНО: Node.js-окружение, не browser
  compact: true,
  simplify: true,
  seed: 0,                                     // Рандомный seed при каждом запуске

  // ── Control Flow ───────────────────────
  controlFlowFlattening: true,
  controlFlowFlatteningThreshold: 0.7,         // 70% — хороший баланс защита/производительность
  deadCodeInjection: true,
  deadCodeInjectionThreshold: 0.3,             // 30% мёртвого кода — усложняет декомпиляцию

  // ── Переименование ─────────────────────
  identifierNamesGenerator: 'hexadecimal',
  renameGlobals: true,                         // Безопасно для Node.js (нет DOM/window)

  // ── Строки ─────────────────────────────
  splitStrings: true,
  splitStringsChunkLength: 15,                 // 15 символов — баланс защита/размер кода
  stringArray: true,
  stringArrayCallsTransform: true,
  stringArrayEncoding: ['base64', 'rc4'],      // Чередование base64 + RC4 — значительно сложнее взломать
  stringArrayIndexShift: true,
  stringArrayRotate: true,
  stringArrayShuffle: true,
  stringArrayWrappersCount: 2,
  stringArrayWrappersChainedCalls: true,
  stringArrayWrappersType: 'function',
  stringArrayThreshold: 0.75,
  transformObjectKeys: true,

  // ── Числа ──────────────────────────────
  numbersToExpressions: true,

  // ── Защита от дебага ───────────────────
  debugProtection: true,                       // Блокирует DevTools debugger statement
  debugProtectionInterval: 2000,               // Проверка каждые 2с (только при открытом дебаггере)
  selfDefending: true,                         // Защита от форматирования/модификации кода

  // ── Консоль ────────────────────────────
  disableConsoleOutput: false,                 // НЕ отключаем — нужен для Winston логгера

  // ── Прочее ─────────────────────────────
  unicodeEscapeSequence: false,                // Unicode ломает читаемость логов
  log: false,
};

// Файлы, которые НЕ нужно обфусцировать (ломаются при обфускации)
const SKIP_PATTERNS = [
  /node_modules/,
  /\.prisma/,
  /prisma[\\/]/, // Сгенерированный код Prisma — ломается при обфускации
];

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
      // Проверяем, не нужно ли пропустить этот файл
      const relativePath = path.relative(DIST_DIR, srcPath);
      const shouldSkip = SKIP_PATTERNS.some((pattern) => pattern.test(relativePath));

      if (shouldSkip) {
        fs.copyFileSync(srcPath, destPath);
        console.log(`⏭ ${relativePath} (пропущен — несовместим с обфускацией)`);
        return;
      }

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
