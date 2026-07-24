// ═══════════════════════════════════════════════
//  /shop — Магазин ролей
//
//  Субкоманды:
//  • list    — просмотр товаров
//  • buy     — купить роль
//  • add     — добавить товар (Admin)
//  • remove  — удалить товар (Admin)
//
//  Роли могут быть временными (durationHours > 0)
//  или постоянными (durationHours = 0).
// ═══════════════════════════════════════════════

import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  PermissionsBitField,
  GuildMember,
  Role,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
} from 'discord.js';
import type { BublikClient } from '../../../bot';
import { BublikCommand, CommandScope } from '../../../types/Command';
import { logger } from '../../../core/Logger';
import { i18n } from '../../../core/I18n';
import { getGuildLocale } from '../../../core/GuildConfig';
import { getDatabase } from '../../../core/Database';
import { getEcoConfig, invalidateProfileCache, buySafe, buyLockpick, buyMask } from '../database';
import { applyWalletDeltaInTransaction, withFinancialLock, fmt } from '../profile';
import { sanitizePerks, parsePerksString, formatPerksInline, invalidateUserPerks } from '../perks';
import { BublikEmbed } from '../../../core/EmbedBuilder';
import { ecoError, ecoSuccess, ecoLocked } from '../embeds';
import { EMOJI, TX, SAFE_DEFAULTS, LOCKPICK_DEFAULTS, MASK_DEFAULTS } from '../constants';
import { payShopCommissionOnce } from '../shop-expiry';
import {
  evaluateRolePolicy,
  fetchRolePolicySubject,
  hasDangerousAssignablePermissions,
  loadInteractionRolePolicyContext,
  rolePolicyFailureMessage,
} from '../../../core/RolePolicy';

const log = logger.child('Economy:Shop');

function isUnknownRoleError(error: unknown): boolean {
  return Boolean(
    error
    && typeof error === 'object'
    && Number((error as { code?: unknown }).code) === 10_011,
  );
}

const shopCommand: BublikCommand = {
  data: new SlashCommandBuilder()
    .setName('shop')
    .setDescription('Магазин ролей за шекели')

    // ── list ──────────────────────
    .addSubcommand((sub) =>
      sub
        .setName('list')
        .setDescription('Просмотреть товары'),
    )

    // ── buy ───────────────────────
    .addSubcommand((sub) =>
      sub
        .setName('buy')
        .setDescription('Купить роль')
        .addStringOption((opt) =>
          opt
            .setName('item')
            .setDescription('Название товара (выберите из подсказок)')
            .setRequired(true)
            .setAutocomplete(true),
        ),
    )

    // ── add (admin) ───────────────
    .addSubcommand((sub) =>
      sub
        .setName('add')
        .setDescription('Добавить роль в магазин (Admin)')
        .addRoleOption((opt) =>
          opt
            .setName('role')
            .setDescription('Discord-роль для продажи')
            .setRequired(true),
        )
        .addIntegerOption((opt) =>
          opt
            .setName('price')
            .setDescription('Цена (₪)')
            .setMinValue(1)
            .setRequired(true),
        )
        .addStringOption((opt) =>
          opt
            .setName('name')
            .setDescription('Название товара')
            .setRequired(true),
        )
        .addIntegerOption((opt) =>
          opt
            .setName('duration')
            .setDescription('Длительность в часах (0 = навсегда)')
            .setMinValue(0)
            .setRequired(false),
        )
        .addStringOption((opt) =>
          opt
            .setName('description')
            .setDescription('Описание товара')
            .setRequired(false),
        )
        .addIntegerOption((opt) =>
          opt
            .setName('stock')
            .setDescription('Лимит покупок (-1 = безлимит)')
            .setRequired(false),
        )
        .addStringOption((opt) =>
          opt
            .setName('perks')
            .setDescription("Перки, напр. 'robBonus=10,dirtyMul=0.7'")
            .setRequired(false),
        ),
    )

    // ── remove (admin) ────────────
    .addSubcommand((sub) =>
      sub
        .setName('remove')
        .setDescription('Удалить товар из магазина (Admin)')
        .addStringOption((opt) =>
          opt
            .setName('item')
            .setDescription('Название товара (выберите из подсказок)')
            .setRequired(true)
            .setAutocomplete(true),
        ),
    )

    // ── safe (Криминал) ──────────
    .addSubcommand((sub) =>
      sub
        .setName('safe')
        .setDescription('Купить сейф (защита от /rob и /heist)'),
    )

    // ── lockpick (Криминал) ──────
    .addSubcommand((sub) =>
      sub
        .setName('lockpick')
        .setDescription('Купить отмычку (+бонус к /rob)'),
    )

    // ── mask (Криминал) ──────────
    .addSubcommand((sub) =>
      sub
        .setName('mask')
        .setDescription('Купить маску с рынка Кармель (защита от звезд и скрытие имени в /rob)'),
    ),

  scope: CommandScope.Guild,
  category: 'economy',
  descriptionKey: 'commands.shop.description',

  async execute(interaction: ChatInputCommandInteraction, _client: BublikClient): Promise<void> {
    const locale = await getGuildLocale(interaction.guildId);
    const sub = interaction.options.getSubcommand();
    const guildId = interaction.guildId!;

    const config = await getEcoConfig(guildId);
    if (!config?.enabled) {
      await interaction.reply({ embeds: [ecoError(i18n.t('economy.common.error_economy_disabled_short', locale))], ephemeral: true });
      return;
    }
    if (config.shopEnabled === false) {
      await interaction.reply({ embeds: [ecoError(i18n.t('economy.cmd.shop.error_shop_disabled', locale))], ephemeral: true });
      return;
    }

    switch (sub) {
      case 'list':
        await handleList(interaction, guildId, locale);
        break;
      case 'buy':
        await handleBuy(interaction, guildId, config.id, locale);
        break;
      case 'add':
        await handleAdd(interaction, guildId, config.id, locale);
        break;
      case 'remove':
        await handleRemove(interaction, guildId, locale);
        break;
      case 'safe':
        await handleSafe(interaction, guildId, locale, config);
        break;
      case 'lockpick':
        await handleLockpick(interaction, guildId, locale, config);
        break;
      case 'mask':
        await handleMask(interaction, guildId, locale, config);
        break;
    }
  },

  async autocomplete(interaction): Promise<void> {
    const guildId = interaction.guildId;
    if (!guildId) return;
    const focused = interaction.options.getFocused(true);
    if (focused.name !== 'item') return;
    const q = String(focused.value ?? '').toLowerCase().trim();
    const items = await getDatabase().shopItem.findMany({
      where: { guildId, isActive: true },
      orderBy: { price: 'asc' },
      take: 25,
    });
    const filtered = q
      ? items.filter((i) => i.name.toLowerCase().includes(q))
      : items;
    await interaction.respond(
      filtered.slice(0, 25).map((i) => ({
        name: `${i.name} — ${fmt(i.price)} ₪${i.maxStock > 0 ? ` [${i.currentStock}/${i.maxStock}]` : ''}`.slice(0, 100),
        value: i.id,
      })),
    ).catch(() => {});
  },
};

async function handleList(
  interaction: ChatInputCommandInteraction,
  guildId: string,
  locale: string,
): Promise<void> {
  await renderShopList(interaction, guildId, locale, 1);
}

export async function handleShopListPagination(
  interaction: any,
  page: number,
): Promise<void> {
  const guildId = interaction.guildId!;
  const locale = await getGuildLocale(guildId);
  await renderShopList(interaction, guildId, locale, page);
}

async function renderShopList(
  interaction: any,
  guildId: string,
  locale: string,
  page: number,
): Promise<void> {
  const db = getDatabase();
  const config = await getEcoConfig(guildId);
  const items = await db.shopItem.findMany({
    where: { guildId, isActive: true },
    orderBy: { price: 'asc' },
  });

  const totalPages = Math.ceil(items.length / 5) || 1;
  const targetPage = Math.max(1, Math.min(page, totalPages));
  const startIndex = (targetPage - 1) * 5;
  const pageItems = items.slice(startIndex, startIndex + 5);

  const lines = pageItems.map((item, idx) => {
    const duration = item.durationHours > 0
      ? i18n.t('economy.cmd.shop.embed_duration_hours', locale, { hours: item.durationHours })
      : i18n.t('economy.cmd.shop.embed_duration_permanent', locale);
    const stock = item.maxStock > 0 ? `[${item.currentStock}/${item.maxStock}]` : '';
    const perks = sanitizePerks(item.perks);
    const perksLine = perks ? `\n✨ ${formatPerksInline(perks, locale)}` : '';
    const sellerLine = item.sellerId ? `\n🛍️ ${i18n.t('economy.cmd.shop.embed_by_seller', locale, { user: item.sellerId })}` : '';
    return `**${startIndex + idx + 1}. ${item.name}** — **${fmt(item.price)}** ${duration} ${stock}\n` +
      `<@&${item.roleId}>` +
      (item.description ? `\n> ${item.description}` : '') +
      perksLine +
      sellerLine;
  });

  const safePrice = config?.safePrice ?? SAFE_DEFAULTS.price;
  const lockpickPrice = config?.lockpickPrice ?? LOCKPICK_DEFAULTS.price;
  const maskPrice = MASK_DEFAULTS.price;

  let description = `Страница **${targetPage}** из **${totalPages}**\n\n`;
  if (lines.length > 0) {
    description += `🎭 **Роли в магазине:**\n\n${lines.join('\n\n')}\n\n`;
  } else {
    description += `🎭 *Ролей в продаже пока нет.*\n\n`;
  }

  description += `💼 **Криминальные товары / Общее снаряжение:**\n` +
    `• **Сейф** — **${fmt(safePrice)} ₪**\n` +
    `• **Отмычка** — **${fmt(lockpickPrice)} ₪**\n` +
    `• **Маска с Кармеля** — **${fmt(maskPrice)} ₪**`;

  const embed = new BublikEmbed()
    .setColor(0x9b59b6)
    .setTitle(`${EMOJI.SHOP} ${i18n.t('economy.cmd.shop.embed_title', locale)}`)
    .setDescription(description)
    .setFooter({ text: i18n.t('economy.cmd.shop.embed_footer', locale) });

  const components: any[] = [];

  const selectRow = new ActionRowBuilder<StringSelectMenuBuilder>();
  const select = new StringSelectMenuBuilder()
    .setCustomId('eco:shop:buy_select')
    .setPlaceholder('Выберите товар для покупки...');

  if (pageItems.length > 0) {
    for (const item of pageItems) {
      select.addOptions({
        label: item.name.replace(/[^a-zA-Zа-яА-Я0-9\s()]/g, '').substring(0, 40),
        value: `role:${item.id}`,
        description: `Цена: ${fmt(item.price)} ₪`,
      });
    }
  }

  select.addOptions(
    {
      label: '💼 Сейф (защита банка)',
      value: 'item:safe',
      description: `Цена: ${fmt(safePrice)} ₪`,
    },
    {
      label: '🔒 Отмычка (+шанс к rob)',
      value: 'item:lockpick',
      description: `Цена: ${fmt(lockpickPrice)} ₪`,
    },
    {
      label: '🎭 Маска с Кармеля (скрытность)',
      value: 'item:mask',
      description: `Цена: ${fmt(maskPrice)} ₪`,
    }
  );

  selectRow.addComponents(select);
  components.push(selectRow);

  const btnRow = new ActionRowBuilder<ButtonBuilder>();
  const prevBtn = new ButtonBuilder()
    .setCustomId(`eco:shop:list:${targetPage - 1}`)
    .setLabel('◀️ Назад')
    .setStyle(ButtonStyle.Primary)
    .setDisabled(targetPage <= 1);

  const nextBtn = new ButtonBuilder()
    .setCustomId(`eco:shop:list:${targetPage + 1}`)
    .setLabel('Вперед ▶️')
    .setStyle(ButtonStyle.Primary)
    .setDisabled(targetPage >= totalPages);

  btnRow.addComponents(prevBtn, nextBtn);
  components.push(btnRow);

  if (interaction.isButton?.()) {
    await interaction.update({ embeds: [embed], components });
  } else {
    await interaction.reply({ embeds: [embed], components });
  }
}

async function handleBuy(
  interaction: ChatInputCommandInteraction,
  guildId: string,
  configId: string,
  locale: string,
): Promise<void> {
  const queryRaw = interaction.options.getString('item', true);
  const query = queryRaw.toLowerCase().trim();

  const db = getDatabase();
  const items = await db.shopItem.findMany({
    where: { guildId, isActive: true },
  });

  const item =
    items.find((i) => i.id === queryRaw) ||
    items.find((i) => i.name.toLowerCase() === query) ||
    items.find((i) => i.name.toLowerCase().includes(query));

  if (!item) {
    await interaction.reply({ embeds: [ecoError(i18n.t('economy.cmd.shop.error_item_not_found', locale))], ephemeral: true });
    return;
  }

  await executeBuyRole(interaction, item.id, guildId, locale, false);
}

export async function handleShopBuySelect(interaction: any, value: string): Promise<void> {
  const guildId = interaction.guildId!;
  const userId = interaction.user.id;
  const locale = await getGuildLocale(guildId);
  const config = await getEcoConfig(guildId);

  if (!config?.enabled) {
    await interaction.reply({ embeds: [ecoError(i18n.t('economy.common.error_economy_disabled_short', locale))], ephemeral: true });
    return;
  }
  if (config.shopEnabled === false) {
    await interaction.reply({ embeds: [ecoError(i18n.t('economy.cmd.shop.error_shop_disabled', locale))], ephemeral: true });
    return;
  }

  if (value.startsWith('role:')) {
    const itemId = value.split(':')[1];
    await executeBuyRole(interaction, itemId, guildId, locale, true);
    return;
  }

  if (value === 'item:safe') {
    if (config.safeEnabled === false) {
      await interaction.reply({ embeds: [ecoError(i18n.t('economy.cmd.shop.safe_disabled', locale))], ephemeral: true });
      return;
    }
    const price = config.safePrice ?? SAFE_DEFAULTS.price;
    const durationMs = Number(config.safeDurationMs ?? SAFE_DEFAULTS.durationMs);

    const result = await withFinancialLock(guildId, userId, async () => buySafe(guildId, userId, price, durationMs));
    if (result === null) {
      await interaction.reply({ embeds: [ecoLocked(locale)], ephemeral: true });
      return;
    }
    if (result.type === 'no_money') {
      await interaction.reply({ embeds: [ecoError(i18n.t('economy.cmd.shop.safe_no_money', locale, { price: fmt(result.need) }))], ephemeral: true });
    } else {
      const days = Math.round(durationMs / (24 * 3600_000));
      const embed = new BublikEmbed()
        .setColor(0x3498db)
        .setTitle(`${EMOJI.SAFE} ${i18n.t('economy.cmd.shop.safe_title', locale)}`)
        .setDescription(
          `💼 **Вы приобрели сейф за ${fmt(price)}!**\n\n` +
          `📦 **Предмет добавлен в инвентарь.** Вы можете активировать его в любое время командой \`/inventory\` (действие защиты: ${days} дн.).\n\n` +
          `${EMOJI.WALLET} ${i18n.t('economy.common.embed_wallet', locale, { amount: fmt(result.wallet) })}`,
        );
      await interaction.reply({ embeds: [embed], ephemeral: true });
      log.info(`[${guildId}] ${userId} купил сейф (предмет) за ${price} через селект`);
    }
    return;
  }

  if (value === 'item:lockpick') {
    if (config.lockpickEnabled === false) {
      await interaction.reply({ embeds: [ecoError(i18n.t('economy.cmd.shop.lockpick_disabled', locale))], ephemeral: true });
      return;
    }
    const price = config.lockpickPrice ?? LOCKPICK_DEFAULTS.price;

    const result = await withFinancialLock(guildId, userId, async () => buyLockpick(guildId, userId, price));
    if (result === null) {
      await interaction.reply({ embeds: [ecoLocked(locale)], ephemeral: true });
      return;
    }
    if (result.type === 'no_money') {
      await interaction.reply({ embeds: [ecoError(i18n.t('economy.cmd.shop.lockpick_no_money', locale, { price: fmt(result.need) }))], ephemeral: true });
    } else {
      const embed = new BublikEmbed()
        .setColor(0x2ecc71)
        .setTitle(`${EMOJI.LOCKPICK} ${i18n.t('economy.cmd.shop.lockpick_title', locale)}`)
        .setDescription(
          `🔒 **Вы успешно приобрели отмычку за ${fmt(price)}!**\n\n` +
          `📦 **Предмет добавлен в инвентарь.** Вы можете использовать его для взлома сейфов игроков или продажи на Черном Рынке.\n\n` +
          `${EMOJI.WALLET} ${i18n.t('economy.common.embed_wallet', locale, { amount: fmt(result.wallet) })}`,
        );
      await interaction.reply({ embeds: [embed], ephemeral: true });
      log.info(`[${guildId}] ${userId} купил отмычку (предмет) за ${price} через селект`);
    }
    return;
  }

  if (value === 'item:mask') {
    const price = MASK_DEFAULTS.price;

    const result = await withFinancialLock(guildId, userId, async () => buyMask(guildId, userId, price));
    if (result === null) {
      await interaction.reply({ embeds: [ecoLocked(locale)], ephemeral: true });
      return;
    }
    if (result.type === 'no_money') {
      await interaction.reply({ embeds: [ecoError(`У вас недостаточно шекелей для покупки маски. Нужно ${fmt(result.need)}`)], ephemeral: true });
    } else {
      const embed = new BublikEmbed()
        .setColor(0x34495e)
        .setTitle(`🎭 Кошерная маска приобретена!`)
        .setDescription(
          `Вы приобрели маску-балаклаву с рынка Кармель!\n\n` +
          `📦 **Предмет добавлен в инвентарь.** Вы можете носить его во время краж и грабежей.\n\n` +
          `${EMOJI.WALLET} ${i18n.t('economy.common.embed_wallet', locale, { amount: fmt(result.wallet) })}`,
        );
      await interaction.reply({ embeds: [embed], ephemeral: true });
      log.info(`[${guildId}] ${userId} купил маску (предмет) за ${price} через селект`);
    }
    return;
  }
}

async function executeBuyRole(
  interaction: any,
  itemId: string,
  guildId: string,
  locale: string,
  ephemeral: boolean,
): Promise<void> {
  const userId = interaction.user.id;
  const member = interaction.member as GuildMember;
  const db = getDatabase();

  const item = await db.shopItem.findUnique({
    where: { id: itemId },
  });

  if (!item || item.guildId !== guildId || !item.isActive) {
    await interaction.reply({ embeds: [ecoError(i18n.t('economy.cmd.shop.error_item_not_found', locale))], ephemeral: true });
    return;
  }

  if (item.maxStock > 0 && item.currentStock <= 0) {
    await interaction.reply({ embeds: [ecoError(i18n.t('economy.cmd.shop.error_out_of_stock', locale))], ephemeral: true });
    return;
  }

  let discordRole: Role | null = null;
  if (interaction.guild) {
    try {
      discordRole = await fetchRolePolicySubject(interaction.guild, item.roleId);
    } catch (error) {
      if (!isUnknownRoleError(error)) {
        log.warn(`Temporary Discord role lookup failure for ${item.roleId}`, error as Error);
        await interaction.reply({
          embeds: [ecoError('Не удалось проверить роль в Discord. Покупка не списана; попробуйте ещё раз позже.')],
          ephemeral: true,
        });
        return;
      }
    }
  }
  if (!discordRole) {
    await db.shopItem.updateMany({
      where: { id: item.id, guildId },
      data: { isActive: false },
    });
    await interaction.reply({
      embeds: [ecoError(i18n.t('economy.cmd.shop.error_role_missing', locale, { name: item.name }))],
      ephemeral: true,
    });
    return;
  }

  if (hasDangerousAssignablePermissions(discordRole.permissions)) {
    await db.shopItem.updateMany({
      where: { id: item.id, guildId },
      data: { isActive: false },
    });
    await interaction.reply({
      embeds: [ecoError('У роли товара появились административные или модераторские права. Товар отключён, средства не списаны.')],
      ephemeral: true,
    });
    log.warn(`[${guildId}] Товар ${item.name} (${item.roleId}) деактивирован: опасные права роли`);
    return;
  }

  if (member.roles.cache.has(item.roleId)) {
    await interaction.reply({ embeds: [ecoError(i18n.t('economy.cmd.shop.error_has_role', locale))], ephemeral: true });
    return;
  }

  const result = await withFinancialLock(guildId, userId, async () => {
    try {
      const txResult = await db.$transaction(async (tx) => {
        const existingPurchase = await tx.shopPurchase.findFirst({
          where: {
            guildId,
            userId,
            itemId: item.id,
            OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
          },
          select: { id: true },
        });
        if (existingPurchase) throw new Error('already_owned');

        if (item.maxStock > 0) {
          const stockResult = await tx.shopItem.updateMany({
            where: { id: item.id, currentStock: { gt: 0 } },
            data: { currentStock: { decrement: 1 } },
          });
          if (stockResult.count === 0) throw new Error('out_of_stock');
        }

        const updated = await applyWalletDeltaInTransaction(
          tx,
          guildId,
          userId,
          -item.price,
          TX.SHOP_BUY,
          i18n.t('economy.cmd.shop.tx_buy', locale, { name: item.name }),
          undefined,
          { allowDirtySpend: false },
        );

        const expiresAt = item.durationHours > 0
          ? new Date(Date.now() + item.durationHours * 3600_000)
          : null;

        const purchase = await tx.shopPurchase.create({
          data: {
            guildId,
            userId,
            itemId: item.id,
            price: item.price,
            expiresAt,
          },
        });

        return { wallet: updated.wallet, expiresAt, purchaseId: purchase.id };
      });

      await invalidateProfileCache(guildId, userId);
      return txResult;
    } catch (err: any) {
      if (err?.message === 'no_money' || err?.message === 'insufficient_funds' || err?.message === 'dirty_blocked') return { error: 'no_money' as const };
      if (err?.message === 'out_of_stock') return { error: 'out_of_stock' as const };
      if (err?.message === 'already_owned') return { error: 'already_owned' as const };
      throw err;
    }
  });

  if (result === null) {
    await interaction.reply({ embeds: [ecoLocked(locale)], ephemeral: true });
    return;
  }

  if ('error' in result) {
    const errorMsgs: Record<string, string> = {
      no_money: i18n.t('economy.cmd.shop.error_no_money', locale, { price: fmt(item.price) }),
      out_of_stock: i18n.t('economy.cmd.shop.error_out_of_stock', locale),
      already_owned: i18n.t('economy.cmd.shop.error_has_role', locale),
    };
    await interaction.reply({ embeds: [ecoError(errorMsgs[result.error as string] || i18n.t('economy.cmd.shop.error_purchase_default', locale))], ephemeral: true });
    return;
  }

  try {
    await member.roles.add(item.roleId, i18n.t('economy.cmd.shop.tx_buy', locale, { name: item.name }));
  } catch (err: any) {
    const isUnknownRole = err?.code === 10011 || /Unknown Role/i.test(String(err?.message ?? ''));
    log.error(`Не удалось выдать роль ${item.roleId} для ${userId}`, err);
    if (isUnknownRole) {
      try {
        await db.$transaction(async (tx) => {
          const removed = await tx.shopPurchase.deleteMany({
            where: { id: result.purchaseId, guildId, userId, itemId: item.id },
          });
          if (removed.count !== 1) throw new Error('purchase_rollback_already_done');
          await applyWalletDeltaInTransaction(
            tx,
            guildId,
            userId,
            item.price,
            'shop_role_delivery_refund',
            i18n.t('economy.cmd.shop.tx_refund', locale),
          );
          if (item.maxStock > 0) {
            await tx.shopItem.updateMany({
              where: { id: item.id, guildId },
              data: { currentStock: { increment: 1 } },
            });
          }
        });
        await invalidateProfileCache(guildId, userId);
        await invalidateUserPerks(guildId, userId).catch(() => {});
      } catch (rollbackErr) {
        log.error(`Не удалось атомарно откатить покупку ${result.purchaseId}`, rollbackErr as Error);
      }
      await db.shopItem.update({
        where: { id: item.id },
        data: { isActive: false },
      }).catch(() => {});
      log.warn(`[${guildId}] Товар ${item.name} (${item.roleId}) деактивирован: роль удалена в Discord`);
      await interaction.reply({ embeds: [ecoError(i18n.t('economy.cmd.shop.error_role_missing', locale, { name: item.name }))], ephemeral: true });
    } else {
      await interaction.reply({
        embeds: [ecoError('Выдача роли временно не удалась. Покупка сохранена и будет автоматически доставлена повторно; повторно покупать её не нужно.')],
        ephemeral: true,
      });
    }
    return;
  }

  await invalidateUserPerks(guildId, userId).catch(() => {});

  await payShopCommissionOnce({
    id: result.purchaseId,
    guildId,
    userId,
    price: item.price,
    item,
  }).catch((err) => log.warn(`Не удалось выплатить комиссию продавцу ${item.sellerId}`, err as Error));

  const expiryText = result.expiresAt
    ? `\n⏰ ${i18n.t('economy.cmd.shop.embed_purchase_expires', locale, { timestamp: Math.floor(result.expiresAt.getTime() / 1000) })}`
    : `\n✨ ${i18n.t('economy.cmd.shop.embed_purchase_permanent', locale)}`;

  const embed = new BublikEmbed()
    .setColor(0x2ecc71)
    .setTitle(`${EMOJI.CART} ${i18n.t('economy.cmd.shop.embed_purchase_title', locale)}`)
    .setDescription(
      `${i18n.t('economy.cmd.shop.embed_purchase_text', locale, { roleId: item.roleId, price: fmt(item.price) })}${expiryText}\n\n` +
      `${EMOJI.WALLET} ${i18n.t('economy.common.embed_wallet', locale, { amount: fmt(result.wallet) })}`,
    );

  await interaction.reply({ embeds: [embed], ephemeral });
  log.info(`[${guildId}] ${userId} купил ${item.name} (${item.roleId}) за ${item.price} (ephemeral=${ephemeral})`);
}

// ── add (admin) ──────────────────────────────

async function handleAdd(
  interaction: ChatInputCommandInteraction,
  guildId: string,
  configId: string,
  locale: string,
): Promise<void> {
  const member = interaction.member as GuildMember;
  if (!member.permissions.has(PermissionsBitField.Flags.Administrator)) {
    await interaction.reply({ embeds: [ecoError(i18n.t('economy.cmd.shop.error_admin_only', locale))], ephemeral: true });
    return;
  }

  const role = interaction.options.getRole('role', true) as Role;
  const price = interaction.options.getInteger('price', true);
  const name = interaction.options.getString('name', true);
  const duration = interaction.options.getInteger('duration') ?? 0;
  const description = interaction.options.getString('description') ?? null;
  const stock = interaction.options.getInteger('stock') ?? -1;
  const perksRaw = interaction.options.getString('perks');
  const perks = parsePerksString(perksRaw);

  const policyContext = await loadInteractionRolePolicyContext(interaction).catch(() => null);
  const freshRole = await fetchRolePolicySubject(interaction.guild!, role.id).catch(() => null);
  const roleDecision = policyContext
    ? evaluateRolePolicy(policyContext, freshRole)
    : { ok: false as const, reason: 'wrong_guild' as const };
  if (!roleDecision.ok) {
    await interaction.reply({
      embeds: [ecoError(rolePolicyFailureMessage(roleDecision.reason))],
      ephemeral: true,
    });
    return;
  }
  if (freshRole && hasDangerousAssignablePermissions(freshRole.permissions)) {
    await interaction.reply({
      embeds: [ecoError('Роль с административными или модераторскими правами нельзя продавать в магазине.')],
      ephemeral: true,
    });
    return;
  }

  const db = getDatabase();

  // Проверяем дубликат
  const existing = await db.shopItem.findUnique({
    where: { guildId_roleId: { guildId, roleId: role.id } },
  });
  if (existing) {
    await interaction.reply({ embeds: [ecoError(i18n.t('economy.cmd.shop.error_duplicate_role', locale))], ephemeral: true });
    return;
  }

  await db.shopItem.create({
    data: {
      guildId,
      roleId: role.id,
      name,
      description,
      price,
      durationHours: duration,
      maxStock: stock,
      currentStock: stock,
      configId,
      perks: perks ? (perks as any) : undefined,
    },
  });

  const durationText = duration > 0
    ? i18n.t('economy.cmd.shop.embed_duration_hours', locale, { hours: duration })
    : i18n.t('economy.cmd.shop.embed_duration_permanent', locale);
  const stockText = stock > 0 ? `(${stock} шт.)` : '(безлимит)';

  await interaction.reply({
    embeds: [
      ecoSuccess(
        `${EMOJI.SHOP} ${i18n.t('economy.cmd.shop.embed_add_success', locale)}\n\n` +
        `**${name}** — <@&${role.id}>\n` +
        `${EMOJI.SHEKEL} Цена: **${fmt(price)}**\n` +
        `⏰ ${durationText}\n` +
        `📦 ${stockText}` +
        (perks ? `\n✨ ${formatPerksInline(perks, locale)}` : ''),
      ),
    ],
    ephemeral: true,
  });

  log.info(`[${guildId}] Товар ${name} (${role.id}) добавлен за ${price}`);
}

// ── remove (admin) ───────────────────────────

async function handleRemove(
  interaction: ChatInputCommandInteraction,
  guildId: string,
  locale: string,
): Promise<void> {
  const member = interaction.member as GuildMember;
  if (!member.permissions.has(PermissionsBitField.Flags.Administrator)) {
    await interaction.reply({ embeds: [ecoError(i18n.t('economy.cmd.shop.error_admin_only_short', locale))], ephemeral: true });
    return;
  }

  const query = interaction.options.getString('item', true).toLowerCase();
  const db = getDatabase();

  const items = await db.shopItem.findMany({ where: { guildId } });
  const item = items.find((i) =>
    i.name.toLowerCase() === query ||
    i.id === query ||
    i.name.toLowerCase().includes(query),
  );

  if (!item) {
    await interaction.reply({ embeds: [ecoError(i18n.t('economy.cmd.shop.error_item_not_found', locale))], ephemeral: true });
    return;
  }

  // Собираем владельцев заранее — после delete их перки нужно сбросить
  const ownerRows = await db.shopPurchase.findMany({
    where: { itemId: item.id },
    select: { userId: true },
    distinct: ['userId'],
  });

  // Удаляем связанные покупки перед удалением товара (FK constraint)
  await db.shopPurchase.deleteMany({ where: { itemId: item.id } });
  await db.shopItem.delete({ where: { id: item.id } });

  // Сбрасываем кэш перков у бывших владельцев
  await Promise.all(ownerRows.map((r) => invalidateUserPerks(guildId, r.userId).catch(() => {})));

  await interaction.reply({
    embeds: [ecoSuccess(`${EMOJI.SHOP} ${i18n.t('economy.cmd.shop.embed_remove_success', locale, { name: item.name })}`)],
    ephemeral: true,
  });

  log.info(`[${guildId}] Товар ${item.name} удалён`);
}

// ── safe (Криминал) ──────────────────────────

async function handleSafe(
  interaction: ChatInputCommandInteraction,
  guildId: string,
  locale: string,
  config: any,
): Promise<void> {
  const userId = interaction.user.id;

  if (config.safeEnabled === false) {
    await interaction.reply({ embeds: [ecoError(i18n.t('economy.cmd.shop.safe_disabled', locale))], ephemeral: true });
    return;
  }

  const price = config.safePrice ?? SAFE_DEFAULTS.price;
  const durationMs = Number(config.safeDurationMs ?? SAFE_DEFAULTS.durationMs);

  const result = await withFinancialLock(guildId, userId, async () => {
    return buySafe(guildId, userId, price, durationMs);
  });

  if (result === null) {
    await interaction.reply({ embeds: [ecoLocked(locale)], ephemeral: true });
    return;
  }

  switch (result.type) {
    case 'no_money':
      await interaction.reply({
        embeds: [ecoError(i18n.t('economy.cmd.shop.safe_no_money', locale, { price: fmt(result.need) }))],
        ephemeral: true,
      });
      return;
    case 'ok': {
      const days = Math.round(durationMs / (24 * 3600_000));
      const embed = new BublikEmbed()
        .setColor(0x3498db)
        .setTitle(`${EMOJI.SAFE} ${i18n.t('economy.cmd.shop.safe_title', locale)}`)
        .setDescription(
          `💼 **Вы приобрели сейф за ${fmt(price)}!**\n\n` +
          `📦 **Предмет добавлен в инвентарь.** Вы можете активировать его в любое время командой \`/inventory\` (действие защиты: ${days} дн.).\n\n` +
          `${EMOJI.WALLET} ${i18n.t('economy.common.embed_wallet', locale, { amount: fmt(result.wallet) })}`,
        );
      await interaction.reply({ embeds: [embed] });
      log.info(`[${guildId}] ${userId} купил сейф (предмет) за ${price}`);
      return;
    }
  }
}

// ── lockpick (Криминал) ──────────────────────

async function handleLockpick(
  interaction: ChatInputCommandInteraction,
  guildId: string,
  locale: string,
  config: any,
): Promise<void> {
  const userId = interaction.user.id;

  if (config.lockpickEnabled === false) {
    await interaction.reply({ embeds: [ecoError(i18n.t('economy.cmd.shop.lockpick_disabled', locale))], ephemeral: true });
    return;
  }

  const price = config.lockpickPrice ?? LOCKPICK_DEFAULTS.price;
  const result = await withFinancialLock(guildId, userId, async () => {
    return buyLockpick(guildId, userId, price);
  });

  if (result === null) {
    await interaction.reply({ embeds: [ecoLocked(locale)], ephemeral: true });
    return;
  }

  switch (result.type) {
    case 'no_money':
      await interaction.reply({
        embeds: [ecoError(i18n.t('economy.cmd.shop.lockpick_no_money', locale, { price: fmt(result.need) }))],
        ephemeral: true,
      });
      return;
    case 'ok': {
      const embed = new BublikEmbed()
        .setColor(0x2ecc71)
        .setTitle(`${EMOJI.LOCKPICK} ${i18n.t('economy.cmd.shop.lockpick_title', locale)}`)
        .setDescription(
          `🔒 **Вы успешно приобрели отмычку за ${fmt(price)}!**\n\n` +
          `📦 **Предмет добавлен в инвентарь.** Вы можете использовать его для взлома сейфов игроков или продажи на Черном Рынке.\n\n` +
          `${EMOJI.WALLET} ${i18n.t('economy.common.embed_wallet', locale, { amount: fmt(result.wallet) })}`,
        );
      await interaction.reply({ embeds: [embed] });
      log.info(`[${guildId}] ${userId} купил отмычку (предмет) за ${price}`);
      return;
    }
  }
}

// ── mask (Криминал) ──────────────────────────

async function handleMask(
  interaction: ChatInputCommandInteraction,
  guildId: string,
  locale: string,
  _config: any,
): Promise<void> {
  const userId = interaction.user.id;

  const price = MASK_DEFAULTS.price;

  const result = await withFinancialLock(guildId, userId, async () => {
    return buyMask(guildId, userId, price);
  });

  if (result === null) {
    await interaction.reply({ embeds: [ecoLocked(locale)], ephemeral: true });
    return;
  }

  switch (result.type) {
    case 'no_money':
      await interaction.reply({
        embeds: [ecoError(`У вас недостаточно шекелей для покупки маски. Нужно ${fmt(result.need)}`)],
        ephemeral: true,
      });
      return;
    case 'ok': {
      const embed = new BublikEmbed()
        .setColor(0x34495e)
        .setTitle(`🎭 Кошерная маска приобретена!`)
        .setDescription(
          `Вы приобрели маску-балаклаву с рынка Кармель!\n\n` +
          `📦 **Предмет добавлен в инвентарь.** Вы можете носить его во время краж и грабежей.\n\n` +
          `${EMOJI.WALLET} ${i18n.t('economy.common.embed_wallet', locale, { amount: fmt(result.wallet) })}`,
        );
      await interaction.reply({ embeds: [embed] });
      log.info(`[${guildId}] ${userId} купил маску (предмет) за ${price}`);
      return;
    }
  }
}

export default shopCommand;
