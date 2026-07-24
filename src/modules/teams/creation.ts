// ═══════════════════════════════════════════════
//  Teams — Создание команды, инвайты, одобрение
// ═══════════════════════════════════════════════

import {
  ChatInputCommandInteraction,
  GuildMember,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
  ModalSubmitInteraction,
  UserSelectMenuInteraction,
  ButtonInteraction,
  PermissionsBitField,
  Message,
  Role,
  Guild,
} from 'discord.js';
import type { BublikClient } from '../../bot';
import { logger } from '../../core/Logger';
import { isGuildAllowed } from '../../core/Whitelist';
import { errorReporter } from '../../core/ErrorReporter';
import { fetchGuildMemberIfPresent } from '../../utils/helpers';
import { scheduleTask, unscheduleTask } from '../../core/SchedulerManager';
import { withMemberRoleLock } from '../../core/MemberRoleLock';
import { fetchSafeAutomaticRole } from '../../core/RolePolicy';

import {
  TM_PREFIX,
  TM_SEP,
  TeamStatus,
  ApplicationStatus,
  InviteStatus,
  MAX_TEAM_NAME_LENGTH,
  MIN_TEAM_NAME_LENGTH,
  INVITE_EXPIRY_CHECK_MS,
  MAX_TEAM_SIZE,
  isTeamOperationalStatus,
} from './constants';
import {
  canReviewApplication,
  componentTreeContainsCustomId,
  isValidConfiguredTeamSize,
  mustPreserveCreationAfterFailedMessageLink,
} from './policy';

import * as db from './database';

import {
  tmSuccess,
  tmError,
  tmWarn,
  buildInviteEmbed,
  buildInviteButtons,
  buildApplicationEmbed,
  buildApplicationButtons,
  buildMemberSelectRow,
  TEAM_NAME_MODAL_ID,
} from './embeds';

const log = logger.child('Teams:Creation');
const PENDING_ROLE_PREFIX = 'pending-team-role:';

function pendingRoleId(guildId: string, userId: string): string {
  return `${PENDING_ROLE_PREFIX}${guildId}:${userId}`;
}

function pendingDiscordRoleName(teamId: string): string {
  return `bublik-pending-${teamId}`;
}

async function fetchRoleIfExists(guild: Guild, roleId: string): Promise<Role | null> {
  const cached = guild.roles.cache.get(roleId);
  if (cached) return cached;
  try {
    return await guild.roles.fetch(roleId);
  } catch (err) {
    if ((err as { code?: number }).code === 10011) return null;
    throw err;
  }
}

async function fetchChannelIfExists(guild: Guild, channelId: string) {
  const cached = guild.channels.cache.get(channelId);
  if (cached) return cached;
  try {
    return await guild.channels.fetch(channelId);
  } catch (err) {
    if ((err as { code?: number }).code === 10003) return null;
    throw err;
  }
}

async function deleteRoleIfExists(guild: Guild, roleId: string, reason: string): Promise<void> {
  const role = await fetchRoleIfExists(guild, roleId);
  if (!role) return;
  try {
    await role.delete(reason);
  } catch (err) {
    if ((err as { code?: number }).code !== 10011) throw err;
  }
}

type TeamCreationCleanupRecord = NonNullable<Awaited<ReturnType<typeof db.getApplication>>>;

async function deleteApplicationMessagesIfExists(
  guild: Guild,
  application: TeamCreationCleanupRecord,
): Promise<void> {
  const channelId = application.channelId ?? application.team.config.applicationChannelId;
  if (!channelId) throw new Error('Application cleanup has no durable Discord channel id');
  const channel = await fetchChannelIfExists(guild, channelId);
  // A missing channel authoritatively means all of its messages are gone.
  if (!channel) return;
  if (!channel.isTextBased()) throw new Error(`Application channel ${channelId} is no longer text-based`);

  if (application.messageId) {
    let message: Message | null;
    try {
      message = await channel.messages.fetch(application.messageId);
    } catch (err) {
      if ((err as { code?: number }).code === 10008) return;
      throw err;
    }
    try {
      await message.delete();
    } catch (err) {
      if ((err as { code?: number }).code !== 10008) throw err;
    }
    return;
  }

  // A Discord send can succeed while its REST response is lost. In that case
  // no message id reached the process, so locate the deterministic component.
  const recent = await channel.messages.fetch({ limit: 100 });
  for (const message of recent.values()) {
    if (!messageContainsApplicationReviewId(message, application.id, application.teamId)) continue;
    try {
      await message.delete();
    } catch (err) {
      if ((err as { code?: number }).code !== 10008) throw err;
    }
  }
}

async function cleanupPendingTeamCreation(
  application: TeamCreationCleanupRecord,
  guild: Guild,
): Promise<boolean> {
  await deleteApplicationMessagesIfExists(guild, application);
  if (application.team.roleId.startsWith(PENDING_ROLE_PREFIX)) {
    // The role create may have succeeded while its response/DB attachment was
    // lost. Its deterministic marker is the only durable lookup available.
    await guild.roles.fetch();
    const marker = guild.roles.cache.find(role => role.name === pendingDiscordRoleName(application.team.id));
    if (marker) await deleteRoleIfExists(guild, marker.id, 'Компенсация незавершённого создания команды');
  } else {
    await deleteRoleIfExists(guild, application.team.roleId, 'Компенсация незавершённого создания команды');
  }
  return db.finalizePendingTeamCreationCleanup(application.id, application.teamId);
}

// Временное хранилище выбранных участников до модального окна
const pendingSelections = new Map<string, { userIds: string[]; expiresAt: number }>();

function selectionKey(guildId: string, userId: string): string {
  return `${guildId}:${userId}`;
}

// ═══════════════════════════════════════════════
//  Шаг 1: /team create → UserSelectMenu
// ═══════════════════════════════════════════════

export async function handleCreateStart(
  interaction: ChatInputCommandInteraction,
  _client: BublikClient,
): Promise<void> {
  const guildId = interaction.guildId!;
  const userId = interaction.user.id;

  const config = await db.getConfig(guildId);
  if (!config) {
    await interaction.reply({ embeds: [tmError('Модуль команд не настроен. Используйте `/team setup`.')], ephemeral: true });
    return;
  }
  if (!isValidConfiguredTeamSize(config.minSize)) {
    await interaction.reply({
      embeds: [tmError(`Некорректный минимальный размер команды. Допустимо от 2 до ${MAX_TEAM_SIZE}.`)],
      ephemeral: true,
    });
    return;
  }

  // Проверка базовой роли
  const member = interaction.member as GuildMember;
  if (config.baseRoleId && !member.roles.cache.has(config.baseRoleId)) {
    await interaction.reply({ embeds: [tmError('У вас нет базовой роли для создания команды.')], ephemeral: true });
    return;
  }

  // Проверка: не состоит ли уже в команде
  const existingTeam = await db.getMemberTeam(userId, guildId);
  if (existingTeam) {
    await interaction.reply({ embeds: [tmError(`Вы уже состоите в команде «${existingTeam.name}».`)], ephemeral: true });
    return;
  }

  // Показать UserSelect для выбора участников
  await interaction.reply({
    embeds: [tmWarn(
      `Выберите участников для команды (минимум **${config.minSize - 1}** человек, не считая вас).\n` +
      'Доступны только участники с базовой ролью. У них будет **24 часа** для ответа.',
    )],
    components: [buildMemberSelectRow('new', config.minSize)],
    ephemeral: true,
  });
}

// ═══════════════════════════════════════════════
//  Шаг 2: UserSelect → Modal (название)
// ═══════════════════════════════════════════════

export async function handleMemberSelect(
  interaction: UserSelectMenuInteraction,
  _client: BublikClient,
): Promise<void> {
  const guildId = interaction.guildId!;
  const userId = interaction.user.id;

  const config = await db.getConfig(guildId);
  if (!config) return;
  if (!isValidConfiguredTeamSize(config.minSize)) {
    await interaction.reply({
      embeds: [tmError(`Некорректный минимальный размер команды. Допустимо от 2 до ${MAX_TEAM_SIZE}.`)],
      ephemeral: true,
    });
    return;
  }

  const selectedIds = [...new Set(interaction.values)].slice(0, MAX_TEAM_SIZE - 1);

  // Фильтрация: только с базовой ролью, не боты, не лидер
  const guild = interaction.guild!;
  const validMembers: string[] = [];
  const invalidMembers: string[] = [];

  for (const id of selectedIds) {
    if (id === userId) continue; // Лидер не выбирает себя
    const member = guild.members.cache.get(id) || await guild.members.fetch(id).catch(() => null);
    if (!member || member.user.bot) continue;

    if (config.baseRoleId && !member.roles.cache.has(config.baseRoleId)) {
      invalidMembers.push(member.user.tag);
      continue;
    }

    // Проверка: не в другой команде
    const existing = await db.getMemberTeam(id, guildId);
    if (existing) {
      invalidMembers.push(`${member.user.tag} (уже в «${existing.name}»)`);
      continue;
    }

    validMembers.push(id);
  }

  if (validMembers.length < config.minSize - 1) {
    let msg = `Недостаточно участников. Нужно минимум **${config.minSize - 1}** (выбрано валидных: ${validMembers.length}).`;
    if (invalidMembers.length > 0) {
      msg += `\n\nОтклонены: ${invalidMembers.join(', ')}`;
    }
    await interaction.reply({ embeds: [tmError(msg)], ephemeral: true });
    return;
  }

  // Сохранить выбранных во временное хранилище
  pendingSelections.set(selectionKey(guildId, userId), {
    userIds: validMembers,
    expiresAt: Date.now() + 300_000, // 5 минут на ввод названия
  });

  // Показать модальное окно для названия
  const modal = new ModalBuilder()
    .setCustomId(`${TEAM_NAME_MODAL_ID}${TM_SEP}${userId}`)
    .setTitle('Название команды')
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId('team_name')
          .setLabel('Название команды')
          .setStyle(TextInputStyle.Short)
          .setPlaceholder('Латиница или кириллица, 2-32 символа')
          .setMinLength(MIN_TEAM_NAME_LENGTH)
          .setMaxLength(MAX_TEAM_NAME_LENGTH)
          .setRequired(true),
      ),
    );

  await interaction.showModal(modal);
}

// ═══════════════════════════════════════════════
//  Шаг 3: Modal submit → Инвайты → Заявка
// ═══════════════════════════════════════════════

export async function handleNameModal(
  interaction: ModalSubmitInteraction,
  _client: BublikClient,
): Promise<void> {
  const userId = interaction.user.id;
  const guildId = interaction.guildId!;

  await interaction.deferReply({ ephemeral: true });

  const pendingKey = selectionKey(guildId, userId);
  const pending = pendingSelections.get(pendingKey);
  if (!pending || pending.expiresAt < Date.now()) {
    pendingSelections.delete(pendingKey);
    await interaction.editReply({ embeds: [tmError('Время выбора участников истекло. Попробуйте снова.')] });
    return;
  }

  const teamName = interaction.fields.getTextInputValue('team_name').trim();
  pendingSelections.delete(pendingKey);

  // Валидация имени
  if (teamName.length < MIN_TEAM_NAME_LENGTH || teamName.length > MAX_TEAM_NAME_LENGTH) {
    await interaction.editReply({ embeds: [tmError(`Название должно быть от ${MIN_TEAM_NAME_LENGTH} до ${MAX_TEAM_NAME_LENGTH} символов.`)] });
    return;
  }

  // Проверка уникальности
  const existing = await db.getTeamByName(guildId, teamName);
  if (existing) {
    await interaction.editReply({ embeds: [tmError(`Команда «${teamName}» уже существует.`)] });
    return;
  }

  const config = await db.getConfig(guildId);
  if (!config) {
    await interaction.editReply({ embeds: [tmError('Конфигурация не найдена.')] });
    return;
  }
  if (!isValidConfiguredTeamSize(config.minSize)) {
    await interaction.editReply({ embeds: [tmError(`Минимальный размер команды должен быть от 2 до ${MAX_TEAM_SIZE}.`)] });
    return;
  }

  const leaderExistingTeam = await db.getMemberTeam(userId, guildId);
  if (leaderExistingTeam) {
    await interaction.editReply({ embeds: [tmError(`Вы уже состоите в команде «${leaderExistingTeam.name}».`)] });
    return;
  }

  const guild = interaction.guild!;
  const leaderMember = await guild.members.fetch({ user: userId, force: true }).catch(() => null);
  if (!leaderMember || leaderMember.user.bot || (config.baseRoleId && !leaderMember.roles.cache.has(config.baseRoleId))) {
    await interaction.editReply({ embeds: [tmError('Вы больше не соответствуете требованиям для создания команды.')] });
    return;
  }
  const validatedInvitees: string[] = [];
  for (const selectedId of [...new Set(pending.userIds)].slice(0, MAX_TEAM_SIZE - 1)) {
    const selected = await guild.members.fetch(selectedId).catch(() => null);
    if (!selected || selected.user.bot || selectedId === userId) continue;
    if (config.baseRoleId && !selected.roles.cache.has(config.baseRoleId)) continue;
    if (await db.getMemberTeam(selectedId, guildId)) continue;
    validatedInvitees.push(selectedId);
  }
  if (validatedInvitees.length < config.minSize - 1) {
    await interaction.editReply({
      embeds: [tmError(`После повторной проверки осталось ${validatedInvitees.length} приглашённых; требуется минимум ${config.minSize - 1}.`)],
    });
    return;
  }

  if (!config.applicationChannelId) {
    await interaction.editReply({ embeds: [tmError('Канал рассмотрения заявок не настроен. Обратитесь к администратору.')] });
    return;
  }
  const applicationChannel = guild.channels.cache.get(config.applicationChannelId);
  if (!applicationChannel?.isTextBased()) {
    await interaction.editReply({ embeds: [tmError('Настроенный канал рассмотрения заявок недоступен.')] });
    return;
  }

  let createdRole: Role | null = null;
  let createdTeamId: string | null = null;
  let createdApplicationId: string | null = null;
  let applicationMessage: Message | null = null;
  let creationCommitted = false;

  try {
    const placeholderRoleId = pendingRoleId(guildId, userId);
    const pendingCreation = await db.createPendingTeamWithLeaderApplication({
      guildId,
      name: teamName,
      pendingRoleId: placeholderRoleId,
      leaderId: userId,
      configId: config.id,
      applicationChannelId: config.applicationChannelId,
    });
    const { team, application } = pendingCreation;
    createdTeamId = team.id;
    createdApplicationId = application.id;

    createdRole = await guild.roles.create({
      // A deterministic temporary marker closes the otherwise unavoidable
      // crash gap between Discord role creation and persisting its snowflake.
      name: pendingDiscordRoleName(team.id),
      reason: `Команда «${teamName}» — ожидает одобрения`,
      mentionable: false,
    });

    const roleAttached = await db.attachCreatedTeamRole(team.id, placeholderRoleId, createdRole.id);
    if (!roleAttached) throw new Error('Team creation state changed before its Discord role was linked');
    await createdRole.edit({ name: teamName, reason: `Команда «${teamName}» — ожидает одобрения` });

    await withMemberRoleLock(guildId, leaderMember.id, async (lock) => {
      const safeRole = await fetchSafeAutomaticRole(guild, createdRole!.id);
      await lock.assertOwned();
      await leaderMember.roles.add(safeRole, 'Создание команды — лидер');
    });

    // The application exists before buttons become visible, so duplicate
    // review messages cannot create duplicate application records.
    applicationMessage = await applicationChannel.send({
      embeds: [buildApplicationEmbed(
        teamName,
        interaction.user.tag,
        userId,
        team.members,
        validatedInvitees.length,
        config.minSize,
      )],
      components: [buildApplicationButtons(application.id)],
    });
    const linked = await db.setApplicationMessage(application.id, applicationMessage.id);
    if (!linked) throw new Error('Application state changed before its Discord message was linked');
    // From this point the team and its visible review message form a complete,
    // recoverable creation. Later notification/reply failures are not grounds
    // for destructively compensating the team.
    creationCommitted = true;

    const inviteTimeoutMs = (config.inviteTimeoutH || 24) * 3_600_000;
    const expiresAt = new Date(Date.now() + inviteTimeoutMs);
    let sentCount = 0;
    let failedCount = 0;

    for (const memberId of validatedInvitees) {
      try {
        const member = await guild.members.fetch(memberId);
        // The pending row is the durable notification intent. A crash or DM
        // send response-loss can now be retried without inventing membership.
        try {
          await db.createInvite({ teamId: team.id, userId: memberId, expiresAt });
        } catch (persistError) {
          const existing = await db.getInvite(team.id, memberId).catch(() => null);
          if (!existing || existing.status !== InviteStatus.PENDING) throw persistError;
        }
        const dmMessage = await member.send({
          embeds: [buildInviteEmbed(teamName, interaction.user.tag, guild.name, 1)],
          components: [buildInviteButtons(team.id, memberId)],
        });
        try {
          if (!await db.setInviteMessage(team.id, memberId, dmMessage.id)) {
            throw new Error('Invite message link CAS was lost');
          }
        } catch (linkError) {
          const existing = await db.getInvite(team.id, memberId).catch(() => null);
          if (existing?.status !== InviteStatus.PENDING || existing.messageId !== dmMessage.id) {
            // Unknown DB outcome: retain the already-sent DM. A missing
            // messageId is recovered by a later idempotent notification pass.
            log.warn('DM-инвайт отправлен, но его messageId пока не подтверждён', {
              error: String(linkError), teamId: team.id, memberId, messageId: dmMessage.id,
            });
          }
        }
        sentCount++;
      } catch (err) {
        failedCount++;
        log.error(`Ошибка отправки инвайта ${memberId}`, { error: String(err) });
      }
    }

    await updateApplicationMessage(guildId, team.id, _client);
    await interaction.editReply({
      embeds: [tmSuccess(
        `Команда «**${teamName}**» создана!\n\n` +
        `📨 Инвайтов отправлено: **${sentCount}**\n` +
        (failedCount > 0 ? `❌ Не удалось: **${failedCount}**\n` : '') +
        `⏳ У участников **${config.inviteTimeoutH || 24}ч** на ответ.\n` +
        '📋 Заявка отправлена на рассмотрение.',
      )],
    });
    log.info(`Команда «${teamName}» создана: лидер ${interaction.user.tag}, инвайтов ${sentCount}`);
  } catch (err) {
    log.error(`Ошибка создания команды «${teamName}»`, { error: String(err) });
    errorReporter.moduleError(err, 'teams', `Создание команды «${teamName}»`);
    if (creationCommitted) {
      log.warn('Создание уже зафиксировано; ошибка ответа не откатывает живую команду', {
        teamId: createdTeamId,
        applicationId: createdApplicationId,
      });
      await interaction.editReply({
        embeds: [tmWarn('Команда создана и заявка сохранена, но не все уведомления удалось отправить.')],
      }).catch(() => null);
      return;
    }

    let cleanupComplete = false;
    let cleanupTracked = false;
    let liveCreationWonRace = false;
    if (createdTeamId && createdApplicationId) {
      try {
        cleanupTracked = await db.claimPendingTeamCreationCleanup(
          createdApplicationId,
          createdTeamId,
          applicationMessage?.id ?? null,
        );
        if (cleanupTracked) {
          const cleanup = await db.getApplication(createdApplicationId);
          cleanupComplete = !cleanup || await cleanupPendingTeamCreation(cleanup, guild);
        } else {
          // A concurrent recovery may have linked the message after our stale
          // snapshot. Re-read before deciding anything destructive.
          const latest = await db.getApplication(createdApplicationId);
          liveCreationWonRace = latest !== null && mustPreserveCreationAfterFailedMessageLink(latest);
        }
      } catch (cleanupErr) {
        log.error('Компенсация создания отложена; durable tracker сохранён', {
          error: String(cleanupErr),
          teamId: createdTeamId,
          applicationId: createdApplicationId,
        });
      }
    }

    const message = liveCreationWonRace
      ? 'Команда уже была зафиксирована параллельным восстановлением; автоматический откат отменён.'
      : cleanupComplete
        ? 'Произошла ошибка при создании команды. Созданные объекты безопасно удалены.'
        : cleanupTracked
          ? 'Произошла ошибка при создании команды. Очистка сохранена и будет автоматически продолжена.'
          : 'Произошла ошибка при создании команды. Безопасность состояния будет проверена автоматически.';
    await interaction.editReply({ embeds: [tmError(message)] }).catch(() => null);
  }
}

// ═══════════════════════════════════════════════
//  Ответ на инвайт (Accept / Decline)
// ═══════════════════════════════════════════════

export async function handleInviteResponse(
  interaction: ButtonInteraction,
  action: 'accept' | 'decline',
  teamId: string,
  targetUserId: string,
  client: BublikClient,
): Promise<void> {
  // Проверка: нажал тот, кому инвайт
  if (interaction.user.id !== targetUserId) {
    await interaction.reply({ embeds: [tmError('Это приглашение не для вас.')], ephemeral: true });
    return;
  }

  await interaction.deferUpdate();

  const invite = await db.getInvite(teamId, targetUserId);
  if (!invite) {
    await interaction.editReply({ embeds: [tmError('Приглашение не найдено.')], components: [] });
    return;
  }
  if (!isGuildAllowed(invite.team.guildId)) {
    await interaction.editReply({ embeds: [tmError('Сервер этого приглашения больше не авторизован.')], components: [] });
    return;
  }

  if (invite.status !== InviteStatus.PENDING) {
    await interaction.editReply({
      embeds: [tmWarn(`Приглашение уже обработано (${invite.status}).`)],
      components: [],
    });
    return;
  }

  if (invite.expiresAt.getTime() <= Date.now()) {
    await db.transitionInvite(teamId, targetUserId, InviteStatus.PENDING, InviteStatus.EXPIRED);
    await interaction.editReply({ embeds: [tmWarn('Срок приглашения истёк.')], components: [] });
    return;
  }

  const team = await db.getTeam(teamId);
  if (!team || !isTeamOperationalStatus(team.status)) {
    await db.transitionInvite(teamId, targetUserId, InviteStatus.PENDING, InviteStatus.EXPIRED);
    await interaction.editReply({ embeds: [tmError('Команда больше не существует.')], components: [] });
    return;
  }

  if (action === 'decline') {
    const declined = await db.transitionInvite(teamId, targetUserId, InviteStatus.PENDING, InviteStatus.DECLINED);
    if (!declined) {
      await interaction.editReply({ embeds: [tmWarn('Приглашение уже обработано.')], components: [] });
      return;
    }
    await interaction.editReply({
      embeds: [tmWarn(`Вы отклонили приглашение в команду «${team.name}».`)],
      components: [],
    });
    log.info(`Инвайт отклонён: ${interaction.user.tag} → «${team.name}»`);
    return;
  }

  const claimed = await db.claimPendingInvite(teamId, targetUserId);
  if (!claimed) {
    await interaction.editReply({ embeds: [tmWarn('Приглашение уже обработано или истекло.')], components: [] });
    return;
  }

  const acceptToken = claimed.token;
  const claimedInvite = claimed.invite;

  let roleWasPresentBeforeAttempt: boolean | null = null;
  let acceptanceCommitted = false;
  try {
    const guild = client.guilds.cache.get(team.guildId);
    if (!guild) throw new Error('Guild is unavailable');
    await withMemberRoleLock(team.guildId, targetUserId, async (lock) => {
      const member = await guild.members.fetch({ user: targetUserId, force: true });
      if (team.config.baseRoleId && !member.roles.cache.has(team.config.baseRoleId)) {
        throw new Error('Invitee no longer has the configured base role');
      }
      roleWasPresentBeforeAttempt = member.roles.cache.has(team.roleId);
      if (!await db.setInviteAcceptRoleBaseline(
        claimedInvite.id,
        acceptToken,
        roleWasPresentBeforeAttempt,
      )) {
        throw new Error('Invite acceptance was fenced before Discord role mutation');
      }
      if (!roleWasPresentBeforeAttempt) {
        const safeRole = await fetchSafeAutomaticRole(guild, team.roleId);
        await lock.assertOwned();
        await member.roles.add(safeRole, `Присоединился к команде «${team.name}»`);
      }

      // A successful REST response is not enough: confirm the desired external
      // state before committing durable membership, then fence once more.
      const verified = await guild.members.fetch({ user: targetUserId, force: true });
      if (!verified.roles.cache.has(team.roleId)) {
        throw new Error(`Team role ${team.roleId} was not confirmed after invite acceptance`);
      }
      await lock.assertOwned();
      const committed = await db.commitClaimedInvite(
        teamId,
        targetUserId,
        team.guildId,
        MAX_TEAM_SIZE,
        acceptToken,
      );
      if (!committed) throw new Error('Membership invariant rejected the invite acceptance');
      acceptanceCommitted = true;
    });
  } catch (err) {
    try {
      const guild = client.guilds.cache.get(team.guildId);
      if (!guild) {
        throw new Error('Guild is unavailable during invite compensation');
      }
      // Re-acquire a fresh renewable lock even when the old fencing token was
      // lost. The durable membership re-check prevents an old worker from
      // removing a role committed by a newer successful acceptance.
      await withMemberRoleLock(team.guildId, targetUserId, async (lock) => {
        const [latestInvite, durableMember] = await Promise.all([
          db.getInvite(teamId, targetUserId),
          db.isMemberOfTeam(targetUserId, teamId, team.guildId),
        ]);
        acceptanceCommitted = latestInvite?.status === InviteStatus.ACCEPTED && durableMember;
        if (acceptanceCommitted) return;

        const freshMember = await fetchGuildMemberIfPresent(guild, targetUserId);
        // Compensate only a role proven absent before this attempt. This is safe
        // even after claim loss because all newer role work uses this same lock.
        if (roleWasPresentBeforeAttempt === false && freshMember?.roles.cache.has(team.roleId)) {
          await lock.assertOwned();
          await freshMember.roles.remove(team.roleId, 'Компенсация незавершённого вступления');
          const verified = await fetchGuildMemberIfPresent(freshMember.guild, targetUserId);
          if (verified?.roles.cache.has(team.roleId)) {
            throw new Error(`Team role ${team.roleId} is still present after invite compensation`);
          }
        }
        if (await db.isInviteAcceptClaimOwned(claimedInvite.id, acceptToken)) {
          const retryStatus = claimedInvite.expiresAt <= new Date()
            ? InviteStatus.EXPIRED
            : InviteStatus.PENDING;
          await db.releaseClaimedInvite(claimedInvite.id, acceptToken, retryStatus);
        }
      });
    } catch (recoveryError) {
      // Unknown database/Discord outcome: retain the claim. The scheduler will
      // repeat the same locked verification and compensation.
      log.error('Статус принятия инвайта не подтверждён; claim сохранён', {
        error: String(recoveryError), inviteId: claimedInvite.id,
      });
      await interaction.editReply({
        embeds: [tmWarn('Исход вступления проверяется автоматически; повторно кнопку не нажимайте.')],
        components: [],
      }).catch(() => null);
      return;
    }

    if (acceptanceCommitted) {
      log.warn(`Принятие инвайта ${targetUserId} committed при потере ответа БД`);
    } else {
    log.error(`Ошибка принятия инвайта ${targetUserId}`, { error: String(err) });
    await interaction.editReply({
      embeds: [tmError(`Не удалось присоединиться к команде. Возможно, команда заполнена (максимум ${MAX_TEAM_SIZE}) или вы уже вступили в другую.`)],
      components: [],
    });
    return;
    }
  }

  await interaction.editReply({
    embeds: [tmSuccess(`Вы присоединились к команде «${team.name}»! 🎉`)],
    components: [],
  });

  log.info(`Инвайт принят: ${interaction.user.tag} → «${team.name}»`);

  // Обновить заявку в канале одобрений
  await updateApplicationMessage(team.guildId, teamId, client);
}

// ═══════════════════════════════════════════════
//  Одобрение / Отклонение заявки
// ═══════════════════════════════════════════════

export async function handleApplicationReview(
  interaction: ButtonInteraction,
  action: 'approve' | 'reject',
  applicationId: string,
  client: BublikClient,
): Promise<void> {
  await interaction.deferUpdate();

  const guild = interaction.guild;
  if (!guild) {
    await interaction.followUp({ embeds: [tmError('Заявки можно рассматривать только на сервере.')], ephemeral: true });
    return;
  }

  // Older deployed messages encoded teamId in this slot. Resolve both forms so
  // hardening does not strand already-published applications.
  let applicationSnapshot = await db.getApplication(applicationId);
  if (!applicationSnapshot) {
    const legacyApplication = await db.getPendingApplication(applicationId);
    if (legacyApplication) applicationSnapshot = await db.getApplication(legacyApplication.id);
  }
  if (!applicationSnapshot || applicationSnapshot.team.guildId !== guild.id) {
    await interaction.followUp({ embeds: [tmError('Заявка не найдена на этом сервере.')], ephemeral: true });
    return;
  }
  const config = applicationSnapshot.team.config;

  // Fetch a fresh member snapshot at the terminal button submit. Cached roles
  // from when the message was rendered are not an authorization decision.
  const member = await guild.members.fetch({ user: interaction.user.id, force: true }).catch(() => null);
  const canReview = member !== null && canReviewApplication({
    isAdministrator: member.permissions.has(PermissionsBitField.Flags.Administrator),
    canManageGuild: member.permissions.has(PermissionsBitField.Flags.ManageGuild),
    roleIds: member.roles.cache.keys(),
  }, config.approverRoleIds);

  if (!canReview) {
    await interaction.followUp({ embeds: [tmError('У вас нет прав для рассмотрения заявок.')], ephemeral: true });
    return;
  }

  const reviewClaim = await db.claimApplicationReview(applicationSnapshot.id, interaction.user.id, action);
  if (!reviewClaim) {
    await interaction.followUp({ embeds: [tmError('Заявка не найдена или уже обработана.')], ephemeral: true });
    return;
  }

  const application = reviewClaim.application;
  const reviewToken = reviewClaim.token;
  const team = application.team;
  const reviewingStatus = `reviewing_${action}`;

  if (action === 'reject') {
    let rejectionCommitted = false;
    try {
      const rejected = await db.rejectClaimedApplication(
        application.id,
        team.id,
        interaction.user.id,
        reviewToken,
      );
      if (!rejected) throw new Error('Application/team state changed before rejection commit');
      rejectionCommitted = true;
    } catch (err) {
      // The DB response itself may be lost after COMMIT. Re-read before
      // releasing the claim; a terminal rejection must never be resurrected.
      let latest;
      try {
        latest = await db.getApplication(application.id);
      } catch (readError) {
        log.error('Исход отклонения не подтверждён; fenced claim сохранён', {
          error: String(readError), applicationId: application.id,
        });
        await interaction.followUp({
          embeds: [tmWarn('Исход операции проверяется автоматически; повторно кнопку не нажимайте.')],
          ephemeral: true,
        });
        return;
      }
      rejectionCommitted = Boolean(
        latest?.status === ApplicationStatus.REJECTED &&
        latest.team.status === TeamStatus.DISBANDED,
      );
      if (!rejectionCommitted) {
        await db.releaseApplicationReview(
          application.id,
          reviewingStatus,
          interaction.user.id,
          reviewToken,
        ).catch(() => null);
      }
      log.error('Не удалось отклонить заявку с согласованием Discord/БД', {
        error: String(err), applicationId: application.id, rejectionCommitted,
      });
      errorReporter.moduleError(err, 'teams', `Отклонение заявки ${application.id}`);
      if (!rejectionCommitted) {
        await interaction.followUp({
          embeds: [tmError('Не удалось зафиксировать отклонение заявки. Повторите действие.')],
          ephemeral: true,
        });
        return;
      }
    }

    try {
      await deleteRoleIfExists(guild, team.roleId, 'Заявка на команду отклонена');
    } catch (err) {
      // Rejection is already terminal. Keep members as the durable cleanup
      // tracker; the disband recovery worker retries the idempotent role delete.
      log.error('Заявка отклонена, Discord-роль ожидает повторной очистки', {
        error: String(err), applicationId: application.id, teamId: team.id,
      });
      errorReporter.moduleError(err, 'teams', `Очистка роли отклонённой команды ${team.id}`);
      await interaction.followUp({
        embeds: [tmWarn('Заявка отклонена. Очистка Discord-роли будет автоматически продолжена.')],
        ephemeral: true,
      });
      return;
    }

    try {
      await db.cleanupDisbandedTeamRelations(team.id);
    } catch (err) {
      log.error('Заявка отклонена, но очистка состава требует повтора', { error: String(err), teamId: team.id });
      errorReporter.moduleError(err, 'teams', `Очистка отклонённой команды ${team.id}`);
      await interaction.followUp({
        embeds: [tmError('Заявка отклонена, но очистка состава ещё не завершена. Система повторит её автоматически.')],
        ephemeral: true,
      });
      return;
    }

    // Уведомить лидера
    const leader = await client.users.fetch(team.leaderId).catch(() => null);
    if (leader) await leader.send({ embeds: [tmError(`Заявка на создание команды «${team.name}» была отклонена.`)] }).catch(() => null);

    await interaction.editReply({
      embeds: [tmError(`Заявка на команду «${team.name}» отклонена пользователем ${interaction.user.tag}.`)],
      components: [],
    });

    log.info(`Заявка «${team.name}» отклонена: ${interaction.user.tag}`);
    return;
  }

  // Approve
  const memberCount = await db.getMemberCount(team.id);
  if (memberCount < config.minSize) {
    await db.releaseApplicationReview(application.id, reviewingStatus, interaction.user.id, reviewToken);
    await interaction.followUp({
      embeds: [tmWarn(`В команде пока **${memberCount}/${config.minSize}** участников. Дождитесь набора.`)],
      ephemeral: true,
    });
    return;
  }

  let role: Role | null;
  try {
    role = await fetchRoleIfExists(guild, team.roleId);
  } catch (err) {
    await db.releaseApplicationReview(
      application.id,
      reviewingStatus,
      interaction.user.id,
      reviewToken,
    ).catch(() => null);
    log.error('Discord не подтвердил роль команды при одобрении', { error: String(err), roleId: team.roleId });
    await interaction.followUp({ embeds: [tmError('Discord не подтвердил роль команды; заявка оставлена ожидающей.')], ephemeral: true });
    return;
  }
  if (!role) {
    await db.releaseApplicationReview(application.id, reviewingStatus, interaction.user.id, reviewToken);
    await interaction.followUp({ embeds: [tmError('Роль команды не найдена; заявка оставлена ожидающей.')], ephemeral: true });
    return;
  }

  const wasMentionable = role.mentionable;
  if (!await db.setApplicationReviewRoleBaseline(application.id, reviewToken, wasMentionable)) {
    await interaction.followUp({
      embeds: [tmWarn('Рассмотрение заявки уже перехвачено восстановлением; действие безопасно отложено.')],
      ephemeral: true,
    });
    return;
  }
  let approvalCommitted = false;
  try {
    if (!wasMentionable) await role.edit({ mentionable: true, reason: 'Команда одобрена' });
    const approved = await db.approveClaimedApplication(
      application.id,
      team.id,
      interaction.user.id,
      config.minSize,
      reviewToken,
    );
    if (!approved) throw new Error('Application/team state changed before approval commit');
    approvalCommitted = true;
  } catch (err) {
    let latest = null;
    try {
      latest = await db.getApplication(application.id);
      approvalCommitted = Boolean(
        latest?.status === ApplicationStatus.APPROVED &&
        latest.team.status === TeamStatus.ACTIVE,
      );
    } catch (readError) {
      log.error('Исход одобрения не подтверждён; claim оставлен recovery', {
        error: String(readError), applicationId: application.id,
      });
      await interaction.followUp({
        embeds: [tmWarn('Исход операции проверяется автоматически; повторно кнопку не нажимайте.')],
        ephemeral: true,
      });
      return;
    }

    if (!approvalCommitted) {
      const claimOwned = await db.isApplicationReviewClaimOwned(application.id, reviewToken);
      // If recovery already fenced us, a durable PENDING/FORMING state still
      // requires the unapproved role invariant. Force-fetch after our own REST
      // call has settled so a slow response cannot win last.
      if (!wasMentionable && (claimOwned || (
        latest?.status === ApplicationStatus.PENDING && latest.team.status === TeamStatus.FORMING
      ))) {
        const freshRole = await guild.roles.fetch(team.roleId, { force: true }).catch(() => null);
        if (freshRole?.mentionable) {
          await freshRole.edit({ mentionable: false, reason: 'Компенсация незавершённого одобрения' });
        }
      }
      if (claimOwned) {
        await db.releaseApplicationReview(
          application.id,
          reviewingStatus,
          interaction.user.id,
          reviewToken,
        );
      }
      log.error('Не удалось одобрить заявку с согласованием Discord/БД', { error: String(err), applicationId: application.id });
      errorReporter.moduleError(err, 'teams', `Одобрение заявки ${application.id}`);
      await interaction.followUp({ embeds: [tmError('Не удалось одобрить заявку; состояние будет перепроверено автоматически.')], ephemeral: true });
      return;
    }
    log.warn(`Одобрение заявки ${application.id} committed при потере ответа БД`);
  }

  // Уведомить лидера
  const leader = await client.users.fetch(team.leaderId).catch(() => null);
  if (leader) await leader.send({ embeds: [tmSuccess(`Команда «${team.name}» одобрена! 🎉 Теперь вы можете участвовать в ПБ как команда.`)] }).catch(() => null);

  await interaction.editReply({
    embeds: [tmSuccess(`Команда «${team.name}» одобрена пользователем ${interaction.user.tag}!`)],
    components: [],
  });

  log.info(`Команда «${team.name}» одобрена: ${interaction.user.tag}`);
}

// ═══════════════════════════════════════════════
//  Обновление сообщения заявки
// ═══════════════════════════════════════════════

async function updateApplicationMessage(
  guildId: string,
  teamId: string,
  client: BublikClient,
): Promise<void> {
  try {
    const config = await db.getConfig(guildId);
    if (!config?.applicationChannelId) return;

    const application = await db.getPendingApplication(teamId);
    if (!application?.messageId) return;

    const guild = client.guilds.cache.get(guildId);
    if (!guild) return;

    const channel = guild.channels.cache.get(config.applicationChannelId);
    if (!channel?.isTextBased()) return;

    const team = await db.getTeam(teamId);
    if (!team) return;

    const members = await db.getTeamMembers(teamId);
    const pendingInvites = await db.getPendingInvites(teamId);
    const leader = await client.users.fetch(team.leaderId).catch(() => null);

    const embed = buildApplicationEmbed(
      team.name,
      leader?.tag ?? 'Unknown',
      team.leaderId,
      members,
      pendingInvites.length,
      config.minSize,
    );
    const buttons = buildApplicationButtons(application.id);

    const msg = await channel.messages.fetch(application.messageId).catch(() => null);
    if (msg) {
      await msg.edit({ embeds: [embed], components: [buttons] }).catch(() => null);
    }
  } catch (err) {
    log.error('Ошибка обновления сообщения заявки', { error: String(err) });
  }
}

// ═══════════════════════════════════════════════
//  Проверка истёкших инвайтов (шедулер)
// ═══════════════════════════════════════════════

const INVITE_EXPIRY_TASK = 'teams:inviteExpiry';

export function startInviteExpiryChecker(client: BublikClient): void {
  unscheduleTask(INVITE_EXPIRY_TASK);
  scheduleTask(INVITE_EXPIRY_TASK, INVITE_EXPIRY_CHECK_MS, async () => {
    await checkExpiredInvites(client);
  }, { exclusive: true, immediate: true });
}

export function stopInviteExpiryChecker(): void {
  unscheduleTask(INVITE_EXPIRY_TASK);
}

async function checkExpiredInvites(client: BublikClient): Promise<void> {
  const leaseCutoff = new Date(Date.now() - 5 * 60_000);
  let recoveredInvites = 0;
  for (const invite of await db.getStaleInviteClaims(leaseCutoff)) {
    if (!isGuildAllowed(invite.team.guildId)) continue;
    try {
      const guild = client.guilds.cache.get(invite.team.guildId);
      if (!guild) continue;
      await withMemberRoleLock(invite.team.guildId, invite.userId, async (lock) => {
        // Claim only after acquiring the cross-module role lock. Otherwise a
        // recovery worker could fence a live accept while merely waiting.
        const recovery = await db.claimStaleInviteRecovery(invite.id, leaseCutoff);
        if (!recovery) return;
        const member = await fetchGuildMemberIfPresent(guild, recovery.invite.userId);
        const durableMember = await db.isMemberOfTeam(
          recovery.invite.userId,
          recovery.invite.teamId,
          recovery.invite.team.guildId,
        );
        if (
          !durableMember && recovery.roleWasPresent === false &&
          member?.roles.cache.has(recovery.invite.team.roleId)
        ) {
          await lock.assertOwned();
          await member.roles.remove(recovery.invite.team.roleId, 'Восстановление прерванного вступления в команду');
          const verified = await fetchGuildMemberIfPresent(guild, recovery.invite.userId);
          if (verified?.roles.cache.has(recovery.invite.team.roleId)) {
            throw new Error('Invite recovery role removal was not confirmed');
          }
        }
        const status = recovery.invite.expiresAt <= new Date() ? InviteStatus.EXPIRED : InviteStatus.PENDING;
        if (await db.releaseClaimedInvite(recovery.invite.id, recovery.token, status)) recoveredInvites++;
      });
    } catch (err) {
      log.error('Не удалось восстановить зависшее принятие инвайта', { error: String(err), inviteId: invite.id });
    }
  }
  let recoveredReviews = 0;
  for (const application of await db.getStaleApplicationReviews(leaseCutoff)) {
    if (!isGuildAllowed(application.team.guildId)) continue;
    try {
      const recovery = await db.claimStaleApplicationReviewRecovery(application.id, leaseCutoff);
      if (!recovery) continue;
      const current = recovery.application;
      if (
        current.status === 'reviewing_approve' &&
        current.team.status === TeamStatus.FORMING &&
        recovery.wasMentionable === false
      ) {
        const guild = client.guilds.cache.get(current.team.guildId);
        if (!guild) continue;
        const role = await guild.roles.fetch(current.team.roleId, { force: true }).catch(() => null);
        if (role?.mentionable) {
          await role.edit({ mentionable: false, reason: 'Восстановление прерванного одобрения команды' });
          const verified = await guild.roles.fetch(current.team.roleId, { force: true }).catch(() => null);
          if (verified?.mentionable) throw new Error('Application recovery mentionable=false was not confirmed');
        }
      }
      if (
        current.reviewerId &&
        await db.releaseApplicationReview(current.id, current.status, current.reviewerId, recovery.token)
      ) recoveredReviews++;
    } catch (err) {
      log.error('Не удалось восстановить зависшее рассмотрение заявки', { error: String(err), applicationId: application.id });
    }
  }
  if (recoveredInvites || recoveredReviews) {
    log.warn('Восстановлены зависшие CAS-операции Teams', { recoveredInvites, recoveredReviews });
  }

  // Pending/forming applications must never retain mentionable=true from a
  // crashed or fenced approval worker.
  for (const application of await db.getPendingApplicationRoleAudits()) {
    if (!isGuildAllowed(application.team.guildId)) continue;
    const guild = client.guilds.cache.get(application.team.guildId);
    if (!guild) continue;
    try {
      const role = await guild.roles.fetch(application.team.roleId, { force: true }).catch(() => null);
      if (role?.mentionable) {
        await role.edit({ mentionable: false, reason: 'Teams: аудит ожидающей заявки' });
      }
    } catch (err) {
      log.warn('Не удалось проверить mentionable ожидающей заявки', {
        error: String(err), applicationId: application.id,
      });
    }
  }

  // A pending row with no messageId is a durable DM notification intent.
  for (const invite of await db.getPendingInvitesWithoutMessage()) {
    if (!isGuildAllowed(invite.team.guildId)) continue;
    try {
      const guild = client.guilds.cache.get(invite.team.guildId);
      if (!guild) continue;
      const target = await fetchGuildMemberIfPresent(guild, invite.userId);
      if (!target) continue;
      const leader = await client.users.fetch(invite.team.leaderId).catch(() => null);
      const message = await target.send({
        embeds: [buildInviteEmbed(invite.team.name, leader?.tag ?? 'Командир', guild.name, 0)],
        components: [buildInviteButtons(invite.teamId, invite.userId)],
      });
      await db.setInviteMessage(invite.teamId, invite.userId, message.id);
    } catch (err) {
      log.warn('Pending DM-инвайт сохранён для повторной отправки', {
        error: String(err), inviteId: invite.id,
      });
    }
  }

  // Recover the narrow crash window between sending an application message and
  // persisting its Discord id. If the message was never sent, compensate the
  // half-created team instead of blocking its leader forever.
  for (const application of await db.getPendingTeamCreationCleanups()) {
    if (!isGuildAllowed(application.team.guildId)) continue;
    try {
      const guild = client.guilds.cache.get(application.team.guildId);
      if (!guild) continue;
      if (await cleanupPendingTeamCreation(application, guild)) {
        log.warn('Завершена отложенная компенсация создания команды', { teamId: application.teamId });
      }
    } catch (err) {
      log.error('Не удалось продолжить компенсацию создания команды; tracker сохранён', {
        error: String(err),
        applicationId: application.id,
      });
    }
  }

  for (const application of await db.getStaleUnlinkedApplications(leaseCutoff)) {
    if (!isGuildAllowed(application.team.guildId)) continue;
    try {
      const guild = client.guilds.cache.get(application.team.guildId);
      if (!guild) continue;
      const channelId = application.channelId ?? application.team.config.applicationChannelId;
      const channel = channelId ? await fetchChannelIfExists(guild, channelId) : null;
      if (channel?.isTextBased()) {
        const recent = await channel.messages.fetch({ limit: 100 });
        const message = recent.find(candidate =>
          messageContainsApplicationReviewId(candidate, application.id, application.teamId),
        );
        if (message) {
          if (await db.setApplicationMessage(application.id, message.id)) continue;

          // A false CAS is not permission to compensate from a stale snapshot:
          // another worker may already have linked or reviewed this application.
          const latest = await db.getApplication(application.id);
          if (mustPreserveCreationAfterFailedMessageLink(latest)) continue;
          log.warn('CAS привязки заявки не подтвердился при неизменном snapshot; очистка отложена', {
            applicationId: application.id,
          });
          continue;
        }
      }

      const claimed = await db.claimPendingTeamCreationCleanup(
        application.id,
        application.teamId,
        null,
        leaseCutoff,
      );
      if (!claimed) {
        // Re-read is deliberate: never delete Discord state based on the stale
        // row returned at the beginning of this scheduler pass.
        const latest = await db.getApplication(application.id);
        if (!mustPreserveCreationAfterFailedMessageLink(latest)) {
          log.warn('Cleanup CAS не подтвердился при неизменном snapshot; повтор отложен', {
            applicationId: application.id,
          });
        }
        continue;
      }
      const cleanup = await db.getApplication(application.id);
      if (!cleanup) continue;
      if (await cleanupPendingTeamCreation(cleanup, guild)) {
        log.warn('Компенсирована незавершённая команда без заявки', { teamId: application.teamId });
      }
    } catch (err) {
      log.error('Не удалось восстановить незавершённую заявку', { error: String(err), applicationId: application.id });
    }
  }

  const expired = await db.getExpiredInvites();
  for (const invite of expired) {
    if (!isGuildAllowed(invite.team.guildId)) continue;
    const changed = await db.transitionInvite(invite.teamId, invite.userId, InviteStatus.PENDING, InviteStatus.EXPIRED);
    if (changed) log.debug(`Инвайт истёк: ${invite.userId} → «${invite.team.name}»`);
  }
}

function messageContainsCustomId(message: Message, customId: string): boolean {
  return message.components.some(component => componentTreeContainsCustomId(component, customId));
}

function messageContainsApplicationReviewId(
  message: Message,
  applicationId: string,
  teamId: string,
): boolean {
  // Older deployed messages used teamId in the final custom-id slot.
  return [applicationId, teamId].some(id =>
    messageContainsCustomId(message, `${TM_PREFIX}${TM_SEP}app${TM_SEP}approve${TM_SEP}${id}`),
  );
}

// Очистка временных данных
export function clearPendingSelections(): void {
  pendingSelections.clear();
}
