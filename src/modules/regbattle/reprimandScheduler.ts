// ═══════════════════════════════════════════════
//  RegBattle — Планировщик истечения выговоров
//
//  Периодически проверяет выговоры с истёкшим
//  сроком (expiresAt) и снимает роли.
// ═══════════════════════════════════════════════

import type { BublikClient } from '../../bot';
import { logger } from '../../core/Logger';
import { BublikEmbed } from '../../core/EmbedBuilder';
import { APPEAL_COOLDOWN_MS, REPRIMAND_EXPIRY_CHECK_INTERVAL_MS } from './constants';
import {
  getExpiredReprimands,
  getTransitionalReprimands,
  getReprimandsWithPendingAppealCleanup,
  claimReprimandForExpiry,
  hasOtherLiveReprimand,
  updateReprimandStatusCas,
  deleteReprimandStatusCas,
  getConfig,
} from './database';
import { scheduleTask, unscheduleTask } from '../../core/SchedulerManager';
import { isGuildAllowed } from '../../core/Whitelist';
import { getGuildLocale } from '../../core/GuildConfig';
import { isUnknownChannelError, isUnknownMemberError, isUnknownMessageError } from './safety';
import { updateReprimandMessage } from './handlers';

const log = logger.child('RegBattle:ReprimandScheduler');

/**
 * Запуск периодической проверки истёкших выговоров
 */
export function startReprimandExpiryChecker(client: BublikClient): void {
  scheduleTask('regbattle:reprimandExpiry', REPRIMAND_EXPIRY_CHECK_INTERVAL_MS, async () => {
    await recoverReprimandTransitions(client, true);
    await checkExpiredReprimands(client);
    await recoverTerminalAppealCleanup(client);
  });

  // A rolling deployment may leave another process alive; recover only stale
  // leases even on startup instead of racing a fresh interaction.
  void recoverReprimandTransitions(client, true).catch((error: unknown) =>
    log.error('Ошибка initial recovery выговоров', { error: String(error) }));
  void recoverTerminalAppealCleanup(client).catch((error: unknown) =>
    log.error('Ошибка initial cleanup каналов апелляций', { error: String(error) }));

  log.info('Планировщик истечения выговоров запущен');
}

/**
 * Остановка планировщика
 */
export function stopReprimandExpiryChecker(): void {
  unscheduleTask('regbattle:reprimandExpiry');
  log.info('Планировщик истечения выговоров остановлен');
}

/**
 * Проверить и обработать все истёкшие выговоры
 */
async function checkExpiredReprimands(client: BublikClient): Promise<void> {
  const expired = await getExpiredReprimands();
  if (expired.length === 0) return;

  // Группируем по гильдии для batch-fetch участников
  const byGuild = new Map<string, typeof expired>();
  for (const r of expired) {
    const arr = byGuild.get(r.guildId) ?? [];
    arr.push(r);
    byGuild.set(r.guildId, arr);
  }

  for (const [guildId, reprimands] of byGuild) {
    if (!isGuildAllowed(guildId)) continue;
    const guild = client.guilds.cache.get(guildId);
    if (!guild) continue;

    for (const reprimand of reprimands) {
      try {
        // DB is the authority. Only one process can move a live/stale record to
        // expiring; Redis/timer overlap therefore cannot double-finalise it.
        if (!(await claimReprimandForExpiry(reprimand.id))) continue;

        let fetchError: unknown = null;
        const offender = guild.members.cache.get(reprimand.offenderId) ??
          await guild.members.fetch(reprimand.offenderId).catch((error: unknown) => {
            fetchError = error;
            return null;
          });
        const unknownMember = isUnknownMemberError(fetchError);
        if (!offender && fetchError && !unknownMember) {
          await updateReprimandStatusCas(reprimand.id, ['expiring'], { status: 'pending_cleanup' });
          log.warn(`Отложена очистка выговора ${reprimand.id}: участник временно недоступен`, {
            error: String(fetchError),
          });
          continue;
        }

        // A Discord role represents the type, not one DB row. Keep it while a
        // second live reprimand of the same type still exists.
        const roleStillRequired = await hasOtherLiveReprimand(
          reprimand.id,
          reprimand.guildId,
          reprimand.offenderId,
          reprimand.typeRoleId,
        );
        if (offender && !roleStillRequired && offender.roles.cache.has(reprimand.typeRoleId)) {
          try {
            await offender.roles.remove(reprimand.typeRoleId, 'Срок выговора истёк');
          } catch (err) {
            await updateReprimandStatusCas(reprimand.id, ['expiring'], { status: 'pending_cleanup' });
            log.warn(`Очистка выговора ${reprimand.id} будет повторена: роль не снята у ${offender.user.tag}`, {
              error: String(err),
            });
            continue;
          }
        }

        // Keep a durable transitional state until the public message and
        // appeal-channel cleanup are confirmed. UI failures are therefore
        // retried instead of leaving live buttons on a terminal reprimand.
        if (!(await updateReprimandStatusCas(reprimand.id, ['expiring'], {
          status: 'expired_ui_pending',
        }))) continue;

        // Re-check after terminal commit. If two shared-role records expired in
        // parallel, the last commit now sees no live sibling and removes it.
        if (offender && offender.roles.cache.has(reprimand.typeRoleId)) {
          const stillRequiredAfterCommit = await hasOtherLiveReprimand(
            reprimand.id,
            reprimand.guildId,
            reprimand.offenderId,
            reprimand.typeRoleId,
          );
          if (!stillRequiredAfterCommit) {
            try {
              await offender.roles.remove(reprimand.typeRoleId, 'Срок всех выговоров этого типа истёк');
            } catch (error) {
              await updateReprimandStatusCas(reprimand.id, ['expired_ui_pending'], { status: 'pending_cleanup' });
              log.warn(`Post-commit cleanup роли выговора ${reprimand.id} будет повторён`, {
                error: String(error),
              });
              continue;
            }
          }
        }

        // Обновить оригинальное сообщение
        const config = await getConfig(guild.id);
        if (config && reprimand.messageId && reprimand.channelId) {
          if (!(await updateExpiredReprimandMessage(guild, reprimand, config))) continue;
        }

        if (!(await cleanupAppealChannels(guild, reprimand, 'Срок выговора истёк'))) continue;

        if (!(await updateReprimandStatusCas(reprimand.id, ['expired_ui_pending'], {
          status: 'expired',
          appealCategoryId: null,
          appealTextId: null,
          appealVoiceId: null,
        }))) continue;

        log.info(`Выговор ${reprimand.id} истёк — cleanup завершён для ${reprimand.offenderId}`);
      } catch (err) {
        log.error(`Ошибка обработки истёкшего выговора ${reprimand.id}`, { error: String(err) });
      }
    }
  }
}

async function fetchOffenderForRecovery(guild: any, userId: string): Promise<any | null> {
  const cached = guild.members.cache.get(userId);
  if (cached) return cached;
  try {
    return await guild.members.fetch(userId);
  } catch (error) {
    if (isUnknownMemberError(error)) return null;
    throw error;
  }
}

async function deleteAppealChannel(guild: any, channelId: string | null, reason: string): Promise<boolean> {
  if (!channelId) return true;
  try {
    const channel = guild.channels.cache.get(channelId) ?? await guild.channels.fetch(channelId);
    if (channel) await channel.delete(reason);
    return true;
  } catch (error) {
    if (isUnknownChannelError(error)) return true;
    log.warn(`Appeal channel ${channelId} cleanup отложен`, { error: String(error) });
    return false;
  }
}

async function cleanupAppealChannels(guild: any, reprimand: any, reason: string): Promise<boolean> {
  const textDeleted = await deleteAppealChannel(guild, reprimand.appealTextId, reason);
  const voiceDeleted = await deleteAppealChannel(guild, reprimand.appealVoiceId, reason);
  if (!textDeleted || !voiceDeleted) return false;
  return deleteAppealChannel(guild, reprimand.appealCategoryId, reason);
}

async function removeRecoveredRoleIfUnused(guild: any, reprimand: any, reason: string): Promise<boolean> {
  if (await hasOtherLiveReprimand(
    reprimand.id,
    reprimand.guildId,
    reprimand.offenderId,
    reprimand.typeRoleId,
  )) return true;
  const offender = await fetchOffenderForRecovery(guild, reprimand.offenderId);
  if (!offender || !offender.roles.cache.has(reprimand.typeRoleId)) return true;
  try {
    await offender.roles.remove(reprimand.typeRoleId, reason);
    return true;
  } catch (error) {
    log.warn(`Recovery не смог снять роль выговора ${reprimand.id}`, { error: String(error) });
    return false;
  }
}

async function fetchTrackedReprimandMessage(guild: any, reprimand: any): Promise<any | null> {
  if (!reprimand.channelId || !reprimand.messageId) return null;
  let channel: any;
  try {
    channel = guild.channels.cache.get(reprimand.channelId) ??
      await guild.channels.fetch(reprimand.channelId);
  } catch (error) {
    if (isUnknownChannelError(error)) return null;
    throw error;
  }
  if (!channel?.isTextBased()) return null;
  try {
    return await channel.messages.fetch(reprimand.messageId);
  } catch (error) {
    if (isUnknownMessageError(error)) return null;
    throw error;
  }
}

async function cleanupUntrackedGrantingMessages(guild: any, reprimand: any): Promise<void> {
  if (!reprimand.channelId) return;
  let channel: any;
  try {
    channel = guild.channels.cache.get(reprimand.channelId) ??
      await guild.channels.fetch(reprimand.channelId);
  } catch (error) {
    if (isUnknownChannelError(error)) return;
    throw error;
  }
  if (!channel?.isTextBased()) return;
  const recent = await channel.messages.fetch({ limit: 50 });
  const marker = `\`${String(reprimand.id).slice(-6)}\``;
  for (const message of recent.values()) {
    if (message.embeds.some((embed: any) => embed.description?.includes(marker))) {
      await message.delete();
    }
  }
}

/** Recover crash-interrupted reprimand sagas without guessing on transient REST failures. */
export async function recoverReprimandTransitions(client: BublikClient, staleOnly: boolean): Promise<void> {
  const staleBefore = staleOnly ? new Date(Date.now() - 5 * 60_000) : undefined;
  const records = await getTransitionalReprimands(staleBefore);
  for (const reprimand of records) {
    if (!isGuildAllowed(reprimand.guildId)) continue;
    const guild = client.guilds.cache.get(reprimand.guildId);
    if (!guild) continue;
    try {
      if (reprimand.status === 'granting') {
        const offender = await fetchOffenderForRecovery(guild, reprimand.offenderId);
        const trackedMessage = await fetchTrackedReprimandMessage(guild, reprimand);
        if (offender?.roles.cache.has(reprimand.typeRoleId) && trackedMessage) {
          await updateReprimandStatusCas(reprimand.id, ['granting'], { status: 'active' });
        } else {
          if (!(await updateReprimandStatusCas(reprimand.id, ['granting'], { status: 'grant_cleanup' }))) continue;
          await cleanupUntrackedGrantingMessages(guild, reprimand);
          if (await removeRecoveredRoleIfUnused(
            guild,
            reprimand,
            'RegBattle: rollback interrupted reprimand grant',
          )) {
            await deleteReprimandStatusCas(reprimand.id, ['grant_cleanup']);
          }
        }
        continue;
      }

      if (reprimand.status === 'grant_cleanup') {
        await cleanupUntrackedGrantingMessages(guild, reprimand);
        if (await removeRecoveredRoleIfUnused(
          guild,
          reprimand,
          'RegBattle: retry reprimand grant rollback',
        )) {
          await deleteReprimandStatusCas(reprimand.id, ['grant_cleanup']);
        }
        continue;
      }

      if (reprimand.status === 'appeal_creating') {
        if (!(await cleanupAppealChannels(guild, reprimand, 'RegBattle: rollback interrupted appeal creation'))) continue;
        await updateReprimandStatusCas(reprimand.id, ['appeal_creating'], {
          status: 'active',
          appealCategoryId: null,
          appealTextId: null,
          appealVoiceId: null,
        });
        continue;
      }

      if (reprimand.status === 'annulling') {
        if (!(await removeRecoveredRoleIfUnused(guild, reprimand, 'RegBattle: recover interrupted annulment'))) continue;
        if (!(await cleanupAppealChannels(guild, reprimand, 'RegBattle: recovered annulment'))) continue;
        const config = await getConfig(guild.id);
        const locale = await getGuildLocale(guild.id);
        if (!(await updateReprimandMessage(
          guild,
          reprimand,
          'annulled',
          config,
          locale,
          reprimand.annulledById ? `<@${reprimand.annulledById}>` : undefined,
        ))) continue;
        if (await updateReprimandStatusCas(reprimand.id, ['annulling'], {
          status: 'annulled',
          annulledAt: reprimand.annulledAt ?? new Date(),
          appealCategoryId: null,
          appealTextId: null,
          appealVoiceId: null,
        })) {
          if (!(await removeRecoveredRoleIfUnused(guild, reprimand, 'RegBattle: post-commit annulment cleanup'))) {
            await updateReprimandStatusCas(reprimand.id, ['annulled'], { status: 'annulling' });
          }
        }
        continue;
      }

      if (reprimand.status === 'appeal_resolving') {
        const accepting = reprimand.appealDecision === 'resolving_accept';
        const rejecting = reprimand.appealDecision === 'resolving_reject';
        if (!accepting && !rejecting) {
          // Legacy transition has no durable decision payload. Restore the
          // review state instead of guessing an irreversible decision.
          await updateReprimandStatusCas(reprimand.id, ['appeal_resolving'], { status: 'appealing' });
          continue;
        }
        if (accepting && !(await removeRecoveredRoleIfUnused(
          guild,
          reprimand,
          'RegBattle: recover accepted appeal',
        ))) continue;
        if (!(await cleanupAppealChannels(guild, reprimand, 'RegBattle: recover appeal decision'))) continue;
        const config = await getConfig(guild.id);
        const locale = await getGuildLocale(guild.id);
        if (!(await updateReprimandMessage(
          guild,
          reprimand,
          accepting ? 'appeal_accepted' : 'appeal_rejected',
          config,
          locale,
          reprimand.appealDecisionById ? `<@${reprimand.appealDecisionById}>` : undefined,
          reprimand.appealDecisionReason ?? undefined,
        ))) continue;
        const committed = await updateReprimandStatusCas(reprimand.id, ['appeal_resolving'], accepting ? {
          status: 'annulled',
          annulledById: reprimand.appealDecisionById,
          annulledAt: reprimand.appealDecisionAt ?? new Date(),
          appealDecision: 'accepted',
          appealCategoryId: null,
          appealTextId: null,
          appealVoiceId: null,
        } : {
          status: 'active',
          appealDecision: 'rejected',
          nextAppealAt: reprimand.nextAppealAt ?? new Date(Date.now() + APPEAL_COOLDOWN_MS),
          appealCategoryId: null,
          appealTextId: null,
          appealVoiceId: null,
        });
        if (committed && accepting) {
          if (!(await removeRecoveredRoleIfUnused(guild, reprimand, 'RegBattle: post-commit accepted appeal cleanup'))) {
            await updateReprimandStatusCas(reprimand.id, ['annulled'], {
              status: 'appeal_resolving',
              appealDecision: 'resolving_accept',
            });
          }
        }
      }
    } catch (error) {
      // Transient Discord/DB errors deliberately leave the transition intact
      // for the next recovery pass.
      log.warn(`Recovery выговора ${reprimand.id} отложено`, { error: String(error) });
    }
  }
}

async function recoverTerminalAppealCleanup(client: BublikClient): Promise<void> {
  const records = await getReprimandsWithPendingAppealCleanup();
  for (const reprimand of records) {
    if (!isGuildAllowed(reprimand.guildId)) continue;
    const guild = client.guilds.cache.get(reprimand.guildId);
    if (!guild) continue;
    try {
      if (!(await cleanupAppealChannels(guild, reprimand, 'RegBattle: terminal appeal cleanup'))) continue;
      await updateReprimandStatusCas(reprimand.id, [reprimand.status], {
        appealCategoryId: null,
        appealTextId: null,
        appealVoiceId: null,
      });
    } catch (error) {
      log.warn(`Terminal appeal cleanup ${reprimand.id} отложен`, { error: String(error) });
    }
  }
}

/**
 * Обновить сообщение выговора при истечении срока
 */
async function updateExpiredReprimandMessage(
  guild: any,
  reprimand: any,
  _config: any,
): Promise<boolean> {
  try {
    let channel: any;
    try {
      channel = guild.channels.cache.get(reprimand.channelId) ??
        await guild.channels.fetch(reprimand.channelId);
    } catch (error) {
      if (isUnknownChannelError(error)) return true;
      throw error;
    }
    if (!channel || !channel.isTextBased()) return true;

    let msg: any;
    try {
      msg = await channel.messages.fetch(reprimand.messageId);
    } catch (error) {
      if (isUnknownMessageError(error)) return true;
      throw error;
    }
    if (!msg) return true;

    const offender = await guild.members.fetch(reprimand.offenderId).catch(() => null);
    const typeRole = guild.roles.cache.get(reprimand.typeRoleId);
    const typeName = typeRole?.name ?? 'Неизвестный тип';

    const expiresAt = reprimand.expiresAt ? new Date(reprimand.expiresAt) : null;
    const expiryLine = expiresAt
      ? `\n**Истёк:** <t:${Math.floor(expiresAt.getTime() / 1000)}:F>`
      : '';

    const embed = new BublikEmbed()
      .setTitle('⚠️ ДИСЦИПЛИНАРНОЕ ВЗЫСКАНИЕ')
      .setDescription(
        `━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
        `**Нарушитель:** ${offender?.toString() ?? `<@${reprimand.offenderId}>`} (${offender?.user.tag ?? 'N/A'})\n` +
        `**Тип взыскания:** ${typeName}\n` +
        `**Причина:**\n> ${reprimand.reason}\n\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
        `**Выдал:** <@${reprimand.issuerId}>\n` +
        `**Дата:** <t:${Math.floor(reprimand.createdAt.getTime() / 1000)}:F>${expiryLine}\n` +
        `**ID:** \`${reprimand.id.slice(-6)}\`\n` +
        `**Статус:** ⏰ Истёк`,
      )
      .setColor(0x99aab5);

    if (offender) embed.setThumbnail(offender.displayAvatarURL({ size: 128 }));

    await msg.edit({ embeds: [embed], components: [] });
    return true;
  } catch (err) {
    if (isUnknownChannelError(err) || isUnknownMessageError(err)) return true;
    log.warn(`Не удалось обновить сообщение истёкшего выговора ${reprimand.id}`, { error: String(err) });
    return false;
  }
}
