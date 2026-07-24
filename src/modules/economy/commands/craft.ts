import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  ActionRowBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ModalSubmitInteraction,
  MessageFlags,
  EmbedBuilder,
  PermissionsBitField,
} from 'discord.js';
import type { CustomItemRequest, Prisma } from '@prisma/client';
import type { BublikClient } from '../../../bot';
import { BublikCommand, CommandScope } from '../../../types/Command';
import { getGuildLocale } from '../../../core/GuildConfig';
import { getDatabase } from '../../../core/Database';
import { getEcoConfig, invalidateProfileCache } from '../database';
import {
  applyWalletDeltaInTransaction,
  claimOperationInTransaction,
  withFinancialLock,
  fmt,
} from '../profile';
import { addInventoryItem } from '../inventory';
import { BublikEmbed } from '../../../core/EmbedBuilder';
import { ecoError, ecoLocked } from '../embeds';
import { craftPublishIntentKey, publishPendingCraftRequest } from '../craft-recovery';

export const CRAFT_BTN = 'eco:craft';

export const craftApproveBtnId = (id: string) => `${CRAFT_BTN}:approve:${id}`;
export const craftRejectBtnId  = (id: string) => `${CRAFT_BTN}:reject:${id}`;
export const craftRejectModalId  = (id: string) => `${CRAFT_BTN}:reject_form:${id}`;

interface CompletedCraftCreateClaim {
  version: 1;
  state: 'completed';
  interactionId: string;
  guildId: string;
  userId: string;
  requestId: string;
}

export function craftCreateClaimKey(guildId: string, interactionId: string): string {
  return `economy:craft-create:${guildId}:${interactionId}`;
}

export function parseCompletedCraftCreateClaim(value: unknown): CompletedCraftCreateClaim | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const claim = value as Partial<CompletedCraftCreateClaim>;
  if (
    claim.version !== 1
    || claim.state !== 'completed'
    || typeof claim.interactionId !== 'string'
    || typeof claim.guildId !== 'string'
    || typeof claim.userId !== 'string'
    || typeof claim.requestId !== 'string'
  ) return null;
  return claim as CompletedCraftCreateClaim;
}

async function loadClaimedCraftRequest(
  tx: Prisma.TransactionClient,
  claimKey: string,
  interactionId: string,
  guildId: string,
  userId: string,
): Promise<CustomItemRequest> {
  const claim = await tx.operationClaim.findUnique({ where: { key: claimKey } });
  const metadata = parseCompletedCraftCreateClaim(claim?.metadata);
  if (
    !claim
    || claim.scope !== 'craft_create'
    || claim.guildId !== guildId
    || claim.userId !== userId
    || !metadata
    || metadata.interactionId !== interactionId
    || metadata.guildId !== guildId
    || metadata.userId !== userId
  ) throw new Error('craft_create_claim_corrupt');
  const request = await tx.customItemRequest.findUnique({ where: { id: metadata.requestId } });
  if (!request || request.guildId !== guildId || request.creatorId !== userId) {
    throw new Error('craft_create_claim_corrupt');
  }
  return request;
}

const craftCommand: BublikCommand = {
  data: new SlashCommandBuilder()
    .setName('craft')
    .setDescription('Мастерская: подать заявку на крафт кастомного предмета')
    .addStringOption((opt) =>
      opt.setName('name').setDescription('Название предмета (до 50 симв.)').setRequired(true).setMaxLength(50),
    )
    .addStringOption((opt) =>
      opt.setName('description').setDescription('Описание предмета (до 200 симв.)').setRequired(true).setMaxLength(200),
    )
    .addStringOption((opt) =>
      opt
        .setName('perk')
        .setDescription('Характеристика предмета')
        .setRequired(false)
        .addChoices(
          { name: '🎯 Бонус к /rob (успех ограблений в %)', value: 'robBonus' },
          { name: '🔫 Бонус к /crime (успех криминала в %)', value: 'crimeBonus' },
          { name: '🛡️ Защита от /rob (снижение шанса в %)', value: 'robDefense' },
          { name: '⏱️ Сгорание звёзд розыска (быстрее на %)', value: 'wantedDecayMul' },
          { name: '🧼 Меньше грязных денег (чище на %)', value: 'dirtyMul' },
          { name: '⚡ Уменьшение кулдаунов (быстрее на %)', value: 'cooldownMul' },
        ),
    )
    .addIntegerOption((opt) =>
      opt
        .setName('value')
        .setDescription('Значение характеристики (в процентах)')
        .setRequired(false)
        .setMinValue(1)
        .setMaxValue(90),
    ),

  scope: CommandScope.Guild,
  category: 'economy',
  descriptionKey: 'commands.craft.description',

  async execute(interaction: ChatInputCommandInteraction, client: BublikClient): Promise<void> {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const guildId = interaction.guildId!;
    const userId = interaction.user.id;
    const locale = await getGuildLocale(guildId);

    const name = interaction.options.getString('name', true).trim();
    const description = interaction.options.getString('description', true).trim();
    const perk = interaction.options.getString('perk');
    const value = interaction.options.getInteger('value');

    const config = await getEcoConfig(guildId);
    if (!config?.marketModChannelId) {
      await interaction.editReply({
        embeds: [ecoError('Крафтовая мастерская закрыта! Администраторы сервера не настроили канал модерации предметов.')],
      });
      return;
    }

    // Проверяем валидность ввода характеристик
    if (perk && (!value || value <= 0)) {
      await interaction.editReply({
        embeds: [ecoError('Вы выбрали характеристику, но не указали её значение! Укажите положительное число.')],
      });
      return;
    }

    const price = calculateCraftPrice(perk, value);
    const perksJson = getPerksJson(perk, value);

    const result = await withFinancialLock(guildId, userId, async () => {
      const db = getDatabase();
      try {
        const creation = await db.$transaction(async (tx) => {
          const claimKey = craftCreateClaimKey(guildId, interaction.id);
          const existingClaim = await tx.operationClaim.findUnique({ where: { key: claimKey } });
          if (existingClaim) {
            return {
              request: await loadClaimedCraftRequest(
                tx,
                claimKey,
                interaction.id,
                guildId,
                userId,
              ),
              duplicate: true,
            };
          }

          const claimed = await claimOperationInTransaction(
            tx,
            claimKey,
            'craft_create',
            guildId,
            userId,
            {
              version: 1,
              state: 'creating',
              interactionId: interaction.id,
              guildId,
              userId,
            },
          );
          if (!claimed) {
            return {
              request: await loadClaimedCraftRequest(
                tx,
                claimKey,
                interaction.id,
                guildId,
                userId,
              ),
              duplicate: true,
            };
          }

          await applyWalletDeltaInTransaction(
            tx,
            guildId,
            userId,
            -price,
            'craft_reserve',
            `Craft request: ${name}`,
            undefined,
            { allowDirtySpend: false },
          );

          const request = await tx.customItemRequest.create({
            data: {
              guildId,
              creatorId: userId,
              name,
              description,
              perks: perksJson || undefined,
              feePaid: price,
              status: 'pending'
            },
          });
          const completed: CompletedCraftCreateClaim = {
            version: 1,
            state: 'completed',
            interactionId: interaction.id,
            guildId,
            userId,
            requestId: request.id,
          };
          await tx.operationClaim.update({
            where: { key: claimKey },
            data: { metadata: completed as unknown as Prisma.InputJsonValue },
          });
          return { request, duplicate: false };
        });

        if (!creation.duplicate) await invalidateProfileCache(guildId, userId);
        return { success: true as const, ...creation };
      } catch (err: any) {
        if (err?.message === 'insufficient_funds' || err?.message === 'dirty_blocked') {
          return { success: false as const, error: 'no_money', price };
        }
        throw err;
      }
    });

    if (result === null) {
      await interaction.editReply({ embeds: [ecoLocked(locale)] });
      return;
    }

    if (!result.success) {
      await interaction.editReply({
        embeds: [ecoError(`Недостаточно шекелей для подачи заявки на крафт! Стоимость крафта: **${fmt(result.price || price)}**`)],
      });
      return;
    }

    const request = result.request!;

    const publication = await publishPendingCraftRequest(client, request.id);
    if (publication === 'refunded') {
      await interaction.editReply({
        embeds: [ecoError('Не удалось доставить заявку модераторам. Резерв полностью возвращён на ваш кошелёк.')],
      });
      return;
    }

    const embed = new BublikEmbed()
      .setColor(0xe67e22)
      .setTitle(`🛠️ Заявка на крафт успешно отправлена!`)
      .setDescription(
        `Ваша заявка на создание предмета **"${name}"** принята модераторами.\n\n` +
        `💰 **Резерв средств:** **${fmt(price)}** (деньги временно заморожены).\n` +
        (publication === 'retry'
          ? '⏳ Заявка надёжно сохранена и будет автоматически доставлена модераторам после восстановления Discord.'
          : `⏳ Как только администратор проверит и одобрит название и описание предмета, вещь появится в вашем \`/inventory\`!`)
      );

    await interaction.editReply({ embeds: [embed] });
  }
};

/**
 * Расчет стоимости крафта
 */
export function calculateCraftPrice(perk: string | null, value: number | null): number {
  const base = 5000;
  if (!perk || !value || value <= 0) return base;

  switch (perk) {
    case 'robBonus':
      const clampedRob = Math.max(1, Math.min(30, value));
      return base + clampedRob * 5000;
    case 'crimeBonus':
      const clampedCrime = Math.max(1, Math.min(20, value));
      return base + clampedCrime * 3000;
    case 'robDefense':
      const clampedDef = Math.max(1, Math.min(30, value));
      return base + clampedDef * 4000;
    case 'wantedDecayMul':
      const clampedDecay = Math.max(10, Math.min(70, value));
      return base + clampedDecay * 10000;
    case 'dirtyMul':
      const clampedDirty = Math.max(10, Math.min(90, value));
      return base + clampedDirty * 15000;
    case 'cooldownMul':
      const clampedCd = Math.max(10, Math.min(50, value));
      return base + clampedCd * 10000;
    default:
      return base;
  }
}

/**
 * Получение перков в формате JSON
 */
export function getPerksJson(perk: string | null, value: number | null): any {
  if (!perk || !value || value <= 0) return null;
  switch (perk) {
    case 'robBonus':
      return { robBonus: Math.max(1, Math.min(30, value)) };
    case 'crimeBonus':
      return { crimeBonus: Math.max(1, Math.min(20, value)) };
    case 'robDefense':
      return { robDefense: Math.max(1, Math.min(30, value)) };
    case 'wantedDecayMul':
      const decayVal = Math.max(10, Math.min(70, value));
      return { wantedDecayMul: parseFloat((1 - decayVal / 100).toFixed(2)) };
    case 'dirtyMul':
      const dirtyVal = Math.max(10, Math.min(90, value));
      return { dirtyMul: parseFloat((1 - dirtyVal / 100).toFixed(2)) };
    case 'cooldownMul':
      const cdVal = Math.max(10, Math.min(50, value));
      return { cooldownMul: parseFloat((1 - cdVal / 100).toFixed(2)) };
    default:
      return null;
  }
}

// ═══════════════════════════════════════════════
//  Button Handlers (Модерация)
// ═══════════════════════════════════════════════

export async function handleCraftApproveButton(interaction: any, requestId: string): Promise<void> {
  if (!interaction.memberPermissions?.has(PermissionsBitField.Flags.Administrator)) {
    await interaction.reply({ content: '❌ Только администратор может рассматривать заявки.', flags: MessageFlags.Ephemeral });
    return;
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const db = getDatabase();
  const request = await db.customItemRequest.findUnique({ where: { id: requestId } });
  if (!request || request.guildId !== interaction.guildId || request.status !== 'pending') {
    await interaction.editReply({ content: '❌ Заявка не найдена или уже обработана.' });
    return;
  }

  // Одобряем и выдаем предмет в инвентарь
  try {
    await db.$transaction(async (tx) => {
      const claimed = await tx.customItemRequest.updateMany({
        where: { id: requestId, guildId: request.guildId, status: 'pending' },
        data: { status: 'approved', reviewerId: interaction.user.id, reviewedAt: new Date() }
      });
      if (claimed.count !== 1) throw new Error('request_already_processed');

      const itemKey = `custom_${requestId}`;
      await addInventoryItem(
        tx,
        request.guildId,
        request.creatorId,
        itemKey,
        `🛠️ ${request.name}`,
        'custom',
        1,
        request.perks,
        request.description || undefined,
        true,
        request.creatorId
      );
      await tx.operationClaim.deleteMany({ where: { key: craftPublishIntentKey(requestId) } });
    });
  } catch (err: any) {
    if (err?.message === 'request_already_processed') {
      await interaction.editReply({ content: '❌ Заявка уже обработана.' });
      return;
    }
    await interaction.editReply({ content: '❌ Не удалось обработать заявку. Изменения не применены.' }).catch(() => {});
    throw err;
  }

  await invalidateProfileCache(request.guildId, request.creatorId);
  await interaction.editReply({ content: '✅ Предмет успешно создан и выдан игроку.' });

  // Обновляем сообщение модераторов
  try {
    const embed = EmbedBuilder.from(interaction.message.embeds[0])
      .setColor(0x2ecc71)
      .setTitle(`✅ Заявка на крафт #${requestId} ОДОБРЕНА`)
      .addFields({ name: 'Модератор', value: `<@${interaction.user.id}>` });
    await interaction.message.edit({ embeds: [embed], components: [] });
  } catch {
    // The DB status is authoritative; recovery/repeated clicks remain safe.
  }

  // Отправляем уведомление автору в ЛС
  const creator = await interaction.client.users.fetch(request.creatorId).catch(() => null);
  if (creator) {
    const clientEmbed = new BublikEmbed()
      .setColor(0x2ecc71)
      .setTitle(`🛠️ Ваша заявка на крафт одобрена!`)
      .setDescription(
        `Модераторы одобрили создание предмета **"${request.name}"**!\n` +
        `📦 Предмет успешно добавлен в ваш \`/inventory\`.`
      );
    await creator.send({ embeds: [clientEmbed] }).catch(() => {});
  }

}

export async function handleCraftRejectButton(interaction: any, requestId: string): Promise<void> {
  if (!interaction.memberPermissions?.has(PermissionsBitField.Flags.Administrator)) {
    await interaction.reply({ content: '❌ Только администратор может рассматривать заявки.', flags: MessageFlags.Ephemeral });
    return;
  }

  // Showing the modal is the initial ACK. Durable request validation happens
  // again on submit, so no database call can make this button time out.
  const modal = new ModalBuilder()
    .setCustomId(craftRejectModalId(requestId))
    .setTitle('Отклонение заявки на крафт');

  const reasonInput = new TextInputBuilder()
    .setCustomId('reject_reason')
    .setLabel('Укажите причину отклонения')
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(true)
    .setMaxLength(200);

  modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(reasonInput));
  await interaction.showModal(modal);
}

export async function handleCraftRejectModalSubmit(interaction: ModalSubmitInteraction, requestId: string): Promise<void> {
  if (!interaction.memberPermissions?.has(PermissionsBitField.Flags.Administrator)) {
    await interaction.reply({ content: '❌ Только администратор может рассматривать заявки.', flags: MessageFlags.Ephemeral });
    return;
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const reason = interaction.fields.getTextInputValue('reject_reason');
  const db = getDatabase();
  const request = await db.customItemRequest.findUnique({ where: { id: requestId } });
  if (!request || request.guildId !== interaction.guildId || request.status !== 'pending') {
    await interaction.editReply({ content: '❌ Заявка не найдена или уже обработана.' });
    return;
  }

  // Отклоняем заявку и возвращаем резерв
  try {
    await db.$transaction(async (tx) => {
      const claimed = await tx.customItemRequest.updateMany({
        where: { id: requestId, guildId: request.guildId, status: 'pending' },
        data: { status: 'rejected', reviewerId: interaction.user.id, reviewNote: reason, reviewedAt: new Date() }
      });
      if (claimed.count !== 1) throw new Error('request_already_processed');

      await applyWalletDeltaInTransaction(
        tx,
        request.guildId,
        request.creatorId,
        request.feePaid,
        'craft_refund',
        `Rejected craft request ${requestId}: ${reason.slice(0, 80)}`,
      );
      await tx.operationClaim.deleteMany({ where: { key: craftPublishIntentKey(requestId) } });
    });
  } catch (err: any) {
    if (err?.message === 'request_already_processed') {
      await interaction.editReply({ content: '❌ Заявка уже обработана.' });
      return;
    }
    await interaction.editReply({ content: '❌ Не удалось обработать заявку. Изменения не применены.' }).catch(() => {});
    throw err;
  }

  await invalidateProfileCache(request.guildId, request.creatorId);
  await interaction.editReply({ content: '❌ Заявка отклонена, средства возвращены автору.' });

  // Обновляем сообщение в канале модераторов
  try {
    const embed = EmbedBuilder.from(interaction.message!.embeds[0])
      .setColor(0xe74c3c)
      .setTitle(`❌ Заявка на крафт #${requestId} ОТКЛОНЕНА`)
      .addFields(
        { name: 'Модератор', value: `<@${interaction.user.id}>` },
        { name: 'Причина', value: `*${reason}*` },
      );
    await interaction.message!.edit({ embeds: [embed], components: [] });
  } catch {
    // The durable status/refund is already committed.
  }

  // Отправляем уведомление автору в ЛС
  const creator = await interaction.client.users.fetch(request.creatorId).catch(() => null);
  if (creator) {
    const clientEmbed = new BublikEmbed()
      .setColor(0xe74c3c)
      .setTitle(`❌ Ваша заявка на крафт отклонена!`)
      .setDescription(
        `Заявка на создание предмета **"${request.name}"** была отклонена модераторами.\n` +
        `💰 **Возврат резерва:** **${fmt(request.feePaid)}** начислены обратно на баланс.\n\n` +
        `📝 **Причина отклонения:** *${reason}*`
      );
    await creator.send({ embeds: [clientEmbed] }).catch(() => {});
  }

}

export default craftCommand;
