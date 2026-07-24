// ═══════════════════════════════════════════════
//  /market — Маркетплейс ролей от игроков
//
//  Подкоманды:
//  • submit  — предложить свою роль на продажу
//  • my      — мои активные роли + доход
//  • cancel  — отменить ожидающую заявку (с возвратом взноса)
//  • pending — список заявок (Admin)
//  • info    — параметры маркетплейса
//
//  Button-flow:
//  • market:approve:<requestId> → modal → создаём роль + ShopItem
//  • market:reject:<requestId>  → modal с причиной → возврат взноса
// ═══════════════════════════════════════════════

import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  PermissionsBitField,
  ButtonBuilder,
  ButtonStyle,
  ActionRowBuilder,
  ButtonInteraction,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ModalSubmitInteraction,
  TextChannel,
  Role,
  ColorResolvable,
  EmbedBuilder,
} from 'discord.js';
import type { BublikClient } from '../../../bot';
import { BublikCommand, CommandScope } from '../../../types/Command';
import { logger } from '../../../core/Logger';
import { i18n } from '../../../core/I18n';
import { getGuildLocale } from '../../../core/GuildConfig';
import { getDatabase } from '../../../core/Database';
import { BublikEmbed } from '../../../core/EmbedBuilder';
import { getEcoConfig, invalidateProfileCache } from '../database';
import { applyWalletDeltaInTransaction, fmt } from '../profile';
import { ecoError, ecoSuccess } from '../embeds';
import { EMOJI, TX, ECO_PREFIX, ECO_SEP } from '../constants';
import { parsePerksString, formatPerksInline, sanitizePerks, type Perks } from '../perks';
import { getMarketRefundAmount } from '../safety-policy';

const log = logger.child('Economy:Market');

export const MARKET_BTN = `${ECO_PREFIX}${ECO_SEP}market`;

export const marketApproveBtnId = (id: string) => `${MARKET_BTN}${ECO_SEP}approve${ECO_SEP}${id}`;
export const marketRejectBtnId  = (id: string) => `${MARKET_BTN}${ECO_SEP}reject${ECO_SEP}${id}`;
export const marketApproveModalId = (id: string) => `${MARKET_BTN}${ECO_SEP}approve_form${ECO_SEP}${id}`;
export const marketRejectModalId  = (id: string) => `${MARKET_BTN}${ECO_SEP}reject_form${ECO_SEP}${id}`;

// ═══════════════════════════════════════════════
//  Command
// ═══════════════════════════════════════════════

const marketCommand: BublikCommand = {
  data: new SlashCommandBuilder()
    .setName('market')
    .setDescription('Маркетплейс ролей от игроков')
    .setDescriptionLocalizations({ 'en-US': 'Player-driven role marketplace' })
    .setDMPermission(false)

    // ── submit ──
    .addSubcommand((s) =>
      s.setName('submit')
        .setDescription('Предложить свою роль на продажу (требует одобрения админа)')
        .addStringOption((o) => o.setName('name').setDescription('Название товара').setRequired(true).setMaxLength(50))
        .addIntegerOption((o) => o.setName('price').setDescription('Цена в шекелях').setRequired(true).setMinValue(1))
        .addStringOption((o) => o.setName('description').setDescription('Краткое описание').setRequired(false).setMaxLength(200))
        .addIntegerOption((o) => o.setName('duration').setDescription('Длительность роли (часы; 0 = навсегда)').setMinValue(0).setRequired(false))
        .addStringOption((o) =>
          o.setName('perks').setDescription("Перки (напр. robBonus=10,dirtyMul=0.7)").setRequired(false),
        ),
    )

    // ── my ──
    .addSubcommand((s) => s.setName('my').setDescription('Мои активные роли и заработок'))

    // ── cancel ──
    .addSubcommand((s) =>
      s.setName('cancel')
        .setDescription('Отменить мою ожидающую заявку (с возвратом взноса)')
        .addStringOption((o) => o.setName('id').setDescription('Заявка (выбери из подсказок)').setRequired(true).setAutocomplete(true)),
    )

    // ── pending (admin) ──
    .addSubcommand((s) => s.setName('pending').setDescription('Заявки на модерации (Admin)'))

    // ── info ──
    .addSubcommand((s) => s.setName('info').setDescription('Параметры маркетплейса')),

  scope: CommandScope.Guild,
  category: 'economy',
  descriptionKey: 'commands.market.description',

  async execute(interaction: ChatInputCommandInteraction, client: BublikClient): Promise<void> {
    const locale = await getGuildLocale(interaction.guildId);
    const guildId = interaction.guildId!;
    const config = await getEcoConfig(guildId);

    if (!config?.enabled || !config.marketEnabled) {
      await interaction.reply({ embeds: [ecoError(i18n.t('economy.cmd.market.error_disabled', locale))], ephemeral: true });
      return;
    }

    const sub = interaction.options.getSubcommand();
    switch (sub) {
      case 'submit':  await handleSubmit(interaction, client, guildId, locale, config); break;
      case 'my':      await handleMy(interaction, guildId, locale); break;
      case 'cancel':  await handleCancel(interaction, guildId, locale); break;
      case 'pending': await handlePending(interaction, guildId, locale); break;
      case 'info':    await handleInfo(interaction, locale, config); break;
    }
  },

  async autocomplete(interaction): Promise<void> {
    const guildId = interaction.guildId;
    if (!guildId) return;
    const focused = interaction.options.getFocused(true);
    if (focused.name !== 'id') return;
    const q = String(focused.value ?? '').toLowerCase().trim();
    try {
      const reqs = await getDatabase().shopRoleRequest.findMany({
        where: { guildId, sellerId: interaction.user.id, status: 'pending' },
        orderBy: { createdAt: 'desc' },
        take: 25,
      });
      const filtered = q
        ? reqs.filter((r) => r.name.toLowerCase().includes(q) || r.id.startsWith(q))
        : reqs;
      await interaction.respond(
        filtered.slice(0, 25).map((r) => ({
          name: `⏳ ${r.name} — ${fmt(r.proposedPrice)} ₪`.slice(0, 100),
          value: r.id,
        })),
      );
    } catch { /* ignore */ }
  },
};

export default marketCommand;

// ═══════════════════════════════════════════════
//  /market submit
// ═══════════════════════════════════════════════

async function handleSubmit(
  interaction: ChatInputCommandInteraction,
  client: BublikClient,
  guildId: string,
  locale: string,
  config: any,
): Promise<void> {
  const userId = interaction.user.id;
  const name = interaction.options.getString('name', true).trim();
  const price = interaction.options.getInteger('price', true);
  const description = interaction.options.getString('description')?.trim() ?? null;
  const duration = interaction.options.getInteger('duration') ?? 0;
  const perksRaw = interaction.options.getString('perks');
  const perks = parsePerksString(perksRaw);

  // Валидация цены
  if (price < config.marketMinPrice || price > config.marketMaxPrice) {
    await interaction.reply({
      embeds: [ecoError(i18n.t('economy.cmd.market.error_price_range', locale, {
        min: fmt(config.marketMinPrice),
        max: fmt(config.marketMaxPrice),
      }))],
      ephemeral: true,
    });
    return;
  }

  // Валидация имени (не чисто пробелы, не слишком короткое)
  if (name.length < 2) {
    await interaction.reply({ embeds: [ecoError(i18n.t('economy.cmd.market.error_name_short', locale))], ephemeral: true });
    return;
  }

  // Запрет токсичных подстановок (роль не должна выглядеть как @everyone и т.п.)
  if (/^(everyone|here|@everyone|@here)$/i.test(name)) {
    await interaction.reply({ embeds: [ecoError(i18n.t('economy.cmd.market.error_name_forbidden', locale))], ephemeral: true });
    return;
  }

  // Проверка лимита активных + pending у пользователя
  const db = getDatabase();
  const activeRoles = await db.shopItem.count({ where: { guildId, sellerId: userId, isActive: true } });
  const pendingReqs = await db.shopRoleRequest.count({ where: { guildId, sellerId: userId, status: 'pending' } });
  if (activeRoles + pendingReqs >= config.marketMaxPerUser) {
    await interaction.reply({
      embeds: [ecoError(i18n.t('economy.cmd.market.error_limit', locale, { max: config.marketMaxPerUser }))],
      ephemeral: true,
    });
    return;
  }

  const fee = config.marketSubmitFee ?? 5000;
  const commissionPct = config.marketCommissionPct ?? 80;
  const modChannelId = config.marketModChannelId;

  if (!modChannelId) {
    await interaction.reply({ embeds: [ecoError(i18n.t('economy.cmd.market.error_no_mod_channel', locale))], ephemeral: true });
    return;
  }

  // Списание взноса и создание заявки — одна транзакция. Иначе при падении
  // между двумя запросами деньги терялись, а неуспешное списание игнорировалось.
  const detail = i18n.t('economy.cmd.market.tx_fee', locale, { name });
  let request;
  let walletAfterFee = 0;
  try {
    const created = await db.$transaction(async (tx) => {
      const updated = await applyWalletDeltaInTransaction(
        tx,
        guildId,
        userId,
        -fee,
        TX.MARKET_FEE,
        detail,
        undefined,
        { allowDirtySpend: false },
      );
      const roleRequest = await tx.shopRoleRequest.create({
        data: {
          guildId,
          sellerId: userId,
          name,
          description,
          proposedPrice: price,
          durationHours: duration,
          perks: perks ? (perks as any) : undefined,
          feePaid: fee,
          commissionPct,
        },
      });
      return { roleRequest, wallet: updated.wallet };
    });
    request = created.roleRequest;
    walletAfterFee = created.wallet;
    await invalidateProfileCache(guildId, userId);
  } catch (err: any) {
    if (['insufficient_funds', 'dirty_blocked'].includes(String(err?.message ?? ''))) {
      await interaction.reply({
        embeds: [ecoError(i18n.t('economy.cmd.market.error_no_money', locale, { fee: fmt(fee) }))],
        ephemeral: true,
      });
      return;
    }
    log.error('market fee tx failed', err);
    await interaction.reply({ embeds: [ecoError(i18n.t('economy.common.error_generic', locale))], ephemeral: true });
    return;
  }

  // Уведомляем модераторов
  const modChannel = client.channels.cache.get(modChannelId) as TextChannel | undefined;
  if (!modChannel || !modChannel.isTextBased()) {
    log.warn(`[${guildId}] mod channel ${modChannelId} not found`);
  } else {
    try {
      const modEmbed = buildModEmbed(request, interaction.user.tag, locale);
      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId(marketApproveBtnId(request.id)).setStyle(ButtonStyle.Success).setLabel('Approve').setEmoji('✅'),
        new ButtonBuilder().setCustomId(marketRejectBtnId(request.id)).setStyle(ButtonStyle.Danger).setLabel('Reject').setEmoji('❌'),
      );
      const msg = await modChannel.send({ embeds: [modEmbed], components: [row] });
      await db.shopRoleRequest.update({ where: { id: request.id }, data: { modMessageId: msg.id } });
    } catch (err) {
      log.error('failed to post mod embed', err);
    }
  }

  await interaction.reply({
    embeds: [ecoSuccess(
      `${EMOJI.SHOP} ${i18n.t('economy.cmd.market.submit_ok', locale, {
        name,
        price: fmt(price),
        fee: fmt(fee),
        commission: commissionPct,
        wallet: fmt(walletAfterFee),
      })}\n\n` +
      `\`${request.id}\``,
    )],
    ephemeral: true,
  });

  log.info(`[${guildId}] ${userId} submit role "${name}" price=${price} fee=${fee} req=${request.id}`);
}

// ═══════════════════════════════════════════════
//  /market my
// ═══════════════════════════════════════════════

async function handleMy(
  interaction: ChatInputCommandInteraction,
  guildId: string,
  locale: string,
): Promise<void> {
  const userId = interaction.user.id;
  const db = getDatabase();

  const [items, pending, salesAgg] = await Promise.all([
    db.shopItem.findMany({ where: { guildId, sellerId: userId } }),
    db.shopRoleRequest.findMany({ where: { guildId, sellerId: userId, status: 'pending' } }),
    db.economyTransaction.aggregate({
      where: { guildId, userId, type: TX.MARKET_INCOME },
      _sum: { amount: true },
      _count: true,
    }),
  ]);

  const totalIncome = Number(salesAgg._sum.amount ?? 0);
  const salesCount = salesAgg._count ?? 0;

  const lines: string[] = [];

  if (items.length > 0) {
    lines.push(`**${i18n.t('economy.cmd.market.my_active', locale)}** (${items.length})`);
    for (const it of items) {
      const status = it.isActive ? '🟢' : '⚪';
      const perks = sanitizePerks(it.perks);
      const perksLine = perks ? `\n   ✨ ${formatPerksInline(perks, locale)}` : '';
      lines.push(`${status} **${it.name}** — ${fmt(it.price)} ₪ • <@&${it.roleId}>${perksLine}`);
    }
    lines.push('');
  }

  if (pending.length > 0) {
    lines.push(`**${i18n.t('economy.cmd.market.my_pending', locale)}** (${pending.length})`);
    for (const r of pending) {
      lines.push(`⏳ \`${r.id}\` — **${r.name}** ${fmt(r.proposedPrice)} ₪`);
    }
    lines.push('');
  }

  if (lines.length === 0) {
    lines.push(`*${i18n.t('economy.cmd.market.my_empty', locale)}*`);
  }

  lines.push(
    `**${i18n.t('economy.cmd.market.my_income', locale)}**: ${EMOJI.SHEKEL} ${fmt(totalIncome)} ` +
    `(${i18n.t('economy.cmd.market.my_sales', locale, { count: salesCount })})`,
  );

  const embed = new BublikEmbed()
    .setColor(0x9b59b6)
    .setAuthor({
      name: i18n.t('economy.cmd.market.my_title', locale, { user: interaction.user.displayName }),
      iconURL: interaction.user.displayAvatarURL({ size: 64 }),
    })
    .setDescription(lines.join('\n'));

  await interaction.reply({ embeds: [embed], ephemeral: true });
}

// ═══════════════════════════════════════════════
//  /market cancel
// ═══════════════════════════════════════════════

async function handleCancel(
  interaction: ChatInputCommandInteraction,
  guildId: string,
  locale: string,
): Promise<void> {
  const userId = interaction.user.id;
  const id = interaction.options.getString('id', true);
  const db = getDatabase();

  const req = await db.shopRoleRequest.findUnique({ where: { id } });
  if (!req || req.guildId !== guildId) {
    await interaction.reply({ embeds: [ecoError(i18n.t('economy.cmd.market.error_request_not_found', locale))], ephemeral: true });
    return;
  }
  if (req.sellerId !== userId) {
    await interaction.reply({ embeds: [ecoError(i18n.t('economy.cmd.market.error_not_your_request', locale))], ephemeral: true });
    return;
  }
  if (req.status !== 'pending') {
    await interaction.reply({ embeds: [ecoError(i18n.t('economy.cmd.market.error_not_pending', locale))], ephemeral: true });
    return;
  }

  try {
    await db.$transaction(async (tx) => {
      const claimed = await tx.shopRoleRequest.updateMany({
        where: { id, guildId, sellerId: userId, status: 'pending' },
        data: { status: 'cancelled', reviewedAt: new Date() },
      });
      const refund = getMarketRefundAmount(req.feePaid, claimed.count === 1);
      if (claimed.count !== 1) throw new Error('request_already_processed');

      if (refund > 0) {
        await applyWalletDeltaInTransaction(
          tx,
          guildId,
          userId,
          refund,
          TX.MARKET_REFUND,
          i18n.t('economy.cmd.market.tx_refund', locale, { name: req.name }),
        );
      }
    });
    await invalidateProfileCache(guildId, userId);
  } catch (err: any) {
    if (err?.message === 'request_already_processed') {
      await interaction.reply({ embeds: [ecoError(i18n.t('economy.cmd.market.error_not_pending', locale))], ephemeral: true });
      return;
    }
    throw err;
  }

  await interaction.reply({
    embeds: [ecoSuccess(i18n.t('economy.cmd.market.cancel_ok', locale, { name: req.name, fee: fmt(req.feePaid) }))],
    ephemeral: true,
  });
}

// ═══════════════════════════════════════════════
//  /market pending (admin)
// ═══════════════════════════════════════════════

async function handlePending(
  interaction: ChatInputCommandInteraction,
  guildId: string,
  locale: string,
): Promise<void> {
  const member = interaction.member as any;
  if (!member?.permissions?.has?.(PermissionsBitField.Flags.Administrator)) {
    await interaction.reply({ embeds: [ecoError(i18n.t('economy.cmd.shop.error_admin_only_short', locale))], ephemeral: true });
    return;
  }
  const db = getDatabase();
  const pending = await db.shopRoleRequest.findMany({
    where: { guildId, status: 'pending' },
    orderBy: { createdAt: 'asc' },
    take: 25,
  });

  if (pending.length === 0) {
    await interaction.reply({ embeds: [ecoSuccess(i18n.t('economy.cmd.market.pending_empty', locale))], ephemeral: true });
    return;
  }

  const lines = pending.map((r) => {
    const perks = sanitizePerks(r.perks);
    const perkLine = perks ? `\n   ✨ ${formatPerksInline(perks, locale)}` : '';
    return `\`${r.id}\` — <@${r.sellerId}> • **${r.name}** ${fmt(r.proposedPrice)} ₪${perkLine}`;
  });

  const embed = new BublikEmbed()
    .setColor(0xf39c12)
    .setTitle(`${EMOJI.SHOP} ${i18n.t('economy.cmd.market.pending_title', locale)} (${pending.length})`)
    .setDescription(lines.join('\n\n'));

  await interaction.reply({ embeds: [embed], ephemeral: true });
}

// ═══════════════════════════════════════════════
//  /market info
// ═══════════════════════════════════════════════

async function handleInfo(
  interaction: ChatInputCommandInteraction,
  locale: string,
  config: any,
): Promise<void> {
  const fee = config.marketSubmitFee ?? 5000;
  const commission = config.marketCommissionPct ?? 80;
  const max = config.marketMaxPerUser ?? 3;
  const minP = config.marketMinPrice ?? 1000;
  const maxP = config.marketMaxPrice ?? 500000;
  const modCh = config.marketModChannelId ? `<#${config.marketModChannelId}>` : '—';

  await interaction.reply({
    embeds: [
      new BublikEmbed()
        .setColor(0x9b59b6)
        .setTitle(`${EMOJI.SHOP} ${i18n.t('economy.cmd.market.info_title', locale)}`)
        .setDescription(
          i18n.t('economy.cmd.market.info_body', locale, {
            fee: fmt(fee), commission, max, minP: fmt(minP), maxP: fmt(maxP), modCh,
          }),
        ),
    ],
    ephemeral: true,
  });
}

// ═══════════════════════════════════════════════
//  Button handlers (вызываются из economy/index.ts)
// ═══════════════════════════════════════════════

export async function handleApproveButton(interaction: ButtonInteraction, requestId: string): Promise<void> {
  if (!interaction.memberPermissions?.has(PermissionsBitField.Flags.Administrator)) {
    await interaction.reply({ content: '❌ Только администратор.', ephemeral: true });
    return;
  }
  const db = getDatabase();
  const req = await db.shopRoleRequest.findUnique({ where: { id: requestId } });
  if (!req || req.guildId !== interaction.guildId || req.status !== 'pending') {
    await interaction.reply({ content: '❌ Заявка не найдена или уже обработана.', ephemeral: true });
    return;
  }

  const modal = new ModalBuilder()
    .setCustomId(marketApproveModalId(requestId))
    .setTitle(`Approve: ${req.name}`.slice(0, 45))
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId('color')
          .setLabel('Цвет роли (HEX, напр. #ff8800)')
          .setStyle(TextInputStyle.Short)
          .setRequired(false)
          .setMaxLength(7)
          .setPlaceholder('#9b59b6'),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId('note')
          .setLabel('Комментарий (опционально)')
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(false)
          .setMaxLength(200),
      ),
    );

  await interaction.showModal(modal);
}

export async function handleRejectButton(interaction: ButtonInteraction, requestId: string): Promise<void> {
  if (!interaction.memberPermissions?.has(PermissionsBitField.Flags.Administrator)) {
    await interaction.reply({ content: '❌ Только администратор.', ephemeral: true });
    return;
  }
  const db = getDatabase();
  const req = await db.shopRoleRequest.findUnique({ where: { id: requestId } });
  if (!req || req.guildId !== interaction.guildId || req.status !== 'pending') {
    await interaction.reply({ content: '❌ Заявка не найдена или уже обработана.', ephemeral: true });
    return;
  }

  const modal = new ModalBuilder()
    .setCustomId(marketRejectModalId(requestId))
    .setTitle(`Reject: ${req.name}`.slice(0, 45))
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId('reason')
          .setLabel('Причина отказа (увидит автор)')
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(true)
          .setMaxLength(300),
      ),
    );

  await interaction.showModal(modal);
}

// ═══════════════════════════════════════════════
//  Modal submit handlers
// ═══════════════════════════════════════════════

export async function handleApproveModalSubmit(
  interaction: ModalSubmitInteraction,
  requestId: string,
  client: BublikClient,
): Promise<void> {
  await interaction.deferReply({ ephemeral: true });

  if (!interaction.memberPermissions?.has(PermissionsBitField.Flags.Administrator)) {
    await interaction.editReply({ content: '❌ Только администратор.' });
    return;
  }

  const db = getDatabase();
  const req = await db.shopRoleRequest.findUnique({ where: { id: requestId } });
  if (!req || req.guildId !== interaction.guildId || req.status !== 'pending') {
    await interaction.editReply({ content: '❌ Заявка уже обработана.' });
    return;
  }
  const guild = client.guilds.cache.get(req.guildId);
  if (!guild) {
    await interaction.editReply({ content: '❌ Гильдия не найдена.' });
    return;
  }

  const config = await getEcoConfig(req.guildId);
  if (!config) {
    await interaction.editReply({ content: '❌ Конфиг не найден.' });
    return;
  }

  // Проверка прав бота
  const me = guild.members.me;
  if (!me?.permissions.has(PermissionsBitField.Flags.ManageRoles)) {
    await interaction.editReply({ content: '❌ У бота нет права **Управление ролями** — выдайте и попробуйте снова.' });
    return;
  }

  const colorRaw = interaction.fields.getTextInputValue('color').trim();
  const note = interaction.fields.getTextInputValue('note').trim() || null;

  const color = parseColor(colorRaw);

  // Забираем заявку себе до любых внешних side-effect. Второй modal submit
  // больше не сможет создать ещё одну Discord-роль.
  const claimed = await db.shopRoleRequest.updateMany({
    where: { id: requestId, guildId: req.guildId, status: 'pending' },
    data: {
      status: 'approving',
      reviewerId: interaction.user.id,
      reviewNote: note,
      reviewedAt: new Date(),
    },
  });
  if (claimed.count !== 1) {
    await interaction.editReply({ content: '❌ Заявка уже обрабатывается.' });
    return;
  }

  const releaseClaim = async () => {
    await db.shopRoleRequest.updateMany({
      where: { id: requestId, status: 'approving', reviewerId: interaction.user.id },
      data: {
        status: 'pending',
        reviewerId: null,
        reviewNote: null,
        reviewedAt: null,
        createdRoleId: null,
        itemId: null,
      },
    }).catch(() => null);
  };

  // 1. Создаём роль
  let role: Role;
  try {
    role = await guild.roles.create({
      name: req.name.slice(0, 100),
      color: color as ColorResolvable,
      mentionable: false,
      hoist: false,
      reason: `Marketplace role: ${req.name} by ${req.sellerId}`,
    });
  } catch (err: any) {
    log.error(`approve: cannot create role`, err);
    await releaseClaim();
    await interaction.editReply({ content: `❌ Не удалось создать роль: \`${err?.message ?? err}\`` });
    return;
  }

  // 2. Создаём ShopItem
  // Persist the Discord side effect before creating the shop item. Recovery can
  // now finish this request after a restart without creating a duplicate role.
  const persistedRole = await db.shopRoleRequest.updateMany({
    where: { id: requestId, status: 'approving', reviewerId: interaction.user.id },
    data: { createdRoleId: role.id },
  }).catch((err) => {
    log.error('approve: cannot persist created role id', err);
    return null;
  });
  if (!persistedRole || persistedRole.count !== 1) {
    await role.delete('rollback: marketplace approval claim was lost').catch(() => {});
    await releaseClaim();
    await interaction.editReply({ content: '❌ Не удалось зафиксировать созданную роль, операция безопасно отменена.' });
    return;
  }

  let item;
  try {
    item = await db.$transaction(async (tx) => {
      const createdItem = await tx.shopItem.create({
        data: {
          guildId: req.guildId,
          roleId: role.id,
          name: req.name,
          description: req.description,
          price: req.proposedPrice,
          durationHours: req.durationHours,
          configId: config.id,
          perks: req.perks ?? undefined,
          sellerId: req.sellerId,
          commissionPct: req.commissionPct,
        },
      });
      const finalized = await tx.shopRoleRequest.updateMany({
        where: { id: requestId, status: 'approving', reviewerId: interaction.user.id },
        data: {
          status: 'approved',
          reviewNote: note,
          createdRoleId: role.id,
          itemId: createdItem.id,
          reviewedAt: new Date(),
        },
      });
      if (finalized.count !== 1) throw new Error('approval_claim_lost');
      return createdItem;
    });
  } catch (err) {
    log.error('approve: cannot create ShopItem (rolling back role)', err);
    await role.delete('rollback: shop item creation failed').catch(() => {});
    await releaseClaim();
    await interaction.editReply({ content: '❌ Не удалось создать товар, роль откатана.' });
    return;
  }

  // 4. Обновляем embed модерации
  if (req.modMessageId && config.marketModChannelId) {
    await editModMessage(client, config.marketModChannelId, req.modMessageId, (e) =>
      e.setColor(0x2ecc71).setTitle(`${EMOJI.SUCCESS} APPROVED — ${req.name}`)
       .setFooter({ text: `Approved by ${interaction.user.tag}${note ? ` • ${note}` : ''}` }),
    );
  }

  // 5. DM продавцу (best-effort)
  try {
    const seller = await client.users.fetch(req.sellerId);
    await seller.send(
      `✅ Твоя роль **${req.name}** одобрена и появилась в \`/shop list\` сервера **${guild.name}**!\n` +
      `Цена: ${fmt(req.proposedPrice)} ₪ • Твоя комиссия с продажи: **${req.commissionPct}%**`,
    );
  } catch { /* DMs closed — ignore */ }

  await interaction.editReply({
    content: `✅ Роль <@&${role.id}> создана, товар **${req.name}** добавлен в магазин.`,
  });

  log.info(`[${req.guildId}] approved request ${requestId} → role ${role.id} item ${item.id} by ${interaction.user.id}`);
}

export async function handleRejectModalSubmit(
  interaction: ModalSubmitInteraction,
  requestId: string,
  client: BublikClient,
): Promise<void> {
  await interaction.deferReply({ ephemeral: true });

  if (!interaction.memberPermissions?.has(PermissionsBitField.Flags.Administrator)) {
    await interaction.editReply({ content: '❌ Только администратор.' });
    return;
  }

  const db = getDatabase();
  const req = await db.shopRoleRequest.findUnique({ where: { id: requestId } });
  if (!req || req.guildId !== interaction.guildId || req.status !== 'pending') {
    await interaction.editReply({ content: '❌ Заявка уже обработана.' });
    return;
  }

  const reason = interaction.fields.getTextInputValue('reason').trim();
  const config = await getEcoConfig(req.guildId);

  try {
    await db.$transaction(async (tx) => {
      const claimed = await tx.shopRoleRequest.updateMany({
        where: { id: requestId, guildId: req.guildId, status: 'pending' },
        data: {
          status: 'rejected',
          reviewerId: interaction.user.id,
          reviewNote: reason,
          reviewedAt: new Date(),
        },
      });
      const refund = getMarketRefundAmount(req.feePaid, claimed.count === 1);
      if (claimed.count !== 1) throw new Error('request_already_processed');

      if (refund > 0) {
        await applyWalletDeltaInTransaction(
          tx,
          req.guildId,
          req.sellerId,
          refund,
          TX.MARKET_REFUND,
          `refund ${req.name}: ${reason.slice(0, 80)}`,
        );
      }
    });
    await invalidateProfileCache(req.guildId, req.sellerId);
  } catch (err: any) {
    if (err?.message === 'request_already_processed') {
      await interaction.editReply({ content: '❌ Заявка уже обработана.' });
      return;
    }
    log.error('market reject transaction failed', err);
    await interaction.editReply({ content: '❌ Не удалось отклонить заявку: состояние не изменено.' });
    return;
  }

  if (req.modMessageId && config?.marketModChannelId) {
    await editModMessage(client, config.marketModChannelId, req.modMessageId, (e) =>
      e.setColor(0xe74c3c).setTitle(`${EMOJI.ERROR} REJECTED — ${req.name}`)
       .setFooter({ text: `Rejected by ${interaction.user.tag} • ${reason.slice(0, 100)}` }),
    );
  }

  // DM
  try {
    const guild = client.guilds.cache.get(req.guildId);
    const seller = await client.users.fetch(req.sellerId);
    await seller.send(
      `❌ Заявка на роль **${req.name}** отклонена на сервере **${guild?.name ?? req.guildId}**.\n` +
      `Причина: *${reason}*\n` +
      `Взнос ${fmt(req.feePaid)} ₪ возвращён.`,
    );
  } catch { /* ignore */ }

  await interaction.editReply({ content: `❌ Заявка отклонена, взнос ${fmt(req.feePaid)} ₪ возвращён.` });
  log.info(`[${req.guildId}] rejected request ${requestId} by ${interaction.user.id}`);
}

// ═══════════════════════════════════════════════
//  Helpers
// ═══════════════════════════════════════════════

function buildModEmbed(req: any, sellerTag: string, locale: string): BublikEmbed {
  const perks: Perks | null = sanitizePerks(req.perks);
  return new BublikEmbed()
    .setColor(0xf39c12)
    .setTitle(`${EMOJI.SHOP} ${i18n.t('economy.cmd.market.mod_title', locale)}`)
    .setDescription(
      `**${req.name}**\n` +
      (req.description ? `> ${req.description}\n` : '') +
      `\n${EMOJI.SHEKEL} **${fmt(req.proposedPrice)} ₪**` +
      `${req.durationHours > 0 ? ` • ⏰ ${req.durationHours}ч` : ' • ✨ навсегда'}` +
      `\n👤 <@${req.sellerId}> (\`${sellerTag}\`)` +
      (perks ? `\n✨ ${formatPerksInline(perks, locale)}` : '') +
      `\n🪙 Взнос: ${fmt(req.feePaid)} • Комиссия продавцу: **${req.commissionPct}%**` +
      `\n\`${req.id}\``,
    );
}

async function editModMessage(
  client: BublikClient,
  channelId: string,
  messageId: string,
  build: (e: BublikEmbed) => BublikEmbed,
): Promise<void> {
  try {
    const ch = client.channels.cache.get(channelId) as TextChannel | undefined;
    if (!ch?.isTextBased()) return;
    const msg = await ch.messages.fetch(messageId).catch(() => null);
    if (!msg) return;
    const base = msg.embeds[0]
      ? (EmbedBuilder.from(msg.embeds[0]) as unknown as BublikEmbed)
      : new BublikEmbed();
    await msg.edit({ embeds: [build(base)], components: [] });
  } catch (err) {
    log.warn('failed to edit mod message', err as Error);
  }
}

function parseColor(raw: string): number {
  const cleaned = raw.replace('#', '').trim();
  if (/^[0-9a-fA-F]{6}$/.test(cleaned)) return parseInt(cleaned, 16);
  // случайный дружелюбный цвет если пусто/некорректно
  const palette = [0x9b59b6, 0x3498db, 0xe67e22, 0xe91e63, 0x1abc9c, 0xf1c40f, 0x95a5a6, 0x2ecc71];
  return palette[Math.floor(Math.random() * palette.length)];
}
