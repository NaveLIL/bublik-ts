import { getRedis } from '../../core/Redis';

export interface RotationPeriod {
  start: string; // YYYY-MM-DD
  end: string;   // YYYY-MM-DD
  rating: string;
}

export interface RotationSnapshot {
  today: string;
  current: RotationPeriod | null;
  next: RotationPeriod | null;
  daysLeft: number;
  progressPercent: number;
  progressBar: string;
}

const TZ_MOSCOW = 'Europe/Moscow';
const ROTATION_DATA_KEY = 'br:rotation:data';
const ROTATION_NOTIFY_KEY = 'br:rotation:notified';

const ENV_DEFAULT_ROTATION: RotationPeriod[] = [];

interface ParsedDmy {
  day: number;
  month: number;
  year?: number;
}

function normalizeDate(input: string): string {
  const m = input.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) throw new Error(`Invalid date format: ${input}`);
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (year < 2000 || year > 2100 || month < 1 || month > 12) {
    throw new Error(`Invalid calendar date: ${input}`);
  }
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (day < 1 || day > daysInMonth) {
    throw new Error(`Invalid calendar date: ${input}`);
  }
  return `${m[1]}-${m[2]}-${m[3]}`;
}

function normalizeRating(value: string | number): string {
  const n = typeof value === 'number' ? value : parseFloat(String(value));
  if (Number.isNaN(n)) throw new Error(`Invalid rating value: ${String(value)}`);
  return n.toFixed(1);
}

function sortPeriods(periods: RotationPeriod[]): RotationPeriod[] {
  return [...periods].sort((a, b) => a.start.localeCompare(b.start));
}

function dateToIsoInMoscow(now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ_MOSCOW,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

function moscowHour(now = new Date()): number {
  return Number(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: TZ_MOSCOW,
      hour: '2-digit',
      hour12: false,
    }).format(now),
  );
}

function isoToUtcDate(iso: string): Date {
  return new Date(`${iso}T00:00:00.000Z`);
}

function daysBetween(startIso: string, endIso: string): number {
  const msPerDay = 24 * 60 * 60 * 1000;
  return Math.floor((isoToUtcDate(endIso).getTime() - isoToUtcDate(startIso).getTime()) / msPerDay);
}

function createProgressBar(current: number, total: number, length = 12): string {
  if (total <= 0) return '`░░░░░░░░░░░░` 0%';
  const ratio = Math.min(1, Math.max(0, current / total));
  const filled = Math.round(ratio * length);
  const bar = '█'.repeat(filled) + '░'.repeat(Math.max(0, length - filled));
  return `\`${bar}\` ${Math.round(ratio * 100)}%`;
}

function normalizePeriods(raw: unknown): RotationPeriod[] {
  if (!Array.isArray(raw)) {
    throw new Error('Rotation JSON must be an array');
  }

  const periods = raw.map((item, idx) => {
    const row = item as Record<string, unknown>;
    if (!row?.start || !row?.end || row?.rating === undefined) {
      throw new Error(`Rotation period #${idx + 1}: missing start/end/rating`);
    }

    const start = normalizeDate(String(row.start));
    const end = normalizeDate(String(row.end));
    const rating = normalizeRating(row.rating as string | number);

    if (start > end) {
      throw new Error(`Rotation period #${idx + 1}: start > end`);
    }

    return { start, end, rating };
  });

  const sorted = sortPeriods(periods);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].start <= sorted[i - 1].end) {
      throw new Error(`Rotation periods overlap: #${i} and #${i + 1}`);
    }
  }

  return sorted;
}

function toIsoDate(year: number, month: number, day: number): string {
  return `${String(year)}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function parseDmy(rawDay: string, rawMonth: string, rawYear?: string): ParsedDmy {
  const day = Number(rawDay);
  const month = Number(rawMonth);
  const year = rawYear ? Number(rawYear) : undefined;

  if (!Number.isInteger(day) || day < 1 || day > 31) {
    throw new Error(`Invalid day in date: ${rawDay}.${rawMonth}`);
  }
  if (!Number.isInteger(month) || month < 1 || month > 12) {
    throw new Error(`Invalid month in date: ${rawDay}.${rawMonth}`);
  }
  if (year !== undefined && (!Number.isInteger(year) || year < 2000 || year > 2100)) {
    throw new Error(`Invalid year in date: ${rawDay}.${rawMonth}.${rawYear}`);
  }
  const validationYear = year ?? 2000; // leap year keeps 29.02 valid when year is omitted
  const daysInMonth = new Date(Date.UTC(validationYear, month, 0)).getUTCDate();
  if (day > daysInMonth) {
    throw new Error(`Invalid calendar date: ${rawDay}.${rawMonth}${rawYear ? `.${rawYear}` : ''}`);
  }

  return { day, month, year };
}

function parseHumanRotation(rawText: string): RotationPeriod[] {
  const lines = rawText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const yearFromText = rawText.match(/\b(20\d{2})\b/)?.[1];
  let rollingYear = yearFromText ? Number(yearFromText) : Number(dateToIsoInMoscow().slice(0, 4));
  let previousStartMonth: number | null = null;

  const periods: RotationPeriod[] = [];
  const ratingRe = /(?:ма(?:х|кс)|max)\s*бр\s*([0-9]+(?:[.,][0-9])?)/iu;
  const rangeRe = /\(\s*(\d{2})\.(\d{2})(?:\.(\d{4}))?\s*[—–-]\s*(\d{2})\.(\d{2})(?:\.(\d{4}))?\s*\)/u;

  for (const line of lines) {
    const ratingMatch = line.match(ratingRe);
    const rangeMatch = line.match(rangeRe);
    if (!ratingMatch || !rangeMatch) continue;

    const startDmy = parseDmy(rangeMatch[1], rangeMatch[2], rangeMatch[3]);
    const endDmy = parseDmy(rangeMatch[4], rangeMatch[5], rangeMatch[6]);

    if (startDmy.year !== undefined) {
      rollingYear = startDmy.year;
    } else if (previousStartMonth !== null && startDmy.month < previousStartMonth) {
      // Cross-year boundary in compact schedules without explicit years.
      rollingYear += 1;
    }

    const startYear = startDmy.year ?? rollingYear;
    const endYear = endDmy.year ?? (endDmy.month < startDmy.month ? startYear + 1 : startYear);
    previousStartMonth = startDmy.month;

    periods.push({
      start: toIsoDate(startYear, startDmy.month, startDmy.day),
      end: toIsoDate(endYear, endDmy.month, endDmy.day),
      rating: normalizeRating(ratingMatch[1].replace(',', '.')),
    });
  }

  if (periods.length === 0) {
    throw new Error('Rotation text format is not recognized');
  }

  return normalizePeriods(periods);
}

function parseDefaultRotationFromEnv(): RotationPeriod[] {
  const raw = process.env.BR_ROTATION_DATA;
  if (!raw?.trim()) return ENV_DEFAULT_ROTATION;

  try {
    return parseRotationJson(raw);
  } catch {
    return ENV_DEFAULT_ROTATION;
  }
}

export function parseRotationJson(rawJson: string): RotationPeriod[] {
  const input = rawJson.trim();
  if (!input) throw new Error('Rotation payload is empty');

  if (input.startsWith('[')) {
    return normalizePeriods(JSON.parse(input));
  }

  return parseHumanRotation(input);
}

export async function getGuildRotation(guildId: string): Promise<RotationPeriod[]> {
  const redis = getRedis();
  const raw = await redis.get(`${ROTATION_DATA_KEY}:${guildId}`);
  if (raw) {
    try {
      return normalizePeriods(JSON.parse(raw));
    } catch {
      // invalid cache payload, fallback to env
    }
  }
  return parseDefaultRotationFromEnv();
}

export async function setGuildRotation(guildId: string, periods: RotationPeriod[]): Promise<void> {
  const redis = getRedis();
  await redis.set(`${ROTATION_DATA_KEY}:${guildId}`, JSON.stringify(sortPeriods(periods)));
}

export function getRotationSnapshot(periods: RotationPeriod[], now = new Date()): RotationSnapshot {
  const today = dateToIsoInMoscow(now);

  const current = periods.find((p) => p.start <= today && today <= p.end) ?? null;
  const next = periods.find((p) => p.start > today) ?? null;

  let daysLeft = 0;
  let progressPercent = 0;
  let progressBar = createProgressBar(0, 1);

  if (current) {
    const totalDays = daysBetween(current.start, current.end) + 1;
    const passedDays = daysBetween(current.start, today) + 1;
    daysLeft = Math.max(0, daysBetween(today, current.end));
    progressPercent = Math.round((passedDays / totalDays) * 100);
    progressBar = createProgressBar(passedDays, totalDays);
  }

  return { today, current, next, daysLeft, progressPercent, progressBar };
}

export function formatShortDate(iso: string): string {
  const d = isoToUtcDate(iso);
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  return `${dd}.${mm}`;
}

export function formatLongDate(iso: string): string {
  const d = isoToUtcDate(iso);
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const yy = String(d.getUTCFullYear());
  return `${dd}.${mm}.${yy}`;
}

export function shouldSendNotificationsNow(now = new Date()): boolean {
  const notifyHour = Number(process.env.BR_ROTATION_NOTIFY_HOUR ?? '12');
  if (Number.isNaN(notifyHour) || notifyHour < 0 || notifyHour > 23) return false;
  return moscowHour(now) === notifyHour;
}

export function getNotifyRoleMention(guildRoleId: string | null | undefined): string {
  if (!guildRoleId) return '';
  return `<@&${guildRoleId}>`;
}

export async function wasRotationNotificationSent(
  guildId: string,
  periodStart: string,
  kind: 'warning' | 'final',
): Promise<boolean> {
  const redis = getRedis();
  const key = `${ROTATION_NOTIFY_KEY}:${guildId}:${periodStart}:${kind}`;
  return Boolean(await redis.get(key));
}

export async function markRotationNotificationSent(
  guildId: string,
  periodStart: string,
  kind: 'warning' | 'final',
): Promise<void> {
  const redis = getRedis();
  const key = `${ROTATION_NOTIFY_KEY}:${guildId}:${periodStart}:${kind}`;
  await redis.set(key, '1');
}

export function getTomorrowIso(now = new Date()): string {
  const todayIso = dateToIsoInMoscow(now);
  const tomorrow = isoToUtcDate(todayIso);
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  const dd = String(tomorrow.getUTCDate()).padStart(2, '0');
  const mm = String(tomorrow.getUTCMonth() + 1).padStart(2, '0');
  const yy = String(tomorrow.getUTCFullYear());
  return `${yy}-${mm}-${dd}`;
}

export function getRotationDisplayBr(snapshot: RotationSnapshot, periods: RotationPeriod[]): string | null {
  if (snapshot.current) return snapshot.current.rating;
  const upcoming = periods.find((period) => period.start > snapshot.today);
  if (upcoming) return upcoming.rating;
  if (periods.length > 0 && periods[periods.length - 1].end < snapshot.today) {
    return periods[periods.length - 1].rating;
  }
  return null;
}

export function isRotationStale(snapshot: RotationSnapshot, periods: RotationPeriod[]): boolean {
  if (periods.length === 0) return true;
  if (snapshot.current) return false;
  return periods[periods.length - 1].end < snapshot.today;
}
