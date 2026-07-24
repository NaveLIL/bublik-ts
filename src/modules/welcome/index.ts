import {
  GuildMember,
  PartialGuildMember,
  Interaction,
  PermissionsBitField,
  TextChannel,
} from 'discord.js';
import type { BublikClient } from '../../bot';
import { BublikModule } from '../../types';
import { logger } from '../../core/Logger';
import { getGuildConfigFresh } from '../../core/GuildConfig';
import { getGuildLocale } from '../../core/GuildConfig';
import {
  drainScheduledTasksByPrefix,
  scheduleTask,
  unscheduleTask,
} from '../../core/SchedulerManager';
import { ModuleBootController } from '../../core/ModuleLifecycle';
import { isGuildAllowed } from '../../core/Whitelist';
import { withMemberRoleLock } from '../../core/MemberRoleLock';
import { fetchGuildMemberIfPresent } from '../../utils/helpers';
import { loadUnavailableUserIds } from '../vacation/availability';
import welcomeCommand from './commands/welcome';
import {
  buildWelcomeEmbed,
  buildMemberLeftEmbed,
  buildReminderEmbed,
} from './embeds';
import {
  buildWelcomeButtons,
  handleWelcomeButton,
  clearState,
  clearReminded,
  markReminded,
  bulkCheckReminded,
  claimReminder,
  releaseReminderClaim,
  startCooldownCleanup,
  stopCooldownCleanup,
  assignRoleReliably,
  removeRoleReliably,
  acquireWelcomeLock,
  acquireLeaveLock,
  disableTrackedWelcomeMessage,
} from './handlers';
import {
  areWelcomeRoleIdsDistinct,
  hasDangerousWelcomeRolePermissions,
  isAuthoritativeMembershipGeneration,
  isAutoRoleRepairCandidate,
  isWelcomeReminderCandidate,
  membershipGeneration,
  needsAutoRoleRemoval,
  throwIfWelcomeAborted,
  shouldReleaseUnsentReminderClaim,
  welcomeMessageNonce,
  WELCOME_REMINDER_ATTEMPT_BUDGET,
  WELCOME_ROLE_REPAIR_BUDGET,
} from './policy';
import { withWelcomeLifecycleLock } from './lifecycleLock';
import {
  recordWelcomeMemberLeft,
  recordWelcomeMemberPresent,
} from './membershipStore';
import { recoverWelcomeRoleGrantIntents } from './roleGrantRecovery';

const log = logger.child('Module:welcome');

const REMINDER_INTERVAL_MS = 60 * 60 * 1_000; // 1 час
const ROLE_GRANT_RECOVERY_INTERVAL_MS = 30_000;
const DELAY_BETWEEN_MS = 2_000;                // 2 с задержка между пингами

let moduleController = new AbortController();
const runtimeBoot = new ModuleBootController();

function sleep(ms: number, signal: AbortSignal = moduleController.signal): Promise<void> {
  throwIfWelcomeAborted(signal);
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      const error = new Error('Welcome module operation aborted');
      error.name = 'AbortError';
      reject(error);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

// ═══════════════════════════════════════════════
//  Цикл напоминаний (раз в час)
// ═══════════════════════════════════════════════

async function runReminderCycle(
  client: BublikClient,
  signal: AbortSignal = moduleController.signal,
): Promise<void> {
  try {
    for (const [guildId, guild] of client.guilds.cache) {
      throwIfWelcomeAborted(signal);
      if (!isGuildAllowed(guildId)) continue;

      try {
        const cfg = await getGuildConfigFresh(guildId);
        throwIfWelcomeAborted(signal);

        const members = guild.members.cache.filter((member) => !member.user.bot);
        // One failure skips this guild completely. Treating an unavailable DB
        // as an empty set would ping people on vacation.
        const unavailable = await loadUnavailableUserIds(guildId);
        const botId = client.user?.id;
        const botMember = botId
          ? await guild.members.fetch({ user: botId, force: true })
          : null;

        const autoRole = cfg.autoRoleId
          ? await guild.roles.fetch(cfg.autoRoleId, { force: true }).catch(() => null)
          : null;
        const canManageAutoRole = Boolean(
          autoRole &&
          botMember?.permissions.has(PermissionsBitField.Flags.ManageRoles) &&
          autoRole.editable &&
          !hasDangerousWelcomeRolePermissions(autoRole) &&
          areWelcomeRoleIdsDistinct([cfg.autoRoleId, cfg.memberRoleId, cfg.recruitRoleId]),
        );

        if (cfg.autoRoleId && canManageAutoRole) {
          const repairCandidates = members.filter((member) =>
            isAutoRoleRepairCandidate(
              guildId,
              member.roles.cache.keys(),
              cfg.autoRoleId!,
              cfg.memberRoleId,
            ));
          let attempts = 0;
          let repaired = 0;
          for (const [userId] of repairCandidates) {
            if (attempts >= WELCOME_ROLE_REPAIR_BUDGET) break;
            throwIfWelcomeAborted(signal);
            if (!isGuildAllowed(guildId) || unavailable.has(userId)) continue;
            attempts++;
            try {
              const current = await fetchGuildMemberIfPresent(guild, userId);
              if (!current) continue;
              const autoRoleId = cfg.autoRoleId!;
              const changed = await assignRoleReliably(
                current,
                autoRoleId,
                'auto',
                'Welcome role reconciliation — Bublik Bot',
                signal,
                (freshMember, freshConfig) => isAutoRoleRepairCandidate(
                  guildId,
                  [...freshMember.roles.cache.keys()].filter((roleId) => roleId !== autoRoleId),
                  autoRoleId,
                  freshConfig.memberRoleId,
                ),
                'repair',
              );
              if (changed) repaired++;
            } catch (err) {
              if ((err as { name?: string })?.name === 'AbortError') throw err;
              log.warn(`Safety net: не удалось довыдать авто-роль для ${userId}`, err as Error);
            }
            if (attempts < WELCOME_ROLE_REPAIR_BUDGET) await sleep(DELAY_BETWEEN_MS, signal);
          }
          if (repaired > 0) log.info(`[${guild.name}] Safety net: исправлено авто-ролей: ${repaired}`);

          if (cfg.memberRoleId) {
            const removalCandidates = members.filter((member) =>
              needsAutoRoleRemoval(
                member.roles.cache.keys(),
                cfg.autoRoleId,
                cfg.memberRoleId,
              ));
            let removalAttempts = 0;
            let removed = 0;
            for (const [userId] of removalCandidates) {
              if (removalAttempts >= WELCOME_ROLE_REPAIR_BUDGET) break;
              throwIfWelcomeAborted(signal);
              if (!isGuildAllowed(guildId) || unavailable.has(userId)) continue;
              removalAttempts++;
              try {
                const changed = await withMemberRoleLock(guildId, userId, async (lock) => {
                  throwIfWelcomeAborted(signal);
                  if ((await loadUnavailableUserIds(guildId, [userId])).has(userId)) return false;
                  const current = await fetchGuildMemberIfPresent(guild, userId);
                  if (!current || !needsAutoRoleRemoval(
                    current.roles.cache.keys(),
                    cfg.autoRoleId,
                    cfg.memberRoleId,
                  )) return false;
                  const [currentRole, currentBot] = await Promise.all([
                    guild.roles.fetch(cfg.autoRoleId!, { force: true }).catch(() => null),
                    guild.members.fetch({ user: client.user!.id, force: true }),
                  ]);
                  if (!currentRole?.editable ||
                      !currentBot.permissions.has(PermissionsBitField.Flags.ManageRoles)) return false;
                  await lock.assertOwned();
                  return removeRoleReliably(
                    current,
                    cfg.autoRoleId!,
                    'Member role present — onboarding auto-role reconciliation',
                    lock,
                    signal,
                  );
                }, signal);
                if (changed) removed++;
              } catch (err) {
                if ((err as { name?: string })?.name === 'AbortError') throw err;
                log.warn(`Safety net: не удалось снять авто-роль для ${userId}`, err as Error);
              }
              if (removalAttempts < WELCOME_ROLE_REPAIR_BUDGET) await sleep(DELAY_BETWEEN_MS, signal);
            }
            if (removed > 0) log.info(`[${guild.name}] Reconciliation: снято авто-ролей: ${removed}`);
          }
        }

        if (!cfg.welcomeChannelId || !botMember) continue;
        const channel = await guild.channels.fetch(cfg.welcomeChannelId).catch(() => null);
        if (!channel?.isTextBased()) continue;
        const channelPermissions = channel.permissionsFor(botMember);
        if (!channelPermissions?.has([
          PermissionsBitField.Flags.ViewChannel,
          PermissionsBitField.Flags.SendMessages,
          PermissionsBitField.Flags.EmbedLinks,
          PermissionsBitField.Flags.ReadMessageHistory,
        ])) continue;

        const reminderCandidates = members.filter((member) =>
          isWelcomeReminderCandidate(
            guildId,
            member.roles.cache.keys(),
            cfg.autoRoleId,
            cfg.memberRoleId,
            cfg.recruitRoleId,
          ));
        if (reminderCandidates.size === 0) continue;

        const locale = await getGuildLocale(guildId);
        const reminded = await bulkCheckReminded(guildId, [...reminderCandidates.keys()]);
        let attempts = 0;
        let sent = 0;
        for (const [userId, member] of reminderCandidates) {
          if (attempts >= WELCOME_REMINDER_ATTEMPT_BUDGET) break;
          throwIfWelcomeAborted(signal);
          if (!isGuildAllowed(guildId) || unavailable.has(userId) || reminded.has(userId)) continue;
          attempts++;
          try {
            const delivered = await withMemberRoleLock(guildId, userId, async (lock) => {
              throwIfWelcomeAborted(signal);
              if ((await loadUnavailableUserIds(guildId, [userId])).has(userId)) return false;
              const current = await fetchGuildMemberIfPresent(guild, userId);
              if (!current) return false;
              if (!isWelcomeReminderCandidate(
                guildId,
                current.roles.cache.keys(),
                cfg.autoRoleId,
                cfg.memberRoleId,
                cfg.recruitRoleId,
              )) return false;
              await lock.assertOwned();
              throwIfWelcomeAborted(signal);
              let claimToken: string | null = null;
              let sendBegan = false;
              try {
                claimToken = await claimReminder(guildId, userId);
                if (!claimToken) return false;
                throwIfWelcomeAborted(signal);

                const dayBucket = new Date().toISOString().slice(0, 10);
                const nonce = welcomeMessageNonce('reminder', guildId, userId, dayBucket);
                for (let sendAttempt = 1; sendAttempt <= 3; sendAttempt++) {
                  throwIfWelcomeAborted(signal);
                  try {
                    await lock.assertOwned();
                    throwIfWelcomeAborted(signal);
                    const freshCfg = await getGuildConfigFresh(guildId);
                    if (freshCfg.welcomeChannelId !== cfg.welcomeChannelId ||
                        (await loadUnavailableUserIds(guildId, [userId])).has(userId)) return false;
                    const freshMember = await fetchGuildMemberIfPresent(guild, userId);
                    if (!freshMember || !isWelcomeReminderCandidate(
                      guildId,
                      freshMember.roles.cache.keys(),
                      freshCfg.autoRoleId,
                      freshCfg.memberRoleId,
                      freshCfg.recruitRoleId,
                    )) return false;
                    await lock.assertOwned();
                    throwIfWelcomeAborted(signal);
                    sendBegan = true;
                    await (channel as TextChannel).send({
                      content: `<@${userId}>`,
                      embeds: [buildReminderEmbed(userId, locale)],
                      components: [buildWelcomeButtons(userId, locale)],
                      allowedMentions: { users: [userId], roles: [], repliedUser: false },
                      nonce,
                      enforceNonce: true,
                    });
                    return true;
                  } catch (err) {
                    if ((err as { name?: string })?.name === 'AbortError') throw err;
                    log.warn(`Reminder send ${sendAttempt}/3 failed for ${userId}`, err as Error);
                    if (sendAttempt < 3) await sleep(2_000 * sendAttempt, signal);
                  }
                }
                return false;
              } finally {
                if (claimToken && shouldReleaseUnsentReminderClaim(claimToken, sendBegan)) {
                  await releaseReminderClaim(guildId, userId, claimToken).catch((err) =>
                    log.warn(`Failed to release unsent reminder claim for ${userId}`, err as Error));
                }
              }
            }, signal);
            if (delivered) {
              sent++;
              log.info(`Напоминание -> ${member.user.tag} (${userId}) [${guild.name}]`);
            }
          } catch (err) {
            if ((err as { name?: string })?.name === 'AbortError') throw err;
            log.warn(`Не удалось отправить напоминание для ${userId}`, err as Error);
          }
          if (attempts < WELCOME_REMINDER_ATTEMPT_BUDGET) await sleep(DELAY_BETWEEN_MS, signal);
        }
        if (sent > 0) log.info(`[Цикл напоминаний] ${guild.name}: ${sent}/${reminderCandidates.size} уведомлены`);
      } catch (err) {
        if ((err as { name?: string })?.name === 'AbortError') throw err;
        log.error(`Ошибка безопасного цикла welcome для ${guild.name}`, err);
      }
    }
  } catch (err) {
    if ((err as { name?: string })?.name !== 'AbortError') {
      log.error('Ошибка цикла напоминаний', err);
    }
  }
}

const welcomeModule: BublikModule = {
  name: 'welcome',
  descriptionKey: 'modules.welcome.description',
  version: '2.0.0',
  author: 'NaveLIL',

  commands: [welcomeCommand],

  events: [
    // ── Новый участник присоединился ─────────
    {
      event: 'guildMemberAdd',
      async execute(member: GuildMember) {
        if (member.user.bot || !isGuildAllowed(member.guild.id)) return;
        const signal = moduleController.signal;
        const generation = membershipGeneration(member.joinedTimestamp);
        log.info(`guildMemberAdd: ${member.user.tag} (${member.id})`);
        if (!isAuthoritativeMembershipGeneration(generation)) {
          log.warn(`Welcome deferred: Discord returned unknown join generation for ${member.id}`);
          return;
        }

        try {
          throwIfWelcomeAborted(signal);
          const lifecycleReady = await withWelcomeLifecycleLock(
            member.guild.id,
            member.id,
            async (lock) => {
              throwIfWelcomeAborted(signal);
              const current = await fetchGuildMemberIfPresent(member.guild, member.id);
              if (!current || membershipGeneration(current.joinedTimestamp) !== generation) return false;
              await lock.assertOwned();
              throwIfWelcomeAborted(signal);
              // Membership truth is independent from vacation/onboarding: a
              // present member must never remain eligible as a LeftMember.
              await recordWelcomeMemberPresent(
                member.guild.id,
                member.id,
                generation,
              );
              await lock.assertOwned();
              return true;
            },
            signal,
          );
          if (!lifecycleReady) return;

          const cfg = await getGuildConfigFresh(member.guild.id);
          const locale = await getGuildLocale(member.guild.id);
          throwIfWelcomeAborted(signal);
          if ((await loadUnavailableUserIds(member.guild.id, [member.id])).has(member.id)) {
            log.info(`Welcome пропущен для недоступного участника ${member.user.tag}`);
            return;
          }

          // ── 0. Дедупликация — защита от дубля gateway ───
          throwIfWelcomeAborted(signal);
          const canSend = await acquireWelcomeLock(member.guild.id, member.id, generation);
          if (!canSend) {
            log.warn(`Дубль guildMemberAdd для ${member.user.tag} (${member.id}) — пропускаем`);
            return;
          }

          // ── 1. Мгновенная авто-роль ──────────────────────
          const autoRoleId = cfg.autoRoleId;
          const rolesAreDistinct = areWelcomeRoleIdsDistinct([
            cfg.autoRoleId,
            cfg.memberRoleId,
            cfg.recruitRoleId,
          ]);
          if (!rolesAreDistinct) {
            log.error(`Welcome auto-role blocked by overlapping role configuration for ${member.guild.id}`);
          }
          if (autoRoleId && rolesAreDistinct) {
            const current = await fetchGuildMemberIfPresent(member.guild, member.id);
            const assigned = current
              ? await assignRoleReliably(
                current,
                autoRoleId,
                'auto',
                'Авто-роль при входе на сервер — Bublik Bot',
                signal,
                (freshMember, freshConfig) =>
                  membershipGeneration(freshMember.joinedTimestamp) === generation &&
                  (!freshConfig.memberRoleId ||
                    !freshMember.roles.cache.has(freshConfig.memberRoleId)) &&
                  (!freshConfig.recruitRoleId ||
                    !freshMember.roles.cache.has(freshConfig.recruitRoleId)),
              )
              : false;
            if (!assigned) {
              log.error(`⚠ Авто-роль ${autoRoleId} НЕ выдана ${member.user.tag} (${member.id})!`);
            }
          }

          // ── 2. Welcome-сообщение ─────────────────────────
          throwIfWelcomeAborted(signal);
          if (!isGuildAllowed(member.guild.id) ||
              (await loadUnavailableUserIds(member.guild.id, [member.id])).has(member.id)) return;
          const currentMember = await fetchGuildMemberIfPresent(member.guild, member.id);
          if (!currentMember || membershipGeneration(currentMember.joinedTimestamp) !== generation) return;

          const channelId = cfg.welcomeChannelId;
          if (!channelId) {
            log.warn('WELCOME_CHANNEL_ID не задан — пропускаем');
            return;
          }

          const channel = await member.guild.channels.fetch(channelId).catch(() => null);
          if (!channel || !channel.isTextBased()) {
            log.error(`Welcome-канал ${channelId} не найден или не текстовый`);
            return;
          }
          const botMember = await member.guild.members.fetch({
            user: member.client.user.id,
            force: true,
          });
          if (!channel.permissionsFor(botMember)?.has([
            PermissionsBitField.Flags.ViewChannel,
            PermissionsBitField.Flags.SendMessages,
            PermissionsBitField.Flags.EmbedLinks,
          ])) {
            log.error(`У бота нет прав на отправку welcome в канале ${channelId}`);
            return;
          }

          // Retry для channel.send — Discord API может вернуть 5xx / rate-limit
          let sent = false;
          const nonce = welcomeMessageNonce('join', member.guild.id, member.id, generation);
          for (let attempt = 1; attempt <= 3; attempt++) {
            throwIfWelcomeAborted(signal);
            try {
              await (channel as TextChannel).send({
                content: `<@${member.id}>`,
                embeds: [buildWelcomeEmbed(currentMember, locale)],
                components: [buildWelcomeButtons(member.id, locale)],
                allowedMentions: { users: [member.id], roles: [], repliedUser: false },
                nonce,
                enforceNonce: true,
              });
              sent = true;
              break;
            } catch (sendErr: any) {
              if (sendErr?.name === 'AbortError') throw sendErr;
              log.warn(`channel.send attempt ${attempt}/3 failed: ${sendErr.message}`);
              if (attempt < 3) await sleep(2_000 * attempt, signal);
            }
          }
          if (!sent) {
            log.error(`Не удалось отправить приветствие для ${member.user.tag} после 3 попыток`);
            return;
          }

          // Ставим флаг «напомнили» — первое напоминание не раньше чем через час
          await markReminded(member.guild.id, member.id).catch(() => {});

          log.info(`Приветствие отправлено для ${member.user.tag}`);
        } catch (err) {
          if ((err as { name?: string })?.name === 'AbortError') return;
          log.error(`Ошибка приветствия ${member.user.tag}`, err);
        }
      },
    },

    // ── Участник покинул сервер ──────────────
    {
      event: 'guildMemberRemove',
      async execute(member: GuildMember | PartialGuildMember) {
        if (member.user?.bot || !isGuildAllowed(member.guild.id)) return;
        const signal = moduleController.signal;
        const tag = member.user?.tag ?? `ID:${member.id}`;
        const removeGeneration = membershipGeneration(member.joinedTimestamp);
        log.info(`guildMemberRemove: ${tag} (${member.id})`);

        try {
          await withWelcomeLifecycleLock(
            member.guild.id,
            member.id,
            async (lock) => {
              const reconcileIfPresent = async (): Promise<boolean> => {
                await lock.assertOwned();
                throwIfWelcomeAborted(signal);
                const current = await fetchGuildMemberIfPresent(member.guild, member.id);
                await lock.assertOwned();
                throwIfWelcomeAborted(signal);
                if (!current) return false;
                await recordWelcomeMemberPresent(
                  member.guild.id,
                  member.id,
                  membershipGeneration(current.joinedTimestamp),
                );
                log.info(`Устаревший guildMemberRemove проигнорирован для ${tag}`);
                return true;
              };

              // Gateway remove events can arrive after a rapid rejoin. Every
              // destructive phase is fenced by the lifecycle lock and a fresh
              // authoritative Discord membership read.
              if (await reconcileIfPresent()) return;
              await lock.assertOwned();
              throwIfWelcomeAborted(signal);
              const recordedLeft = await recordWelcomeMemberLeft(
                member.guild.id,
                member.id,
                removeGeneration,
              );
              if (!recordedLeft) {
                log.info(`Stale guildMemberRemove DB write fenced for ${tag}`);
                return;
              }

              if (await reconcileIfPresent()) return;
              try {
                await disableTrackedWelcomeMessage(member.guild, member.id, signal);
              } catch (err) {
                if ((err as { name?: string })?.name === 'AbortError') throw err;
                log.warn(`Не удалось отключить старое welcome-сообщение для ${member.id}`, err as Error);
              }

              if (await reconcileIfPresent()) return;
              try {
                throwIfWelcomeAborted(signal);
                await clearState(member.guild.id, member.id);
              } catch (err) {
                if ((err as { name?: string })?.name === 'AbortError') throw err;
                log.warn(`Не удалось очистить welcome state для ${member.id}`, err as Error);
              }

              if (await reconcileIfPresent()) return;
              try {
                throwIfWelcomeAborted(signal);
                await clearReminded(member.guild.id, member.id);
              } catch (err) {
                if ((err as { name?: string })?.name === 'AbortError') throw err;
                log.warn(`Не удалось очистить welcome reminder для ${member.id}`, err as Error);
              }

              if (await reconcileIfPresent()) return;
              const leaveGeneration = removeGeneration === 'unknown'
                ? `bucket-${Math.floor(Date.now() / 60_000)}`
                : removeGeneration;
              await lock.assertOwned();
              throwIfWelcomeAborted(signal);
              const canSendLeave = await acquireLeaveLock(
                member.guild.id,
                member.id,
                leaveGeneration,
              );
              if (!canSendLeave) {
                log.warn(`Дубль guildMemberRemove для ${tag} (${member.id}) — уведомление пропущено`);
                return;
              }

              // A partial payload has no authoritative role snapshot. Fail
              // closed: record the leave, but publish no potentially false notice.
              if (member.partial) return;
              const cfg = await getGuildConfigFresh(member.guild.id);
              const locale = await getGuildLocale(member.guild.id);
              throwIfWelcomeAborted(signal);
              const recruitRoleId = cfg.recruitRoleId;
              const hasRoles = member.roles?.cache ? member.roles.cache.size > 1 : false;
              const isCandidate = recruitRoleId
                ? (member.roles?.cache?.has(recruitRoleId) ?? false)
                : false;

              if (!hasRoles || isCandidate) {
                const channelId = cfg.welcomeChannelId;
                if (!channelId || await reconcileIfPresent()) return;

                const channel = await member.guild.channels.fetch(channelId).catch(() => null);
                throwIfWelcomeAborted(signal);
                if (!channel || !channel.isTextBased() || await reconcileIfPresent()) return;
                await lock.assertOwned();
                throwIfWelcomeAborted(signal);
                await (channel as TextChannel).send({
                  embeds: [buildMemberLeftEmbed(tag, member.id, locale)],
                  allowedMentions: { parse: [] },
                  nonce: welcomeMessageNonce(
                    'leave',
                    member.guild.id,
                    member.id,
                    String(Math.floor(Date.now() / 300_000)),
                  ),
                  enforceNonce: true,
                });

                log.info(`Уведомление о выходе ${tag} отправлено`);
              }
            },
            signal,
          );
        } catch (err) {
          if ((err as { name?: string })?.name === 'AbortError') return;
          log.error(`Ошибка обработки выхода ${tag}`, err);
        }
      },
    },

    // ── Обработка нажатий кнопок ─────────────
    {
      event: 'interactionCreate',
      async execute(interaction: Interaction) {
        if (!interaction.isButton()) return;
        if (!interaction.customId.startsWith('welcome:')) return;

        const client = interaction.client as unknown as BublikClient;
        await handleWelcomeButton(interaction, client, moduleController.signal);
      },
    },

    // ── Снятие авто-роли при получении member-роли ───
    {
      event: 'guildMemberUpdate',
      async execute(_oldMember: GuildMember | PartialGuildMember, newMember: GuildMember) {
        if (newMember.user.bot || !isGuildAllowed(newMember.guild.id)) return;
        const signal = moduleController.signal;
        try {
          throwIfWelcomeAborted(signal);
          const cfg = await getGuildConfigFresh(newMember.guild.id);
          const { autoRoleId, memberRoleId } = cfg;

          // Ничего делать не нужно если не сконфигурировано
          if (!autoRoleId || !memberRoleId || autoRoleId === memberRoleId) return;
          if (!needsAutoRoleRemoval(newMember.roles.cache.keys(), autoRoleId, memberRoleId)) return;

          const removed = await withMemberRoleLock(newMember.guild.id, newMember.id, async (lock) => {
            throwIfWelcomeAborted(signal);
            if ((await loadUnavailableUserIds(newMember.guild.id, [newMember.id])).has(newMember.id)) {
              return false;
            }
            const current = await fetchGuildMemberIfPresent(newMember.guild, newMember.id);
            if (!current || !needsAutoRoleRemoval(
              current.roles.cache.keys(),
              autoRoleId,
              memberRoleId,
            )) return false;
            const [role, botMember] = await Promise.all([
              newMember.guild.roles.fetch(autoRoleId, { force: true }).catch(() => null),
              newMember.guild.members.fetch({ user: newMember.client.user.id, force: true }),
            ]);
            if (!role?.editable || !botMember.permissions.has(PermissionsBitField.Flags.ManageRoles)) {
              return false;
            }
            await lock.assertOwned();
            return removeRoleReliably(
              current,
              autoRoleId,
              'Получена роль участника — авто-роль снята',
              lock,
              signal,
            );
          }, signal);
          if (removed) {
            log.info(`✓ Авто-роль ${autoRoleId} снята у ${newMember.user.tag} (есть member-роль ${memberRoleId})`);
          }
        } catch (err) {
          if ((err as { name?: string })?.name === 'AbortError') return;
          log.error(`Ошибка guildMemberUpdate для ${newMember.user?.tag ?? newMember.id}`, err);
        }
      },
    },
  ],

  async onLoad(client) {
    moduleController.abort();
    moduleController = new AbortController();
    const signal = moduleController.signal;
    log.info('Настройки ролей/каналов загружаются из БД (per-guild). Используйте /welcome для управления.');

    // Запускаем цикл напоминаний (раз в час, до 10-ти за цикл)
    scheduleTask('welcome:reminder', REMINDER_INTERVAL_MS, async () => {
      await runReminderCycle(client as BublikClient, signal);
    });

    runtimeBoot.start(client, async (isCurrent) => {
      try {
        await recoverWelcomeRoleGrantIntents(client, signal);
      } catch (error) {
        if ((error as { name?: string })?.name !== 'AbortError') {
          log.warn('Начальное восстановление welcome role intents будет повторено', {
            error: String(error),
          });
        }
      }
      if (!isCurrent() || signal.aborted) return;
      scheduleTask(
        'welcome:roleGrantRecovery',
        ROLE_GRANT_RECOVERY_INTERVAL_MS,
        () => recoverWelcomeRoleGrantIntents(client, signal),
        { exclusive: true },
      );
    }, (error: unknown) => {
      log.error('Не удалось запустить recovery welcome-ролей', { error: String(error) });
    });

    // Запускаем периодическую чистку кулдаунов кнопок
    startCooldownCleanup();

    log.info('Модуль приветствия загружен ✓ (v2.0.0 — per-guild config + авто-роль + safety net)');
  },

  async onUnload(_client) {
    const bootDrain = runtimeBoot.stopAndDrain();
    moduleController.abort();
    unscheduleTask('welcome:reminder');
    unscheduleTask('welcome:roleGrantRecovery');
    stopCooldownCleanup();
    await drainScheduledTasksByPrefix('welcome:');

    if (!await bootDrain) {
      log.warn('Таймаут ожидания boot Welcome; generation guard запретит поздний recovery');
    }
    unscheduleTask('welcome:roleGrantRecovery');

    log.info('Модуль приветствия выгружен');
  },
};

export default welcomeModule;
