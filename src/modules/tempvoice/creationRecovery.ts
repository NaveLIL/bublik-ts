import { randomUUID } from 'node:crypto';
import { ChannelType, type Client, type Guild, type VoiceChannel } from 'discord.js';
import type { Prisma } from '@prisma/client';
import { getDatabase } from '../../core/Database';
import { logger } from '../../core/Logger';
import { isGuildAllowed } from '../../core/Whitelist';
import { deleteChannel } from './database';
import { isUnknownChannelError } from './recovery';
import { runGeneratorExclusive } from './permissionSync';

const log = logger.child('TempVoice:CreationRecovery');
const CREATION_SCOPE = 'tempvoice_creation';
const CREATION_LEASE_MS = 2 * 60_000;
const MARKER_PREFIX = ' [tv:';

export interface TempVoiceCreationIntent {
  version: 1;
  token: string;
  guildId: string;
  ownerId: string;
  generatorId: string;
  categoryId: string;
  marker: string;
  desiredName: string;
  markedName: string;
  channelId: string | null;
  preparedAt: number;
}

function creationKey(guildId: string, generatorId: string, ownerId: string): string {
  return `tempvoice:create:${guildId}:${generatorId}:${ownerId}`;
}

function asMetadata(intent: TempVoiceCreationIntent): Prisma.InputJsonObject {
  return intent as unknown as Prisma.InputJsonObject;
}

export function creationMarkerSuffix(marker: string): string {
  return `${MARKER_PREFIX}${marker}]`;
}

export function buildMarkedChannelName(desiredName: string, marker: string): string {
  const suffix = creationMarkerSuffix(marker);
  const maxBase = Math.max(1, 100 - suffix.length);
  return `${desiredName.slice(0, maxBase)}${suffix}`;
}

export function parseTempVoiceCreationIntent(value: unknown): TempVoiceCreationIntent | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const intent = value as Partial<TempVoiceCreationIntent>;
  if (
    intent.version !== 1 ||
    typeof intent.token !== 'string' || !intent.token ||
    typeof intent.guildId !== 'string' || !intent.guildId ||
    typeof intent.ownerId !== 'string' || !intent.ownerId ||
    typeof intent.generatorId !== 'string' || !intent.generatorId ||
    typeof intent.categoryId !== 'string' || !intent.categoryId ||
    typeof intent.marker !== 'string' || !intent.marker ||
    typeof intent.desiredName !== 'string' || !intent.desiredName ||
    typeof intent.markedName !== 'string' || !intent.markedName ||
    !(intent.channelId === null || typeof intent.channelId === 'string') ||
    typeof intent.preparedAt !== 'number' || !Number.isFinite(intent.preparedAt)
  ) return null;
  if (intent.markedName !== buildMarkedChannelName(intent.desiredName, intent.marker)) return null;
  return intent as TempVoiceCreationIntent;
}

async function readIntentByKey(key: string): Promise<TempVoiceCreationIntent | null> {
  const claim = await getDatabase().operationClaim.findUnique({ where: { key } });
  if (!claim || claim.scope !== CREATION_SCOPE) return null;
  return parseTempVoiceCreationIntent(claim.metadata);
}

export async function prepareTempVoiceCreation(
  guildId: string,
  ownerId: string,
  generatorId: string,
  categoryId: string,
  desiredName: string,
): Promise<TempVoiceCreationIntent | null> {
  const token = randomUUID();
  const marker = token.replaceAll('-', '').slice(0, 10);
  const intent: TempVoiceCreationIntent = {
    version: 1,
    token,
    guildId,
    ownerId,
    generatorId,
    categoryId,
    marker,
    desiredName: desiredName.slice(0, 100),
    markedName: buildMarkedChannelName(desiredName, marker),
    channelId: null,
    preparedAt: Date.now(),
  };
  const key = creationKey(guildId, generatorId, ownerId);
  try {
    const inserted = await getDatabase().operationClaim.createMany({
      data: [{
        key,
        scope: CREATION_SCOPE,
        guildId,
        userId: ownerId,
        metadata: asMetadata(intent),
      }],
      skipDuplicates: true,
    });
    if (inserted.count === 1) return intent;
  } catch (error) {
    const persisted = await readIntentByKey(key).catch(() => null);
    if (persisted?.token === token) return persisted;
    throw error;
  }
  return null;
}

export async function recordTempVoiceCreationChannel(
  intent: TempVoiceCreationIntent,
  channelId: string,
): Promise<TempVoiceCreationIntent> {
  const updatedIntent = { ...intent, channelId };
  const key = creationKey(intent.guildId, intent.generatorId, intent.ownerId);
  try {
    const updated = await getDatabase().operationClaim.updateMany({
      where: {
        key,
        scope: CREATION_SCOPE,
        metadata: { path: ['token'], equals: intent.token },
      },
      data: { metadata: asMetadata(updatedIntent) },
    });
    if (updated.count === 1) return updatedIntent;
  } catch (error) {
    const persisted = await readIntentByKey(key).catch(() => null);
    if (persisted?.token === intent.token && persisted.channelId === channelId) return persisted;
    throw error;
  }
  throw new Error(`TempVoice creation intent was fenced for ${intent.guildId}:${intent.ownerId}`);
}

export async function completeTempVoiceCreation(intent: TempVoiceCreationIntent): Promise<void> {
  const key = creationKey(intent.guildId, intent.generatorId, intent.ownerId);
  try {
    const removed = await getDatabase().operationClaim.deleteMany({
      where: {
        key,
        scope: CREATION_SCOPE,
        metadata: { path: ['token'], equals: intent.token },
      },
    });
    if (removed.count === 1) return;
  } catch (error) {
    const persisted = await readIntentByKey(key).catch(() => undefined);
    if (persisted === null) return;
    throw error;
  }
  const current = await readIntentByKey(key);
  if (current === null) return;
  throw new Error(`TempVoice creation intent completion was fenced for ${intent.guildId}:${intent.ownerId}`);
}

async function findIntentChannels(guild: Guild, intent: TempVoiceCreationIntent): Promise<VoiceChannel[]> {
  const channels = await guild.channels.fetch();
  const suffix = creationMarkerSuffix(intent.marker);
  return channels
    .filter((channel): channel is VoiceChannel => Boolean(
      channel &&
      channel.type === ChannelType.GuildVoice &&
      channel.parentId === intent.categoryId &&
      (channel.id === intent.channelId || channel.name.endsWith(suffix)),
    ))
    .map((channel) => channel);
}

export async function cleanupTempVoiceCreationIntent(
  client: Client,
  intent: TempVoiceCreationIntent,
): Promise<boolean> {
  if (!isGuildAllowed(intent.guildId)) return false;
  return runGeneratorExclusive(intent.generatorId, async (assertOwned) => {
    await assertOwned();
    const key = creationKey(intent.guildId, intent.generatorId, intent.ownerId);
    const current = await readIntentByKey(key);
    if (!current || current.token !== intent.token) return true;
    const guild = client.guilds.cache.get(intent.guildId);
    if (!guild) return false;

    let channels: VoiceChannel[];
    try {
      channels = await findIntentChannels(guild, current);
    } catch (error) {
      log.warn(`Cannot scan TempVoice creation ${current.token}; retained`, { error: String(error) });
      return false;
    }

    for (const channel of channels) {
      await assertOwned();
      try {
        await channel.delete('TempVoice: recovery of interrupted channel creation');
      } catch (error) {
        if (!isUnknownChannelError(error)) return false;
      }
    }

    await assertOwned();
    const ids = new Set(channels.map(({ id }) => id));
    if (current.channelId) ids.add(current.channelId);
    for (const channelId of ids) {
      await deleteChannel(channelId);
    }
    await completeTempVoiceCreation(current);
    log.warn(`Recovered interrupted TempVoice creation ${current.token}`, {
      guildId: current.guildId,
      ownerId: current.ownerId,
      channels: [...ids],
    });
    return true;
  });
}

export async function recoverTempVoiceCreationIntents(client: Client, force = false): Promise<void> {
  const guildIds = [...client.guilds.cache.keys()].filter(isGuildAllowed);
  if (guildIds.length === 0) return;
  const claims = await getDatabase().operationClaim.findMany({
    where: { scope: CREATION_SCOPE, guildId: { in: guildIds } },
    orderBy: { createdAt: 'asc' },
  });
  for (const claim of claims) {
    const intent = parseTempVoiceCreationIntent(claim.metadata);
    if (!intent) {
      log.error(`Malformed TempVoice creation intent ${claim.key} retained for inspection`);
      continue;
    }
    if (!force && intent.preparedAt > Date.now() - CREATION_LEASE_MS) continue;
    await cleanupTempVoiceCreationIntent(client, intent).catch((error: unknown) => {
      log.warn(`TempVoice creation ${intent.token} retained for retry`, { error: String(error) });
    });
  }
}
