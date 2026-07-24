import { createHash, randomUUID } from 'node:crypto';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  Message,
  TextChannel,
} from 'discord.js';
import type { CustomItemRequest, Prisma } from '@prisma/client';
import { getDatabase } from '../../core/Database';
import { getGuildLocale } from '../../core/GuildConfig';
import { logger } from '../../core/Logger';
import { scheduleTask, unscheduleTask } from '../../core/SchedulerManager';
import { isGuildAllowed } from '../../core/Whitelist';
import { BublikEmbed } from '../../core/EmbedBuilder';
import { invalidateProfileCache } from './database';
import { formatPerksInline } from './perks';
import { applyWalletDeltaInTransaction, fmt } from './profile';

const TASK = 'economy:craftPublishRecovery';
const INTERVAL_MS = 60_000;
const PUBLISH_LEASE_MS = 2 * 60_000;
const PERMANENT_DISCORD_CODES = new Set([10_003, 50_001, 50_013]);
const log = logger.child('Economy:CraftRecovery');

interface CraftPublishIntent {
  version: 1;
  requestId: string;
  guildId: string;
  channelId: string;
  nonce: string;
  state: 'pending' | 'linked';
  leaseOwner?: string;
  leaseUntil?: number;
  messageId?: string;
}

function discordErrorCode(error: unknown): number | null {
  if (!error || typeof error !== 'object') return null;
  const value = Number((error as { code?: unknown }).code);
  return Number.isFinite(value) ? value : null;
}

export function craftPublishIntentKey(requestId: string): string {
  return `economy:craft-publish:${requestId}`;
}

export function craftPublishNonce(requestId: string): string {
  return createHash('sha256').update(`bublik-craft:${requestId}`).digest('hex').slice(0, 24);
}

export function parseCraftPublishIntent(value: unknown): CraftPublishIntent | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const intent = value as Partial<CraftPublishIntent>;
  if (
    intent.version !== 1 ||
    typeof intent.requestId !== 'string' ||
    typeof intent.guildId !== 'string' ||
    typeof intent.channelId !== 'string' ||
    typeof intent.nonce !== 'string' ||
    (intent.state !== 'pending' && intent.state !== 'linked') ||
    (intent.leaseOwner !== undefined && typeof intent.leaseOwner !== 'string') ||
    (intent.leaseUntil !== undefined && typeof intent.leaseUntil !== 'number') ||
    (intent.messageId !== undefined && typeof intent.messageId !== 'string')
  ) return null;
  return intent as CraftPublishIntent;
}

/** Exact identity check; title fragments and user-authored lookalikes are rejected. */
export function isCraftPanelMessage(
  value: unknown,
  botUserId: string,
  requestId: string,
): boolean {
  if (!value || typeof value !== 'object') return false;
  const message = value as {
    author?: { id?: string } | null;
    embeds?: readonly { footer?: { text?: string | null } | null }[];
    components?: readonly unknown[];
  };
  if (message.author?.id !== botUserId) return false;
  const marker = `craft-request:${requestId}`;
  if (!message.embeds?.some((embed) => embed.footer?.text === marker)) return false;
  const customIds = new Set<string>();
  for (const rowValue of message.components ?? []) {
    if (!rowValue || typeof rowValue !== 'object') continue;
    const components = (rowValue as { components?: unknown }).components;
    if (!Array.isArray(components)) continue;
    for (const componentValue of components) {
      if (!componentValue || typeof componentValue !== 'object') continue;
      const customId = (componentValue as { customId?: unknown }).customId;
      if (typeof customId === 'string') customIds.add(customId);
    }
  }
  return customIds.has(`eco:craft:approve:${requestId}`)
    && customIds.has(`eco:craft:reject:${requestId}`);
}

function buildCraftPanel(request: CustomItemRequest, locale: string) {
  const perks = request.perks && typeof request.perks === 'object' && !Array.isArray(request.perks)
    ? request.perks as Record<string, number>
    : null;
  const embed = new BublikEmbed()
    .setColor(0xf1c40f)
    .setTitle(`🛠️ Заявка на крафт предмета #${request.id}`)
    .setDescription(
      `👤 **Создатель:** <@${request.creatorId}> (\`${request.creatorId}\`)\n`
      + `📦 **Название:** \`${request.name}\`\n`
      + `📝 **Описание:** *${request.description ?? ''}*\n`
      + (perks
        ? `⚡ **Характеристики:** ${formatPerksInline(perks, locale)}\n`
        : '✨ **Характеристики:** *Косметический сувенир*\n')
      + `💰 **Стоимость крафта (в резерве):** **${fmt(request.feePaid)}**`,
    )
    .setFooter({ text: `craft-request:${request.id}` });
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`eco:craft:approve:${request.id}`)
      .setLabel('Одобрить')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`eco:craft:reject:${request.id}`)
      .setLabel('Отклонить')
      .setStyle(ButtonStyle.Danger),
  );
  return { embed, row };
}

async function refundUnpublishedCraft(request: CustomItemRequest, reason: string): Promise<boolean> {
  const db = getDatabase();
  const refunded = await db.$transaction(async (tx) => {
    const claimed = await tx.customItemRequest.updateMany({
      where: { id: request.id, guildId: request.guildId, status: 'pending' },
      data: {
        status: 'rejected',
        reviewNote: reason.slice(0, 200),
        reviewedAt: new Date(),
      },
    });
    if (claimed.count !== 1) return false;
    await applyWalletDeltaInTransaction(
      tx,
      request.guildId,
      request.creatorId,
      request.feePaid,
      'craft_refund',
      `Automatic craft refund ${request.id}: ${reason.slice(0, 80)}`,
    );
    await tx.operationClaim.deleteMany({ where: { key: craftPublishIntentKey(request.id) } });
    return true;
  });
  if (refunded) await invalidateProfileCache(request.guildId, request.creatorId);
  return refunded;
}

async function ensureCraftPublishIntent(
  request: CustomItemRequest,
  configuredChannelId: string | null,
): Promise<CraftPublishIntent | null> {
  const db = getDatabase();
  const key = craftPublishIntentKey(request.id);
  const existing = await db.operationClaim.findUnique({ where: { key } });
  if (!existing) {
    if (!configuredChannelId) return null;
    const intent: CraftPublishIntent = {
      version: 1,
      requestId: request.id,
      guildId: request.guildId,
      channelId: configuredChannelId,
      nonce: craftPublishNonce(request.id),
      state: 'pending',
    };
    await db.operationClaim.createMany({
      data: [{
        key,
        scope: 'craft_publish_intent',
        guildId: request.guildId,
        userId: request.creatorId,
        metadata: intent as unknown as Prisma.InputJsonValue,
      }],
      skipDuplicates: true,
    });
  }

  const persisted = await db.operationClaim.findUnique({ where: { key } });
  const intent = parseCraftPublishIntent(persisted?.metadata);
  if (
    !persisted ||
    persisted.scope !== 'craft_publish_intent' ||
    !intent ||
    intent.requestId !== request.id ||
    intent.guildId !== request.guildId
  ) throw new Error('craft_publish_intent_corrupt');
  return intent;
}

async function acquireCraftPublishLease(requestId: string): Promise<CraftPublishIntent | null> {
  const db = getDatabase();
  const key = craftPublishIntentKey(requestId);
  const owner = randomUUID();
  const now = Date.now();
  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "key" FROM "operation_claims" WHERE "key" = ${key} FOR UPDATE`;
    const claim = await tx.operationClaim.findUnique({ where: { key } });
    const intent = parseCraftPublishIntent(claim?.metadata);
    if (!claim || !intent) throw new Error('craft_publish_intent_corrupt');
    if (intent.leaseUntil && intent.leaseUntil > now) return null;
    const leased: CraftPublishIntent = {
      ...intent,
      state: 'pending',
      leaseOwner: owner,
      leaseUntil: now + PUBLISH_LEASE_MS,
    };
    await tx.operationClaim.update({
      where: { key },
      data: { metadata: leased as unknown as Prisma.InputJsonValue },
    });
    return leased;
  });
}

async function markCraftMessageLinked(
  requestId: string,
  messageId: string,
  expectedLeaseOwner?: string,
): Promise<'linked' | 'already_done' | 'lease_lost'> {
  const db = getDatabase();
  const key = craftPublishIntentKey(requestId);
  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "key" FROM "operation_claims" WHERE "key" = ${key} FOR UPDATE`;
    const claim = await tx.operationClaim.findUnique({ where: { key } });
    const intent = parseCraftPublishIntent(claim?.metadata);
    if (!claim || !intent) throw new Error('craft_publish_intent_corrupt');
    if (expectedLeaseOwner && intent.leaseOwner !== expectedLeaseOwner) return 'lease_lost';

    const request = await tx.customItemRequest.findUnique({ where: { id: requestId } });
    if (!request || request.status !== 'pending') return 'already_done';
    let canonicalMessageId = request.modMessageId;
    if (!canonicalMessageId) {
      const linked = await tx.customItemRequest.updateMany({
        where: { id: requestId, status: 'pending', modMessageId: null },
        data: { modMessageId: messageId },
      });
      if (linked.count === 1) canonicalMessageId = messageId;
      else {
        canonicalMessageId = (await tx.customItemRequest.findUnique({ where: { id: requestId } }))?.modMessageId ?? null;
      }
    }
    if (!canonicalMessageId) return 'lease_lost';

    const { leaseOwner: _owner, leaseUntil: _until, ...rest } = intent;
    const linkedIntent: CraftPublishIntent = {
      ...rest,
      state: 'linked',
      messageId: canonicalMessageId,
    };
    await tx.operationClaim.update({
      where: { key },
      data: { metadata: linkedIntent as unknown as Prisma.InputJsonValue },
    });
    return canonicalMessageId === messageId ? 'linked' : 'already_done';
  });
}

async function findExactCraftPanels(
  channel: TextChannel,
  botUserId: string,
  request: CustomItemRequest,
): Promise<Message[]> {
  const matches: Message[] = [];
  const oldestRelevantTimestamp = request.createdAt.getTime() - 60_000;
  let before: string | undefined;

  while (true) {
    const batch = await channel.messages.fetch({ limit: 100, ...(before ? { before } : {}) });
    for (const message of batch.values()) {
      if (isCraftPanelMessage(message, botUserId, request.id)) matches.push(message);
    }
    const oldest = batch.last();
    if (!oldest || batch.size < 100 || oldest.createdTimestamp < oldestRelevantTimestamp) break;
    before = oldest.id;
  }

  return matches.sort((a, b) => a.createdTimestamp - b.createdTimestamp);
}

export type CraftPublishResult = 'published' | 'linked' | 'already_done' | 'refunded' | 'retry';

export async function publishPendingCraftRequest(
  client: Client,
  requestId: string,
): Promise<CraftPublishResult> {
  const db = getDatabase();
  const request = await db.customItemRequest.findUnique({ where: { id: requestId } });
  if (!request || request.status !== 'pending') return 'already_done';
  if (!isGuildAllowed(request.guildId)) return 'retry';
  const guild = client.guilds.cache.get(request.guildId);
  if (!guild) return 'retry';

  const config = await db.economyConfig.findUnique({
    where: { guildId: request.guildId },
    select: { enabled: true, marketModChannelId: true },
  });

  let intent: CraftPublishIntent | null;
  try {
    intent = await ensureCraftPublishIntent(request, config?.enabled ? config.marketModChannelId : null);
  } catch (error) {
    log.error(`Craft request ${request.id} has a corrupt durable publish intent`, error);
    return 'retry';
  }
  if (!intent) {
    return await refundUnpublishedCraft(request, 'Moderation channel is not configured')
      ? 'refunded'
      : 'already_done';
  }

  let channel: TextChannel | null = null;
  try {
    const fetched = guild.channels.cache.get(intent.channelId)
      ?? await guild.channels.fetch(intent.channelId);
    if (fetched instanceof TextChannel) channel = fetched;
  } catch (error) {
    if (!PERMANENT_DISCORD_CODES.has(discordErrorCode(error) ?? -1)) return 'retry';
  }
  if (!channel) {
    return await refundUnpublishedCraft(request, 'Moderation channel is unavailable')
      ? 'refunded'
      : 'already_done';
  }

  const botUserId = client.user?.id;
  if (!botUserId) return 'retry';

  if (request.modMessageId) {
    try {
      const existing = await channel.messages.fetch(request.modMessageId);
      if (isCraftPanelMessage(existing, botUserId, request.id)) {
        await markCraftMessageLinked(request.id, existing.id);
        return 'linked';
      }
      await db.customItemRequest.updateMany({
        where: { id: request.id, status: 'pending', modMessageId: request.modMessageId },
        data: { modMessageId: null },
      });
    } catch (error) {
      if (discordErrorCode(error) !== 10_008) return 'retry';
      await db.customItemRequest.updateMany({
        where: { id: request.id, status: 'pending', modMessageId: request.modMessageId },
        data: { modMessageId: null },
      });
    }
  }

  const leased = await acquireCraftPublishLease(request.id);
  if (!leased?.leaseOwner) return 'retry';

  try {
    const existingPanels = await findExactCraftPanels(channel, botUserId, request);
    if (existingPanels.length > 0) {
      const canonical = existingPanels[0];
      const linked = await markCraftMessageLinked(request.id, canonical.id, leased.leaseOwner);
      if (linked === 'lease_lost') return 'retry';
      for (const duplicate of existingPanels.slice(1)) {
        await duplicate.delete().catch(() => {});
      }
      return linked === 'linked' ? 'linked' : 'already_done';
    }

    const locale = await getGuildLocale(request.guildId);
    const { embed, row } = buildCraftPanel(request, locale);
    const sent = await channel.send({
      embeds: [embed],
      components: [row],
      nonce: leased.nonce,
      enforceNonce: true,
    });
    const linked = await markCraftMessageLinked(request.id, sent.id, leased.leaseOwner);
    if (linked === 'lease_lost') return 'retry';
    if (linked === 'already_done') {
      const current = await db.customItemRequest.findUnique({ where: { id: request.id } });
      if (current?.modMessageId && current.modMessageId !== sent.id) {
        await sent.delete().catch(() => {});
      }
      return 'already_done';
    }
    return 'published';
  } catch (error) {
    if (PERMANENT_DISCORD_CODES.has(discordErrorCode(error) ?? -1)) {
      return await refundUnpublishedCraft(request, 'Cannot publish to moderation channel')
        ? 'refunded'
        : 'already_done';
    }
    log.error(`Craft request ${request.id} publish failed; it will be retried`, error);
    return 'retry';
  }
}

export async function reconcilePendingCraftRequests(client: Client): Promise<void> {
  const guildIds = [...client.guilds.cache.keys()].filter(isGuildAllowed);
  if (guildIds.length === 0) return;
  const requests = await getDatabase().customItemRequest.findMany({
    where: { guildId: { in: guildIds }, status: 'pending' },
    orderBy: { createdAt: 'asc' },
    take: 100,
    select: { id: true },
  });
  for (const request of requests) {
    await publishPendingCraftRequest(client, request.id);
  }
}

export function startCraftRecovery(client: Client): void {
  scheduleTask(TASK, INTERVAL_MS, async () => {
    await reconcilePendingCraftRequests(client);
  }, { exclusive: true, immediate: true });
}

export function stopCraftRecovery(): void {
  unscheduleTask(TASK);
}
