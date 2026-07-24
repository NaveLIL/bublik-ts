import { ChannelType, type TextChannel } from 'discord.js';

export interface StatusPanelSquadSnapshotItem {
  id: string;
  voiceChannelId: string;
  airChannelId?: string | null;
  ownerId?: string;
  number?: number;
}

export interface StatusPanelAbsentState {
  epoch: string;
  acc: number;
  onAt: number | null;
}

export interface StatusPanelMessageIdentity {
  author?: { id?: string } | null;
  embeds?: ArrayLike<{ title?: string | null }> | null;
}

export class StatusPanelPipelineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StatusPanelPipelineError';
  }
}

/** ioredis pipelines resolve with per-command errors instead of always rejecting. */
export function assertStatusPanelPipelineSucceeded(
  replies: unknown,
  expectedCommands: number,
): void {
  if (!Array.isArray(replies)) {
    throw new StatusPanelPipelineError('Status panel Redis pipeline returned no replies');
  }
  if (replies.length !== expectedCommands) {
    throw new StatusPanelPipelineError(
      `Status panel Redis pipeline returned ${replies.length}/${expectedCommands} replies`,
    );
  }
  for (const reply of replies) {
    if (!Array.isArray(reply) || reply.length < 2) {
      throw new StatusPanelPipelineError('Status panel Redis pipeline returned a malformed reply');
    }
    if (reply[0]) {
      throw new StatusPanelPipelineError(`Status panel Redis pipeline command failed: ${String(reply[0])}`);
    }
    if (reply[1] === null || reply[1] === undefined) {
      throw new StatusPanelPipelineError('Status panel Redis pipeline command returned no result');
    }
  }
}

/**
 * A retry already queued sooner than the newly requested one is sufficient.
 * Keeping this decision pure makes the coalescing policy deterministic in
 * tests while the lifecycle owns the actual timers.
 */
export function shouldReplaceStatusPanelRetry(
  existingDueAt: number | null,
  requestedDueAt: number,
): boolean {
  return existingDueAt === null || requestedDueAt < existingDueAt;
}

/** Delay for a trailing refresh when a leading-edge refresh was throttled. */
export function statusPanelTrailingRetryDelay(
  now: number,
  lastUpdateAt: number,
  intervalMs: number,
): number {
  return Math.max(1, intervalMs - Math.max(0, now - lastUpdateAt));
}

/** Never follow a persisted panel reference across a guild/type boundary. */
export function isStatusPanelTextChannel(
  channel: unknown,
  guildId: string,
): channel is TextChannel {
  if (!channel || typeof channel !== 'object') return false;
  const candidate = channel as { type?: unknown; guildId?: unknown };
  return candidate.type === ChannelType.GuildText && candidate.guildId === guildId;
}

export function isOwnedStatusPanelMessageIdentity(
  message: StatusPanelMessageIdentity,
  botId: string | undefined,
  titleTokens: readonly string[],
): boolean {
  if (!botId || message.author?.id !== botId) return false;
  const title = message.embeds?.[0]?.title?.trim().toLowerCase() ?? '';
  return titleTokens.some((token) => title.includes(token));
}

/**
 * Stable identity for the DB-backed squad population used to build a panel.
 * Member occupancy is deliberately excluded: gateway events schedule their own
 * refresh, while this fence protects create/delete/channel-remap races.
 */
export function statusPanelSquadSnapshot(
  squads: readonly StatusPanelSquadSnapshotItem[],
): string {
  return JSON.stringify(squads
    .map((squad) => ({
      id: squad.id,
      voiceChannelId: squad.voiceChannelId,
      airChannelId: squad.airChannelId ?? null,
      ownerId: squad.ownerId ?? '',
      number: squad.number ?? 0,
    }))
    .sort((a, b) => a.id.localeCompare(b.id)));
}

/**
 * Parse legacy/current absentee state and fence it to one configured reset
 * epoch. Legacy values are adopted once; an explicitly older epoch is reset.
 */
export function parseStatusPanelAbsentState(
  raw: string | null,
  now: number,
  epoch: string,
): StatusPanelAbsentState {
  const fresh = (): StatusPanelAbsentState => ({ epoch, acc: 0, onAt: null });
  if (!raw) return fresh();

  const fromLegacyTimestamp = (): StatusPanelAbsentState => {
    const timestamp = Number(raw);
    if (!Number.isFinite(timestamp) || timestamp <= 0) return fresh();
    return { epoch, acc: Math.max(0, now - timestamp), onAt: null };
  };

  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object') return fromLegacyTimestamp();
    const parsed = value as { epoch?: unknown; acc?: unknown; onAt?: unknown };
    if (typeof parsed.epoch === 'string' && parsed.epoch !== epoch) return fresh();
    const acc = typeof parsed.acc === 'number' && Number.isFinite(parsed.acc)
      ? Math.max(0, parsed.acc)
      : 0;
    const onAt = typeof parsed.onAt === 'number' && Number.isFinite(parsed.onAt) && parsed.onAt > 0
      ? parsed.onAt
      : null;
    return { epoch, acc, onAt };
  } catch {
    return fromLegacyTimestamp();
  }
}

/**
 * Daily cleanup may remove legacy, corrupt and older-epoch values, but it must
 * preserve time already accumulated after the current reset boundary.
 */
export function shouldPurgeStatusPanelAbsentState(
  raw: string | null,
  currentEpoch: string,
): boolean {
  if (raw === null) return false;
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object') return true;
    const parsed = value as { epoch?: unknown; acc?: unknown; onAt?: unknown };
    if (parsed.epoch !== currentEpoch) return true;
    if (typeof parsed.acc !== 'number' || !Number.isFinite(parsed.acc) || parsed.acc < 0) {
      return true;
    }
    return parsed.onAt !== null && (
      typeof parsed.onAt !== 'number' ||
      !Number.isFinite(parsed.onAt) ||
      parsed.onAt <= 0
    );
  } catch {
    return true;
  }
}
