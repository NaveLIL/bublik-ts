// Одноразовый скрипт миграции: TSV из старого Bublik-EREZ → Postgres
// Запуск (на VPS, внутри контейнера bot):
//   docker compose exec -T bot node scripts/migrate-br.js < /opt/migration/br_entries.tsv
// или локально:
//   ts-node scripts/migrate-br.ts < /tmp/bublik-migration/br_entries.tsv GUILD_ID
//
// Вход: TSV строки `br\tcategory_ru\tpriority_ru\tname` через stdin.
// Аргумент 1: GUILD_ID
//
// Идемпотентно НЕ является — добавляет записи. Перед запуском очистите таблицу
// если делаете повторный импорт:
//   DELETE FROM br_tech_entries WHERE "guildId" = '<id>';

import { PrismaClient } from '@prisma/client';
import { normalizeCategory, normalizePriority } from '../src/modules/br/constants';

async function main() {
  const guildId = process.argv[2];
  if (!guildId) {
    console.error('Usage: ts-node scripts/migrate-br.ts <guildId>  < br_entries.tsv');
    process.exit(1);
  }

  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString('utf-8');

  const rows: { guildId: string; br: string; category: string; priority: string; name: string }[] = [];
  let skipped = 0;

  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split('\t');
    if (parts.length < 4) {
      skipped++;
      continue;
    }
    const [br, catRu, priRu, ...rest] = parts;
    const name = rest.join('\t').trim();
    const cat = normalizeCategory(catRu);
    const pri = normalizePriority(priRu);
    if (!cat || !pri || !name) {
      console.warn(`SKIP: br=${br} cat=${catRu} pri=${priRu} name=${name}`);
      skipped++;
      continue;
    }
    rows.push({ guildId, br: br.trim(), category: cat, priority: pri, name });
  }

  console.log(`Подготовлено к импорту: ${rows.length} (пропущено: ${skipped})`);

  const prisma = new PrismaClient();
  const result = await prisma.brTechEntry.createMany({ data: rows });
  console.log(`Импортировано записей: ${result.count}`);

  // Сводка по БР
  const byBr = new Map<string, number>();
  for (const r of rows) byBr.set(r.br, (byBr.get(r.br) ?? 0) + 1);
  const sorted = Array.from(byBr.entries()).sort((a, b) => parseFloat(a[0]) - parseFloat(b[0]));
  console.log('Распределение по БР:');
  for (const [br, n] of sorted) console.log(`  БР ${br}: ${n}`);

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
