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
} from 'discord.js';
import type { BublikClient } from '../../../bot';
import { BublikCommand, CommandScope } from '../../../types/Command';
import { logger } from '../../../core/Logger';
import { getDatabase } from '../../../core/Database';
import { getEcoConfig, getOrCreateProfile, invalidateProfileCache } from '../database';
import { addToWallet, withFinancialLock, fmt } from '../profile';
import { BublikEmbed } from '../../../core/EmbedBuilder';
import { ecoError, ecoSuccess, ecoLocked } from '../embeds';
import { EMOJI, TX, CURRENCY } from '../constants';

const log = logger.child('Economy:Shop');

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
            .setDescription('Название или ID товара')
            .setRequired(true),
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
            .setDescription('Название или ID товара')
            .setRequired(true),
        ),
    ),

  scope: CommandScope.Guild,
  category: 'economy',
  descriptionKey: 'commands.shop.description',

  async execute(interaction: ChatInputCommandInteraction, client: BublikClient): Promise<void> {
    const sub = interaction.options.getSubcommand();
    const guildId = interaction.guildId!;

    const config = await getEcoConfig(guildId);
    if (!config?.enabled) {
      await interaction.reply({ embeds: [ecoError('Экономика отключена.')], ephemeral: true });
      return;
    }
    if (config.shopEnabled === false) {
      await interaction.reply({ embeds: [ecoError('Магазин отключён на этом сервере.')], ephemeral: true });
      return;
    }

    switch (sub) {
      case 'list':
        await handleList(interaction, guildId);
        break;
      case 'buy':
        await handleBuy(interaction, guildId, config.id);
        break;
      case 'add':
        await handleAdd(interaction, guildId, config.id);
        break;
      case 'remove':
        await handleRemove(interaction, guildId);
        break;
    }
  },
};

// ── list ──────────────────────────────────────

async function handleList(
  interaction: ChatInputCommandInteraction,
  guildId: string,
): Promise<void> {
  const db = getDatabase();
  const items = await db.shopItem.findMany({
    where: { guildId, isActive: true },
    orderBy: { price: 'asc' },
  });

  if (items.length === 0) {
    await interaction.reply({
      embeds: [ecoError('Магазин пуст. Администратор может добавить товары через `/shop add`.')],
      ephemeral: true,
    });
    return;
  }

  const lines = items.map((item, idx) => {
    const duration = item.durationHours > 0 ? `(${item.durationHours}ч)` : '(навсегда)';
    const stock = item.maxStock > 0 ? `[${item.currentStock}/${item.maxStock}]` : '';
    return `**${idx + 1}.** <@&${item.roleId}> — **${fmt(item.price)}** ${duration} ${stock}\n${item.description ? `> ${item.description}` : ''}`;
  });

  const embed = new BublikEmbed()
    .setColor(0x9b59b6)
    .setTitle(`${EMOJI.SHOP} Магазин ролей`)
    .setDescription(lines.join('\n\n'))
    .setFooter({ text: 'Купить: /shop buy <название>' });

  await interaction.reply({ embeds: [embed] });
}

// ── buy ──────────────────────────────────────

async function handleBuy(
  interaction: ChatInputCommandInteraction,
  guildId: string,
  configId: string,
): Promise<void> {
  const userId = interaction.user.id;
  const member = interaction.member as GuildMember;
  const query = interaction.options.getString('item', true).toLowerCase();

  const db = getDatabase();

  // Поиск товара по имени или ID
  const items = await db.shopItem.findMany({
    where: { guildId, isActive: true },
  });

  const item = items.find((i) =>
    i.name.toLowerCase() === query ||
    i.id === query ||
    i.name.toLowerCase().includes(query),
  );

  if (!item) {
    await interaction.reply({ embeds: [ecoError('Товар не найден.')], ephemeral: true });
    return;
  }

  // Проверяем сток
  if (item.maxStock > 0 && item.currentStock <= 0) {
    await interaction.reply({ embeds: [ecoError('Товар закончился.')], ephemeral: true });
    return;
  }

  // Проверяем, нет ли уже этой роли
  if (member.roles.cache.has(item.roleId)) {
    await interaction.reply({ embeds: [ecoError('У вас уже есть эта роль.')], ephemeral: true });
    return;
  }

  const result = await withFinancialLock(guildId, userId, async () => {
    const profile = await getOrCreateProfile(guildId, userId);
    if (profile.wallet < item.price) return { error: 'no_money' as const };

    // Списываем деньги
    const walletResult = await addToWallet(guildId, userId, -item.price, TX.SHOP_BUY, `Покупка: ${item.name}`);
    if (!walletResult.success) return { error: 'no_money' as const };

    // Уменьшаем сток
    if (item.maxStock > 0) {
      await db.shopItem.update({
        where: { id: item.id },
        data: { currentStock: { decrement: 1 } },
      });
    }

    // Записываем покупку
    const expiresAt = item.durationHours > 0
      ? new Date(Date.now() + item.durationHours * 3600_000)
      : null;

    await db.shopPurchase.create({
      data: {
        guildId,
        userId,
        itemId: item.id,
        price: item.price,
        expiresAt,
      },
    });

    return { wallet: walletResult.wallet, expiresAt };
  });

  if (result === null) {
    await interaction.reply({ embeds: [ecoLocked()], ephemeral: true });
    return;
  }

  if ('error' in result) {
    await interaction.reply({ embeds: [ecoError(`Недостаточно шекелей. Нужно: ${fmt(item.price)}.`)], ephemeral: true });
    return;
  }

  // Выдаём роль
  try {
    await member.roles.add(item.roleId, `Покупка в магазине: ${item.name}`);
  } catch (err) {
    log.error(`Не удалось выдать роль ${item.roleId} для ${userId}`, err);
    // Возвращаем деньги
    await addToWallet(guildId, userId, item.price, TX.SHOP_BUY, `Возврат: не удалось выдать роль`);
    await interaction.reply({ embeds: [ecoError('Не удалось выдать роль. Шекели возвращены.')], ephemeral: true });
    return;
  }

  const expiryText = result.expiresAt
    ? `\n⏰ Истекает: <t:${Math.floor(result.expiresAt.getTime() / 1000)}:R>`
    : '\n✨ Навсегда';

  const embed = new BublikEmbed()
    .setColor(0x2ecc71)
    .setTitle(`${EMOJI.CART} Покупка успешна!`)
    .setDescription(
      `Вы купили <@&${item.roleId}> за **${fmt(item.price)}**${expiryText}\n\n` +
      `${EMOJI.WALLET} Кошелёк: **${fmt(result.wallet)}**`,
    );

  await interaction.reply({ embeds: [embed] });
  log.info(`[${guildId}] ${userId} купил ${item.name} (${item.roleId}) за ${item.price}`);
}

// ── add (admin) ──────────────────────────────

async function handleAdd(
  interaction: ChatInputCommandInteraction,
  guildId: string,
  configId: string,
): Promise<void> {
  const member = interaction.member as GuildMember;
  if (!member.permissions.has(PermissionsBitField.Flags.Administrator)) {
    await interaction.reply({ embeds: [ecoError('Только администраторы могут добавлять товары.')], ephemeral: true });
    return;
  }

  const role = interaction.options.getRole('role', true) as Role;
  const price = interaction.options.getInteger('price', true);
  const name = interaction.options.getString('name', true);
  const duration = interaction.options.getInteger('duration') ?? 0;
  const description = interaction.options.getString('description') ?? null;
  const stock = interaction.options.getInteger('stock') ?? -1;

  const db = getDatabase();

  // Проверяем дубликат
  const existing = await db.shopItem.findUnique({
    where: { guildId_roleId: { guildId, roleId: role.id } },
  });
  if (existing) {
    await interaction.reply({ embeds: [ecoError('Эта роль уже в магазине.')], ephemeral: true });
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
    },
  });

  const durationText = duration > 0 ? `${duration}ч` : 'навсегда';
  const stockText = stock > 0 ? `(${stock} шт.)` : '(безлимит)';

  await interaction.reply({
    embeds: [
      ecoSuccess(
        `${EMOJI.SHOP} Товар добавлен:\n\n` +
        `**${name}** — <@&${role.id}>\n` +
        `${EMOJI.SHEKEL} Цена: **${fmt(price)}**\n` +
        `⏰ Длительность: ${durationText}\n` +
        `📦 Запас: ${stockText}`,
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
): Promise<void> {
  const member = interaction.member as GuildMember;
  if (!member.permissions.has(PermissionsBitField.Flags.Administrator)) {
    await interaction.reply({ embeds: [ecoError('Только администраторы.')], ephemeral: true });
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
    await interaction.reply({ embeds: [ecoError('Товар не найден.')], ephemeral: true });
    return;
  }

  await db.shopItem.delete({ where: { id: item.id } });

  await interaction.reply({
    embeds: [ecoSuccess(`${EMOJI.SHOP} Товар **${item.name}** удалён из магазина.`)],
    ephemeral: true,
  });

  log.info(`[${guildId}] Товар ${item.name} удалён`);
}

export default shopCommand;
