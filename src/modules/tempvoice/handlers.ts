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
  ChannelType,
  PermissionsBitField,
  ComponentType,
  InteractionCollector,
  UserSelectMenuBuilder,
} from 'discord.js';
import type { TempVoiceChannel, TempVoiceGenerator } from '@prisma/client';
import type { BublikClient } from '../../bot';
import { logger } from '../../core/Logger';
import { errorReporter } from '../../core/ErrorReporter';

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
} from './constants';

import {
  getChannel,
  getGeneratorById,
  updateChannel,
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
  buildPermissionOverwrites,
  hasActiveInteraction,
  setActiveInteraction,
  clearActiveInteraction,
  getMemberVoiceChannel,
} from './utils';

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
  tvSuccess,
  tvError,
  tvWarn,
} from './embeds';

import { sendControlPanel } from './lifecycle';

const log = logger.child('TempVoice:Panel');

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

  // Rate-limit
  if (isRateLimited(interaction.user.id)) {
    await interaction.reply({
      embeds: [tvWarn('Слишком много действий. Подождите немного.')],
      ephemeral: true,
    });
    return;
  }

  // Найти голосовой канал участника
  const member = interaction.member as GuildMember;
  const voiceChannel = getMemberVoiceChannel(member);

  if (!voiceChannel) {
    await interaction.reply({
      embeds: [tvError('Вы не находитесь в голосовом канале.')],
      ephemeral: true,
    });
    return;
  }

  // Проверить что это tempvoice канал
  const channelData = await getChannel(voiceChannel.id);
  if (!channelData) {
    await interaction.reply({
      embeds: [tvError('Ваш голосовой канал не является временным.')],
      ephemeral: true,
    });
    return;
  }

  const generator = await getGeneratorById(channelData.generatorId);
  if (!generator) {
    await interaction.reply({
      embeds: [tvError('Конфигурация генератора не найдена.')],
      ephemeral: true,
    });
    return;
  }

  const accessLevel = await getAccessLevel(member, channelData, generator);

  // Заблокированные не могут использовать панель
  if (accessLevel === AccessLevel.Blocked) {
    await interaction.reply({
      embeds: [tvError('Вы заблокированы в этом канале.')],
      ephemeral: true,
    });
    return;
  }

  try {
    // Навигация по страницам
    if (action === 'page') {
      await handlePageSwitch(interaction, voiceChannel, channelData, generator, extra as PanelPage);
      return;
    }

    // Действия, доступные всем (claim)
    if (action === 'claim') {
      await handleClaim(interaction, voiceChannel, channelData, generator, member);
      return;
    }

    // Действия, доступные бустерам (rename, limit, bitrate)
    const boosterActions = new Set(['rename', 'limit', 'bitrate']);
    if (boosterActions.has(action) && hasElevated(accessLevel)) {
      // Бустер, модератор или владелец — пропускаем
    } else if (!canManage(accessLevel)) {
      await interaction.reply({
        embeds: [tvError('У вас недостаточно прав для этого действия.')],
        ephemeral: true,
      });
      return;
    }

    switch (action) {
      case 'rename':    await handleRename(interaction, channelData, generator); break;
      case 'limit':     await handleLimit(interaction, channelData, generator); break;
      case 'lock':      await handleLock(interaction, voiceChannel, channelData, generator); break;
      case 'hide':      await handleHide(interaction, voiceChannel, channelData, generator); break;
      case 'delete':    await handleDelete(interaction); break;
      case 'delete_yes':await handleDeleteConfirm(interaction, voiceChannel, channelData); break;
      case 'delete_no': await handleDeleteCancel(interaction); break;
      case 'trust':     await handleTrust(interaction, client, voiceChannel, channelData, generator); break;
      case 'untrust':   await handleUntrust(interaction, client, voiceChannel, channelData, generator); break;
      case 'block':     await handleBlock(interaction, client, voiceChannel, channelData, generator); break;
      case 'unblock':   await handleUnblock(interaction, client, voiceChannel, channelData, generator); break;
      case 'kick':      await handleKick(interaction, client, voiceChannel, channelData, generator, member); break;
      case 'transfer':  await handleTransfer(interaction, client, voiceChannel, channelData, generator, member); break;
      case 'invite':    await handleInvite(interaction, voiceChannel); break;
      case 'bitrate':   await handleBitrate(interaction, voiceChannel, channelData, generator); break;
      case 'region':    await handleRegion(interaction, voiceChannel, channelData, generator); break;
      case 'save':      await handleSave(interaction, voiceChannel, channelData); break;
      case 'reset':     await handleReset(interaction, voiceChannel, channelData, generator); break;
      default:
        log.warn(`Неизвестное tv-действие: ${action}`);
    }
  } catch (err) {
    log.error(`Ошибка tv-кнопки "${action}"`, { error: String(err) });
    errorReporter.componentError(err, interaction, `tv:${action}`);
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({
        embeds: [tvError('Произошла ошибка. Попробуйте ещё раз.')],
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
  channelData: TempVoiceChannel,
  generator: TempVoiceGenerator,
  page: PanelPage,
): Promise<void> {
  switch (page) {
    case PanelPage.Main: {
      const owner = await interaction.guild!.members.fetch(channelData.ownerId).catch(() => null);
      await interaction.update({
        embeds: [buildMainPageEmbed(
          owner?.user.tag ?? 'Неизвестен',
          vc.name,
          channelData.state,
          vc.members.size,
          vc.userLimit,
          vc.bitrate,
        )],
        components: buildMainPageButtons(),
      });
      break;
    }
    case PanelPage.Access: {
      const trusted = await getTrusted(channelData.id);
      const blocked = await getBlocked(channelData.id);
      await interaction.update({
        embeds: [buildAccessPageEmbed(trusted, blocked, channelData.state)],
        components: buildAccessPageButtons(),
      });
      break;
    }
    case PanelPage.Settings: {
      await interaction.update({
        embeds: [buildSettingsPageEmbed(
          channelData.state,
          vc.rtcRegion ?? 'auto',
          vc.bitrate,
        )],
        components: buildSettingsPageButtons(),
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
  channelData: TempVoiceChannel,
  generator: TempVoiceGenerator,
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
      embeds: [tvWarn(`Лимит переименований исчерпан. Подождите **${remaining}с**.`)],
      ephemeral: true,
    });
    return;
  }

  const modal = new ModalBuilder()
    .setCustomId(`${TV_PREFIX}:modal:rename`)
    .setTitle('Переименовать канал')
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId('name')
          .setLabel('Новое имя канала')
          .setPlaceholder('Например: Тусовка, Игра, Общалка…')
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
  const newName = interaction.fields.getTextInputValue('name').trim();
  if (!newName) {
    await interaction.reply({ embeds: [tvError('Имя не может быть пустым.')], ephemeral: true });
    return;
  }

  const member = interaction.member as GuildMember;
  const vc = getMemberVoiceChannel(member);
  if (!vc) {
    await interaction.reply({ embeds: [tvError('Вы не в голосовом канале.')], ephemeral: true });
    return;
  }

  const channelData = await getChannel(vc.id);
  if (!channelData) {
    await interaction.reply({ embeds: [tvError('Канал не найден.')], ephemeral: true });
    return;
  }

  await vc.setName(newName).catch(() => null);

  await updateChannel(channelData.id, {
    nameChanges: channelData.nameChanges + 1,
    lastNameChange: new Date(),
  });

  await interaction.reply({
    embeds: [tvSuccess(`Канал переименован в **${newName}**.`)],
    ephemeral: true,
  });
}

// ═══════════════════════════════════════════════
//  Лимит участников (Modal)
// ═══════════════════════════════════════════════

async function handleLimit(
  interaction: ButtonInteraction,
  channelData: TempVoiceChannel,
  generator: TempVoiceGenerator,
): Promise<void> {
  const modal = new ModalBuilder()
    .setCustomId(`${TV_PREFIX}:modal:limit`)
    .setTitle('Лимит участников')
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId('limit')
          .setLabel(`Количество (${generator.minUserLimit}–${generator.maxUserLimit}, 0 = без лимита)`)
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
  const raw = interaction.fields.getTextInputValue('limit').trim();
  const limit = parseInt(raw, 10);

  if (isNaN(limit) || limit < 0 || limit > 99) {
    await interaction.reply({ embeds: [tvError('Введите число от 0 до 99.')], ephemeral: true });
    return;
  }

  const member = interaction.member as GuildMember;
  const vc = getMemberVoiceChannel(member);
  if (!vc) {
    await interaction.reply({ embeds: [tvError('Вы не в голосовом канале.')], ephemeral: true });
    return;
  }

  const channelData = await getChannel(vc.id);
  if (!channelData) {
    await interaction.reply({ embeds: [tvError('Канал не найден.')], ephemeral: true });
    return;
  }

  const generator = await getGeneratorById(channelData.generatorId);
  if (generator) {
    if (limit > 0 && (limit < generator.minUserLimit || limit > generator.maxUserLimit)) {
      await interaction.reply({
        embeds: [tvError(`Лимит должен быть от ${generator.minUserLimit} до ${generator.maxUserLimit} (или 0).`)],
        ephemeral: true,
      });
      return;
    }
  }

  await vc.setUserLimit(limit).catch(() => null);

  const text = limit === 0 ? 'снят' : `установлен на **${limit}**`;
  await interaction.reply({
    embeds: [tvSuccess(`Лимит участников ${text}.`)],
    ephemeral: true,
  });
}

// ═══════════════════════════════════════════════
//  Lock / Unlock
// ═══════════════════════════════════════════════

async function handleLock(
  interaction: ButtonInteraction,
  vc: VoiceChannel,
  channelData: TempVoiceChannel,
  generator: TempVoiceGenerator,
): Promise<void> {
  const newState = channelData.state === ChannelState.Locked
    ? ChannelState.Unlocked
    : ChannelState.Locked;

  const updated = await updateChannel(channelData.id, { state: newState });
  const overwrites = await buildPermissionOverwrites(updated, generator, vc.guild, vc.client.user!.id);

  await vc.permissionOverwrites.set(overwrites).catch((e) => log.error('Ошибка установки прав lock', { error: String(e) }));

  const text = newState === ChannelState.Locked
    ? '🔒 Канал **закрыт**. Только доверенные могут войти.'
    : '🔓 Канал **открыт** для всех.';

  await interaction.reply({ embeds: [tvSuccess(text)], ephemeral: true });

  // Обновить панель
  await refreshControlPanel(interaction, vc, updated, generator);
}

// ═══════════════════════════════════════════════
//  Hide / Unhide
// ═══════════════════════════════════════════════

async function handleHide(
  interaction: ButtonInteraction,
  vc: VoiceChannel,
  channelData: TempVoiceChannel,
  generator: TempVoiceGenerator,
): Promise<void> {
  const newState = channelData.state === ChannelState.Hidden
    ? ChannelState.Unlocked
    : ChannelState.Hidden;

  const updated = await updateChannel(channelData.id, { state: newState });
  const overwrites = await buildPermissionOverwrites(updated, generator, vc.guild, vc.client.user!.id);

  await vc.permissionOverwrites.set(overwrites).catch((e) => log.error('Ошибка установки прав hide', { error: String(e) }));

  const text = newState === ChannelState.Hidden
    ? '👻 Канал **скрыт**. Только доверенные видят его.'
    : '👁️ Канал снова **виден** для всех.';

  await interaction.reply({ embeds: [tvSuccess(text)], ephemeral: true });
  await refreshControlPanel(interaction, vc, updated, generator);
}

// ═══════════════════════════════════════════════
//  Claim — забрать владение
// ═══════════════════════════════════════════════

async function handleClaim(
  interaction: ButtonInteraction,
  vc: VoiceChannel,
  channelData: TempVoiceChannel,
  generator: TempVoiceGenerator,
  member: GuildMember,
): Promise<void> {
  // Проверить, в канале ли ещё владелец
  if (vc.members.has(channelData.ownerId)) {
    await interaction.reply({
      embeds: [tvError('Владелец всё ещё в канале.')],
      ephemeral: true,
    });
    return;
  }

  // Передать владение
  const updated = await updateChannel(channelData.id, { ownerId: member.id });
  const overwrites = await buildPermissionOverwrites(updated, generator, vc.guild, vc.client.user!.id);
  await vc.permissionOverwrites.set(overwrites).catch(() => null);

  await interaction.reply({
    embeds: [tvSuccess(`👑 **${member.displayName}** теперь владелец канала.`)],
    ephemeral: true,
  });

  await refreshControlPanel(interaction, vc, updated, generator);

  log.info(`Claim: ${member.user.tag} забрал канал ${vc.name}`);
}

// ═══════════════════════════════════════════════
//  Delete — удаление с подтверждением
// ═══════════════════════════════════════════════

async function handleDelete(interaction: ButtonInteraction): Promise<void> {
  await interaction.reply({
    embeds: [buildDeleteConfirmEmbed()],
    components: [buildDeleteConfirmButtons()],
    ephemeral: true,
  });
}

async function handleDeleteConfirm(
  interaction: ButtonInteraction,
  vc: VoiceChannel,
  channelData: TempVoiceChannel,
): Promise<void> {
  await interaction.update({
    embeds: [tvSuccess('Канал удалён.')],
    components: [],
  });

  await dbDeleteChannel(channelData.id);
  await vc.delete('Удалён владельцем через панель').catch(() => null);

  log.info(`Delete: канал ${vc.name} (${vc.id}) удалён владельцем`);
}

async function handleDeleteCancel(interaction: ButtonInteraction): Promise<void> {
  await interaction.update({
    embeds: [tvSuccess('Удаление отменено.')],
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
  channelData: TempVoiceChannel,
  generator: TempVoiceGenerator,
): Promise<void> {
  if (hasActiveInteraction(interaction.user.id)) {
    await interaction.reply({ embeds: [tvWarn('У вас уже открыто меню.')], ephemeral: true });
    return;
  }
  setActiveInteraction(interaction.user.id);

  await interaction.reply({
    content: '✅ Выберите пользователя для доверия:',
    components: [buildUserSelectRow('trust', 'Выберите пользователя…')],
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
    const targetId = sel.values[0];

    if (targetId === interaction.user.id) {
      await sel.update({ content: '❌ Нельзя добавить себя.', components: [] });
      return;
    }

    await addTrusted(channelData.id, targetId);

    // Обновить permissions
    const updatedData = await getChannel(channelData.id);
    if (updatedData) {
      const overwrites = await buildPermissionOverwrites(updatedData, generator, vc.guild, vc.client.user!.id);
      await vc.permissionOverwrites.set(overwrites).catch(() => null);
    }

    await sel.update({
      content: `✅ <@${targetId}> добавлен в доверенные.`,
      components: [],
    });
  });

  collector.on('end', (collected) => {
    clearActiveInteraction(interaction.user.id);
    if (collected.size === 0) {
      interaction.editReply({ content: '⏰ Время вышло.', components: [] }).catch(() => {});
    }
  });
}

async function handleUntrust(
  interaction: ButtonInteraction,
  client: BublikClient,
  vc: VoiceChannel,
  channelData: TempVoiceChannel,
  generator: TempVoiceGenerator,
): Promise<void> {
  const trustedList = await getTrusted(channelData.id);
  if (trustedList.length === 0) {
    await interaction.reply({ embeds: [tvWarn('Список доверенных пуст.')], ephemeral: true });
    return;
  }

  if (hasActiveInteraction(interaction.user.id)) {
    await interaction.reply({ embeds: [tvWarn('У вас уже открыто меню.')], ephemeral: true });
    return;
  }
  setActiveInteraction(interaction.user.id);

  await interaction.reply({
    content: '🚫 Выберите пользователя для удаления из доверенных:',
    components: [buildUserSelectRow('untrust', 'Выберите пользователя…')],
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
    const targetId = sel.values[0];

    if (!trustedList.includes(targetId)) {
      await sel.update({ content: '❌ Пользователь не в списке доверенных.', components: [] });
      return;
    }

    await removeTrusted(channelData.id, targetId);

    const updatedData = await getChannel(channelData.id);
    if (updatedData) {
      const overwrites = await buildPermissionOverwrites(updatedData, generator, vc.guild, vc.client.user!.id);
      await vc.permissionOverwrites.set(overwrites).catch(() => null);
    }

    await sel.update({
      content: `🚫 <@${targetId}> убран из доверенных.`,
      components: [],
    });
  });

  collector.on('end', (collected) => {
    clearActiveInteraction(interaction.user.id);
    if (collected.size === 0) {
      interaction.editReply({ content: '⏰ Время вышло.', components: [] }).catch(() => {});
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
  channelData: TempVoiceChannel,
  generator: TempVoiceGenerator,
): Promise<void> {
  if (hasActiveInteraction(interaction.user.id)) {
    await interaction.reply({ embeds: [tvWarn('У вас уже открыто меню.')], ephemeral: true });
    return;
  }
  setActiveInteraction(interaction.user.id);

  await interaction.reply({
    content: '⛔ Выберите пользователя для блокировки:',
    components: [buildUserSelectRow('block', 'Выберите пользователя…')],
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
    const targetId = sel.values[0];

    if (targetId === interaction.user.id) {
      await sel.update({ content: '❌ Нельзя заблокировать себя.', components: [] });
      return;
    }

    // Нельзя блокировать модератора
    const targetMember = await interaction.guild!.members.fetch(targetId).catch(() => null);
    if (targetMember && generator.immuneRoleIds.length > 0 && generator.immuneRoleIds.some((rid) => targetMember.roles.cache.has(rid))) {
      await sel.update({ content: '❌ Нельзя заблокировать модератора.', components: [] });
      return;
    }

    await addBlocked(channelData.id, targetId);
    // Убрать из доверенных если был
    await removeTrusted(channelData.id, targetId);

    // Обновить permissions
    const updatedData = await getChannel(channelData.id);
    if (updatedData) {
      const overwrites = await buildPermissionOverwrites(updatedData, generator, vc.guild, vc.client.user!.id);
      await vc.permissionOverwrites.set(overwrites).catch(() => null);
    }

    // Кикнуть из канала если в нём
    if (vc.members.has(targetId) && targetMember) {
      await targetMember.voice.disconnect('Заблокирован владельцем канала').catch(() => null);
    }

    await sel.update({
      content: `⛔ <@${targetId}> заблокирован и отключён от канала.`,
      components: [],
    });
  });

  collector.on('end', (collected) => {
    clearActiveInteraction(interaction.user.id);
    if (collected.size === 0) {
      interaction.editReply({ content: '⏰ Время вышло.', components: [] }).catch(() => {});
    }
  });
}

async function handleUnblock(
  interaction: ButtonInteraction,
  client: BublikClient,
  vc: VoiceChannel,
  channelData: TempVoiceChannel,
  generator: TempVoiceGenerator,
): Promise<void> {
  const blockedList = await getBlocked(channelData.id);
  if (blockedList.length === 0) {
    await interaction.reply({ embeds: [tvWarn('Список заблокированных пуст.')], ephemeral: true });
    return;
  }

  if (hasActiveInteraction(interaction.user.id)) {
    await interaction.reply({ embeds: [tvWarn('У вас уже открыто меню.')], ephemeral: true });
    return;
  }
  setActiveInteraction(interaction.user.id);

  await interaction.reply({
    content: '⭕ Выберите пользователя для разблокировки:',
    components: [buildUserSelectRow('unblock', 'Выберите пользователя…')],
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
    const targetId = sel.values[0];

    if (!blockedList.includes(targetId)) {
      await sel.update({ content: '❌ Пользователь не в блок-листе.', components: [] });
      return;
    }

    await removeBlocked(channelData.id, targetId);

    const updatedData = await getChannel(channelData.id);
    if (updatedData) {
      const overwrites = await buildPermissionOverwrites(updatedData, generator, vc.guild, vc.client.user!.id);
      await vc.permissionOverwrites.set(overwrites).catch(() => null);
    }

    await sel.update({
      content: `⭕ <@${targetId}> разблокирован.`,
      components: [],
    });
  });

  collector.on('end', (collected) => {
    clearActiveInteraction(interaction.user.id);
    if (collected.size === 0) {
      interaction.editReply({ content: '⏰ Время вышло.', components: [] }).catch(() => {});
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
  channelData: TempVoiceChannel,
  generator: TempVoiceGenerator,
  member: GuildMember,
): Promise<void> {
  const kickable = vc.members
    .filter((m) => m.id !== member.id && m.id !== client.user!.id)
    .map((m) => ({ id: m.id, tag: m.user.tag }));

  if (kickable.length === 0) {
    await interaction.reply({ embeds: [tvWarn('В канале нет участников для удаления.')], ephemeral: true });
    return;
  }

  if (hasActiveInteraction(interaction.user.id)) {
    await interaction.reply({ embeds: [tvWarn('У вас уже открыто меню.')], ephemeral: true });
    return;
  }
  setActiveInteraction(interaction.user.id);

  await interaction.reply({
    content: '👢 Выберите участника для отключения:',
    components: [buildKickSelect(kickable)],
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
    const targetId = sel.values[0];
    const targetMember = vc.members.get(targetId);

    if (targetMember) {
      await targetMember.voice.disconnect('Кикнут владельцем канала').catch(() => null);
    }

    await sel.update({
      content: `👢 <@${targetId}> отключён от канала.`,
      components: [],
    });
  });

  collector.on('end', (collected) => {
    clearActiveInteraction(interaction.user.id);
    if (collected.size === 0) {
      interaction.editReply({ content: '⏰ Время вышло.', components: [] }).catch(() => {});
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
  channelData: TempVoiceChannel,
  generator: TempVoiceGenerator,
  member: GuildMember,
): Promise<void> {
  const transferable = vc.members
    .filter((m) => m.id !== member.id && !m.user.bot)
    .map((m) => ({ id: m.id, tag: m.user.tag }));

  if (transferable.length === 0) {
    await interaction.reply({ embeds: [tvWarn('В канале нет подходящих участников.')], ephemeral: true });
    return;
  }

  if (hasActiveInteraction(interaction.user.id)) {
    await interaction.reply({ embeds: [tvWarn('У вас уже открыто меню.')], ephemeral: true });
    return;
  }
  setActiveInteraction(interaction.user.id);

  await interaction.reply({
    content: '🔄 Выберите нового владельца:',
    components: [buildTransferSelect(transferable)],
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
    const targetId = sel.values[0];

    const updated = await updateChannel(channelData.id, { ownerId: targetId });
    const overwrites = await buildPermissionOverwrites(updated, generator, vc.guild, vc.client.user!.id);
    await vc.permissionOverwrites.set(overwrites).catch(() => null);

    await sel.update({
      content: `🔄 Владение передано <@${targetId}>.`,
      components: [],
    });

    // Обновить панель
    await refreshControlPanel(interaction, vc, updated, generator);

    log.info(`Transfer: ${member.user.tag} → ${targetId} в ${vc.name}`);
  });

  collector.on('end', (collected) => {
    clearActiveInteraction(interaction.user.id);
    if (collected.size === 0) {
      interaction.editReply({ content: '⏰ Время вышло.', components: [] }).catch(() => {});
    }
  });
}

// ═══════════════════════════════════════════════
//  Invite
// ═══════════════════════════════════════════════

async function handleInvite(
  interaction: ButtonInteraction,
  vc: VoiceChannel,
): Promise<void> {
  try {
    const invite = await vc.createInvite({
      maxAge: 3600,    // 1 час
      maxUses: 1,
      unique: true,
    });

    await interaction.reply({
      embeds: [tvSuccess(`Приглашение создано: ${invite.url}\n\nДействительно 1 час, одноразовое.`)],
      ephemeral: true,
    });
  } catch {
    await interaction.reply({
      embeds: [tvError('Не удалось создать приглашение.')],
      ephemeral: true,
    });
  }
}

// ═══════════════════════════════════════════════
//  Bitrate (StringSelectMenu)
// ═══════════════════════════════════════════════

async function handleBitrate(
  interaction: ButtonInteraction,
  vc: VoiceChannel,
  channelData: TempVoiceChannel,
  generator: TempVoiceGenerator,
): Promise<void> {
  if (hasActiveInteraction(interaction.user.id)) {
    await interaction.reply({ embeds: [tvWarn('У вас уже открыто меню.')], ephemeral: true });
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
    await interaction.reply({ embeds: [tvWarn('Нет доступных вариантов битрейта.')], ephemeral: true });
    return;
  }

  const { StringSelectMenuBuilder: Builder } = await import('discord.js');
  const menu = new Builder()
    .setCustomId(`${TV_PREFIX}:sel:bitrate`)
    .setPlaceholder('Выберите битрейт…')
    .addOptions(options);

  await interaction.reply({
    content: '🎚️ Выберите битрейт:',
    components: [new ActionRowBuilder<typeof menu>().addComponents(menu)],
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
    const bitrate = parseInt(sel.values[0], 10);
    await vc.setBitrate(bitrate).catch(() => null);

    await sel.update({
      content: `🎚️ Битрейт установлен на **${Math.floor(bitrate / 1000)} кбит/с**.`,
      components: [],
    });
  });

  collector.on('end', (collected) => {
    clearActiveInteraction(interaction.user.id);
    if (collected.size === 0) {
      interaction.editReply({ content: '⏰ Время вышло.', components: [] }).catch(() => {});
    }
  });
}

// ═══════════════════════════════════════════════
//  Region (StringSelectMenu)
// ═══════════════════════════════════════════════

async function handleRegion(
  interaction: ButtonInteraction,
  vc: VoiceChannel,
  channelData: TempVoiceChannel,
  generator: TempVoiceGenerator,
): Promise<void> {
  if (hasActiveInteraction(interaction.user.id)) {
    await interaction.reply({ embeds: [tvWarn('У вас уже открыто меню.')], ephemeral: true });
    return;
  }
  setActiveInteraction(interaction.user.id);

  const { StringSelectMenuBuilder: Builder } = await import('discord.js');
  const currentRegion = vc.rtcRegion ?? 'auto';

  const menu = new Builder()
    .setCustomId(`${TV_PREFIX}:sel:region`)
    .setPlaceholder('Выберите регион…')
    .addOptions(
      VOICE_REGIONS.map((r) => ({
        label: r.label,
        value: r.value,
        default: r.value === currentRegion,
      })),
    );

  await interaction.reply({
    content: '🌐 Выберите голосовой регион:',
    components: [new ActionRowBuilder<typeof menu>().addComponents(menu)],
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
    const region = sel.values[0] === 'auto' ? null : sel.values[0];
    await vc.setRTCRegion(region).catch(() => null);

    const label = VOICE_REGIONS.find((r) => r.value === sel.values[0])?.label ?? sel.values[0];
    await sel.update({
      content: `🌐 Регион изменён на **${label}**.`,
      components: [],
    });
  });

  collector.on('end', (collected) => {
    clearActiveInteraction(interaction.user.id);
    if (collected.size === 0) {
      interaction.editReply({ content: '⏰ Время вышло.', components: [] }).catch(() => {});
    }
  });
}

// ═══════════════════════════════════════════════
//  Save / Reset
// ═══════════════════════════════════════════════

async function handleSave(
  interaction: ButtonInteraction,
  vc: VoiceChannel,
  channelData: TempVoiceChannel,
): Promise<void> {
  await saveUserSettings(interaction.user.id, vc.guildId, {
    savedName: vc.name,
    savedLimit: vc.userLimit,
    savedBitrate: vc.bitrate,
    savedRegion: vc.rtcRegion ?? 'auto',
  });

  await interaction.reply({
    embeds: [tvSuccess('💾 Настройки канала сохранены. Они будут применены при создании следующего канала.')],
    ephemeral: true,
  });
}

async function handleReset(
  interaction: ButtonInteraction,
  vc: VoiceChannel,
  channelData: TempVoiceChannel,
  generator: TempVoiceGenerator,
): Promise<void> {
  await vc.edit({
    name: generator.defaultName.replace(/{nickname}/gi, (interaction.member as GuildMember).displayName),
    userLimit: generator.defaultLimit,
    bitrate: generator.defaultBitrate,
    rtcRegion: generator.defaultRegion === 'auto' ? null : generator.defaultRegion,
  }).catch(() => null);

  await interaction.reply({
    embeds: [tvSuccess('🔄 Настройки канала сброшены к значениям по умолчанию.')],
    ephemeral: true,
  });
  
  const updatedData = await getChannel(channelData.id);
  if (updatedData) {
    await refreshControlPanel(interaction, vc, updatedData, generator);
  }
}

// ═══════════════════════════════════════════════
//  Обновление панели управления
// ═══════════════════════════════════════════════

async function refreshControlPanel(
  interaction: ButtonInteraction,
  vc: VoiceChannel,
  channelData: TempVoiceChannel,
  generator: TempVoiceGenerator,
): Promise<void> {
  if (!channelData.controlMsgId) return;

  try {
    // Панель находится в текстовом чате голосового канала
    const owner = await interaction.guild!.members.fetch(channelData.ownerId).catch(() => null);

    const msg = await vc.messages.fetch(channelData.controlMsgId).catch(() => null);
    if (!msg) return;

    await msg.edit({
      embeds: [buildMainPageEmbed(
        owner?.user.tag ?? 'Неизвестен',
        vc.name,
        channelData.state,
        vc.members.size,
        vc.userLimit,
        vc.bitrate,
      )],
      components: buildMainPageButtons(),
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
