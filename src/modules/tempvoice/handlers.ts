// ═══════════════════════════════════════════════
//  TempVoice — Обработчики кнопок панели
// ═══════════════════════════════════════════════

import {
  ButtonInteraction,
  StringSelectMenuInteraction,
  UserSelectMenuInteraction,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
  ModalSubmitInteraction,
  VoiceChannel,
  GuildMember,
  ComponentType,
  UserSelectMenuBuilder,
} from 'discord.js';
import type { TempvoiceChannel, TempvoiceGenerator } from '@prisma/client';
import type { BublikClient } from '../../bot';
import { logger } from '../../core/Logger';
import { errorReporter } from '../../core/ErrorReporter';
import { i18n } from '../../core/I18n';
import { getGuildLocale } from '../../core/GuildConfig';
import { isGuildAllowed } from '../../core/Whitelist';

import {
  TV_PREFIX,
  TV_SEP,
  ChannelState,
  PanelPage,
  MAX_RENAMES,
  RENAME_RESET_MS,
  COLLECTOR_TIMEOUT_MS,
  BITRATE_OPTIONS,
  VOICE_REGIONS,
  AccessLevel,
  WT_NATIONS,
  WT_MODES,
  brToEmoji,
} from './constants';

import {
  getChannel,
  getGeneratorById,
  updateChannel,
  updateChannelState,
  transferChannelOwnership,
  deleteChannel as dbDeleteChannel,
  addTrusted,
  removeTrusted,
  getTrusted,
  addBlocked,
  removeBlocked,
  getBlocked,
  saveUserSettings,
} from './database';

import {
  isRateLimited,
  getAccessLevel,
  canManage,
  hasElevated,
  hasActiveInteraction,
  setActiveInteraction,
  clearActiveInteraction,
  getMemberVoiceChannel,
} from './utils';

import { runPermissionMutation } from './permissionSync';

import { isTransientInteractionError } from '../../utils/helpers';
import { isUnknownChannelError } from './recovery';

import {
  buildMainPageEmbed,
  buildMainPageButtons,
  buildAccessPageEmbed,
  buildAccessPageButtons,
  buildSettingsPageEmbed,
  buildSettingsPageButtons,
  buildDeleteConfirmEmbed,
  buildDeleteConfirmButtons,
  buildKickSelect,
  buildTransferSelect,
  buildBrSelectMenus,
  buildNationSelectMenu,
  buildModeSelectMenu,
  tvSuccess,
  tvError,
  tvWarn,
} from './embeds';

const log = logger.child('TempVoice:Panel');

interface CollectorAuthorization {
  member: GuildMember;
  channel: TempvoiceChannel;
  generator: TempvoiceGenerator;
  access: AccessLevel;
}

/** Re-authorize long-lived collector actions against fresh DB/voice state. */
async function revalidateCollectorCapability(
  interaction: ButtonInteraction,
  vc: VoiceChannel,
  allows: (access: AccessLevel) => boolean,
): Promise<CollectorAuthorization | null> {
  if (!interaction.guildId || !isGuildAllowed(interaction.guildId)) return null;
  const member = await interaction.guild?.members.fetch({
    user: interaction.user.id,
    force: true,
  }).catch(() => null);
  const channel = await getChannel(vc.id);
  if (!member || !channel || member.voice.channelId !== vc.id) return null;
  const generator = await getGeneratorById(channel.generatorId);
  if (!generator) return null;
  const access = await getAccessLevel(member, channel, generator);
  return allows(access) ? { member, channel, generator, access } : null;
}

async function revalidateCollectorManage(
  interaction: ButtonInteraction,
  vc: VoiceChannel,
  _generator?: TempvoiceGenerator,
): Promise<CollectorAuthorization | null> {
  return revalidateCollectorCapability(interaction, vc, canManage);
}

function canSetRegion(access: AccessLevel): boolean {
  return access === AccessLevel.Owner ||
    access === AccessLevel.Moderator ||
    access === AccessLevel.Reward;
}

// ═══════════════════════════════════════════════
//  Маршрутизатор кнопок
// ═══════════════════════════════════════════════

export async function handleTempVoiceButton(
  interaction: ButtonInteraction,
  client: BublikClient,
): Promise<void> {
  const parts = interaction.customId.split(TV_SEP);
  if (parts[0] !== TV_PREFIX || parts.length < 2) return;

  const action = parts[1];
  const extra = parts[2]; // для page:<pageName>

  const locale = await getGuildLocale(interaction.guildId!);

  // Rate-limit
  if (isRateLimited(interaction.user.id)) {
    await interaction.reply({
      embeds: [tvWarn(i18n.t('tempvoice.err.rate_limited', locale))],
      ephemeral: true,
    });
    return;
  }

  // Найти голосовой канал участника
  const member = interaction.member as GuildMember;
  const voiceChannel = getMemberVoiceChannel(member);

  if (!voiceChannel) {
    await interaction.reply({
      embeds: [tvError(i18n.t('tempvoice.err.not_in_voice', locale))],
      ephemeral: true,
    });
    return;
  }

  // Проверить что это tempvoice канал
  const channelData = await getChannel(voiceChannel.id);
  if (!channelData) {
    await interaction.reply({
      embeds: [tvError(i18n.t('tempvoice.err.not_tempvoice', locale))],
      ephemeral: true,
    });
    return;
  }

  const generator = await getGeneratorById(channelData.generatorId);
  if (!generator) {
    await interaction.reply({
      embeds: [tvError(i18n.t('tempvoice.err.generator_not_found', locale))],
      ephemeral: true,
    });
    return;
  }

  const accessLevel = await getAccessLevel(member, channelData, generator);

  // Заблокированные не могут использовать панель
  if (accessLevel === AccessLevel.Blocked) {
    await interaction.reply({
      embeds: [tvError(i18n.t('tempvoice.err.blocked', locale))],
      ephemeral: true,
    });
    return;
  }

  try {
    // Навигация по страницам
    if (action === 'page') {
      await handlePageSwitch(interaction, voiceChannel, channelData, generator, extra as PanelPage, locale);
      return;
    }

    // Действия, доступные всем (claim)
    if (action === 'claim') {
      await handleClaim(interaction, voiceChannel, channelData, generator, member, locale);
      return;
    }

    // Действия, доступные бустерам / наградным (rename, limit, bitrate)
    const boosterActions = new Set(['rename', 'limit', 'bitrate']);
    // Наградная роль даёт ещё и region
    const rewardActions = new Set(['rename', 'limit', 'bitrate', 'region']);

    const isRewardPlus = accessLevel === AccessLevel.Owner || accessLevel === AccessLevel.Moderator || accessLevel === AccessLevel.Reward;

    if (rewardActions.has(action) && isRewardPlus) {
      // Reward+, модератор или владелец — пропускаем
    } else if (boosterActions.has(action) && hasElevated(accessLevel)) {
      // Бустер — пропускаем (rename, limit, bitrate)
    } else if (!canManage(accessLevel)) {
      await interaction.reply({
        embeds: [tvError('У вас недостаточно прав для этого действия.')],
        ephemeral: true,
      });
      return;
    }

    switch (action) {
      case 'rename':    await handleRename(interaction, channelData, generator, locale); break;
      case 'limit':     await handleLimit(interaction, channelData, generator, locale); break;
      case 'lock':      await handleLock(interaction, voiceChannel, channelData, generator, locale); break;
      case 'hide':      await handleHide(interaction, voiceChannel, channelData, generator, locale); break;
      case 'delete':    await handleDelete(interaction, locale); break;
      case 'delete_yes':await handleDeleteConfirm(interaction, voiceChannel, channelData, locale); break;
      case 'delete_no': await handleDeleteCancel(interaction, locale); break;
      case 'trust':     await handleTrust(interaction, client, voiceChannel, channelData, generator, locale); break;
      case 'untrust':   await handleUntrust(interaction, client, voiceChannel, channelData, generator, locale); break;
      case 'block':     await handleBlock(interaction, client, voiceChannel, channelData, generator, locale); break;
      case 'unblock':   await handleUnblock(interaction, client, voiceChannel, channelData, generator, locale); break;
      case 'kick':      await handleKick(interaction, client, voiceChannel, channelData, generator, member, locale); break;
      case 'transfer':  await handleTransfer(interaction, client, voiceChannel, channelData, generator, member, locale); break;
      case 'invite':    await handleInvite(interaction, voiceChannel, locale); break;
      case 'br':        await handleBattleRating(interaction, voiceChannel, locale); break;
      case 'bitrate':   await handleBitrate(interaction, voiceChannel, channelData, generator, locale); break;
      case 'region':    await handleRegion(interaction, voiceChannel, channelData, generator, locale); break;
      case 'save':      await handleSave(interaction, voiceChannel, channelData, locale); break;
      case 'reset':     await handleReset(interaction, voiceChannel, channelData, generator, locale); break;
      default:
        log.warn(`Неизвестное tv-действие: ${action}`);
    }
  } catch (err) {
    if (isTransientInteractionError(err)) {
      log.warn('Транзиентная ошибка в tempvoice interaction (пропускаем репорт)', { error: String(err) });
      return;
    }

    log.error(`Ошибка tv-кнопки "${action}"`, { error: String(err) });
    errorReporter.componentError(err, interaction, `tv:${action}`);
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({
        embeds: [tvError(i18n.t('tempvoice.err.generic', locale))],
        ephemeral: true,
      }).catch(() => {});
    }
  }
}

// ═══════════════════════════════════════════════
//  Навигация по страницам
// ═══════════════════════════════════════════════

async function handlePageSwitch(
  interaction: ButtonInteraction,
  vc: VoiceChannel,
  channelData: TempvoiceChannel,
  generator: TempvoiceGenerator,
  page: PanelPage,
  locale: string,
): Promise<void> {
  switch (page) {
    case PanelPage.Main: {
      const owner = await interaction.guild!.members.fetch(channelData.ownerId).catch(() => null);
      await interaction.update({
        embeds: [buildMainPageEmbed(
          owner?.user.tag ?? i18n.t('tempvoice.err.owner_unknown', locale),
          vc.name,
          channelData.state,
          vc.members.size,
          vc.userLimit,
          vc.bitrate,
          locale,
        )],
        components: buildMainPageButtons(locale),
      });
      break;
    }
    case PanelPage.Access: {
      const trusted = await getTrusted(channelData.id);
      const blocked = await getBlocked(channelData.id);
      await interaction.update({
        embeds: [buildAccessPageEmbed(trusted, blocked, channelData.state, locale)],
        components: buildAccessPageButtons(locale),
      });
      break;
    }
    case PanelPage.Settings: {
      await interaction.update({
        embeds: [buildSettingsPageEmbed(
          channelData.state,
          vc.rtcRegion ?? 'auto',
          vc.bitrate,
          locale,
        )],
        components: buildSettingsPageButtons(locale),
      });
      break;
    }
  }
}

// ═══════════════════════════════════════════════
//  Переименование (Modal)
// ═══════════════════════════════════════════════

async function handleRename(
  interaction: ButtonInteraction,
  channelData: TempvoiceChannel,
  generator: TempvoiceGenerator,
  locale: string,
): Promise<void> {
  // Проверка лимита переименований
  const now = Date.now();
  const lastChange = channelData.lastNameChange ? new Date(channelData.lastNameChange).getTime() : 0;

  if (now - lastChange > RENAME_RESET_MS) {
    // Сброс счётчика
    await updateChannel(channelData.id, { nameChanges: 0 });
    channelData.nameChanges = 0;
  }

  if (channelData.nameChanges >= MAX_RENAMES) {
    const remaining = Math.ceil((RENAME_RESET_MS - (now - lastChange)) / 1000);
    await interaction.reply({
      embeds: [tvWarn(i18n.t('tempvoice.rename.limit_reached', locale, { remaining: String(remaining) }))],
      ephemeral: true,
    });
    return;
  }

  const modal = new ModalBuilder()
    .setCustomId(`${TV_PREFIX}:modal:rename`)
    .setTitle(i18n.t('tempvoice.rename.modal_title', locale))
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId('name')
          .setLabel(i18n.t('tempvoice.rename.modal_label', locale))
          .setPlaceholder(i18n.t('tempvoice.rename.modal_placeholder', locale))
          .setMinLength(1)
          .setMaxLength(100)
          .setStyle(TextInputStyle.Short)
          .setRequired(true),
      ),
    );

  await interaction.showModal(modal);
}

/** Обработка submit модала переименования */
export async function handleRenameModal(
  interaction: ModalSubmitInteraction,
): Promise<void> {
  const locale = await getGuildLocale(interaction.guildId!);
  const newName = interaction.fields.getTextInputValue('name').trim();
  if (!newName) {
    await interaction.reply({ embeds: [tvError(i18n.t('tempvoice.rename.empty_name', locale))], ephemeral: true });
    return;
  }

  const member = interaction.member as GuildMember;
  const vc = getMemberVoiceChannel(member);
  if (!vc) {
    await interaction.reply({ embeds: [tvError(i18n.t('tempvoice.rename.not_in_voice', locale))], ephemeral: true });
    return;
  }

  const channelData = await getChannel(vc.id);
  if (!channelData) {
    await interaction.reply({ embeds: [tvError(i18n.t('tempvoice.rename.channel_not_found', locale))], ephemeral: true });
    return;
  }

  // Проверка лимита переименований (защита от обхода и 429)
  const now = Date.now();
  const lastChange = channelData.lastNameChange ? new Date(channelData.lastNameChange).getTime() : 0;
  let currentChanges = channelData.nameChanges;

  if (now - lastChange > RENAME_RESET_MS) {
    await updateChannel(channelData.id, { nameChanges: 0 });
    currentChanges = 0;
  }

  if (currentChanges >= MAX_RENAMES) {
    const remaining = Math.ceil((RENAME_RESET_MS - (now - lastChange)) / 1000);
    await interaction.reply({
      embeds: [tvWarn(i18n.t('tempvoice.rename.limit_reached', locale, { remaining: String(remaining) }))],
      ephemeral: true,
    });
    return;
  }

  // Проверка прав: rename доступен бустерам+
  const generator = await getGeneratorById(channelData.generatorId);
  if (!generator) {
    await interaction.reply({ embeds: [tvError(i18n.t('tempvoice.rename.generator_not_found', locale))], ephemeral: true });
    return;
  }
  const accessLevel = await getAccessLevel(member, channelData, generator);
  if (!hasElevated(accessLevel)) {
    await interaction.reply({ embeds: [tvError(i18n.t('tempvoice.rename.no_permission', locale))], ephemeral: true });
    return;
  }

  await vc.setName(newName);

  await updateChannel(channelData.id, {
    nameChanges: channelData.nameChanges + 1,
    lastNameChange: new Date(),
  });

  await interaction.reply({
    embeds: [tvSuccess(i18n.t('tempvoice.rename.success', locale, { name: newName }))],
    ephemeral: true,
  });
}

// ═══════════════════════════════════════════════
//  Лимит участников (Modal)
// ═══════════════════════════════════════════════

async function handleLimit(
  interaction: ButtonInteraction,
  channelData: TempvoiceChannel,
  generator: TempvoiceGenerator,
  locale: string,
): Promise<void> {
  const modal = new ModalBuilder()
    .setCustomId(`${TV_PREFIX}:modal:limit`)
    .setTitle(i18n.t('tempvoice.limit.modal_title', locale))
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId('limit')
          .setLabel(i18n.t('tempvoice.limit.modal_label', locale, { min: String(generator.minUserLimit), max: String(generator.maxUserLimit) }))
          .setPlaceholder('0')
          .setMinLength(1)
          .setMaxLength(2)
          .setStyle(TextInputStyle.Short)
          .setRequired(true),
      ),
    );

  await interaction.showModal(modal);
}

/** Обработка submit модала лимита */
export async function handleLimitModal(
  interaction: ModalSubmitInteraction,
): Promise<void> {
  const locale = await getGuildLocale(interaction.guildId!);
  const raw = interaction.fields.getTextInputValue('limit').trim();
  const limit = parseInt(raw, 10);

  if (isNaN(limit) || limit < 0 || limit > 99) {
    await interaction.reply({ embeds: [tvError(i18n.t('tempvoice.limit.invalid', locale))], ephemeral: true });
    return;
  }

  const member = interaction.member as GuildMember;
  const vc = getMemberVoiceChannel(member);
  if (!vc) {
    await interaction.reply({ embeds: [tvError(i18n.t('tempvoice.rename.not_in_voice', locale))], ephemeral: true });
    return;
  }

  const channelData = await getChannel(vc.id);
  if (!channelData) {
    await interaction.reply({ embeds: [tvError(i18n.t('tempvoice.rename.channel_not_found', locale))], ephemeral: true });
    return;
  }

  const generator = await getGeneratorById(channelData.generatorId);
  if (!generator) {
    await interaction.reply({ embeds: [tvError(i18n.t('tempvoice.rename.generator_not_found', locale))], ephemeral: true });
    return;
  }

  // Проверка прав: limit доступен бустерам+
  const accessLevel = await getAccessLevel(member, channelData, generator);
  if (!hasElevated(accessLevel)) {
    await interaction.reply({ embeds: [tvError(i18n.t('tempvoice.rename.no_permission', locale))], ephemeral: true });
    return;
  }

  if (generator) {
    if (limit > 0 && (limit < generator.minUserLimit || limit > generator.maxUserLimit)) {
      await interaction.reply({
        embeds: [tvError(i18n.t('tempvoice.limit.out_of_range', locale, { min: String(generator.minUserLimit), max: String(generator.maxUserLimit) }))],
        ephemeral: true,
      });
      return;
    }
  }

  await vc.setUserLimit(limit);

  const text = limit === 0
    ? i18n.t('tempvoice.limit.removed', locale)
    : i18n.t('tempvoice.limit.set', locale, { limit: String(limit) });
  await interaction.reply({
    embeds: [tvSuccess(text)],
    ephemeral: true,
  });
}

// ═══════════════════════════════════════════════
//  Lock / Unlock
// ═══════════════════════════════════════════════

async function handleLock(
  interaction: ButtonInteraction,
  vc: VoiceChannel,
  channelData: TempvoiceChannel,
  generator: TempvoiceGenerator,
  locale: string,
): Promise<void> {
  const newState = channelData.state === ChannelState.Locked
    ? ChannelState.Unlocked
    : ChannelState.Locked;

  const { value: updated } = await runPermissionMutation(
    interaction.client,
    channelData.guildId,
    channelData.id,
    `channel state ${newState}`,
    () => updateChannelState(channelData.id, channelData.state, newState),
  );
  if (!updated) {
    await interaction.reply({ embeds: [tvWarn('Состояние канала уже изменилось. Откройте панель повторно.')], ephemeral: true });
    return;
  }
  const text = newState === ChannelState.Locked
    ? i18n.t('tempvoice.lock.locked', locale)
    : i18n.t('tempvoice.lock.unlocked', locale);

  await interaction.reply({ embeds: [tvSuccess(text)], ephemeral: true });

  // Обновить панель
  await refreshControlPanel(interaction, vc, updated, generator, locale);
}

// ═══════════════════════════════════════════════
//  Hide / Unhide
// ═══════════════════════════════════════════════

async function handleHide(
  interaction: ButtonInteraction,
  vc: VoiceChannel,
  channelData: TempvoiceChannel,
  generator: TempvoiceGenerator,
  locale: string,
): Promise<void> {
  const newState = channelData.state === ChannelState.Hidden
    ? ChannelState.Unlocked
    : ChannelState.Hidden;

  const { value: updated } = await runPermissionMutation(
    interaction.client,
    channelData.guildId,
    channelData.id,
    `channel state ${newState}`,
    () => updateChannelState(channelData.id, channelData.state, newState),
  );
  if (!updated) {
    await interaction.reply({ embeds: [tvWarn('Состояние канала уже изменилось. Откройте панель повторно.')], ephemeral: true });
    return;
  }
  const text = newState === ChannelState.Hidden
    ? i18n.t('tempvoice.hide.hidden', locale)
    : i18n.t('tempvoice.hide.visible', locale);

  await interaction.reply({ embeds: [tvSuccess(text)], ephemeral: true });
  await refreshControlPanel(interaction, vc, updated, generator, locale);
}

// ═══════════════════════════════════════════════
//  Claim — забрать владение
// ═══════════════════════════════════════════════

async function handleClaim(
  interaction: ButtonInteraction,
  vc: VoiceChannel,
  channelData: TempvoiceChannel,
  generator: TempvoiceGenerator,
  member: GuildMember,
  locale: string,
): Promise<void> {
  // Проверить, в канале ли ещё владелец
  if (vc.members.has(channelData.ownerId)) {
    await interaction.reply({
      embeds: [tvError(i18n.t('tempvoice.claim.owner_present', locale))],
      ephemeral: true,
    });
    return;
  }

  // Передать владение
  const { value: updated } = await runPermissionMutation(
    interaction.client,
    channelData.guildId,
    channelData.id,
    'claim ownership',
    () => transferChannelOwnership(channelData.id, channelData.ownerId, member.id),
  );
  if (!updated) {
    await interaction.reply({ embeds: [tvWarn('Канал уже забрал другой участник.')], ephemeral: true });
    return;
  }
  await interaction.reply({
    embeds: [tvSuccess(i18n.t('tempvoice.claim.success', locale, { displayName: member.displayName }))],
    ephemeral: true,
  });

  await refreshControlPanel(interaction, vc, updated, generator, locale);

  log.info(`Claim: ${member.user.tag} забрал канал ${vc.name}`);
}

// ═══════════════════════════════════════════════
//  Delete — удаление с подтверждением
// ═══════════════════════════════════════════════

async function handleDelete(interaction: ButtonInteraction, locale: string): Promise<void> {
  await interaction.reply({
    embeds: [buildDeleteConfirmEmbed(locale)],
    components: [buildDeleteConfirmButtons(locale)],
    ephemeral: true,
  });
}

async function handleDeleteConfirm(
  interaction: ButtonInteraction,
  vc: VoiceChannel,
  channelData: TempvoiceChannel,
  locale: string,
): Promise<void> {
  await interaction.deferUpdate();
  let discordChannelGone = false;
  try {
    await vc.delete('Удалён владельцем через панель');
    discordChannelGone = true;
  } catch (error) {
    discordChannelGone = isUnknownChannelError(error);
    if (discordChannelGone) {
      log.info(`Delete: канал ${vc.id} уже отсутствует в Discord`);
    } else {
      log.error(`Delete: не удалось удалить канал ${vc.id}`, { error: String(error) });
      await interaction.editReply({
        embeds: [tvError('Не удалось удалить Discord-канал. Запись сохранена, повторите попытку.')],
        components: [],
      });
      return;
    }
  }

  try {
    await dbDeleteChannel(channelData.id);
  } catch (error) {
    // Discord removal is already confirmed. Keeping the row is safe: startup
    // cleanup will recognize REST 10003 and retry the database cleanup.
    log.error(`Delete: не удалось удалить канал ${vc.id}`, { error: String(error) });
    await interaction.editReply({
      embeds: [tvWarn('Канал удалён, но служебная запись будет очищена автоматически.')],
      components: [],
    });
    return;
  }

  if (!discordChannelGone) return;

  await interaction.editReply({
    embeds: [tvSuccess(i18n.t('tempvoice.delete.success', locale))],
    components: [],
  });

  log.info(`Delete: канал ${vc.name} (${vc.id}) удалён владельцем`);
}

async function handleDeleteCancel(interaction: ButtonInteraction, locale: string): Promise<void> {
  await interaction.update({
    embeds: [tvSuccess(i18n.t('tempvoice.delete.cancelled', locale))],
    components: [],
  });
}

// ═══════════════════════════════════════════════
//  Trust / Untrust (UserSelectMenu)
// ═══════════════════════════════════════════════

async function handleTrust(
  interaction: ButtonInteraction,
  client: BublikClient,
  vc: VoiceChannel,
  channelData: TempvoiceChannel,
  generator: TempvoiceGenerator,
  locale: string,
): Promise<void> {
  if (hasActiveInteraction(interaction.user.id)) {
    await interaction.reply({ embeds: [tvWarn(i18n.t('tempvoice.menu_already_open', locale))], ephemeral: true });
    return;
  }
  setActiveInteraction(interaction.user.id);

  await interaction.reply({
    content: i18n.t('tempvoice.trust.prompt', locale),
    components: [buildUserSelectRow('trust', i18n.t('tempvoice.select.user_placeholder', locale))],
    ephemeral: true,
  });

  const reply = await interaction.fetchReply();
  const collector = reply.createMessageComponentCollector({
    componentType: ComponentType.UserSelect,
    time: COLLECTOR_TIMEOUT_MS,
    max: 1,
  });

  collector.on('collect', async (sel: UserSelectMenuInteraction) => {
    clearActiveInteraction(interaction.user.id);
    try {
      const authorization = await revalidateCollectorManage(interaction, vc, generator);
      if (!authorization) {
        await sel.update({ content: '❌ Права или состояние канала изменились. Откройте панель заново.', components: [] });
        return;
      }
      const targetId = sel.values[0];

      if (targetId === interaction.user.id) {
        await sel.update({ content: `❌ ${i18n.t('tempvoice.trust.cant_self', locale)}`, components: [] });
        return;
      }

      // Нельзя добавить бота
      const targetUser = await interaction.guild!.members.fetch(targetId).catch(() => null);
      if (targetUser?.user.bot) {
        await sel.update({ content: `❌ ${i18n.t('tempvoice.trust.cant_bot', locale)}`, components: [] });
        return;
      }

      // Лимит доверенных
      const currentTrusted = await getTrusted(authorization.channel.id);
      if (currentTrusted.length >= 25) {
        await sel.update({ content: `❌ ${i18n.t('tempvoice.trust.max_reached', locale)}`, components: [] });
        return;
      }

      await runPermissionMutation(
        interaction.client,
        authorization.channel.guildId,
        authorization.channel.id,
        `trust ${targetId}`,
        () => addTrusted(authorization.channel.id, targetId),
      );

      await sel.update({
        content: i18n.t('tempvoice.trust.success', locale, { userMention: `<@${targetId}>` }),
        components: [],
      });
    } catch (err) {
      log.error('Ошибка в collector trust', { error: String(err) });
      await sel.update({ content: `❌ ${i18n.t('tempvoice.trust.error', locale)}`, components: [] }).catch(() => {});
    }
  });

  collector.on('end', (collected) => {
    clearActiveInteraction(interaction.user.id);
    if (collected.size === 0) {
      interaction.editReply({ content: i18n.t('tempvoice.timeout', locale), components: [] }).catch(() => {});
    }
  });
}

async function handleUntrust(
  interaction: ButtonInteraction,
  client: BublikClient,
  vc: VoiceChannel,
  channelData: TempvoiceChannel,
  generator: TempvoiceGenerator,
  locale: string,
): Promise<void> {
  const trustedList = await getTrusted(channelData.id);
  if (trustedList.length === 0) {
    await interaction.reply({ embeds: [tvWarn(i18n.t('tempvoice.untrust.empty', locale))], ephemeral: true });
    return;
  }

  if (hasActiveInteraction(interaction.user.id)) {
    await interaction.reply({ embeds: [tvWarn(i18n.t('tempvoice.menu_already_open', locale))], ephemeral: true });
    return;
  }
  setActiveInteraction(interaction.user.id);

  await interaction.reply({
    content: i18n.t('tempvoice.untrust.prompt', locale),
    components: [buildUserSelectRow('untrust', i18n.t('tempvoice.select.user_placeholder', locale))],
    ephemeral: true,
  });

  const reply = await interaction.fetchReply();
  const collector = reply.createMessageComponentCollector({
    componentType: ComponentType.UserSelect,
    time: COLLECTOR_TIMEOUT_MS,
    max: 1,
  });

  collector.on('collect', async (sel: UserSelectMenuInteraction) => {
    clearActiveInteraction(interaction.user.id);
    try {
      const authorization = await revalidateCollectorManage(interaction, vc, generator);
      if (!authorization) {
        await sel.update({ content: '❌ Права или состояние канала изменились. Откройте панель заново.', components: [] });
        return;
      }
      const targetId = sel.values[0];

      if (!trustedList.includes(targetId)) {
        await sel.update({ content: `❌ ${i18n.t('tempvoice.untrust.not_found', locale)}`, components: [] });
        return;
      }

      await runPermissionMutation(
        interaction.client,
        authorization.channel.guildId,
        authorization.channel.id,
        `untrust ${targetId}`,
        () => removeTrusted(authorization.channel.id, targetId),
      );

      await sel.update({
        content: i18n.t('tempvoice.untrust.success', locale, { userMention: `<@${targetId}>` }),
        components: [],
      });
    } catch (err) {
      log.error('Ошибка в collector untrust', { error: String(err) });
      await sel.update({ content: `❌ ${i18n.t('tempvoice.trust.error', locale)}`, components: [] }).catch(() => {});
    }
  });

  collector.on('end', (collected) => {
    clearActiveInteraction(interaction.user.id);
    if (collected.size === 0) {
      interaction.editReply({ content: i18n.t('tempvoice.timeout', locale), components: [] }).catch(() => {});
    }
  });
}

// ═══════════════════════════════════════════════
//  Block / Unblock (UserSelectMenu)
// ═══════════════════════════════════════════════

async function handleBlock(
  interaction: ButtonInteraction,
  client: BublikClient,
  vc: VoiceChannel,
  channelData: TempvoiceChannel,
  generator: TempvoiceGenerator,
  locale: string,
): Promise<void> {
  if (hasActiveInteraction(interaction.user.id)) {
    await interaction.reply({ embeds: [tvWarn(i18n.t('tempvoice.menu_already_open', locale))], ephemeral: true });
    return;
  }
  setActiveInteraction(interaction.user.id);

  await interaction.reply({
    content: i18n.t('tempvoice.block.prompt', locale),
    components: [buildUserSelectRow('block', i18n.t('tempvoice.select.user_placeholder', locale))],
    ephemeral: true,
  });

  const reply = await interaction.fetchReply();
  const collector = reply.createMessageComponentCollector({
    componentType: ComponentType.UserSelect,
    time: COLLECTOR_TIMEOUT_MS,
    max: 1,
  });

  collector.on('collect', async (sel: UserSelectMenuInteraction) => {
    clearActiveInteraction(interaction.user.id);
    try {
      const authorization = await revalidateCollectorManage(interaction, vc, generator);
      if (!authorization) {
        await sel.update({ content: '❌ Права или состояние канала изменились. Откройте панель заново.', components: [] });
        return;
      }
      const targetId = sel.values[0];

      if (targetId === interaction.user.id) {
        await sel.update({ content: `❌ ${i18n.t('tempvoice.block.cant_self', locale)}`, components: [] });
        return;
      }

      // Нельзя блокировать бота или модератора
      const targetMember = await interaction.guild!.members.fetch(targetId).catch(() => null);
      if (targetMember?.user.bot) {
        await sel.update({ content: `❌ ${i18n.t('tempvoice.block.cant_bot', locale)}`, components: [] });
        return;
      }

      // Лимит заблокированных
      const currentBlocked = await getBlocked(authorization.channel.id);
      if (currentBlocked.length >= 25) {
        await sel.update({ content: `❌ ${i18n.t('tempvoice.block.max_reached', locale)}`, components: [] });
        return;
      }
      if (targetMember && generator.immuneRoleIds.length > 0 && generator.immuneRoleIds.some((rid) => targetMember.roles.cache.has(rid))) {
        await sel.update({ content: `❌ ${i18n.t('tempvoice.block.cant_mod', locale)}`, components: [] });
        return;
      }

      await runPermissionMutation(
        interaction.client,
        authorization.channel.guildId,
        authorization.channel.id,
        `block ${targetId}`,
        () => addBlocked(authorization.channel.id, targetId),
      );

      // Кикнуть из канала если в нём
      if (vc.members.has(targetId) && targetMember) {
        await targetMember.voice.disconnect('Заблокирован владельцем канала');
      }

      await sel.update({
        content: i18n.t('tempvoice.block.success', locale, { userMention: `<@${targetId}>` }),
        components: [],
      });
    } catch (err) {
      log.error('Ошибка в collector block', { error: String(err) });
      await sel.update({ content: `❌ ${i18n.t('tempvoice.trust.error', locale)}`, components: [] }).catch(() => {});
    }
  });

  collector.on('end', (collected) => {
    clearActiveInteraction(interaction.user.id);
    if (collected.size === 0) {
      interaction.editReply({ content: i18n.t('tempvoice.timeout', locale), components: [] }).catch(() => {});
    }
  });
}

async function handleUnblock(
  interaction: ButtonInteraction,
  client: BublikClient,
  vc: VoiceChannel,
  channelData: TempvoiceChannel,
  generator: TempvoiceGenerator,
  locale: string,
): Promise<void> {
  const blockedList = await getBlocked(channelData.id);
  if (blockedList.length === 0) {
    await interaction.reply({ embeds: [tvWarn(i18n.t('tempvoice.unblock.empty', locale))], ephemeral: true });
    return;
  }

  if (hasActiveInteraction(interaction.user.id)) {
    await interaction.reply({ embeds: [tvWarn(i18n.t('tempvoice.menu_already_open', locale))], ephemeral: true });
    return;
  }
  setActiveInteraction(interaction.user.id);

  await interaction.reply({
    content: i18n.t('tempvoice.unblock.prompt', locale),
    components: [buildUserSelectRow('unblock', i18n.t('tempvoice.select.user_placeholder', locale))],
    ephemeral: true,
  });

  const reply = await interaction.fetchReply();
  const collector = reply.createMessageComponentCollector({
    componentType: ComponentType.UserSelect,
    time: COLLECTOR_TIMEOUT_MS,
    max: 1,
  });

  collector.on('collect', async (sel: UserSelectMenuInteraction) => {
    clearActiveInteraction(interaction.user.id);
    try {
      const authorization = await revalidateCollectorManage(interaction, vc, generator);
      if (!authorization) {
        await sel.update({ content: '❌ Права или состояние канала изменились. Откройте панель заново.', components: [] });
        return;
      }
      const targetId = sel.values[0];

      if (!blockedList.includes(targetId)) {
        await sel.update({ content: `❌ ${i18n.t('tempvoice.unblock.not_found', locale)}`, components: [] });
        return;
      }

      await runPermissionMutation(
        interaction.client,
        authorization.channel.guildId,
        authorization.channel.id,
        `unblock ${targetId}`,
        () => removeBlocked(authorization.channel.id, targetId),
      );

      await sel.update({
        content: i18n.t('tempvoice.unblock.success', locale, { userMention: `<@${targetId}>` }),
        components: [],
      });
    } catch (err) {
      log.error('Ошибка в collector unblock', { error: String(err) });
      await sel.update({ content: `❌ ${i18n.t('tempvoice.trust.error', locale)}`, components: [] }).catch(() => {});
    }
  });

  collector.on('end', (collected) => {
    clearActiveInteraction(interaction.user.id);
    if (collected.size === 0) {
      interaction.editReply({ content: i18n.t('tempvoice.timeout', locale), components: [] }).catch(() => {});
    }
  });
}

// ═══════════════════════════════════════════════
//  Kick (StringSelectMenu из участников канала)
// ═══════════════════════════════════════════════

async function handleKick(
  interaction: ButtonInteraction,
  client: BublikClient,
  vc: VoiceChannel,
  channelData: TempvoiceChannel,
  generator: TempvoiceGenerator,
  member: GuildMember,
  locale: string,
): Promise<void> {
  const kickable = vc.members
    .filter((m) => {
      if (m.id === member.id || m.id === client.user!.id) return false;
      if (generator.immuneRoleIds.length > 0 && generator.immuneRoleIds.some((rid) => m.roles.cache.has(rid))) return false;
      return true;
    })
    .map((m) => ({ id: m.id, tag: m.user.tag }));

  if (kickable.length === 0) {
    await interaction.reply({ embeds: [tvWarn(i18n.t('tempvoice.kick.nobody', locale))], ephemeral: true });
    return;
  }

  if (hasActiveInteraction(interaction.user.id)) {
    await interaction.reply({ embeds: [tvWarn(i18n.t('tempvoice.menu_already_open', locale))], ephemeral: true });
    return;
  }
  setActiveInteraction(interaction.user.id);

  await interaction.reply({
    content: i18n.t('tempvoice.kick.prompt', locale),
    components: [buildKickSelect(kickable, locale)],
    ephemeral: true,
  });

  const reply = await interaction.fetchReply();
  const collector = reply.createMessageComponentCollector({
    componentType: ComponentType.StringSelect,
    time: COLLECTOR_TIMEOUT_MS,
    max: 1,
  });

  collector.on('collect', async (sel: StringSelectMenuInteraction) => {
    clearActiveInteraction(interaction.user.id);
    try {
      const authorization = await revalidateCollectorManage(interaction, vc, generator);
      if (!authorization) {
        await sel.update({ content: '❌ Права или состояние канала изменились. Откройте панель заново.', components: [] });
        return;
      }
      const targetId = sel.values[0];
      const targetMember = vc.members.get(targetId);

      if (
        !targetMember ||
        targetMember.user.bot ||
        authorization.generator.immuneRoleIds.some((id) => targetMember.roles.cache.has(id))
      ) {
        await sel.update({ content: '❌ Участник больше недоступен для исключения.', components: [] });
        return;
      }
      await targetMember.voice.disconnect('Кикнут владельцем канала');

      await sel.update({
        content: i18n.t('tempvoice.kick.success', locale, { userMention: `<@${targetId}>` }),
        components: [],
      });
    } catch (err) {
      log.error('Ошибка в collector kick', { error: String(err) });
      await sel.update({ content: `❌ ${i18n.t('tempvoice.trust.error', locale)}`, components: [] }).catch(() => {});
    }
  });

  collector.on('end', (collected) => {
    clearActiveInteraction(interaction.user.id);
    if (collected.size === 0) {
      interaction.editReply({ content: i18n.t('tempvoice.timeout', locale), components: [] }).catch(() => {});
    }
  });
}

// ═══════════════════════════════════════════════
//  Transfer (StringSelectMenu из участников)
// ═══════════════════════════════════════════════

async function handleTransfer(
  interaction: ButtonInteraction,
  client: BublikClient,
  vc: VoiceChannel,
  channelData: TempvoiceChannel,
  generator: TempvoiceGenerator,
  member: GuildMember,
  locale: string,
): Promise<void> {
  const transferable = vc.members
    .filter((m) => m.id !== member.id && !m.user.bot)
    .map((m) => ({ id: m.id, tag: m.user.tag }));

  if (transferable.length === 0) {
    await interaction.reply({ embeds: [tvWarn(i18n.t('tempvoice.transfer.nobody', locale))], ephemeral: true });
    return;
  }

  if (hasActiveInteraction(interaction.user.id)) {
    await interaction.reply({ embeds: [tvWarn(i18n.t('tempvoice.menu_already_open', locale))], ephemeral: true });
    return;
  }
  setActiveInteraction(interaction.user.id);

  await interaction.reply({
    content: i18n.t('tempvoice.transfer.prompt', locale),
    components: [buildTransferSelect(transferable, locale)],
    ephemeral: true,
  });

  const reply = await interaction.fetchReply();
  const collector = reply.createMessageComponentCollector({
    componentType: ComponentType.StringSelect,
    time: COLLECTOR_TIMEOUT_MS,
    max: 1,
  });

  collector.on('collect', async (sel: StringSelectMenuInteraction) => {
    clearActiveInteraction(interaction.user.id);
    try {
      const authorization = await revalidateCollectorManage(interaction, vc, generator);
      if (!authorization) {
        await sel.update({ content: '❌ Права или состояние канала изменились. Откройте панель заново.', components: [] });
        return;
      }
      const targetId = sel.values[0];

      if (!vc.members.has(targetId)) {
        await sel.update({ content: '❌ Новый владелец уже покинул канал.', components: [] });
        return;
      }

      const { value: updated } = await runPermissionMutation(
        interaction.client,
        authorization.channel.guildId,
        authorization.channel.id,
        `transfer ownership to ${targetId}`,
        () => transferChannelOwnership(
          authorization.channel.id,
          authorization.channel.ownerId,
          targetId,
        ),
      );
      if (!updated) {
        await sel.update({ content: '❌ Владелец канала уже изменился.', components: [] });
        return;
      }
      await sel.update({
        content: i18n.t('tempvoice.transfer.success', locale, { userMention: `<@${targetId}>` }),
        components: [],
      });

      // Обновить панель
      await refreshControlPanel(interaction, vc, updated, generator, locale);

      log.info(`Transfer: ${member.user.tag} → ${targetId} в ${vc.name}`);
    } catch (err) {
      log.error('Ошибка в collector transfer', { error: String(err) });
      await sel.update({ content: `❌ ${i18n.t('tempvoice.trust.error', locale)}`, components: [] }).catch(() => {});
    }
  });

  collector.on('end', (collected) => {
    clearActiveInteraction(interaction.user.id);
    if (collected.size === 0) {
      interaction.editReply({ content: i18n.t('tempvoice.timeout', locale), components: [] }).catch(() => {});
    }
  });
}

// ═══════════════════════════════════════════════
//  Invite
// ═══════════════════════════════════════════════

async function handleInvite(
  interaction: ButtonInteraction,
  vc: VoiceChannel,
  locale: string,
): Promise<void> {
  try {
    const invite = await vc.createInvite({
      maxAge: 3600,    // 1 час
      maxUses: 1,
      unique: true,
    });

    await interaction.reply({
      embeds: [tvSuccess(i18n.t('tempvoice.invite.success', locale, { url: invite.url }))],
      ephemeral: true,
    });
  } catch {
    await interaction.reply({
      embeds: [tvError(i18n.t('tempvoice.invite.error', locale))],
      ephemeral: true,
    });
  }
}

// ═══════════════════════════════════════════════
//  Боевой Рейтинг (War Thunder)
// ═══════════════════════════════════════════════

async function handleBattleRating(
  interaction: ButtonInteraction,
  vc: VoiceChannel,
  _locale: string,
): Promise<void> {
  if (hasActiveInteraction(interaction.user.id)) {
    await interaction.reply({ embeds: [tvWarn('Меню уже открыто. Завершите предыдущий выбор.')], ephemeral: true });
    return;
  }
  setActiveInteraction(interaction.user.id);

  // Шаг 1: выбор BR (два select menu - для охвата всех значений 2.0..14.7)
  const brMenus = buildBrSelectMenus();

  await interaction.reply({
    content: '### 🎯 Шаг 1/3 — Боевой Рейтинг\nВыбери BR из одного из меню ниже (верхнее — 2.0..9.3, нижнее — 9.7..14.7):',
    components: brMenus,
    ephemeral: true,
  });

  const reply = await interaction.fetchReply();

  // Коллектор для обоих select menu BR
  const brCollector = reply.createMessageComponentCollector({
    componentType: ComponentType.StringSelect,
    filter: (i) => i.user.id === interaction.user.id && (
      i.customId === `${TV_PREFIX}:sel:br` || i.customId === `${TV_PREFIX}:sel:br2`
    ),
    time: COLLECTOR_TIMEOUT_MS * 2,
    max: 1,
  });

  brCollector.on('collect', async (brSel: StringSelectMenuInteraction) => {
    const selectedBr = brSel.values[0];

    // Шаг 2: выбор нации
    await brSel.update({
      content: `### 🌍 Шаг 2/3 — Нация\n**BR ${selectedBr}** выбран. Теперь выбери нацию или пропусти:`,
      components: [buildNationSelectMenu()],
    });

    const nationCollector = reply.createMessageComponentCollector({
      componentType: ComponentType.StringSelect,
      filter: (i) => i.user.id === interaction.user.id && i.customId === `${TV_PREFIX}:sel:nation`,
      time: COLLECTOR_TIMEOUT_MS * 2,
      max: 1,
    });

    nationCollector.on('collect', async (nationSel: StringSelectMenuInteraction) => {
      const selectedNation = nationSel.values[0]; // 'skip' или значение нации

      // Шаг 3: выбор рода войск
      await nationSel.update({
        content: `### ⚔️ Шаг 3/3 — Род войск\nВыбери род войск или пропусти:`,
        components: [buildModeSelectMenu()],
      });

      const modeCollector = reply.createMessageComponentCollector({
        componentType: ComponentType.StringSelect,
        filter: (i) => i.user.id === interaction.user.id && i.customId === `${TV_PREFIX}:sel:mode`,
        time: COLLECTOR_TIMEOUT_MS * 2,
        max: 1,
      });

      modeCollector.on('collect', async (modeSel: StringSelectMenuInteraction) => {
        clearActiveInteraction(interaction.user.id);
        try {
          const authorization = await revalidateCollectorManage(interaction, vc);
          if (!authorization) {
            await modeSel.update({
              content: '❌ Владелец, права или голосовой канал изменились. Откройте панель заново.',
              components: [],
            });
            return;
          }
          const selectedMode = modeSel.values[0]; // 'skip' или значение рода

          // Строим строку описания канала
          const brEmoji = brToEmoji(selectedBr);
          const nationInfo = WT_NATIONS.find((n) => n.value === selectedNation);
          const modeInfo = WT_MODES.find((m) => m.value === selectedMode);

          const parts: string[] = [];
          parts.push(brEmoji);  // Эмоджи-цифры BR
          if (nationInfo) parts.push(nationInfo.flag); // Флаг нации
          if (modeInfo) parts.push(modeInfo.emoji);   // Эмоджи рода войск

          const topic = parts.join(' ');

          // Устанавливаем статус голосового канала через REST (отображается под названием)
          // discord.js ещё не добавил типы для setStatus на VoiceChannel — используем REST напрямую
          await (vc.client as BublikClient).rest.put(
            `/channels/${vc.id}/voice-status` as `/${string}`,
            { body: { status: topic } },
          );


          // Формируем ответ пользователю
          const nationLabel = nationInfo ? nationInfo.label : 'нация не выбрана';
          const modeLabel = modeInfo ? modeInfo.label : 'род войск не выбран';

          await modeSel.update({
            content:
              `### ✅ Боевой рейтинг установлен!\n` +
              `> 🎯 BR: **${selectedBr}**\n` +
              `> ${nationInfo?.flag ?? '🌐'} Нация: **${nationLabel}**\n` +
              `> ${modeInfo?.emoji ?? '⚔️'} Род войск: **${modeLabel}**\n\n` +
              `Описание канала: ${topic}`,
            components: [],
          });

          log.info(`BR установлен для ${vc.name}: ${topic}`);
        } catch (err) {
          clearActiveInteraction(interaction.user.id);
          log.error('Ошибка при установке BR', { error: String(err) });
          await modeSel.update({ content: '❌ Не удалось установить боевой рейтинг.', components: [] }).catch(() => {});
        }
      });

      modeCollector.on('end', (collected) => {
        clearActiveInteraction(interaction.user.id);
        if (collected.size === 0) {
          interaction.editReply({ content: '⏰ Время выбора истекло.', components: [] }).catch(() => {});
        }
      });
    });

    nationCollector.on('end', (collected) => {
      if (collected.size === 0) {
        clearActiveInteraction(interaction.user.id);
        interaction.editReply({ content: '⏰ Время выбора истекло.', components: [] }).catch(() => {});
      }
    });
  });

  brCollector.on('end', (collected) => {
    clearActiveInteraction(interaction.user.id);
    if (collected.size === 0) {
      interaction.editReply({ content: '⏰ Время выбора истекло.', components: [] }).catch(() => {});
    }
  });
}

// ═══════════════════════════════════════════════
//  Bitrate (StringSelectMenu)
// ═══════════════════════════════════════════════

async function handleBitrate(
  interaction: ButtonInteraction,
  vc: VoiceChannel,
  channelData: TempvoiceChannel,
  generator: TempvoiceGenerator,
  locale: string,
): Promise<void> {
  if (hasActiveInteraction(interaction.user.id)) {
    await interaction.reply({ embeds: [tvWarn(i18n.t('tempvoice.menu_already_open', locale))], ephemeral: true });
    return;
  }
  setActiveInteraction(interaction.user.id);

  // Фильтруем по лимитам генератора
  const options = BITRATE_OPTIONS
    .filter((o) => {
      const val = parseInt(o.value, 10);
      return val >= generator.minBitrate && val <= generator.maxBitrate;
    })
    .map((o) => ({
      label: o.label,
      value: o.value,
      default: parseInt(o.value, 10) === vc.bitrate,
    }));

  if (options.length === 0) {
    clearActiveInteraction(interaction.user.id);
    await interaction.reply({ embeds: [tvWarn(i18n.t('tempvoice.bitrate.no_options', locale))], ephemeral: true });
    return;
  }

  const { StringSelectMenuBuilder: Builder } = await import('discord.js');
  const menu = new Builder()
    .setCustomId(`${TV_PREFIX}:sel:bitrate`)
    .setPlaceholder(i18n.t('tempvoice.select.bitrate_placeholder', locale))
    .addOptions(options);

  await interaction.reply({
    content: i18n.t('tempvoice.bitrate.prompt', locale),
    components: [new ActionRowBuilder<typeof menu>().addComponents(menu)],
    ephemeral: true,
  });

  const reply = await interaction.fetchReply();
  const collector = reply.createMessageComponentCollector({
    componentType: ComponentType.StringSelect,
    filter: (i) => i.user.id === interaction.user.id && i.customId === `${TV_PREFIX}:sel:bitrate`,
    time: COLLECTOR_TIMEOUT_MS,
    max: 1,
  });

  collector.on('collect', async (sel: StringSelectMenuInteraction) => {
    clearActiveInteraction(interaction.user.id);
    try {
      const authorization = await revalidateCollectorCapability(interaction, vc, hasElevated);
      if (!authorization) {
        await sel.update({ content: '❌ Права или состояние канала изменились. Откройте панель заново.', components: [] });
        return;
      }
      const bitrate = parseInt(sel.values[0], 10);
      if (
        !Number.isInteger(bitrate) ||
        bitrate < authorization.generator.minBitrate ||
        bitrate > authorization.generator.maxBitrate
      ) {
        await sel.update({ content: '❌ Допустимый диапазон битрейта изменился. Откройте панель заново.', components: [] });
        return;
      }
      await vc.setBitrate(bitrate);

      await sel.update({
        content: i18n.t('tempvoice.bitrate.success', locale, { bitrate: String(Math.floor(bitrate / 1000)) }),
        components: [],
      });
    } catch (err) {
      log.error('Ошибка в collector bitrate', { error: String(err) });
      await sel.update({ content: `❌ ${i18n.t('tempvoice.trust.error', locale)}`, components: [] }).catch(() => {});
    }
  });

  collector.on('end', (collected) => {
    clearActiveInteraction(interaction.user.id);
    if (collected.size === 0) {
      interaction.editReply({ content: i18n.t('tempvoice.timeout', locale), components: [] }).catch(() => {});
    }
  });
}

// ═══════════════════════════════════════════════
//  Region (StringSelectMenu)
// ═══════════════════════════════════════════════

async function handleRegion(
  interaction: ButtonInteraction,
  vc: VoiceChannel,
  channelData: TempvoiceChannel,
  generator: TempvoiceGenerator,
  locale: string,
): Promise<void> {
  if (hasActiveInteraction(interaction.user.id)) {
    await interaction.reply({ embeds: [tvWarn(i18n.t('tempvoice.menu_already_open', locale))], ephemeral: true });
    return;
  }
  setActiveInteraction(interaction.user.id);

  const { StringSelectMenuBuilder: Builder } = await import('discord.js');
  const currentRegion = vc.rtcRegion ?? 'auto';

  const menu = new Builder()
    .setCustomId(`${TV_PREFIX}:sel:region`)
    .setPlaceholder(i18n.t('tempvoice.select.region_placeholder', locale))
    .addOptions(
      VOICE_REGIONS.map((r) => ({
        label: r.label,
        value: r.value,
        default: r.value === currentRegion,
      })),
    );

  await interaction.reply({
    content: i18n.t('tempvoice.region.prompt', locale),
    components: [new ActionRowBuilder<typeof menu>().addComponents(menu)],
    ephemeral: true,
  });

  const reply = await interaction.fetchReply();
  const collector = reply.createMessageComponentCollector({
    componentType: ComponentType.StringSelect,
    filter: (i) => i.user.id === interaction.user.id && i.customId === `${TV_PREFIX}:sel:region`,
    time: COLLECTOR_TIMEOUT_MS,
    max: 1,
  });

  collector.on('collect', async (sel: StringSelectMenuInteraction) => {
    clearActiveInteraction(interaction.user.id);
    try {
      const authorization = await revalidateCollectorCapability(interaction, vc, canSetRegion);
      if (!authorization) {
        await sel.update({ content: '❌ Права или состояние канала изменились. Откройте панель заново.', components: [] });
        return;
      }
      const region = sel.values[0] === 'auto' ? null : sel.values[0];
      await vc.setRTCRegion(region);

      const label = VOICE_REGIONS.find((r) => r.value === sel.values[0])?.label ?? sel.values[0];
      await sel.update({
        content: i18n.t('tempvoice.region.success', locale, { label }),
        components: [],
      });
    } catch (err) {
      log.error('Ошибка в collector region', { error: String(err) });
      await sel.update({ content: `❌ ${i18n.t('tempvoice.trust.error', locale)}`, components: [] }).catch(() => {});
    }
  });

  collector.on('end', (collected) => {
    clearActiveInteraction(interaction.user.id);
    if (collected.size === 0) {
      interaction.editReply({ content: i18n.t('tempvoice.timeout', locale), components: [] }).catch(() => {});
    }
  });
}

// ═══════════════════════════════════════════════
//  Save / Reset
// ═══════════════════════════════════════════════

async function handleSave(
  interaction: ButtonInteraction,
  vc: VoiceChannel,
  channelData: TempvoiceChannel,
  locale: string,
): Promise<void> {
  await saveUserSettings(interaction.user.id, vc.guildId, {
    savedName: vc.name,
    savedLimit: vc.userLimit,
    savedBitrate: vc.bitrate,
    savedRegion: vc.rtcRegion ?? 'auto',
  });

  await interaction.reply({
    embeds: [tvSuccess(i18n.t('tempvoice.save.success', locale))],
    ephemeral: true,
  });
}

async function handleReset(
  interaction: ButtonInteraction,
  vc: VoiceChannel,
  channelData: TempvoiceChannel,
  generator: TempvoiceGenerator,
  locale: string,
): Promise<void> {
  await vc.edit({
    name: generator.defaultName.replace(/{nickname}/gi, (interaction.member as GuildMember).displayName),
    userLimit: generator.defaultLimit,
    bitrate: generator.defaultBitrate,
    rtcRegion: generator.defaultRegion === 'auto' ? null : generator.defaultRegion,
  }).catch(() => null);

  await interaction.reply({
    embeds: [tvSuccess(i18n.t('tempvoice.reset.success', locale))],
    ephemeral: true,
  });

  const updatedData = await getChannel(channelData.id);
  if (updatedData) {
    await refreshControlPanel(interaction, vc, updatedData, generator, locale);
  }
}

// ═══════════════════════════════════════════════
//  Обновление панели управления
// ═══════════════════════════════════════════════

async function refreshControlPanel(
  interaction: ButtonInteraction,
  vc: VoiceChannel,
  channelData: TempvoiceChannel,
  generator: TempvoiceGenerator,
  locale?: string,
): Promise<void> {
  if (!channelData.controlMsgId) return;

  const loc = locale ?? await getGuildLocale(interaction.guildId!);

  try {
    // Панель находится в текстовом чате голосового канала
    const owner = await interaction.guild!.members.fetch(channelData.ownerId).catch(() => null);

    const msg = await vc.messages.fetch(channelData.controlMsgId).catch(() => null);
    if (!msg) return;

    await msg.edit({
      embeds: [buildMainPageEmbed(
        owner?.user.tag ?? i18n.t('tempvoice.err.owner_unknown', loc),
        vc.name,
        channelData.state,
        vc.members.size,
        vc.userLimit,
        vc.bitrate,
        loc,
      )],
      components: buildMainPageButtons(loc),
    });
  } catch (err) {
    log.warn('Не удалось обновить панель управления', { error: String(err) });
  }
}

// ═══════════════════════════════════════════════
//  Вспомогательная функция для UserSelectMenu row
// ═══════════════════════════════════════════════

function buildUserSelectRow(
  action: string,
  placeholder: string,
): ActionRowBuilder<UserSelectMenuBuilder> {
  return new ActionRowBuilder<UserSelectMenuBuilder>().addComponents(
    new UserSelectMenuBuilder()
      .setCustomId(`${TV_PREFIX}:sel:${action}`)
      .setPlaceholder(placeholder)
      .setMinValues(1)
      .setMaxValues(1),
  );
}
