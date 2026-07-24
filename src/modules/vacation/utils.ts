// ═══════════════════════════════════════════════
//  Vacation — Утилиты
// ═══════════════════════════════════════════════

import { GuildMember } from 'discord.js';
import type { VacationConfig } from '@prisma/client';
import { MSK_OFFSET } from './constants';
import { selectVacationSavedRoles } from './state';
import { getDatabase } from '../../core/Database';
import type { MemberRoleLock } from '../../core/MemberRoleLock';
import { fetchSafeAutomaticRole, UnsafeAutomaticRoleError } from '../../core/RolePolicy';
import { logger } from '../../core/Logger';

const log = logger.child('Vacation:Utils');

// ═══════════════════════════════════════════════
//  Парсинг длительности
// ═══════════════════════════════════════════════

/**
 * Парсит строку вида "3d", "2w 1d", "1mo", "12h", "30m" → минуты.
 * mo/month = месяц (30д), w = неделя, d = день, h = час, m/min = минуты.
 * Поддерживает русские и английские сокращения.
 */
export function parseDuration(input: string): number | null {
  const cleaned = input.trim().toLowerCase();
  if (!cleaned) return null;

  let total = 0;
  let found = false;

  // Порядок важен: длинные юниты перед короткими
  const re = /(\d+)\s*(months?|month|mo|мес|minutes?|mins?|min|мин|weeks?|week|нед|days?|day|дн|hours?|hour|час|m|w|d|h|н|д|ч)/gi;
  let match: RegExpExecArray | null;
  let cursor = 0;

  while ((match = re.exec(cleaned)) !== null) {
    // Разрешаем между токенами только пробелы, запятые и «+».
    // Иначе строка вроде «навсегда 3d» незаметно превращалась в валидные 3 дня.
    if (!/^[\s,+]*$/.test(cleaned.slice(cursor, match.index))) return null;
    found = true;
    const v = parseInt(match[1], 10);
    const u = match[2].toLowerCase();

    if (/^(months?|month|mo|мес)$/i.test(u)) {
      total += v * 30 * 24 * 60;           // месяц ≈ 30 дней
    } else if (/^(weeks?|нед|н|w)$/i.test(u)) {
      total += v * 7 * 24 * 60;
    } else if (/^(days?|дн|д|d)$/i.test(u)) {
      total += v * 24 * 60;
    } else if (/^(hours?|час|ч|h)$/i.test(u)) {
      total += v * 60;
    } else if (/^(minutes?|mins?|min|мин|m)$/i.test(u)) {
      total += v;
    }
    cursor = re.lastIndex;
  }

  if (!/^[\s,+]*$/.test(cleaned.slice(cursor))) return null;
  return found && total > 0 && Number.isSafeInteger(total) ? total : null;
}

// ═══════════════════════════════════════════════
//  Форматирование
// ═══════════════════════════════════════════════

/** Минуты → «7д 3ч» */
export function formatDuration(minutes: number): string {
  const d = Math.floor(minutes / (24 * 60));
  const h = Math.floor((minutes % (24 * 60)) / 60);
  const m = minutes % 60;

  const parts: string[] = [];
  if (d > 0) parts.push(`${d}д`);
  if (h > 0) parts.push(`${h}ч`);
  if (m > 0 && d === 0) parts.push(`${m}мин`);
  return parts.join(' ') || '0мин';
}

/** Дата → «15.03.2026, 14:00 МСК» */
export function formatDateMsk(date: Date): string {
  return date.toLocaleString('ru-RU', {
    timeZone: 'Europe/Moscow',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }) + ' МСК';
}

/** Оставшееся время до даты в читаемом виде */
export function formatTimeLeft(endDate: Date): string {
  const diff = endDate.getTime() - Date.now();
  if (diff <= 0) return 'завершён';
  return formatDuration(Math.ceil(diff / 60_000));
}

// ═══════════════════════════════════════════════
//  Прайм-тайм
// ═══════════════════════════════════════════════

/** Текущий час по МСК (0-23) */
export function getMskHour(): number {
  const now = new Date();
  return (now.getUTCHours() + MSK_OFFSET) % 24;
}

/**
 * Проверка: сейчас прайм-тайм или буферная зона перед ним?
 * Обрабатывает ночные диапазоны (17:00 → 01:00).
 */
export function isPrimeTime(config: Pick<VacationConfig, 'primeTimeStart' | 'primeTimeEnd' | 'primeTimeBuffer'>): boolean {
  const mskHour = getMskHour();
  const blockStart = (config.primeTimeStart - config.primeTimeBuffer + 24) % 24;
  const end = config.primeTimeEnd;

  if (blockStart < end) {
    // Дневной диапазон (например 10:00 → 15:00)
    return mskHour >= blockStart && mskHour < end;
  } else {
    // Ночной диапазон (например 16:00 → 01:00)
    return mskHour >= blockStart || mskHour < end;
  }
}

/** Текстовое описание прайм-тайма для сообщений */
export function primeTimeText(config: Pick<VacationConfig, 'primeTimeStart' | 'primeTimeEnd' | 'primeTimeBuffer'>): string {
  const blockStart = (config.primeTimeStart - config.primeTimeBuffer + 24) % 24;
  return `${String(blockStart).padStart(2, '0')}:00 — ${String(config.primeTimeEnd).padStart(2, '0')}:00 МСК`;
}

// ═══════════════════════════════════════════════
//  Роли
// ═══════════════════════════════════════════════

/** Получить снимок ролей до первого изменения Discord-состояния. */
export async function snapshotVacationRoles(
  member: GuildMember,
  config: VacationConfig,
): Promise<string[]> {
  // Read RegBattle directly from PostgreSQL: a stale cache or an omitted
  // VacationConfig.removeRoleIds entry must not leave the live PB ping role on
  // a newly-created regular vacation.
  const regbattle = await getDatabase().regbattleConfig.findUnique({
    where: { guildId: member.guild.id },
    select: { pingRoleId: true },
  });
  return selectVacationSavedRoles(
    member.roles.cache.keys(),
    config.removeRoleIds,
    regbattle?.pingRoleId ?? null,
  );
}

/** Получить снимок управляемых ролей для НС shield/troll. */
export function snapshotManageableRoles(
  member: GuildMember,
  excludedRoleIds: ReadonlySet<string> = new Set(),
): string[] {
  return member.roles.cache
    .filter((role) => role.id !== member.guild.id && role.editable && !role.managed && !excludedRoleIds.has(role.id))
    .map((role) => role.id);
}

async function runRoleMutations(operations: Array<() => Promise<unknown>>, context: string): Promise<void> {
  const errors: unknown[] = [];
  for (const operation of operations) {
    try {
      await operation();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) {
    throw new AggregateError(errors, context);
  }
}

/**
 * Применить уже сохранённый в БД снимок. Повторный вызов безопасен: отсутствующие
 * у участника роли просто не снимаются.
 */
export async function applyVacationRoles(
  member: GuildMember,
  savedRoleIds: readonly string[],
  vacationRoleId: string | null,
  lock?: MemberRoleLock,
): Promise<void> {
  const operations: Array<() => Promise<unknown>> = [];
  for (const roleId of savedRoleIds) {
    if (member.roles.cache.has(roleId)) {
      operations.push(async () => {
        await lock?.assertOwned();
        await member.roles.remove(roleId, 'Уход в отпуск');
      });
    }
  }

  if (vacationRoleId && !member.roles.cache.has(vacationRoleId)) {
    operations.push(async () => {
      const vacationRole = await fetchSafeAutomaticRole(member.guild, vacationRoleId);
      await lock?.assertOwned();
      await member.roles.add(vacationRole, 'Уход в отпуск');
    });
  }

  await runRoleMutations(operations, `Failed to apply vacation roles for ${member.id}`);
}

/**
 * Восстановить ранее снятые роли, убрать роль отпуска.
 */
export async function restoreRoles(
  member: GuildMember,
  savedRoleIds: readonly string[],
  vacationRoleId: string | null,
  lock?: MemberRoleLock,
): Promise<void> {
  const operations: Array<() => Promise<unknown>> = [];
  for (const roleId of savedRoleIds) {
    // Удалённую роль восстановить невозможно и повторять такой запрос бессмысленно.
    if (!member.roles.cache.has(roleId)) {
      operations.push(async () => {
        try {
          const role = await fetchSafeAutomaticRole(member.guild, roleId);
          await lock?.assertOwned();
          await member.roles.add(role, 'Возврат из отпуска');
        } catch (error) {
          // A deleted/unsafe role is a permanent configuration problem. Do not
          // keep the entire vacation stuck forever; skip only that grant.
          if (error instanceof UnsafeAutomaticRoleError) {
            log.warn(`Vacation role ${roleId} not restored for ${member.id}: ${error.reason}`);
            return;
          }
          throw error;
        }
      });
    }
  }

  if (vacationRoleId && member.roles.cache.has(vacationRoleId)) {
    operations.push(async () => {
      await lock?.assertOwned();
      await member.roles.remove(vacationRoleId, 'Возврат из отпуска');
    });
  }

  await runRoleMutations(operations, `Failed to restore vacation roles for ${member.id}`);
}
