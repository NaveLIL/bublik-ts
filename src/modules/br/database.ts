// ═══════════════════════════════════════════════
//  BR — CRUD + Redis cache
// ═══════════════════════════════════════════════

import { getDatabase } from '../../core/Database';
import { getRedis } from '../../core/Redis';
import {
  BR_CACHE_PREFIX,
  BR_CACHE_TTL,
  BR_DATA_CACHE_PREFIX,
  BR_DATA_CACHE_TTL,
  Category,
  Priority,
} from './constants';

// ── Panel config ───────────────────────────────

export async function getPanel(guildId: string) {
  const r = getRedis();
  const cached = await r.get(`${BR_CACHE_PREFIX}:${guildId}`);
  if (cached) return JSON.parse(cached);

  const panel = await getDatabase().brPanel.findUnique({ where: { guildId } });
  if (panel) {
    await r.setex(`${BR_CACHE_PREFIX}:${guildId}`, BR_CACHE_TTL, JSON.stringify(panel));
  }
  return panel;
}

export async function upsertPanel(guildId: string, data: Record<string, any>) {
  const panel = await getDatabase().brPanel.upsert({
    where: { guildId },
    create: { guildId, ...data },
    update: data,
  });
  await getRedis().setex(`${BR_CACHE_PREFIX}:${guildId}`, BR_CACHE_TTL, JSON.stringify(panel));
  return panel;
}

export async function getAllPanels(): Promise<Array<{
  guildId: string;
  panelChannelId: string | null;
  panelMessageId: string | null;
  defaultBr: string | null;
}>> {
  const rows = await getDatabase().brPanel.findMany({
    where: { panelChannelId: { not: null } },
    select: {
      guildId: true,
      panelChannelId: true,
      panelMessageId: true,
      defaultBr: true,
    },
  });
  return rows;
}

// ── Tech entries ───────────────────────────────

async function invalidateBr(guildId: string, br: string) {
  await getRedis().del(`${BR_DATA_CACHE_PREFIX}:${guildId}:${br}`);
  await getRedis().del(`${BR_DATA_CACHE_PREFIX}:list:${guildId}`);
}

export type BrEntryRow = { id: number; category: string; priority: string; name: string };

/** Получить все записи для конкретного БР (с кэшем) */
export async function getEntriesForBr(guildId: string, br: string): Promise<BrEntryRow[]> {
  const key = `${BR_DATA_CACHE_PREFIX}:${guildId}:${br}`;
  const cached = await getRedis().get(key);
  if (cached) return JSON.parse(cached) as BrEntryRow[];

  const rows = await getDatabase().brTechEntry.findMany({
    where: { guildId, br },
    select: { id: true, category: true, priority: true, name: true },
    orderBy: [{ category: 'asc' }, { priority: 'asc' }, { name: 'asc' }],
  });

  await getRedis().setex(key, BR_DATA_CACHE_TTL, JSON.stringify(rows));
  return rows;
}

/** Получить уникальные БР по гильдии (отсортированные численно) */
export async function getAvailableBrs(guildId: string): Promise<string[]> {
  const key = `${BR_DATA_CACHE_PREFIX}:list:${guildId}`;
  const cached = await getRedis().get(key);
  if (cached) return JSON.parse(cached);

  const rows = await getDatabase().brTechEntry.findMany({
    where: { guildId },
    select: { br: true },
    distinct: ['br'],
  });
  const sorted = rows
    .map((r) => r.br)
    .sort((a, b) => parseFloat(a) - parseFloat(b));

  await getRedis().setex(key, BR_DATA_CACHE_TTL, JSON.stringify(sorted));
  return sorted;
}

/** Соседние БР (для навигации) */
export async function getAdjacentBrs(guildId: string, current: string): Promise<{ prev: string | null; next: string | null }> {
  const all = await getAvailableBrs(guildId);
  const idx = all.indexOf(current);
  if (idx === -1) return { prev: null, next: null };
  return {
    prev: idx > 0 ? all[idx - 1] : null,
    next: idx < all.length - 1 ? all[idx + 1] : null,
  };
}

/** Добавить запись (одну или массово) */
export async function addEntries(
  guildId: string,
  br: string,
  category: Category,
  priority: Priority,
  names: string[],
): Promise<number> {
  if (names.length === 0) return 0;
  const data = names.map((name) => ({ guildId, br, category, priority, name }));
  const result = await getDatabase().brTechEntry.createMany({ data });
  await invalidateBr(guildId, br);
  return result.count;
}

/** Удалить записи по ID */
export async function deleteEntriesByIds(guildId: string, br: string, ids: number[]): Promise<number> {
  if (ids.length === 0) return 0;
  const result = await getDatabase().brTechEntry.deleteMany({
    where: { guildId, br, id: { in: ids } },
  });
  await invalidateBr(guildId, br);
  return result.count;
}

/** Удалить все записи в категории (для bulk-edit) */
export async function deleteAllInCategory(guildId: string, br: string, category: Category): Promise<number> {
  const result = await getDatabase().brTechEntry.deleteMany({
    where: { guildId, br, category },
  });
  await invalidateBr(guildId, br);
  return result.count;
}

/** Atomically replace one category, so a failed create never leaves it empty. */
export async function replaceCategory(
  guildId: string,
  br: string,
  category: Category,
  entries: Array<{ priority: Priority; name: string }>,
): Promise<number> {
  if (entries.length === 0) throw new Error('Cannot replace a BR category with an empty payload');
  const unique = Array.from(
    new Map(entries.map((entry) => [`${entry.priority}\0${entry.name.toLocaleLowerCase()}`, entry])).values(),
  );
  const db = getDatabase();
  const count = await db.$transaction(async (tx) => {
    await tx.brTechEntry.deleteMany({ where: { guildId, br, category } });
    const inserted = await tx.brTechEntry.createMany({
      data: unique.map((entry) => ({ guildId, br, category, ...entry })),
    });
    return inserted.count;
  });
  await invalidateBr(guildId, br);
  return count;
}

/** Поиск по названию (всем БР) */
export async function searchTech(guildId: string, query: string, limit = 25) {
  return getDatabase().brTechEntry.findMany({
    where: {
      guildId,
      name: { contains: query, mode: 'insensitive' },
    },
    select: { br: true, category: true, priority: true, name: true },
    orderBy: [{ br: 'asc' }, { name: 'asc' }],
    take: limit,
  });
}

/** Очистить весь кэш БР для гильдии */
export async function clearGuildBrCache(guildId: string): Promise<void> {
  const r = getRedis();
  const pattern = `${BR_DATA_CACHE_PREFIX}:${guildId}:*`;
  let cursor = '0';
  do {
    const [nextCursor, keys] = await r.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
    cursor = nextCursor;
    if (keys.length > 0) {
      await r.del(...keys);
    }
  } while (cursor !== '0');
  await r.del(`${BR_DATA_CACHE_PREFIX}:list:${guildId}`);
}

/** Клонировать базу БР из одной гильдии в другую */
export async function cloneBrDatabase(sourceGuildId: string, targetGuildId: string): Promise<number> {
  const db = getDatabase();
  const entries = await db.brTechEntry.findMany({
    where: { guildId: sourceGuildId },
  });
  if (entries.length === 0) return 0;

  const dataToInsert = entries.map((e) => ({
    guildId: targetGuildId,
    br: e.br,
    category: e.category,
    priority: e.priority,
    name: e.name,
  }));

  const inserted = await db.$transaction(async (tx) => {
    await tx.brTechEntry.deleteMany({ where: { guildId: targetGuildId } });
    return tx.brTechEntry.createMany({
      data: dataToInsert,
    });
  });

  await clearGuildBrCache(targetGuildId);

  return inserted.count;
}
