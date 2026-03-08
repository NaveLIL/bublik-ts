// ═══════════════════════════════════════════════
//  Vacation — Утилиты
// ═══════════════════════════════════════════════

import { GuildMember } from 'discord.js';
import type { VacationConfig } from '@prisma/client';
import { MSK_OFFSET } from './constants';

// ═══════════════════════════════════════════════
//  Парсинг длительности
// ═══════════════════════════════════════════════

/**
 * Парсит строку вида "3d", "2w 1d", "1m", "12h" → минуты.
 * m = месяц (30д), w = неделя, d = день, h = час, min = минуты.
 * Поддерживает русские и английские сокращения.
 */
export function parseDuration(input: string): number | null {
  const cleaned = input.trim().toLowerCase();
  if (!cleaned) return null;

  let total = 0;
  let found = false;

  // Порядок важен: длинные юниты перед короткими
  const re = /(\d+)\s*(months?|мес|min|мин|weeks?|нед|days?|дн|hours?|час|m|w|d|h|н|д|ч)/gi;
  let match: RegExpExecArray | null;

  while ((match = re.exec(cleaned)) !== null) {
    found = true;
    const v = parseInt(match[1], 10);
    const u = match[2].toLowerCase();

    if (/^(months?|мес|m)$/i.test(u)) {
      total += v * 30 * 24 * 60;           // месяц ≈ 30 дней
    } else if (/^(weeks?|нед|н|w)$/i.test(u)) {
      total += v * 7 * 24 * 60;
    } else if (/^(days?|дн|д|d)$/i.test(u)) {
      total += v * 24 * 60;
    } else if (/^(hours?|час|ч|h)$/i.test(u)) {
      total += v * 60;
    } else if (/^(min|мін|мин)$/i.test(u)) {
      total += v;
    }
  }

  return found && total > 0 ? total : null;
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

/**
 * Снять настроенные роли, выдать роль отпуска.
 * @returns массив ID ролей, которые были реально сняты (для последующего восстановления)
 */
export async function applyVacationRoles(
  member: GuildMember,
  config: VacationConfig,
): Promise<string[]> {
  const saved: string[] = [];

  for (const roleId of config.removeRoleIds) {
    if (member.roles.cache.has(roleId)) {
      try {
        await member.roles.remove(roleId, 'Уход в отпуск');
        saved.push(roleId);
      } catch { /* роль не удалось снять — пропускаем */ }
    }
  }

  if (config.vacationRoleId) {
    await member.roles.add(config.vacationRoleId, 'Уход в отпуск').catch(() => null);
  }

  return saved;
}

/**
 * Восстановить ранее снятые роли, убрать роль отпуска.
 */
export async function restoreRoles(
  member: GuildMember,
  savedRoleIds: string[],
  vacationRoleId: string | null,
): Promise<void> {
  for (const roleId of savedRoleIds) {
    await member.roles.add(roleId, 'Возврат из отпуска').catch(() => null);
  }

  if (vacationRoleId && member.roles.cache.has(vacationRoleId)) {
    await member.roles.remove(vacationRoleId, 'Возврат из отпуска').catch(() => null);
  }
}
