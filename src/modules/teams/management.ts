// ═══════════════════════════════════════════════
//  Teams — Управление командой (лидер)
// ═══════════════════════════════════════════════

import {
  ButtonInteraction,
  UserSelectMenuInteraction,
  UserSelectMenuBuilder,
  ActionRowBuilder,
  Guild,
  Role,
} from 'discord.js';
import type { BublikClient } from '../../bot';
import { logger } from '../../core/Logger';
import { errorReporter } from '../../core/ErrorReporter';
import { isGuildAllowed } from '../../core/Whitelist';
import { fetchGuildMemberIfPresent, hasDiscordErrorCode } from '../../utils/helpers';
import { scheduleTask, unscheduleTask } from '../../core/SchedulerManager';
import { withMemberRoleLock } from '../../core/MemberRoleLock';

import {
  TeamStatus,
  DISBAND_CHECK_MS,
  DISBAND_GRACE_DAYS,
  MAX_TEAM_SIZE,
  MEMBER_KICK_RECOVERY_CHECK_MS,
  MEMBER_KICK_RECOVERY_LEASE_MS,
  isTeamOperationalStatus,
} from './constants';
import * as db from './database';
import {
  tmSuccess,
  tmError,
  tmWarn,
  buildTeamInfoEmbed,
  buildTeamManageButtons,
  buildInviteEmbed,
  buildInviteButtons,
} from './embeds';
import { getCurrentSeason } from './constants';

const log = logger.child('Teams:Management');

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

async function deleteRoleIfExists(guild: Guild, roleId: string, reason: string): Promise<void> {
  const role = await fetchRoleIfExists(guild, roleId);
  if (!role) return;
  try {
    await role.delete(reason);
  } catch (err) {
    if ((err as { code?: number }).code !== 10011) throw err;
  }
}

// ═══════════════════════════════════════════════
//  Информация о команде
// ═══════════════════════════════════════════════

export async function handleTeamInfo(
  interaction: ButtonInteraction | any,
  teamId: string,
  _client: BublikClient,
): Promise<void> {
  const team = await db.getTeam(teamId);
  if (!team || team.guildId !== interaction.guildId) {
    await interaction.reply({ embeds: [tmError('Команда не найдена.')], ephemeral: true });
    return;
  }

  const members = await db.getTeamMembers(teamId);
  const { season, year } = getCurrentSeason();
  const seasonStats = await db.getSeason(teamId, season, year);

  const embed = buildTeamInfoEmbed(
    team.name,
    team.leaderId,
    team.roleId,
    team.status,
    members.length,
    members,
    seasonStats,
  );

  const isLeader = interaction.user.id === team.leaderId && isTeamOperationalStatus(team.status);
  const components = isLeader ? buildTeamManageButtons(teamId) : [];

  await interaction.reply({ embeds: [embed], components, ephemeral: true });
}

// ═══════════════════════════════════════════════
//  Пригласить нового участника
// ═══════════════════════════════════════════════

export async function handleInviteNew(
  interaction: ButtonInteraction,
  teamId: string,
  _client: BublikClient,
): Promise<void> {
  const team = await db.getTeam(teamId);
  if (!team || team.guildId !== interaction.guildId) {
    await interaction.reply({ embeds: [tmError('Команда не найдена.')], ephemeral: true });
    return;
  }

  if (interaction.user.id !== team.leaderId) {
    await interaction.reply({ embeds: [tmError('Только лидер может приглашать.')], ephemeral: true });
    return;
  }

  if (!isTeamOperationalStatus(team.status)) {
    await interaction.reply({ embeds: [tmError('Команда расформирована.')], ephemeral: true });
    return;
  }

  await interaction.reply({
    embeds: [tmWarn('Выберите участника для приглашения:')],
    components: [buildInviteSingleSelect(teamId)],
    ephemeral: true,
  });
}

function buildInviteSingleSelect(teamId: string) {
  const select = new UserSelectMenuBuilder()
    .setCustomId(`tm:sel:invite_new:${teamId}`)
    .setPlaceholder('Выберите участника')
    .setMinValues(1)
    .setMaxValues(1);
  return new ActionRowBuilder<UserSelectMenuBuilder>().addComponents(select);
}

export async function handleInviteNewSelect(
  interaction: UserSelectMenuInteraction,
  teamId: string,
  _client: BublikClient,
): Promise<void> {
  await interaction.deferUpdate();

  const team = await db.getTeam(teamId);
  if (
    !team || team.guildId !== interaction.guildId || interaction.user.id !== team.leaderId ||
    !isTeamOperationalStatus(team.status)
  ) {
    await interaction.editReply({ embeds: [tmError('Команда не найдена или вы больше не её лидер.')], components: [] });
    return;
  }

  const config = await db.getConfig(team.guildId);
  if (!config) {
    await interaction.editReply({ embeds: [tmError('Конфигурация команд не найдена.')], components: [] });
    return;
  }

  const targetId = interaction.values[0];
  const guild = interaction.guild!;
  const member = guild.members.cache.get(targetId) || await guild.members.fetch(targetId).catch(() => null);

  if (!member || member.user.bot) {
    await interaction.editReply({ embeds: [tmError('Участник не найден.')], components: [] });
    return;
  }

  if (config.baseRoleId && !member.roles.cache.has(config.baseRoleId)) {
    await interaction.editReply({ embeds: [tmError('У участника нет базовой роли.')], components: [] });
    return;
  }

  const existingTeam = await db.getMemberTeam(targetId, team.guildId);
  if (existingTeam) {
    await interaction.editReply({ embeds: [tmError(`${member.user.tag} уже в команде «${existingTeam.name}».`)], components: [] });
    return;
  }

  const memberCount = await db.getMemberCount(team.id);
  if (memberCount >= MAX_TEAM_SIZE) {
    await interaction.editReply({ embeds: [tmError(`Команда заполнена (максимум ${MAX_TEAM_SIZE} участников).`)], components: [] });
    return;
  }

  const inviteTimeoutMs = (config.inviteTimeoutH || 24) * 3_600_000;
  const expiresAt = new Date(Date.now() + inviteTimeoutMs);

  try {
    let persisted = false;
    try {
      persisted = await db.createInviteByLeader(
        { teamId, userId: targetId, expiresAt },
        team.guildId,
        interaction.user.id,
        MAX_TEAM_SIZE,
      );
    } catch (persistError) {
      const existing = await db.getInvite(teamId, targetId).catch(() => null);
      if (existing?.status !== 'pending') throw persistError;
      persisted = true;
    }
    if (!persisted) throw new Error('Team state changed while creating invite');

    const dmMsg = await member.send({
      embeds: [buildInviteEmbed(team.name, interaction.user.tag, guild.name, team.members?.length ?? 0)],
      components: [buildInviteButtons(teamId, targetId)],
    });

    try {
      if (!await db.setInviteMessage(teamId, targetId, dmMsg.id)) {
        throw new Error('Invite message link CAS was lost');
      }
    } catch (linkError) {
      const existing = await db.getInvite(teamId, targetId).catch(() => null);
      // Never delete a DM while the database outcome is uncertain. Recovery
      // can resend a pending invite whose messageId is still null.
      if (existing?.messageId !== dmMsg.id) {
        log.warn('DM-инвайт отправлен, но привязка messageId ожидает recovery', {
          error: String(linkError), teamId, targetId, messageId: dmMsg.id,
        });
      }
    }

    await interaction.editReply({
      embeds: [tmSuccess(`Приглашение отправлено **${member.user.tag}**!`)],
      components: [],
    });

    log.info(`Инвайт отправлен: ${member.user.tag} → «${team.name}» (лидер ${interaction.user.tag})`);
  } catch (err) {
    log.error(`Ошибка отправки инвайта`, { error: String(err) });
    await interaction.editReply({ embeds: [tmError('Ошибка при отправке приглашения.')], components: [] });
  }
}

// ═══════════════════════════════════════════════
//  Исключить участника
// ═══════════════════════════════════════════════

export async function handleKick(
  interaction: ButtonInteraction,
  teamId: string,
  _client: BublikClient,
): Promise<void> {
  const team = await db.getTeam(teamId);
  if (
    !team || team.guildId !== interaction.guildId || interaction.user.id !== team.leaderId ||
    !isTeamOperationalStatus(team.status)
  ) {
    await interaction.reply({ embeds: [tmError('Только лидер может исключать.')], ephemeral: true });
    return;
  }

  const members = await db.getTeamMembers(teamId);
  const kickable = members.filter(m => m.userId !== team.leaderId);

  if (kickable.length === 0) {
    await interaction.reply({ embeds: [tmWarn('Некого исключать — вы единственный участник.')], ephemeral: true });
    return;
  }

  await interaction.reply({
    embeds: [tmWarn('Выберите участника для исключения:')],
    components: [buildKickSelect(teamId)],
    ephemeral: true,
  });
}

function buildKickSelect(teamId: string) {
  const select = new UserSelectMenuBuilder()
    .setCustomId(`tm:sel:kick:${teamId}`)
    .setPlaceholder('Выберите участника')
    .setMinValues(1)
    .setMaxValues(1);
  return new ActionRowBuilder<UserSelectMenuBuilder>().addComponents(select);
}

export async function handleKickSelect(
  interaction: UserSelectMenuInteraction,
  teamId: string,
  client: BublikClient,
): Promise<void> {
  await interaction.deferUpdate();

  const team = await db.getTeam(teamId);
  if (
    !team || team.guildId !== interaction.guildId || interaction.user.id !== team.leaderId ||
    !isTeamOperationalStatus(team.status)
  ) {
    await interaction.editReply({ embeds: [tmError('Команда не найдена или вы больше не её лидер.')], components: [] });
    return;
  }

  const targetId = interaction.values[0];

  if (targetId === team.leaderId) {
    await interaction.editReply({ embeds: [tmError('Нельзя исключить лидера.')], components: [] });
    return;
  }

  const isCurrentMember = await db.isMemberOfTeam(targetId, teamId, team.guildId);
  if (!isCurrentMember) {
    await interaction.editReply({ embeds: [tmError('Участник уже не состоит в этой команде.')], components: [] });
    return;
  }

  const guild = interaction.guild!;
  let kickClaim: db.PendingTeamMemberKick | null = null;

  try {
    await withMemberRoleLock(team.guildId, targetId, async (lock) => {
      const member = await fetchGuildMemberIfPresent(guild, targetId);
      kickClaim = await db.claimMemberKick(teamId, targetId, team.guildId, interaction.user.id);
      if (!kickClaim) throw new Error('Membership changed or kick is already being processed');

      if (member?.roles.cache.has(kickClaim.roleId)) {
        try {
          await lock.assertOwned();
          await member.roles.remove(kickClaim.roleId, `Исключён из команды «${team.name}»`);
        } catch (err) {
          if (!hasDiscordErrorCode(err, 10007) && !hasDiscordErrorCode(err, 10011)) throw err;
        }
        const verified = await fetchGuildMemberIfPresent(guild, targetId);
        if (verified?.roles.cache.has(kickClaim.roleId)) {
          throw new Error(`Team role ${kickClaim.roleId} is still present after kick`);
        }
      }

      await lock.assertOwned();
      const removed = await db.finalizeClaimedMemberKick(kickClaim);
      if (!removed) throw new Error('Durable kick intent disappeared before membership finalization');
    });

    // Уведомить в ЛС
    try {
      const user = await client.users.fetch(targetId).catch(() => null);
      if (user) {
        await user.send({ embeds: [tmWarn(`Вы были исключены из команды «${team.name}».`)] }).catch(() => null);
      }
    } catch { /* ignore */ }

    await interaction.editReply({
      embeds: [tmSuccess(`<@${targetId}> исключён из команды.`)],
      components: [],
    });

    log.info(`Исключён: <@${targetId}> из «${team.name}» (лидер ${interaction.user.tag})`);

    // Проверить минимальный размер
    await checkTeamSize(team.id, team.guildId, client);
  } catch (err) {
    log.error('Ошибка исключения', { error: String(err) });
    errorReporter.moduleError(err, 'teams', `Исключение ${targetId} из ${teamId}`);
    await interaction.editReply({
      embeds: [kickClaim
        ? tmWarn('Исключение зафиксировано и будет безопасно завершено автоматически.')
        : tmError('Ошибка при исключении.')],
      components: [],
    });
  }
}

// ═══════════════════════════════════════════════
//  Передача лидерства
// ═══════════════════════════════════════════════

export async function handleTransfer(
  interaction: ButtonInteraction,
  teamId: string,
  _client: BublikClient,
): Promise<void> {
  const team = await db.getTeam(teamId);
  if (
    !team || team.guildId !== interaction.guildId || interaction.user.id !== team.leaderId ||
    !isTeamOperationalStatus(team.status)
  ) {
    await interaction.reply({ embeds: [tmError('Только лидер может передать лидерство.')], ephemeral: true });
    return;
  }

  await interaction.reply({
    embeds: [tmWarn('Выберите нового лидера:')],
    components: [buildTransferSelect(teamId)],
    ephemeral: true,
  });
}

function buildTransferSelect(teamId: string) {
  const select = new UserSelectMenuBuilder()
    .setCustomId(`tm:sel:transfer:${teamId}`)
    .setPlaceholder('Выберите нового лидера')
    .setMinValues(1)
    .setMaxValues(1);
  return new ActionRowBuilder<UserSelectMenuBuilder>().addComponents(select);
}

export async function handleTransferSelect(
  interaction: UserSelectMenuInteraction,
  teamId: string,
  client: BublikClient,
): Promise<void> {
  await interaction.deferUpdate();

  const team = await db.getTeam(teamId);
  if (
    !team || team.guildId !== interaction.guildId || interaction.user.id !== team.leaderId ||
    !isTeamOperationalStatus(team.status)
  ) {
    await interaction.editReply({ embeds: [tmError('Команда не найдена или вы больше не её лидер.')], components: [] });
    return;
  }

  const targetId = interaction.values[0];
  if (targetId === team.leaderId) {
    await interaction.editReply({ embeds: [tmWarn('Этот участник уже является лидером.')], components: [] });
    return;
  }

  // Проверить что целевой — член команды
  const memberTeam = await db.getMemberTeam(targetId, team.guildId);
  if (!memberTeam || memberTeam.id !== teamId) {
    await interaction.editReply({ embeds: [tmError('Этот человек не является членом команды.')], components: [] });
    return;
  }

  const transferred = await db.transferLeadership(teamId, team.guildId, interaction.user.id, targetId);
  if (!transferred) {
    await interaction.editReply({ embeds: [tmError('Состав или лидер команды уже изменился. Обновите панель.')], components: [] });
    return;
  }

  await interaction.editReply({
    embeds: [tmSuccess(`Лидерство передано <@${targetId}>!`)],
    components: [],
  });

  // Уведомить нового лидера
  try {
    const user = await client.users.fetch(targetId).catch(() => null);
    if (user) {
      await user.send({ embeds: [tmSuccess(`Вы стали лидером команды «${team.name}»! 👑`)] }).catch(() => null);
    }
  } catch { /* ignore */ }

  log.info(`Лидерство «${team.name}» передано: ${interaction.user.tag} → <@${targetId}>`);
}

// ═══════════════════════════════════════════════
//  Расформирование
// ═══════════════════════════════════════════════

export async function handleDisband(
  interaction: ButtonInteraction,
  teamId: string,
  client: BublikClient,
): Promise<void> {
  const team = await db.getTeam(teamId);
  if (!team || team.guildId !== interaction.guildId || interaction.user.id !== team.leaderId) {
    await interaction.reply({ embeds: [tmError('Только лидер может расформировать.')], ephemeral: true });
    return;
  }

  await interaction.deferReply({ ephemeral: true });
  try {
    await disbandTeam(team.id, team.guildId, client, 'Лидер расформировал команду');
    await interaction.editReply({ embeds: [tmSuccess(`Команда «${team.name}» расформирована.`)] });
  } catch (err) {
    log.error('Ошибка расформирования команды', { error: String(err), teamId });
    errorReporter.moduleError(err, 'teams', `Расформирование ${teamId}`);
    const latest = await db.getTeam(teamId).catch(() => null);
    await interaction.editReply({
      embeds: [latest?.status === TeamStatus.DISBANDED
        ? tmSuccess(`Команда «${team.name}» расформирована.`)
        : latest?.status === TeamStatus.DELETING
          ? tmWarn('Расформирование зафиксировано. Очистка Discord-роли будет автоматически продолжена.')
          : tmError('Не удалось зафиксировать расформирование команды.')],
    });
  }
}

export async function disbandTeam(
  teamId: string,
  guildId: string,
  client: BublikClient,
  reason: string,
): Promise<void> {
  const team = await db.getTeam(teamId);
  if (!team || team.guildId !== guildId) throw new Error('Team not found in the requested guild');
  if (team.status === TeamStatus.DISBANDED) return;

  const guild = client.guilds.cache.get(guildId);
  if (!guild) throw new Error('Guild is unavailable during team disband');

  const reservedFrom = await db.reserveTeamDisband(teamId);
  if (!reservedFrom) throw new Error('Team state changed or has an active PB session');

  // `deleting` is a durable terminal intent. A REST timeout may mean Discord
  // already removed the role, so rolling back to a live status would create a
  // live team without its role. Recovery safely repeats this idempotent delete.
  await deleteRoleIfExists(guild, team.roleId, reason);

  const finalized = await db.finalizeTeamDisband(teamId);
  if (!finalized) throw new Error('Could not finalize reserved team disband');

  log.info(`Команда «${team.name}» расформирована: ${reason}`);
}

// ═══════════════════════════════════════════════
//  Проверка размера команды (авто-расформирование)
// ═══════════════════════════════════════════════

export async function checkTeamSize(
  teamId: string,
  guildId: string,
  client: BublikClient,
): Promise<void> {
  const team = await db.getTeam(teamId);
  if (
    !team || team.guildId !== guildId ||
    (team.status !== TeamStatus.ACTIVE && team.status !== TeamStatus.DISBANDING)
  ) return;

  const config = await db.getConfig(guildId);
  if (!config) return;

  const count = await db.getMemberCount(teamId);

  if (count < config.minSize) {
    if (team.status !== TeamStatus.DISBANDING) {
      // Начать обратный отсчёт
      const changed = await db.transitionTeamStatus(
        teamId,
        [TeamStatus.ACTIVE],
        TeamStatus.DISBANDING,
        { disbandWarningAt: new Date() },
      );
      if (!changed) return;

      // Уведомить лидера
      try {
        const leader = await client.users.fetch(team.leaderId).catch(() => null);
        if (leader) {
          await leader.send({
            embeds: [tmWarn(
              `Команда «${team.name}» опустилась ниже минимума (${count}/${config.minSize}).\n` +
              `У вас **${config.disbandGraceDays || DISBAND_GRACE_DAYS} дней**, чтобы набрать людей, иначе команда будет расформирована.`,
            )],
          }).catch(() => null);
        }
      } catch { /* ignore */ }

      log.info(`Команда «${team.name}» начала обратный отсчёт расформирования (${count}/${config.minSize})`);
    }
  } else if (team.status === TeamStatus.DISBANDING) {
    // Набрали снова — отменить расформирование
    const changed = await db.transitionTeamStatus(
      teamId,
      [TeamStatus.DISBANDING],
      TeamStatus.ACTIVE,
      { disbandWarningAt: null },
    );
    if (!changed) return;

    try {
      const leader = await client.users.fetch(team.leaderId).catch(() => null);
      if (leader) {
        await leader.send({
          embeds: [tmSuccess(`Команда «${team.name}» снова укомплектована! Расформирование отменено.`)],
        }).catch(() => null);
      }
    } catch { /* ignore */ }

    log.info(`Команда «${team.name}» снова укомплектована, расформирование отменено`);
  }
}

// ═══════════════════════════════════════════════
//  Шедулер проверки расформирования
// ═══════════════════════════════════════════════

const DISBAND_TASK = 'teams:disband';
const MEMBER_KICK_RECOVERY_TASK = 'teams:memberKickRecovery';

export function startDisbandChecker(client: BublikClient): void {
  unscheduleTask(DISBAND_TASK);
  unscheduleTask(MEMBER_KICK_RECOVERY_TASK);
  scheduleTask(DISBAND_TASK, DISBAND_CHECK_MS, async () => {
    await checkDisbandingTeams(client);
  }, { exclusive: true, immediate: true });
  scheduleTask(MEMBER_KICK_RECOVERY_TASK, MEMBER_KICK_RECOVERY_CHECK_MS, async () => {
    await checkPendingMemberKicks(client);
  }, { exclusive: true, immediate: true });
}

export function stopDisbandChecker(): void {
  unscheduleTask(DISBAND_TASK);
  unscheduleTask(MEMBER_KICK_RECOVERY_TASK);
}

async function checkPendingMemberKicks(client: BublikClient): Promise<void> {
  // A kick intent is committed before Discord role removal. On crash/restart,
  // finish the external mutation and membership deletion at least once.
  const kickCutoff = new Date(Date.now() - MEMBER_KICK_RECOVERY_LEASE_MS);
  for (const claim of await db.getStalePendingMemberKicks(kickCutoff)) {
    if (!isGuildAllowed(claim.guildId)) continue;
    try {
      const guild = client.guilds.cache.get(claim.guildId);
      if (!guild) continue;
      const finalized = await withMemberRoleLock(claim.guildId, claim.userId, async (lock) => {
        const member = await fetchGuildMemberIfPresent(guild, claim.userId);
        if (member?.roles.cache.has(claim.roleId)) {
          try {
            await lock.assertOwned();
            await member.roles.remove(claim.roleId, `Восстановление исключения из команды «${claim.teamName}»`);
          } catch (err) {
            if (!hasDiscordErrorCode(err, 10007) && !hasDiscordErrorCode(err, 10011)) throw err;
          }
          const verified = await fetchGuildMemberIfPresent(guild, claim.userId);
          if (verified?.roles.cache.has(claim.roleId)) {
            throw new Error(`Team role ${claim.roleId} is still present after kick recovery`);
          }
        }
        await lock.assertOwned();
        return db.finalizeClaimedMemberKick(claim);
      });
      if (!finalized) continue;
      log.warn('Завершено прерванное исключение участника команды', {
        teamId: claim.teamId,
        userId: claim.userId,
      });
    } catch (err) {
      log.error('Не удалось восстановить исключение участника команды', {
        error: String(err),
        teamId: claim.teamId,
        userId: claim.userId,
      });
    }
  }
}

async function checkDisbandingTeams(client: BublikClient): Promise<void> {
  // Recover a crash after the Discord role was removed but before the DB
  // transaction was finalized.
  for (const team of await db.getDeletingTeams()) {
    if (!isGuildAllowed(team.guildId)) continue;
    try {
      await disbandTeam(team.id, team.guildId, client, 'Завершение прерванного расформирования');
    } catch (err) {
      log.error('Не удалось восстановить расформирование', { error: String(err), teamId: team.id });
    }
  }

  // Rejections are terminal before their Discord role is deleted. If cleanup
  // was interrupted, release the stale membership uniqueness constraints.
  for (const team of await db.getDisbandedTeamsWithMembers()) {
    if (!isGuildAllowed(team.guildId)) continue;
    try {
      const guild = client.guilds.cache.get(team.guildId);
      if (!guild) throw new Error(`Guild ${team.guildId} is unavailable`);
      await deleteRoleIfExists(guild, team.roleId, 'Завершение прерванного отклонения команды');
      await db.cleanupDisbandedTeamRelations(team.id);
    } catch (err) {
      log.error('Не удалось дочистить расформированную команду', { error: String(err), teamId: team.id });
    }
  }

  const teams = await db.getDisbandingTeams();
  const now = Date.now();

  for (const team of teams) {
    if (!isGuildAllowed(team.guildId)) continue;
    if (!team.disbandWarningAt) continue;
    const graceDays = team.config?.disbandGraceDays ?? DISBAND_GRACE_DAYS;
    const deadline = new Date(team.disbandWarningAt).getTime() + graceDays * 86_400_000;

    if (now >= deadline) {
      try {
        await disbandTeam(team.id, team.guildId, client, `Не набрали минимум за ${graceDays} дней`);
      } catch (err) {
        log.error('Не удалось автоматически расформировать команду', { error: String(err), teamId: team.id });
        continue;
      }

      // Уведомить лидера
      try {
        const leader = await client.users.fetch(team.leaderId).catch(() => null);
        if (leader) {
          await leader.send({
            embeds: [tmError(`Команда «${team.name}» расформирована: не удалось набрать минимум за ${graceDays} дней.`)],
          }).catch(() => null);
        }
      } catch { /* ignore */ }
    }
  }
}
