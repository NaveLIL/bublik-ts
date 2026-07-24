import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  StringSelectMenuBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  GuildMember
} from 'discord.js';
import type { BublikClient } from '../../../bot';
import type { BlackMarketDeal, Prisma } from '@prisma/client';
import { BublikCommand, CommandScope } from '../../../types/Command';
import { logger } from '../../../core/Logger';
import { scheduleTask, unscheduleTask } from '../../../core/SchedulerManager';
import { isGuildAllowed } from '../../../core/Whitelist';
import { getGuildLocale } from '../../../core/GuildConfig';
import { getDatabase } from '../../../core/Database';
import {
  calculateEffectiveWantedDecayMs,
  getEcoConfig,
  invalidateProfileCache,
  wantedDecayAfterIncrement,
} from '../database';
import { applyWalletDeltaInTransaction, withFinancialLock, fmt } from '../profile';
import { getInventory, addInventoryItem } from '../inventory';
import { formatPerksInline, getUserPerks } from '../perks';
import { BublikEmbed } from '../../../core/EmbedBuilder';
import { ecoError, ecoSuccess, ecoLocked } from '../embeds';
import { TX, WANTED_DEFAULTS } from '../constants';
import { isConfiguredEconomyOwner } from '../ownerImmunity';

export const BM_PREFIX = 'eco:bm';
const log = logger.child('Economy:BlackMarket');

// Кэш дуэлей облав в реальном времени
// Key: listingId
export interface RaidDuel {
  guildId: string;
  copId: string;
  sellerId: string;
  listingId: string;
  listingName: string;
  listingPrice: number;
  itemKey: string;
  itemType: string;
  quantity: number;
  description?: string | null;
  perks?: unknown;
  isCustom: boolean;
  creatorId?: string | null;
  sellerChoice?: 'dump' | 'relocate' | 'ambush';
  copChoice?: 'surveillance' | 'gps' | 'swat';
  timer?: NodeJS.Timeout;
  resolved: boolean;
}
export const activeRaidDuels = new Map<string, RaidDuel>();

export interface PendingDeal {
  buyerOrCopId: string;
  dealId: string;
  timeout: NodeJS.Timeout;
}
export const activePendingDeals = new Map<string, PendingDeal>();

const DEAL_TTL_MS = 60_000;
const BM_MAX_UNIT_PRICE = 10_000_000;
export const BLACKMARKET_DUEL_SCOPE = 'blackmarket_duel';
const DUEL_RETENTION_MS = 30 * 24 * 60 * 60_000;
const RECOVERY_TASK = 'economy:blackMarketRecovery';
const RECOVERY_INTERVAL_MS = 30_000;

interface DuelMetadata {
  state: 'active' | 'resolved';
  sellerChoice?: RaidDuel['sellerChoice'];
  copChoice?: RaidDuel['copChoice'];
  outcome?: string;
}

export function parseBlackMarketDuelMetadata(value: unknown): DuelMetadata {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { state: 'active' };
  const raw = value as Record<string, unknown>;
  const sellerChoice = ['dump', 'relocate', 'ambush'].includes(String(raw.sellerChoice))
    ? raw.sellerChoice as RaidDuel['sellerChoice']
    : undefined;
  const copChoice = ['surveillance', 'gps', 'swat'].includes(String(raw.copChoice))
    ? raw.copChoice as RaidDuel['copChoice']
    : undefined;
  return {
    state: raw.state === 'resolved' ? 'resolved' : 'active',
    sellerChoice,
    copChoice,
    outcome: typeof raw.outcome === 'string' ? raw.outcome : undefined,
  };
}

function duelClaimKey(dealId: string): string {
  return `blackmarket-duel:${dealId}`;
}

function dealToDuel(deal: BlackMarketDeal, metadata: DuelMetadata): RaidDuel {
  return {
    guildId: deal.guildId,
    copId: deal.buyerId.slice(4),
    sellerId: deal.sellerId,
    listingId: deal.listingId,
    listingName: deal.name,
    listingPrice: deal.totalPrice,
    itemKey: deal.itemKey,
    itemType: deal.type,
    quantity: deal.quantity,
    description: deal.description,
    perks: deal.perks,
    isCustom: deal.isCustom,
    creatorId: deal.creatorId,
    sellerChoice: metadata.sellerChoice,
    copChoice: metadata.copChoice,
    resolved: metadata.state === 'resolved',
  };
}

async function markDuelResolved(
  tx: Prisma.TransactionClient,
  dealId: string,
  duel: RaidDuel,
  outcome: string,
): Promise<void> {
  await tx.operationClaim.updateMany({
    where: { key: duelClaimKey(dealId), scope: BLACKMARKET_DUEL_SCOPE },
    data: {
      metadata: {
        state: 'resolved',
        sellerChoice: duel.sellerChoice,
        copChoice: duel.copChoice,
        outcome,
      },
      expiresAt: new Date(Date.now() + DUEL_RETENTION_MS),
    },
  });
}

export function getBlackMarketTotal(unitPrice: number, quantity: number): number {
  if (!Number.isSafeInteger(unitPrice) || unitPrice <= 0 || unitPrice > BM_MAX_UNIT_PRICE) {
    throw new Error('invalid_unit_price');
  }
  if (!Number.isSafeInteger(quantity) || quantity <= 0) throw new Error('invalid_quantity');
  const total = unitPrice * quantity;
  if (!Number.isSafeInteger(total) || total > 2_147_483_647) throw new Error('price_overflow');
  return total;
}

async function createPersistentDeal(
  listing: any,
  buyerOrCopId: string,
  operationalCharge = 0,
): Promise<any | null> {
  const db = getDatabase();
  const expiresAt = new Date(Date.now() + DEAL_TTL_MS);
  const totalPrice = getBlackMarketTotal(listing.price, listing.quantity);

  try {
    return await db.$transaction(async (tx) => {
      // Освобождаем только действительно истёкший резерв. Активный deal защищён
      // unique(listingId), в том числе между несколькими процессами бота.
      await tx.blackMarketDeal.updateMany({
        where: { listingId: listing.id, status: { in: ['pending', 'accepted'] }, expiresAt: { lte: new Date() } },
        data: { status: 'expired' },
      });
      await tx.blackMarketDeal.deleteMany({
        where: { listingId: listing.id, status: { in: ['rejected', 'expired'] } },
      });

      if (operationalCharge > 0) {
        const copId = buyerOrCopId.startsWith('cop_') ? buyerOrCopId.slice(4) : buyerOrCopId;
        await applyWalletDeltaInTransaction(
          tx,
          listing.guildId,
          copId,
          -operationalCharge,
          'blackmarket_raid_cost',
          `Operational cost for lot ${listing.id}`,
        );
      }

      return tx.blackMarketDeal.create({
        data: {
          listingId: listing.id,
          guildId: listing.guildId,
          sellerId: listing.sellerId,
          buyerId: buyerOrCopId,
          itemKey: listing.itemKey,
          name: listing.name,
          type: listing.type,
          quantity: listing.quantity,
          unitPrice: listing.price,
          totalPrice,
          description: listing.description,
          perks: listing.perks ?? undefined,
          isCustom: listing.isCustom,
          creatorId: listing.creatorId,
          expiresAt,
        },
      });
    });
  } catch (err: any) {
    if (err?.code === 'P2002') return null;
    throw err;
  }
}

async function expirePersistentDeal(
  dealId: string,
  refundOperationalCharge = 0,
): Promise<boolean> {
  const db = getDatabase();
  const changed = await db.$transaction(async (tx) => {
    const deal = await tx.blackMarketDeal.findUnique({ where: { id: dealId } });
    if (!deal) return false;
    const expired = await tx.blackMarketDeal.updateMany({
      where: { id: dealId, status: 'pending' },
      data: { status: 'expired' },
    });
    if (expired.count !== 1) return false;

    if (refundOperationalCharge > 0 && deal.buyerId.startsWith('cop_')) {
      await applyWalletDeltaInTransaction(
        tx,
        deal.guildId,
        deal.buyerId.slice(4),
        refundOperationalCharge,
        'blackmarket_raid_refund',
        `Failed to contact seller for lot ${deal.listingId}`,
      );
    }
    return true;
  });
  return changed;
}

function registerPendingDealTimeout(deal: BlackMarketDeal): void {
  const current = activePendingDeals.get(deal.listingId);
  if (current?.dealId === deal.id) return;
  if (current) clearTimeout(current.timeout);
  const timeout = setTimeout(async () => {
    try {
      if (!isGuildAllowed(deal.guildId)) return;
      await expirePersistentDeal(deal.id);
    } catch (error) {
      log.error(`Failed to expire black-market deal ${deal.id}`, error);
    } finally {
      const active = activePendingDeals.get(deal.listingId);
      if (active?.dealId === deal.id) activePendingDeals.delete(deal.listingId);
    }
  }, Math.max(0, deal.expiresAt.getTime() - Date.now()));
  activePendingDeals.set(deal.listingId, {
    buyerOrCopId: deal.buyerId,
    dealId: deal.id,
    timeout,
  });
}

function registerRaidDuel(deal: BlackMarketDeal, metadata: DuelMetadata, client: BublikClient): RaidDuel {
  const existing = activeRaidDuels.get(deal.listingId);
  if (existing && !existing.resolved) return existing;
  const duel = dealToDuel(deal, metadata);
  activeRaidDuels.set(deal.listingId, duel);
  duel.timer = setTimeout(() => {
    void resolveRaidDuel(duel, client).catch((error) =>
      log.error(`Failed to resolve recovered black-market duel ${deal.id}`, error),
    );
  }, Math.max(0, deal.expiresAt.getTime() - Date.now()));
  return duel;
}

export async function recoverBlackMarketDeals(client: BublikClient): Promise<void> {
  const db = getDatabase();
  const guildIds = [...client.guilds.cache.keys()].filter(isGuildAllowed);
  if (guildIds.length === 0) return;
  const deals = await db.blackMarketDeal.findMany({
    where: { guildId: { in: guildIds }, status: { in: ['pending', 'accepted'] } },
    orderBy: { expiresAt: 'asc' },
    take: 500,
  });
  const now = new Date();

  for (const deal of deals) {
    try {
    // Only rows belonging to a guild currently served by this client are live work.
    if (!client.guilds.cache.has(deal.guildId) || !isGuildAllowed(deal.guildId)) continue;

    if (deal.status === 'pending') {
      if (deal.expiresAt <= now) {
        await db.blackMarketDeal.updateMany({
          where: { id: deal.id, status: 'pending', expiresAt: { lte: now } },
          data: { status: 'expired' },
        });
      } else {
        registerPendingDealTimeout(deal);
      }
      continue;
    }

    // A normal accepted deal is already terminal. Only cop deals enter a duel.
    if (!deal.buyerId.startsWith('cop_')) continue;
    const listing = await db.blackMarketListing.findUnique({
      where: { id: deal.listingId },
      select: { id: true },
    });
    if (!listing) {
      await db.blackMarketDeal.updateMany({
        where: { id: deal.id, status: 'accepted' },
        data: { status: 'expired' },
      });
      continue;
    }

    await db.operationClaim.createMany({
      data: [{
        key: duelClaimKey(deal.id),
        scope: BLACKMARKET_DUEL_SCOPE,
        guildId: deal.guildId,
        userId: deal.sellerId,
        metadata: { state: 'active' },
        expiresAt: deal.expiresAt,
      }],
      skipDuplicates: true,
    });
    const claim = await db.operationClaim.findUnique({ where: { key: duelClaimKey(deal.id) } });
    const metadata = parseBlackMarketDuelMetadata(claim?.metadata);
    if (metadata.state === 'resolved') continue;
    const duel = registerRaidDuel(deal, metadata, client);
    if (deal.expiresAt <= now) await resolveRaidDuel(duel, client);
    } catch (error) {
      log.error(`Failed to recover black-market deal ${deal.id}; it will be retried`, error);
    }
  }
}

export function startBlackMarketRecovery(client: BublikClient): void {
  scheduleTask(RECOVERY_TASK, RECOVERY_INTERVAL_MS, async () => {
    await recoverBlackMarketDeals(client).catch((error) =>
      log.error('Black-market recovery pass failed', error),
    );
  }, { exclusive: true, immediate: true });
}

export function stopBlackMarketRecovery(): void {
  unscheduleTask(RECOVERY_TASK);
  for (const pending of activePendingDeals.values()) clearTimeout(pending.timeout);
  for (const duel of activeRaidDuels.values()) if (duel.timer) clearTimeout(duel.timer);
  activePendingDeals.clear();
  activeRaidDuels.clear();
}

const blackMarketCommand: BublikCommand = {
  data: new SlashCommandBuilder()
    .setName('blackmarket')
    .setDescription('Чёрный Рынок: покупка, продажа и облавы на контрабанду')
    .setDMPermission(false)

    // ── list ──
    .addSubcommand((sub) =>
      sub
        .setName('list')
        .setDescription('Просмотреть анонимные лоты на Чёрном Рынке')
        .addIntegerOption((opt) =>
          opt.setName('page').setDescription('Страница лотов').setMinValue(1).setRequired(false),
        ),
    )

    // ── sell ──
    .addSubcommand((sub) =>
      sub
        .setName('sell')
        .setDescription('Выставить предмет из инвентаря на Чёрный Рынок')
        .addStringOption((opt) =>
          opt
            .setName('item')
            .setDescription('Название предмета из вашего инвентаря')
            .setRequired(true)
            .setAutocomplete(true),
        )
        .addIntegerOption((opt) =>
          opt.setName('price').setDescription('Цена за 1 шт. в шекелях (₪)').setMinValue(1).setMaxValue(BM_MAX_UNIT_PRICE).setRequired(true),
        )
        .addIntegerOption((opt) =>
          opt.setName('quantity').setDescription('Количество (по умолчанию: 1)').setMinValue(1).setMaxValue(1000).setRequired(false),
        ),
    )

    // ── upgrade ──
    .addSubcommand((sub) =>
      sub.setName('upgrade').setDescription('Купить дополнительные торговые слоты Чёрного Рынка'),
    )

    // ── raid ──
    .addSubcommand((sub) =>
      sub
        .setName('raid')
        .setDescription('👮 (Полиция) Начать облаву / контрольную закупку на лот')
        .addStringOption((opt) =>
          opt.setName('lot_id').setDescription('ID лота на Чёрном Рынке (например, #A92F)').setRequired(true),
        ),
    ),

  scope: CommandScope.Guild,
  category: 'economy',
  descriptionKey: 'commands.blackmarket.description',

  async execute(interaction: ChatInputCommandInteraction, _client: BublikClient): Promise<void> {
    const guildId = interaction.guildId!;
    const locale = await getGuildLocale(guildId);
    const sub = interaction.options.getSubcommand();

    const config = await getEcoConfig(guildId);
    if (!config?.enabled) {
      await interaction.reply({ embeds: [ecoError('Экономика отключена на сервере.')], flags: MessageFlags.Ephemeral });
      return;
    }

    switch (sub) {
      case 'list':
        await handleList(interaction, guildId, locale);
        break;
      case 'sell':
        await handleSell(interaction, guildId, locale);
        break;
      case 'upgrade':
        await handleUpgrade(interaction, guildId, locale);
        break;
      case 'raid':
        await handleRaid(interaction, guildId, config, locale);
        break;
    }
  },

  async autocomplete(interaction): Promise<void> {
    const guildId = interaction.guildId;
    if (!guildId) return;
    const focused = interaction.options.getFocused(true);
    if (focused.name !== 'item') return;
    const q = String(focused.value ?? '').toLowerCase().trim();

    const items = await getInventory(guildId, interaction.user.id);
    const choices = items
      .filter((i) => i.name.toLowerCase().includes(q))
      .map((i) => ({ name: `${i.name} (${i.quantity} шт.)`, value: i.itemKey }))
      .slice(0, 25);

    await interaction.respond(choices).catch(() => {});
  },
};

// ═══════════════════════════════════════════════
//  Subcommand: list (Просмотр лотов)
// ═══════════════════════════════════════════════

async function handleList(interaction: ChatInputCommandInteraction, guildId: string, locale: string) {
  const page = interaction.options.getInteger('page') ?? 1;
  await renderBmList(interaction, guildId, locale, page);
}

export async function handleBmListPagination(interaction: any, page: number) {
  const guildId = interaction.guildId!;
  const locale = await getGuildLocale(guildId);
  await renderBmList(interaction, guildId, locale, page);
}

async function renderBmList(interaction: any, guildId: string, locale: string, page: number) {
  const db = getDatabase();
  const limit = 5;
  const total = await db.blackMarketListing.count({ where: { guildId } });
  const maxPage = Math.max(1, Math.ceil(total / limit));
  const targetPage = Math.max(1, Math.min(page, maxPage));
  const skip = (targetPage - 1) * limit;

  const listings = await db.blackMarketListing.findMany({
    where: { guildId },
    orderBy: { createdAt: 'desc' },
    skip,
    take: limit,
  });

  const embed = new BublikEmbed()
    .setColor(0x2f3542)
    .setTitle(`🖤 Чёрный Рынок Неве-Эрез (Страница ${targetPage}/${maxPage})`)
    .setDescription(
      `Здесь продаются запрещённые товары и редкие предметы.\n` +
      `👤 **Все сделки на Чёрном Рынке проходят СТРОГО АНОНИМНО.**\n` +
      `🚨 *Внимание: копы под прикрытием могут устроить контрольную закупку на любой лот!*\n\n` +
      (listings.length === 0
        ? `*На рынке пока нет активных лотов. Вы можете выставить предмет через* \`/blackmarket sell\`!`
        : listings
            .map((lot) => {
              const perksStr = lot.perks ? formatPerksInline(lot.perks as any, locale) : null;
              const shortId = lot.id.substring(lot.id.length - 4).toUpperCase();
              return (
                `**Лот \`#${shortId}\`** | **${lot.name}** × \`${lot.quantity} шт.\`\n` +
                `💰 **Цена:** **${fmt(lot.price)}** за шт. • всего **${fmt(getBlackMarketTotal(lot.price, lot.quantity))}**\n` +
                `📝 *${lot.description || 'Нет описания'}*\n` +
                (perksStr ? `⚡ *Перки:* ${perksStr}\n` : '')
              );
            })
            .join('\n'))
    );

  const components: any[] = [];

  if (listings.length > 0) {
    const selectRow = new ActionRowBuilder<StringSelectMenuBuilder>();
    const select = new StringSelectMenuBuilder()
      .setCustomId('bm_buy_select')
      .setPlaceholder('Выберите лот для покупки...');

    for (const lot of listings) {
      const shortId = lot.id.substring(lot.id.length - 4).toUpperCase();
      select.addOptions({
        label: `Лот #${shortId} — ${lot.name.replace(/[^a-zA-Zа-яА-Я0-9\s()]/g, '').substring(0, 40)}`,
        value: lot.id,
        description: `Кол-во: ${lot.quantity} шт. | Итого: ${fmt(getBlackMarketTotal(lot.price, lot.quantity))}`,
      });
    }
    selectRow.addComponents(select);
    components.push(selectRow);
  }

  const btnRow = new ActionRowBuilder<ButtonBuilder>();

  const prevBtn = new ButtonBuilder()
    .setCustomId(`eco:bm:list:${targetPage - 1}`)
    .setLabel('◀️ Назад')
    .setStyle(ButtonStyle.Primary)
    .setDisabled(targetPage <= 1);

  const nextBtn = new ButtonBuilder()
    .setCustomId(`eco:bm:list:${targetPage + 1}`)
    .setLabel('Вперед ▶️')
    .setStyle(ButtonStyle.Primary)
    .setDisabled(targetPage >= maxPage);

  btnRow.addComponents(prevBtn, nextBtn);
  components.push(btnRow);

  if (interaction.isButton?.()) {
    await interaction.update({ embeds: [embed], components });
  } else {
    await interaction.reply({ embeds: [embed], components });
  }
}

// ═══════════════════════════════════════════════
//  Subcommand: sell (Выставление товара)
// ═══════════════════════════════════════════════

async function handleSell(interaction: ChatInputCommandInteraction, guildId: string, locale: string) {
  const userId = interaction.user.id;
  const itemKey = interaction.options.getString('item', true);
  const price = interaction.options.getInteger('price', true);
  const qty = interaction.options.getInteger('quantity') ?? 1;
  try {
    getBlackMarketTotal(price, qty);
  } catch {
    await interaction.reply({ embeds: [ecoError('Некорректная цена или количество товара.')], flags: MessageFlags.Ephemeral });
    return;
  }

  const result = await withFinancialLock(guildId, userId, async () => {
    const db = getDatabase();
    return db.$transaction(async (tx) => {
      const profile = await tx.economyProfile.upsert({
        where: { guildId_userId: { guildId, userId } },
        create: { guildId, userId },
        update: {},
      });

      // Проверяем лимит слотов
      const currentListings = await tx.blackMarketListing.count({ where: { guildId, sellerId: userId } });
      const maxSlots = profile.blackMarketSlots;
      if (currentListings >= maxSlots) {
        return { success: false, error: 'slots_limit', limit: maxSlots };
      }

      // Проверяем наличие предмета в инвентаре
      const invItem = await tx.economyInventoryItem.findUnique({
        where: { guildId_userId_itemKey: { guildId, userId, itemKey } }
      });
      if (!invItem || invItem.quantity < qty) {
        return { success: false, error: 'no_item' };
      }

      // Списываем из инвентаря
      if (invItem.quantity === qty) {
        await tx.economyInventoryItem.delete({
          where: { guildId_userId_itemKey: { guildId, userId, itemKey } }
        });
      } else {
        await tx.economyInventoryItem.update({
          where: { guildId_userId_itemKey: { guildId, userId, itemKey } },
          data: { quantity: { decrement: qty } }
        });
      }

      // Создаем лот на черном рынке
      const listing = await tx.blackMarketListing.create({
        data: {
          guildId,
          sellerId: userId,
          itemKey,
          name: invItem.name,
          type: invItem.type,
          quantity: qty,
          price,
          description: invItem.description,
          perks: invItem.perks || undefined,
          isCustom: invItem.isCustom,
          creatorId: invItem.creatorId,
        }
      });

      return { success: true, name: invItem.name, listingId: listing.id };
    });
  });

  if (result === null) {
    await interaction.reply({ embeds: [ecoLocked(locale)], flags: MessageFlags.Ephemeral });
    return;
  }

  if (!result.success) {
    if (result.error === 'slots_limit') {
      await interaction.reply({
        embeds: [ecoError(`Вы достигли лимита торговых слотов Черного Рынка! Максимум лотов: **${result.limit}**. Вы можете расширить лимит с помощью \`/blackmarket upgrade\`.`)],
        flags: MessageFlags.Ephemeral
      });
      return;
    }
    await interaction.reply({
      embeds: [ecoError('У вас недостаточно предметов в инвентаре для продажи.')],
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  const shortId = result.listingId!.substring(result.listingId!.length - 4).toUpperCase();
  await interaction.reply({
    embeds: [ecoSuccess(`📦 **Товар выставлен на Чёрный Рынок!**\n• **Предмет:** ${result.name} (${qty} шт.)\n• **Цена за штуку:** ${fmt(price)}\n• **ID лота:** \`#${shortId}\``)]
  });
}

// ═══════════════════════════════════════════════
//  Subcommand: upgrade (Улучшение слотов)
// ═══════════════════════════════════════════════

async function handleUpgrade(interaction: ChatInputCommandInteraction, guildId: string, locale: string) {
  const userId = interaction.user.id;

  const result = await withFinancialLock(guildId, userId, async () => {
    const db = getDatabase();
    return db.$transaction(async (tx) => {
      const profile = await tx.economyProfile.upsert({
        where: { guildId_userId: { guildId, userId } },
        create: { guildId, userId },
        update: {},
      });

      const current = profile.blackMarketSlots;
      if (current >= 50) {
        return { success: false, error: 'max_slots' };
      }

      const nextSlot = current + 1;
      const cost = 5000 * (nextSlot - 3) * (nextSlot - 3);

      try {
        await applyWalletDeltaInTransaction(
          tx,
          guildId,
          userId,
          -cost,
          'blackmarket_slot_upgrade',
          `Upgrade black market slots to ${nextSlot}`,
        );
      } catch (err: any) {
        if (err?.message === 'insufficient_funds') {
          return { success: false, error: 'no_money', cost, current };
        }
        throw err;
      }

      const updated = await tx.economyProfile.update({
        where: { guildId_userId: { guildId, userId } },
        data: { blackMarketSlots: { increment: 1 } },
      });

      return { success: true, cost, newSlots: updated.blackMarketSlots };
    });
  });

  if (result === null) {
    await interaction.reply({ embeds: [ecoLocked(locale)], flags: MessageFlags.Ephemeral });
    return;
  }

  if (!result.success) {
    if (result.error === 'max_slots') {
      await interaction.reply({
        embeds: [ecoError('Вы уже достигли максимального лимита в **50 слотов** торговли!')],
        flags: MessageFlags.Ephemeral
      });
      return;
    }
    await interaction.reply({
      embeds: [ecoError(`Недостаточно шекелей для покупки нового слота! Стоимость слота №${result.current! + 1}: **${fmt(result.cost!)}**`)],
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  await interaction.reply({
    embeds: [ecoSuccess(`📈 **Лимит слотов Чёрного Рынка успешно расширен!**\n• Теперь вы можете выставлять до **${result.newSlots} лотов** одновременно.\n• Списано на расширение: **${fmt(result.cost!)}**.`)]
  });
}

// ═══════════════════════════════════════════════
//  Subcommand: raid (👮 Облава полиции)
// ═══════════════════════════════════════════════

async function handleRaid(
  interaction: ChatInputCommandInteraction,
  guildId: string,
  config: any,
  locale: string
) {
  const member = interaction.member as GuildMember;
  const copId = interaction.user.id;

  // 1. Проверяем роль копа
  if (!config.policeRoleId || !member.roles.cache.has(config.policeRoleId)) {
    await interaction.reply({
      embeds: [ecoError('👮 **Доступ закрыт!** Начинать облавы на лоты Чёрного Рынка могут только сотрудники полиции при исполнении.')],
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  const lotTag = interaction.options.getString('lot_id', true).trim().replace('#', '').toUpperCase();
  const db = getDatabase();

  // 2. Находим лот по 4 последним символам или полному ID
  const listings = await db.blackMarketListing.findMany({ where: { guildId } });
  const listing = listings.find(
    (l) => l.id.endsWith(lotTag.toLowerCase()) || l.id.toUpperCase() === lotTag
  );

  if (!listing) {
    await interaction.reply({
      embeds: [ecoError(`Лот \`#${lotTag}\` не найден на Чёрном Рынке. Попробуйте обновить список через \`/blackmarket list\`.`)],
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  if (listing.sellerId === copId) {
    await interaction.reply({
      embeds: [ecoError('👮 **Контрольная закупка сорвана!** Вы не можете устраивать облаву на собственный лот.')],
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  if (isConfiguredEconomyOwner(listing.sellerId)) {
    const shortId = listing.id.substring(listing.id.length - 4).toUpperCase();
    await interaction.reply({
      embeds: [ecoError(`👮 **Отдел внутренних расследований заблокировал операцию!** Поступил звонок сверху. Лот \`#${shortId}\` принадлежит Мэру г. Неве-Эрез и защищён дипломатической неприкосновенностью. Копы молча возвращаются в участок.`)],
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  const price = 500; // невозвратные оперативные расходы после отправки запроса

  // 3. Запускаем операцию (проверяем деньги и создаем событие)
  const result = await withFinancialLock(guildId, copId, async () => {
    try {
      const deal = await createPersistentDeal(listing, `cop_${copId}`, price);
      if (!deal) return { success: false, error: 'busy' as const };
      return { success: true, deal };
    } catch (err: any) {
      if (err?.message === 'insufficient_funds') return { success: false, error: 'no_money' as const };
      throw err;
    }
  });

  if (result === null) {
    await interaction.reply({ embeds: [ecoLocked(locale)], flags: MessageFlags.Ephemeral });
    return;
  }

  if (!result.success) {
    if (result.error === 'busy') {
      await interaction.reply({
        embeds: [ecoError('⚠️ Этот лот уже находится в активной сделке или облаве.')],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    await interaction.reply({
      embeds: [ecoError(`У вас нет **${fmt(price)}** для покрытия оперативных расходов на запуск спецоперации.`)],
      flags: MessageFlags.Ephemeral
    });
    return;
  }
  const deal = result.deal!;
  await invalidateProfileCache(guildId, copId);

  // 4. Отправляем анонимный запрос продавцу в личку
  const seller = await interaction.client.users.fetch(listing.sellerId).catch(() => null);
  if (!seller) {
    // Запрос не был доставлен: отменяем deal и возвращаем расходы ровно один раз.
    await expirePersistentDeal(deal.id, price);
    await invalidateProfileCache(guildId, copId);
    await interaction.reply({
      embeds: [ecoError('Не удалось установить канал связи с продавцом. Закупка отменена, деньги возвращены.')],
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  // Создаем кнопки сделки для ЛС продавца
  const acceptBtnId = `${BM_PREFIX}:deal:accept:cop_${copId}:${listing.id}:${deal.totalPrice}`;
  const rejectBtnId = `${BM_PREFIX}:deal:reject:cop_${copId}:${listing.id}:${deal.totalPrice}`;

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(acceptBtnId).setLabel('✅ Принять сделку').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(rejectBtnId).setLabel('❌ Отклонить сделку').setStyle(ButtonStyle.Danger)
  );

  const shortId = listing.id.substring(listing.id.length - 4).toUpperCase();
  const dmEmbed = new BublikEmbed()
    .setColor(0xe74c3c)
    .setTitle(`📦 Поступил анонимный запрос на покупку вашего лота #${shortId}`)
    .setDescription(
      `• **Предмет:** ${listing.name} (${listing.quantity} шт.)\n` +
      `• **Стоимость всего лота:** **${fmt(deal.totalPrice)}**\n\n` +
      `⚠️ **ВНИМАНИЕ:** Имя покупателя полностью скрыто. Это может быть обычный игрок или **контрольная закупка полиции под прикрытием**!\n` +
      `Если это копы, и вы примете сделку — начнется облава. Если отклоните — лот снимется с продажи, но вы останетесь в безопасности.`
    );

  try {
    await seller.send({ embeds: [dmEmbed], components: [row] });
  } catch {
    await expirePersistentDeal(deal.id, price);
    await invalidateProfileCache(guildId, copId);
    await interaction.reply({
      embeds: [ecoError('У продавца закрыты личные сообщения! Сделка невозможна, шекели возвращены.')],
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  const timeout = setTimeout(async () => {
    if (!isGuildAllowed(listing.guildId)) return;
    const local = activePendingDeals.get(listing.id);
    if (local?.dealId === deal.id) activePendingDeals.delete(listing.id);
    const expired = await expirePersistentDeal(deal.id);
    if (!expired) return;

    const copUser = await interaction.client.users.fetch(copId).catch(() => null);
    if (copUser) {
      await copUser.send({
        embeds: [ecoError(`⌛ **Время ожидания сделки по лоту #${shortId} истекло.** Продавец не ответил. Оперативные расходы израсходованы.`)]
      }).catch(() => {});
    }

    const sellerUser = await interaction.client.users.fetch(listing.sellerId).catch(() => null);
    if (sellerUser) {
      await sellerUser.send({
        embeds: [ecoError(`⌛ **Время ожидания сделки по лоту #${shortId} истекло.** Вы не ответили вовремя, сделка отменена.`)]
      }).catch(() => {});
    }
  }, 60_000);

  activePendingDeals.set(listing.id, { buyerOrCopId: `cop_${copId}`, dealId: deal.id, timeout });

  // Сообщаем копу, что операция запущена
  const copEmbed = new BublikEmbed()
    .setColor(0xf1c40f)
    .setTitle('🕵️ Контрольная закупка запущена!')
    .setDescription(
      `Вы отправили анонимный запрос на покупку Лота \`#${shortId}\` стоимостью **${fmt(deal.totalPrice)}**.\n` +
      `С вашего баланса списано **${fmt(price)}** оперативных расходов.\n\n` +
      `⏳ Ожидаем ответа продавца. Если он согласится на сделку, начнётся задержание. Вы получите уведомление в ЛС.`
    );

  await interaction.reply({ embeds: [copEmbed], flags: MessageFlags.Ephemeral });
}

// ═══════════════════════════════════════════════
//  Interaction Handlers (Чёрный Рынок)
// ═══════════════════════════════════════════════

export async function handleBmBuySelect(interaction: any): Promise<void> {
  const listingId = interaction.values[0];
  const db = getDatabase();
  const lot = await db.blackMarketListing.findUnique({ where: { id: listingId } });
  if (!lot) {
    await interaction.reply({ embeds: [ecoError('Этот лот уже продан или снят с продажи!')], flags: MessageFlags.Ephemeral });
    return;
  }

  const shortId = lot.id.substring(lot.id.length - 4).toUpperCase();
  const totalPrice = getBlackMarketTotal(lot.price, lot.quantity);
  const embed = new BublikEmbed()
    .setColor(0xf1c40f)
    .setTitle(`📦 Покупка лота #${shortId}`)
    .setDescription(
      `Вы собираетесь купить лот **"${lot.name}"** (${lot.quantity} шт.) за **${fmt(totalPrice)}**.\n\n` +
      `🛡️ Баланс будет проверен и списан атомарно только после подтверждения продавца.\n` +
      `🕵️ Продавцу будет отправлен анонимный запрос. Он сможет одобрить сделку или отклонить её.`
    );

  const confirmBtnId = `${BM_PREFIX}:confirm_buy:normal:${interaction.user.id}:${lot.id}:${totalPrice}`;
  const cancelBtnId = `${BM_PREFIX}:confirm_buy:cancel`;

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(confirmBtnId).setLabel('✅ Начать сделку').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(cancelBtnId).setLabel('❌ Отмена').setStyle(ButtonStyle.Secondary)
  );

  await interaction.reply({ embeds: [embed], components: [row], flags: MessageFlags.Ephemeral });
}

export async function handleBmConfirmBuy(
  interaction: any,
  actionType: string,
  buyerId: string,
  listingId: string,
  _priceStr: string
): Promise<void> {
  if (actionType === 'cancel') {
    await interaction.reply({ content: 'Покупка отменена.', flags: MessageFlags.Ephemeral });
    return;
  }

  const db = getDatabase();

  if (interaction.user.id !== buyerId || interaction.guildId == null) {
    await interaction.reply({ embeds: [ecoError('Эта кнопка покупки принадлежит другому пользователю.')], flags: MessageFlags.Ephemeral });
    return;
  }

  const lot = await db.blackMarketListing.findUnique({ where: { id: listingId } });
  if (!lot || lot.guildId !== interaction.guildId) {
    await interaction.reply({ embeds: [ecoError('Этот лот больше не доступен.')], flags: MessageFlags.Ephemeral });
    return;
  }
  if (lot.sellerId === buyerId) {
    await interaction.reply({ embeds: [ecoError('Нельзя купить собственный лот.')], flags: MessageFlags.Ephemeral });
    return;
  }

  const totalPrice = getBlackMarketTotal(lot.price, lot.quantity);
  const deal = await createPersistentDeal(lot, buyerId);
  if (!deal) {
    await interaction.reply({ embeds: [ecoError('⚠️ Этот лот уже находится в активной сделке или облаве.')], flags: MessageFlags.Ephemeral });
    return;
  }
  const seller = await interaction.client.users.fetch(lot.sellerId).catch(() => null);

  if (!seller) {
    await expirePersistentDeal(deal.id);
    await interaction.reply({ embeds: [ecoError('Не удалось связаться с продавцом. Сделка отменена.')], flags: MessageFlags.Ephemeral });
    return;
  }

  const acceptBtnId = `${BM_PREFIX}:deal:accept:${buyerId}:${lot.id}:${totalPrice}`;
  const rejectBtnId = `${BM_PREFIX}:deal:reject:${buyerId}:${lot.id}:${totalPrice}`;

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(acceptBtnId).setLabel('✅ Принять сделку').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(rejectBtnId).setLabel('❌ Отклонить сделку').setStyle(ButtonStyle.Danger)
  );

  const shortId = lot.id.substring(lot.id.length - 4).toUpperCase();
  const dmEmbed = new BublikEmbed()
    .setColor(0x3498db)
    .setTitle(`📦 Поступил анонимный запрос на покупку вашего лота #${shortId}`)
    .setDescription(
      `• **Предмет:** ${lot.name} (${lot.quantity} шт.)\n` +
      `• **Стоимость всего лота:** **${fmt(totalPrice)}**\n\n` +
      `⚠️ **ВНИМАНИЕ:** Имя покупателя полностью скрыто. Это может быть обычный игрок или **контрольная закупка полиции под прикрытием**!\n` +
      `Если это копы, и вы примете сделку — начнется облава. Если отклоните — лот снимется с продажи, но вы останетесь в безопасности.`
    );

  try {
    await seller.send({ embeds: [dmEmbed], components: [row] });
  } catch {
    await expirePersistentDeal(deal.id);
    await interaction.reply({ embeds: [ecoError('У продавца закрыты личные сообщения! Сделка невозможна.')], flags: MessageFlags.Ephemeral });
    return;
  }

  const timeout = setTimeout(async () => {
    if (!isGuildAllowed(lot.guildId)) return;
    const local = activePendingDeals.get(lot.id);
    if (local?.dealId === deal.id) activePendingDeals.delete(lot.id);
    const expired = await expirePersistentDeal(deal.id);
    if (!expired) return;

    const buyerUser = await interaction.client.users.fetch(buyerId).catch(() => null);
    if (buyerUser) {
      await buyerUser.send({
        embeds: [ecoError(`⌛ **Время ожидания сделки по лоту #${shortId} истекло.** Продавец не ответил; деньги не списывались.`)]
      }).catch(() => {});
    }

    const sellerUser = await interaction.client.users.fetch(lot.sellerId).catch(() => null);
    if (sellerUser) {
      await sellerUser.send({
        embeds: [ecoError(`⌛ **Время ожидания сделки по лоту #${shortId} истекло.** Вы не ответили вовремя, сделка отменена.`)]
      }).catch(() => {});
    }
  }, 60_000);

  activePendingDeals.set(lot.id, { buyerOrCopId: buyerId, dealId: deal.id, timeout });

  await interaction.reply({
    embeds: [ecoSuccess(`⏳ **Запрос на покупку отправлен продавцу.**\nПри подтверждении будет списано **${fmt(totalPrice)}**. Ожидайте ответа продавца в течение 60 секунд.`)],
    flags: MessageFlags.Ephemeral
  });
}

export async function handleBmDealResponse(
  interaction: any,
  action: 'accept' | 'reject',
  buyerOrCopId: string,
  listingId: string,
  _priceStr: string
): Promise<void> {
  const db = getDatabase();
  const deal = await db.blackMarketDeal.findUnique({ where: { listingId } });
  const listing = await db.blackMarketListing.findUnique({ where: { id: listingId } });
  // DM interactions do not carry guildId. The durable deal is the authority;
  // check it before even expiring or rejecting stale state.
  if (deal && !isGuildAllowed(deal.guildId)) {
    await interaction.reply({
      content: '❌ Этот сервер больше не авторизован для работы с ботом.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  if (
    !deal ||
    !listing ||
    deal.status !== 'pending' ||
    deal.expiresAt.getTime() <= Date.now() ||
    deal.buyerId !== buyerOrCopId ||
    deal.sellerId !== interaction.user.id ||
    listing.guildId !== deal.guildId ||
    listing.sellerId !== deal.sellerId
  ) {
    if (deal?.status === 'pending' && deal.expiresAt.getTime() <= Date.now()) {
      await db.blackMarketDeal.updateMany({
        where: { id: deal.id, status: 'pending' },
        data: { status: 'expired' },
      });
    }
    await interaction.message.edit({ content: '❌ Эта сделка уже завершена или истекла.', embeds: [], components: [] }).catch(() => {});
    await interaction.reply({ content: '❌ Активная сделка не найдена.', flags: MessageFlags.Ephemeral });
    return;
  }

  const isCop = deal.buyerId.startsWith('cop_');
  const actualBuyerId = isCop ? deal.buyerId.substring(4) : deal.buyerId;
  const price = deal.totalPrice;
  const sellerId = deal.sellerId;
  const shortId = listing.id.substring(listing.id.length - 4).toUpperCase();
  const clearLocalPending = () => {
    const pending = activePendingDeals.get(listingId);
    if (pending?.dealId === deal.id) {
      clearTimeout(pending.timeout);
      activePendingDeals.delete(listingId);
    }
  };

  if (action === 'reject') {
    // CAS статуса, возврат вещи и удаление лота — одна транзакция.
    const rejected = await db.$transaction(async (tx) => {
      const claimed = await tx.blackMarketDeal.updateMany({
        where: { id: deal.id, status: 'pending', expiresAt: { gt: new Date() } },
        data: { status: 'rejected' },
      });
      if (claimed.count !== 1) return false;
      const removed = await tx.blackMarketListing.deleteMany({
        where: { id: listingId, guildId: deal.guildId, sellerId },
      });
      if (removed.count !== 1) throw new Error('listing_claim_lost');
      await addInventoryItem(
        tx,
        deal.guildId,
        sellerId,
        deal.itemKey,
        deal.name,
        deal.type,
        deal.quantity,
        deal.perks,
        deal.description || undefined,
        deal.isCustom,
        deal.creatorId || deal.sellerId,
      );
      return true;
    });

    if (!rejected) {
      await interaction.reply({ content: '❌ Сделка уже обработана.', flags: MessageFlags.Ephemeral });
      return;
    }
    clearLocalPending();

    await invalidateProfileCache(deal.guildId, sellerId);

    await interaction.message.edit({
      content: `❌ **Сделка отклонена.** Товар снят с рынка и возвращен в ваш инвентарь.`,
      embeds: [],
      components: []
    }).catch(() => {});

    // Уведомляем покупателя/копа
    if (isCop) {
      const cop = await interaction.client.users.fetch(actualBuyerId).catch(() => null);
      if (cop) {
        await cop.send({
          embeds: [ecoError(`❌ **Контрольная закупка сорвана!** Подозреваемый отклонил сделку по лоту #${shortId} и снял товар с рынка.`)]
        }).catch(() => {});
      }
    } else {
      const buyer = await interaction.client.users.fetch(actualBuyerId).catch(() => null);
      if (buyer) {
        await buyer.send({
          embeds: [ecoError(`❌ **Продавец отклонил ваш запрос** на покупку лота #${shortId}. Деньги не списывались.`)]
        }).catch(() => {});
      }
    }

    await interaction.reply({ content: 'Вы отклонили сделку. Товар снят с рынка.', flags: MessageFlags.Ephemeral });
  } else {
    // action === 'accept'
    if (!isCop) {
      const payout = Math.floor(price * 0.9);
      try {
        const accepted = await db.$transaction(async (tx) => {
          const claimed = await tx.blackMarketDeal.updateMany({
            where: { id: deal.id, status: 'pending', expiresAt: { gt: new Date() } },
            data: { status: 'accepted' },
          });
          if (claimed.count !== 1) return false;

          const removed = await tx.blackMarketListing.deleteMany({
            where: { id: listingId, guildId: deal.guildId, sellerId },
          });
          if (removed.count !== 1) throw new Error('listing_claim_lost');

          await applyWalletDeltaInTransaction(
            tx,
            deal.guildId,
            actualBuyerId,
            -price,
            'blackmarket_buy',
            `Purchase lot #${shortId}`,
            sellerId,
          );
          await applyWalletDeltaInTransaction(
            tx,
            deal.guildId,
            sellerId,
            payout,
            TX.TRANSFER_IN,
            `Продажа лота #${shortId} на Черном Рынке (анонимно)`,
            actualBuyerId,
          );

          await addInventoryItem(
            tx,
            deal.guildId,
            actualBuyerId,
            deal.itemKey,
            deal.name,
            deal.type,
            deal.quantity,
            deal.perks,
            deal.description || undefined,
            deal.isCustom,
            deal.creatorId || deal.sellerId,
          );
          return true;
        });
        if (!accepted) {
          await interaction.reply({ content: '❌ Сделка уже обработана.', flags: MessageFlags.Ephemeral });
          return;
        }
      } catch (err: any) {
        if (err?.message === 'insufficient_funds') {
          await db.blackMarketDeal.updateMany({
            where: { id: deal.id, status: 'pending' },
            data: { status: 'expired' },
          });
          clearLocalPending();
          await interaction.message.edit({ content: '❌ У покупателя уже недостаточно средств. Лот остаётся на рынке.', embeds: [], components: [] }).catch(() => {});
          await interaction.reply({ content: '❌ Сделка отменена без списаний.', flags: MessageFlags.Ephemeral });
          return;
        }
        throw err;
      }
      clearLocalPending();

      await invalidateProfileCache(deal.guildId, sellerId);
      await invalidateProfileCache(deal.guildId, actualBuyerId);

      await interaction.message.edit({
        content: `✅ **Сделка завершена успешно!** Вы получили **${fmt(payout)}** (за вычетом 10% комиссии рынка).`,
        embeds: [],
        components: []
      }).catch(() => {});

      const buyer = await interaction.client.users.fetch(actualBuyerId).catch(() => null);
      if (buyer) {
        await buyer.send({
          embeds: [ecoSuccess(`✅ **Сделка завершена!** Предмет **${deal.name}** (${deal.quantity} шт.) добавлен в ваш инвентарь.`)]
        }).catch(() => {});
      }

      await interaction.reply({ content: 'Сделка завершена!', flags: MessageFlags.Ephemeral });
    } else {
      // ЭТО В ЗАСАДУ! ОБЛАВА КОПОВ!
      const duelExpiresAt = new Date(Date.now() + DEAL_TTL_MS);
      const claimed = await db.$transaction(async (tx) => {
        const accepted = await tx.blackMarketDeal.updateMany({
          where: { id: deal.id, status: 'pending', expiresAt: { gt: new Date() } },
          data: { status: 'accepted', expiresAt: duelExpiresAt },
        });
        if (accepted.count !== 1) return false;
        await tx.operationClaim.create({
          data: {
            key: duelClaimKey(deal.id),
            scope: BLACKMARKET_DUEL_SCOPE,
            guildId: deal.guildId,
            userId: sellerId,
            metadata: { state: 'active' },
            expiresAt: duelExpiresAt,
          },
        });
        return true;
      });
      if (!claimed) {
        await interaction.reply({ content: '❌ Сделка уже обработана.', flags: MessageFlags.Ephemeral });
        return;
      }
      clearLocalPending();

      const acceptedDeal = { ...deal, status: 'accepted', expiresAt: duelExpiresAt };
      registerRaidDuel(acceptedDeal, { state: 'active' }, interaction.client);

      // Отправляем преступнику сообщение о засаде
      const sellerPanel = new BublikEmbed()
        .setColor(0xe74c3c)
        .setTitle('🚨 ЭТО БЫЛА ПОДСТАВА! ВАС ОКРУЖАЮТ!')
        .setDescription(
          `Покупатель оказался полицейским агентом под прикрытием!\n` +
          `Все выходы перекрыты группами захвата. Товар изымается.\n\n` +
          `⏳ **Быстро выберите план отхода (60 секунд):**`
        );

      const sellerRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId(`eco:bm:raid_choice:seller:dump:${listingId}`).setLabel('🏃‍♂️ Сбросить товар').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(`eco:bm:raid_choice:seller:relocate:${listingId}`).setLabel('📦 Сменить точку').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId(`eco:bm:raid_choice:seller:ambush:${listingId}`).setLabel('🔫 Устроить засаду').setStyle(ButtonStyle.Danger)
      );

      await interaction.message.edit({ embeds: [sellerPanel], components: [sellerRow] }).catch(() => {});

      // Отправляем копу панель тактики
      const cop = await interaction.client.users.fetch(actualBuyerId).catch(() => null);
      if (cop) {
        const copPanel = new BublikEmbed()
          .setColor(0x2980b9)
          .setTitle('🚨 Задержание началось!')
          .setDescription(
            `Подозреваемый принял сделку по Лоту #${shortId}!\n` +
            `Подозреваемый заблокирован в секторе. Начинаем операцию.\n\n` +
            `⏳ **Выберите тактику штурма (60 секунд):**`
          );

        const copRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder().setCustomId(`eco:bm:raid_choice:cop:surveillance:${listingId}`).setLabel('🕵️ Наблюдение').setStyle(ButtonStyle.Secondary),
          new ButtonBuilder().setCustomId(`eco:bm:raid_choice:cop:gps:${listingId}`).setLabel('🛰️ GPS-сигнал').setStyle(ButtonStyle.Primary),
          new ButtonBuilder().setCustomId(`eco:bm:raid_choice:cop:swat:${listingId}`).setLabel('🛡️ Штурм SWAT').setStyle(ButtonStyle.Danger)
        );

        await cop.send({ embeds: [copPanel], components: [copRow] }).catch(() => {});
      }

      await interaction.reply({ content: '🚨 Подразделения приведены в боевую готовность! Спецоперация началась.', flags: MessageFlags.Ephemeral });
    }
  }
}

export async function handleBmRaidChoice(
  interaction: any,
  role: 'seller' | 'cop',
  choice: string,
  listingId: string
): Promise<void> {
  const db = getDatabase();
  const selected = await db.$transaction(async (tx) => {
    const deal = await tx.blackMarketDeal.findUnique({ where: { listingId } });
    if (
      !deal ||
      deal.status !== 'accepted' ||
      !deal.buyerId.startsWith('cop_') ||
      deal.expiresAt.getTime() <= Date.now()
    ) return { type: 'inactive' as const };
    if (!isGuildAllowed(deal.guildId)) return { type: 'unauthorized' as const };

    const validSellerChoice = role === 'seller' && ['dump', 'relocate', 'ambush'].includes(choice);
    const validCopChoice = role === 'cop' && ['surveillance', 'gps', 'swat'].includes(choice);
    const expectedUserId = role === 'seller' ? deal.sellerId : deal.buyerId.slice(4);
    if ((!validSellerChoice && !validCopChoice) || interaction.user.id !== expectedUserId) {
      return { type: 'forbidden' as const };
    }

    const claimKey = duelClaimKey(deal.id);
    await tx.operationClaim.createMany({
      data: [{
        key: claimKey,
        scope: BLACKMARKET_DUEL_SCOPE,
        guildId: deal.guildId,
        userId: deal.sellerId,
        metadata: { state: 'active' },
        expiresAt: deal.expiresAt,
      }],
      skipDuplicates: true,
    });
    await tx.$queryRaw`SELECT "key" FROM "operation_claims" WHERE "key" = ${claimKey} FOR UPDATE`;
    const claim = await tx.operationClaim.findUniqueOrThrow({ where: { key: claimKey } });
    const metadata = parseBlackMarketDuelMetadata(claim.metadata);
    if (metadata.state !== 'active') return { type: 'inactive' as const };
    if ((role === 'seller' && metadata.sellerChoice) || (role === 'cop' && metadata.copChoice)) {
      return { type: 'already' as const };
    }

    const nextMetadata: DuelMetadata = {
      ...metadata,
      sellerChoice: role === 'seller' ? choice as RaidDuel['sellerChoice'] : metadata.sellerChoice,
      copChoice: role === 'cop' ? choice as RaidDuel['copChoice'] : metadata.copChoice,
    };
    await tx.operationClaim.update({
      where: { key: claimKey },
      data: { metadata: nextMetadata as unknown as Prisma.InputJsonValue },
    });
    return { type: 'ok' as const, deal, metadata: nextMetadata };
  });

  if (selected.type === 'inactive') {
    await interaction.reply({ content: '❌ Спецоперация уже завершена.', flags: MessageFlags.Ephemeral });
    return;
  }
  if (selected.type === 'unauthorized') {
    await interaction.reply({
      content: '❌ Этот сервер больше не авторизован для работы с ботом.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  if (selected.type === 'forbidden') {
    await interaction.reply({ content: `❌ Вы не можете выбирать тактику ${role === 'seller' ? 'продавца' : 'полиции'}.`, flags: MessageFlags.Ephemeral });
    return;
  }
  if (selected.type === 'already') {
    await interaction.reply({ content: `❌ Тактика ${role === 'seller' ? 'продавца' : 'полиции'} уже выбрана.`, flags: MessageFlags.Ephemeral });
    return;
  }

  const duel = registerRaidDuel(selected.deal, selected.metadata, interaction.client);
  duel.sellerChoice = selected.metadata.sellerChoice;
  duel.copChoice = selected.metadata.copChoice;

  if (role === 'seller') {
    await interaction.message.edit({ content: `⏳ Вы выбрали: **${choice === 'dump' ? 'Сбросить товар' : choice === 'relocate' ? 'Сменить точку' : 'Засаду'}**. Ожидание решений полиции...`, components: [] }).catch(() => {});
  } else {
    await interaction.message.edit({ content: `⏳ Вы выбрали: **${choice === 'surveillance' ? 'Наблюдение' : choice === 'gps' ? 'GPS-сигнал' : 'Штурм SWAT'}**. Ожидание действий подозреваемого...`, components: [] }).catch(() => {});
  }

  if (duel.sellerChoice && duel.copChoice) {
    await resolveRaidDuel(duel, interaction.client);
  } else {
    await interaction.reply({ content: 'Выбор принят. Ждем оппонента...', flags: MessageFlags.Ephemeral });
  }
}

async function resolveRaidDuel(duel: RaidDuel, client: BublikClient) {
  if (!isGuildAllowed(duel.guildId)) return;
  if (duel.resolved) return;
  if (duel.timer) clearTimeout(duel.timer);
  activeRaidDuels.delete(duel.listingId);

  const db = getDatabase();
  const persistedDeal = await db.blackMarketDeal.findUnique({ where: { listingId: duel.listingId } });
  if (!persistedDeal || persistedDeal.status !== 'accepted' || !persistedDeal.buyerId.startsWith('cop_')) {
    duel.resolved = true;
    return;
  }
  const persistedClaim = await db.operationClaim.findUnique({ where: { key: duelClaimKey(persistedDeal.id) } });
  duel = dealToDuel(persistedDeal, parseBlackMarketDuelMetadata(persistedClaim?.metadata));
  duel.resolved = true;

  const sellerId = duel.sellerId;
  const copId = duel.copId;
  const price = duel.listingPrice;

  // Defaults
  const sellerChoice = duel.sellerChoice || 'dump';
  const copChoice = duel.copChoice || 'surveillance';

  let outcome: 'police_win' | 'draw' | 'seller_win_relocate' | 'police_win_swat' | 'seller_win_ambush' = 'draw';

  if (sellerChoice === 'dump') {
    if (copChoice === 'surveillance') outcome = 'police_win';
    else outcome = 'draw';
  } else if (sellerChoice === 'relocate') {
    if (copChoice === 'gps') outcome = 'police_win';
    else outcome = 'seller_win_relocate';
  } else if (sellerChoice === 'ambush') {
    if (copChoice === 'swat') outcome = 'police_win_swat';
    else outcome = 'seller_win_ambush';
  }

  const shortId = duel.listingId.substring(duel.listingId.length - 4).toUpperCase();
  const copUser = await client.users.fetch(copId).catch(() => null);
  const sellerUser = await client.users.fetch(sellerId).catch(() => null);

  const logResult = async (type: string, sellerMsg: string, copMsg: string) => {
    if (sellerUser) {
      await sellerUser.send({ embeds: [new BublikEmbed().setColor(outcome.includes('police') ? 0xe74c3c : 0x2ecc71).setTitle(`🚨 Результат облавы на лот #${shortId}`).setDescription(sellerMsg)] }).catch(() => {});
    }
    if (copUser) {
      await copUser.send({ embeds: [new BublikEmbed().setColor(outcome.includes('police') ? 0x2ecc71 : 0xe74c3c).setTitle(`🚨 Результат облавы на лот #${shortId}`).setDescription(copMsg)] }).catch(() => {});
    }
  };

  const settlePoliceOutcome = async (wantedStars: number, fixedBonus: number) => {
    const [wantedConfig, sellerPerks] = await Promise.all([
      getEcoConfig(duel.guildId),
      getUserPerks(duel.guildId, sellerId),
    ]);
    const wantedDecayMs = calculateEffectiveWantedDecayMs(
      wantedConfig?.wantedDecayMs ?? WANTED_DEFAULTS.decayMs,
      sellerPerks.wantedDecayMul,
    );
    return db.$transaction(async (tx) => {
      const released = await tx.blackMarketDeal.updateMany({
        where: { id: persistedDeal.id, status: 'accepted' },
        data: { status: 'expired' },
      });
      if (released.count !== 1) throw new Error('raid_already_resolved');

      const removed = await tx.blackMarketListing.deleteMany({
        where: { id: duel.listingId, guildId: duel.guildId, sellerId },
      });
      if (removed.count !== 1) throw new Error('raid_already_resolved');

      const seller = await tx.economyProfile.upsert({
        where: { guildId_userId: { guildId: duel.guildId, userId: sellerId } },
        create: { guildId: duel.guildId, userId: sellerId },
        update: {},
      });
      await tx.$queryRaw`SELECT "id" FROM "economy_profiles" WHERE "id" = ${seller.id} FOR UPDATE`;
      const freshSeller = await tx.economyProfile.findUniqueOrThrow({ where: { id: seller.id } });
      const actualFine = Math.min(price, freshSeller.wallet);
      if (actualFine > 0) {
        await applyWalletDeltaInTransaction(
          tx,
          duel.guildId,
          sellerId,
          -actualFine,
          TX.CAPTURE_LOSS,
          `Штраф за торговлю контрабандой (лот #${shortId})`,
          copId,
        );
      }
      await tx.economyProfile.update({
        where: { guildId_userId: { guildId: duel.guildId, userId: sellerId } },
        data: {
          wantedStars: { increment: wantedStars },
          wantedNextDecay: wantedDecayAfterIncrement(
            freshSeller.wantedNextDecay,
            Date.now(),
            wantedDecayMs,
          ),
        },
      });

      // Сначала вся реально взысканная сумма поступает в казну. Премия может
      // быть выплачена только из существующих средств казны и никогда не
      // создаёт отрицательный government-профиль.
      let treasury = await tx.economyProfile.upsert({
        where: { guildId_userId: { guildId: duel.guildId, userId: 'government' } },
        create: { guildId: duel.guildId, userId: 'government' },
        update: {},
      });
      if (actualFine > 0) {
        treasury = await applyWalletDeltaInTransaction(
          tx,
          duel.guildId,
          'government',
          actualFine,
          'blackmarket_fine_income',
          `Fine from lot #${shortId}`,
          sellerId,
        );
      }

      const desiredBounty = Math.floor(actualFine * 0.3) + fixedBonus;
      const bounty = Math.min(desiredBounty, treasury.wallet);
      if (bounty > 0) {
        await applyWalletDeltaInTransaction(
          tx,
          duel.guildId,
          'government',
          -bounty,
          'blackmarket_police_bounty_out',
          `Police bounty for lot #${shortId}`,
          copId,
        );
        await applyWalletDeltaInTransaction(
          tx,
          duel.guildId,
          copId,
          bounty,
          TX.EARN_CRIME,
          `Премия за успешную закупку лота #${shortId}`,
          sellerId,
        );
      }

      await markDuelResolved(tx, persistedDeal.id, duel, outcome);

      return { actualFine, bounty };
    });
  };

  const settleSellerOutcome = async (maxCopFine: number, captureCooldownUntil?: Date) => {
    return db.$transaction(async (tx) => {
      const released = await tx.blackMarketDeal.updateMany({
        where: { listingId: duel.listingId, status: 'accepted' },
        data: { status: 'expired' },
      });
      if (released.count !== 1) throw new Error('raid_already_resolved');

      const cop = await tx.economyProfile.upsert({
        where: { guildId_userId: { guildId: duel.guildId, userId: copId } },
        create: { guildId: duel.guildId, userId: copId },
        update: {},
      });
      const copFine = Math.min(maxCopFine, cop.wallet);
      if (copFine > 0) {
        await applyWalletDeltaInTransaction(
          tx,
          duel.guildId,
          copId,
          -copFine,
          'blackmarket_failed_raid_fine',
          `Failed raid on lot #${shortId}`,
          sellerId,
        );
        await applyWalletDeltaInTransaction(
          tx,
          duel.guildId,
          'government',
          copFine,
          'blackmarket_failed_raid_income',
          `Police fine from lot #${shortId}`,
          copId,
        );
      }
      if (captureCooldownUntil) {
        await tx.economyProfile.update({
          where: { guildId_userId: { guildId: duel.guildId, userId: copId } },
          data: { lastCapture: captureCooldownUntil },
        });
      }
      await markDuelResolved(tx, persistedDeal.id, duel, outcome);
      return copFine;
    });
  };

  // Разрешаем по сценариям
  if (outcome === 'police_win') {
    const { actualFine, bounty } = await settlePoliceOutcome(1, 0);

    await invalidateProfileCache(duel.guildId, sellerId);
    await invalidateProfileCache(duel.guildId, copId);

    const detailText = sellerChoice === 'dump'
      ? 'Полиция вела скрытое наблюдение и зафиксировала сброс улик.'
      : 'Кибер-отдел перехватил сигнал перемещения и накрыл вас на новой точке.';

    await logResult(
      'police_win',
      `🚨 **Облава успешна!** Вы пойманы с поличным!\n• ${detailText}\n• Вам начислена **+1 звезда розыска**.\n• Фактически взыскано: **${fmt(actualFine)}**.`,
      `👮 **Облава завершена успешно!**\n• ${detailText}\n• Подозреваемый опознан: это <@${sellerId}>.\n• Вам начислена премия 30%: **${fmt(bounty)}**.`
    );
  }
  else if (outcome === 'police_win_swat') {
    const { actualFine, bounty } = await settlePoliceOutcome(3, 1500);

    await invalidateProfileCache(duel.guildId, sellerId);
    await invalidateProfileCache(duel.guildId, copId);

    await logResult(
      'police_win_swat',
      `🚨 **ПОЛНЫЙ РАЗГРОМ!** Вашу засаду штурмовал спецназ SWAT!\n• Вы отправлены в глубокую тюрьму (**+3 звезды розыска**).\n• Фактически взыскано: **${fmt(actualFine)}**. Товар уничтожен.`,
      `👮 **УСПЕХ СПЕЦОПЕРАЦИИ!** SWAT полностью зачистил засаду подозреваемого!\n• Подозреваемый отправлен за решётку: это <@${sellerId}>.\n• Вам начислена премия 30% + боевой бонус 1,500 ₪: **${fmt(bounty)}**.`
    );
  }
  else if (outcome === 'seller_win_relocate') {
    // Лот никогда не удалялся: все исходные metadata/quantity/perks сохранены.
    const copFine = await settleSellerOutcome(500);

    await invalidateProfileCache(duel.guildId, sellerId);
    await invalidateProfileCache(duel.guildId, copId);

    await logResult(
      'seller_win_relocate',
      `😎 **Успешный маневр!** Вы вовремя сменили точку закладки.\n• Лот остался на продаже, ваша личность скрыта.\n• Копы ушли ни с чем.`,
      `❌ **Спецоперация провалена!** Подозреваемый успешно переместил товар в другой тайник.\n• Лот остался на продаже, продавец скрылся.\n• Фактически взыскано **${fmt(copFine)}** за ложный выезд.`
    );
  }
  else if (outcome === 'seller_win_ambush') {
    const copFine = await settleSellerOutcome(2000, new Date(Date.now() + 12 * 3600_000));

    await invalidateProfileCache(duel.guildId, sellerId);
    await invalidateProfileCache(duel.guildId, copId);

    await logResult(
      'seller_win_ambush',
      `🔥 **ЗАСАДА СРАБОТАЛА!** Вы заманили копа в ловушку и тяжело ранили его!\n• Ваша личность скрыта, лот остался на продаже.\n• Коп нейтрализован.`,
      `💀 **ВАС ЗАМАНИЛИ В ЗАСАДУ!** Подозреваемый открыл огонь на поражение!\n• Вы тяжело ранены и госпитализированы.\n• Фактически взыскано **${fmt(copFine)}**.\n• Вы не можете проводить аресты и облавы в течение следующих **12 часов**.`
    );
  }
  else {
    // draw (сброс товара преступником, коп без наблюдения)
    await db.$transaction(async (tx) => {
      const resolved = await tx.blackMarketDeal.updateMany({
        where: { listingId: duel.listingId, status: 'accepted' },
        data: { status: 'expired' },
      });
      if (resolved.count !== 1) throw new Error('raid_already_resolved');
      await tx.blackMarketListing.deleteMany({
        where: { id: duel.listingId, guildId: duel.guildId, sellerId },
      });
      await markDuelResolved(tx, persistedDeal.id, duel, outcome);
    });
    await logResult(
      'draw',
      `🤝 **Вы ушли чистым!** Вы успели сбросить товар в канализацию. Вы потеряли вещь, но копы не смогли зафиксировать улики и не опознали вас.`,
      `🤝 **Ничья.** Подозреваемый успел сбросить товар до начала штурма и скрылся. Улик нет, личность не установлена.`
    );
  }
}

export default blackMarketCommand;
