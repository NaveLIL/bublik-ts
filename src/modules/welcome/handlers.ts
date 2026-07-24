import {
  ButtonInteraction,
  ButtonBuilder,
  ButtonStyle,
  ActionRowBuilder,
  Guild,
  GuildMember,
  Message,
  PermissionsBitField,
  TextChannel,
} from 'discord.js';
import type { BublikClient } from '../../bot';
import { cacheGet, cacheSet, cacheDel, getRedis } from '../../core/Redis';
import { logger } from '../../core/Logger';
import { errorReporter } from '../../core/ErrorReporter';
import {
  getGuildConfigFresh,
  type GuildConfig,
} from '../../core/GuildConfig';
import { getGuildLocale } from '../../core/GuildConfig';
import { i18n } from '../../core/I18n';
import { isTransientInteractionError } from '../../utils/helpers';
import { scheduleTask, unscheduleTask } from '../../core/SchedulerManager';
import { type MemberRoleLock, withMemberRoleLock } from '../../core/MemberRoleLock';
import { getEcoConfig } from '../economy/database';
import { grantWelcomeBonusOnce } from '../economy/profile';
import { loadUnavailableUserIds } from '../vacation/availability';
import {
  areWelcomeRoleIdsDistinct,
  hasDangerousWelcomeRolePermissions,
  hasTicketPanelMemberAccess,
  isAuthoritativeMembershipGeneration,
  membershipGeneration,
  runWelcomePostDispatchRoleMutation,
  runValidatedTicketHandoffAttempt,
  runWelcomeRoleGrantSaga,
  throwIfWelcomeAborted,
  welcomeMessageNonce,
  type WelcomeRoleGrantProgress,
} from './policy';
import {
  buildWelcomeChosenEmbed,
  buildRulesPromptEmbed,
  buildServerRulesEmbeds,
  buildRegimentRulesEmbed,
  buildJoinCompleteEmbed,
  buildOtherQuestionEmbed,
  buildTicketPingEmbed,
} from './embeds';
import { withWelcomeLifecycleLock } from './lifecycleLock';
import { acquireReminderClaimToken } from './reminderClaim';
import {
  assertWelcomeRoleGrantIntentCurrent,
  completeWelcomeRoleGrantIntent,
  prepareWelcomeRoleGrantIntent,
  readWelcomeRoleGrantIntent,
  recordWelcomeRoleGrantDispatch,
  WELCOME_ROLE_LATE_APPLY_GRACE_MS,
  type WelcomeAutomaticRoleKind,
  type WelcomeRoleGrantIntent,
  type WelcomeRoleGrantPolicy,
} from './roleGrantIntent';
import { settleWelcomeRoleGrantIntent } from './roleGrantRecovery';
import { readWelcomeAutoRoleRemovalIntent } from './roleRemovalIntent';
import {
  prepareAndDispatchWelcomeAutoRoleRemoval,
  settleWelcomeAutoRoleRemovalIntent,
} from './roleRemovalRecovery';

const log = logger.child('Welcome');

// ── Префикс customId ────────────────────────────
const PREFIX = 'welcome';

// ── Rate-limit кнопок (защита от double-click) ───
const BUTTON_COOLDOWN_MS = 1_500; // 1.5с между нажатиями
const buttonCooldowns = new Map<string, number>();

function isButtonRateLimited(guildId: string, userId: string): boolean {
  const now = Date.now();
  const key = `${guildId}:${userId}`;
  const last = buttonCooldowns.get(key);
  if (last && now - last < BUTTON_COOLDOWN_MS) return true;
  buttonCooldowns.set(key, now);
  return false;
}

// Периодическая очистка устаревших записей (управляется модулем через start/stop)

export function startCooldownCleanup(): void {
  scheduleTask('welcome:cooldownCleanup', 300_000, async () => {
    const now = Date.now();
    for (const [key, ts] of buttonCooldowns) {
      if (now - ts > BUTTON_COOLDOWN_MS * 2) buttonCooldowns.delete(key);
    }
  });
}

export function stopCooldownCleanup(): void {
  unscheduleTask('welcome:cooldownCleanup');
  buttonCooldowns.clear();
}

// ── Redis: состояние прочтения правил ────────────
interface RulesState {
  serverRules: boolean;
  regimentRules: boolean;
  originChannelId?: string;
  originMessageId?: string;
  membershipGeneration?: string;
}

const STATE_TTL = 86_400; // 24 часа — запас если пользователь отвлёкся / бот перезапустился

async function getState(guildId: string, userId: string): Promise<RulesState> {
  const cached = await cacheGet<RulesState>(`welcome:state:${guildId}:${userId}`);
  return cached ?? { serverRules: false, regimentRules: false };
}

async function setState(guildId: string, userId: string, state: RulesState): Promise<void> {
  await cacheSet(`welcome:state:${guildId}:${userId}`, state, STATE_TTL);
}

export async function clearState(guildId: string, userId: string): Promise<void> {
  await cacheDel(`welcome:state:${guildId}:${userId}`);
}

// ── Redis: пометка «напомнили» (антиспам) ────────
const REMINDED_TTL = 86_400; // не чаще 1 раза в 24 часа

export async function markReminded(guildId: string, userId: string): Promise<void> {
  await cacheSet(`welcome:reminded:${guildId}:${userId}`, true, REMINDED_TTL);
}

/** Atomically reserves the daily reminder before a DM is attempted. */
export async function claimReminder(guildId: string, userId: string): Promise<string | null> {
  const redis = getRedis();
  const key = `bublik:welcome:reminded:${guildId}:${userId}`;
  return acquireReminderClaimToken(redis, key, REMINDED_TTL);
}

export async function releaseReminderClaim(
  guildId: string,
  userId: string,
  token: string,
): Promise<void> {
  await getRedis().eval(
    'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end',
    1,
    `bublik:welcome:reminded:${guildId}:${userId}`,
    token,
  );
}

export async function isReminded(guildId: string, userId: string): Promise<boolean> {
  return (await getRedis().get(`bublik:welcome:reminded:${guildId}:${userId}`)) !== null;
}

export async function bulkCheckReminded(guildId: string, userIds: string[]): Promise<Set<string>> {
  if (userIds.length === 0) return new Set();
  const r = getRedis();
  const keys = userIds.map((id) => `bublik:welcome:reminded:${guildId}:${id}`);
  const results = await r.mget(keys);
  const remindedSet = new Set<string>();
  for (let i = 0; i < userIds.length; i++) {
    if (results[i] !== null) {
      remindedSet.add(userIds[i]);
    }
  }
  return remindedSet;
}

export async function clearReminded(guildId: string, userId: string): Promise<void> {
  await cacheDel(`welcome:reminded:${guildId}:${userId}`);
}

// ── Redis: дедупликация welcome-сообщений ────
const WELCOME_DEDUP_TTL = 300; // 5 минут — защита от дубля gateway-событий
const LEAVE_DEDUP_TTL = 300; // 5 минут — защита от дубля guildMemberRemove

/**
 * Попытка захватить лок на отправку welcome-сообщения.
 * Возвращает true если можно отправлять, false если уже отправлено.
 */
export async function acquireWelcomeLock(
  guildId: string,
  userId: string,
  generation = 'unknown',
): Promise<boolean> {
  const key = `welcome:dedup:${guildId}:${userId}:${generation}`;
  const r = getRedis();
  const ok = await r.set(`bublik:${key}`, '1', 'EX', WELCOME_DEDUP_TTL, 'NX');
  return ok === 'OK';
}

/**
 * Попытка захватить лок на отправку уведомления о выходе.
 * Возвращает true если можно отправлять, false если уже отправлено.
 */
export async function acquireLeaveLock(
  guildId: string,
  userId: string,
  generation: string,
): Promise<boolean> {
  const key = `welcome:leave:dedup:${guildId}:${userId}:${generation}`;
  const r = getRedis();
  const ok = await r.set(`bublik:${key}`, '1', 'EX', LEAVE_DEDUP_TTL, 'NX');
  return ok === 'OK';
}

// ═══════════════════════════════════════════════
//  Надёжная выдача роли (с retry + верификацией)
// ═══════════════════════════════════════════════

/**
 * Выдаёт роль участнику с максимальной надёжностью:
 * 1. Пытается roles.add() с retry (до MAX_ATTEMPTS попыток)
 * 2. После каждого "успешного" add — re-fetch member и проверяет что роль реально есть
 * 3. Если верификация провалилась — считает попытку неудачной и повторяет
 *
 * Это решает проблему «бот забывает выдавать роли» — Discord API иногда
 * молча проглатывает roles.add при 5xx / rate-limit без ошибки.
 */
export type WelcomeRoleGrantGuard = (
  member: GuildMember,
  config: GuildConfig,
) => boolean | Promise<boolean>;

class WelcomeRoleFenceLostError extends Error {
  constructor(cause: unknown) {
    super(`Welcome role mutation fence was lost: ${String(cause)}`);
    this.name = 'WelcomeRoleFenceLostError';
  }
}

async function assertWelcomeRoleFence(lock: MemberRoleLock, signal?: AbortSignal): Promise<void> {
  throwIfWelcomeAborted(signal);
  try {
    await lock.assertOwned();
  } catch (error) {
    if ((error as { name?: string })?.name === 'AbortError') throw error;
    throw new WelcomeRoleFenceLostError(error);
  }
  throwIfWelcomeAborted(signal);
}

async function loadFreshAutomaticRoleMutation(
  member: GuildMember,
  roleId: string,
  kind: WelcomeAutomaticRoleKind,
  lock: MemberRoleLock,
  signal?: AbortSignal,
  guard?: WelcomeRoleGrantGuard,
): Promise<GuildMember | null> {
  await assertWelcomeRoleFence(lock, signal);
  const config = await getGuildConfigFresh(member.guild.id);
  const expectedRoleId = kind === 'auto' ? config.autoRoleId : config.recruitRoleId;
  if (expectedRoleId !== roleId || !areWelcomeRoleIdsDistinct([
    config.autoRoleId,
    config.memberRoleId,
    config.recruitRoleId,
  ])) return null;
  if ((await loadUnavailableUserIds(member.guild.id, [member.id])).has(member.id)) return null;

  const [current, role, botMember] = await Promise.all([
    member.guild.members.fetch({ user: member.id, force: true }),
    member.guild.roles.fetch(roleId, { force: true }),
    member.guild.members.fetch({ user: member.client.user.id, force: true }),
  ]);
  if (!isAuthoritativeMembershipGeneration(
    membershipGeneration(current.joinedTimestamp),
  )) return null;
  if (!role?.editable ||
      !botMember.permissions.has(PermissionsBitField.Flags.ManageRoles) ||
      hasDangerousWelcomeRolePermissions(role)) return null;
  if (guard && !await guard(current, config)) return null;
  const finalConfig = await getGuildConfigFresh(member.guild.id);
  const finalExpectedRoleId = kind === 'auto' ? finalConfig.autoRoleId : finalConfig.recruitRoleId;
  if (finalExpectedRoleId !== roleId || !areWelcomeRoleIdsDistinct([
    finalConfig.autoRoleId,
    finalConfig.memberRoleId,
    finalConfig.recruitRoleId,
  ])) return null;
  if ((await loadUnavailableUserIds(member.guild.id, [member.id])).has(member.id)) return null;
  if (guard && !await guard(current, finalConfig)) return null;
  await assertWelcomeRoleFence(lock, signal);
  return current;
}

class WelcomeRoleReconcileRequiredError extends Error {
  constructor(public readonly cause: unknown) {
    super(`Welcome role grant needs reconciliation: ${String(cause)}`);
    this.name = 'WelcomeRoleReconcileRequiredError';
  }
}

interface WelcomeRoleGrantOperation {
  intent: WelcomeRoleGrantIntent | null;
  policy: WelcomeRoleGrantPolicy;
}

async function assignRoleReliablyLocked(
  member: GuildMember,
  roleId: string,
  kind: WelcomeAutomaticRoleKind,
  reason: string,
  lock: MemberRoleLock,
  provenance: WelcomeRoleGrantProgress,
  operation: WelcomeRoleGrantOperation,
  signal?: AbortSignal,
  guard?: WelcomeRoleGrantGuard,
): Promise<boolean> {
  const MAX_ATTEMPTS = 5;
  const BASE_DELAY_MS = 2_000;
  const tag = member.user?.tag ?? member.id;

  await assertWelcomeRoleFence(lock, signal);
  if (kind === 'auto' &&
      await readWelcomeAutoRoleRemovalIntent(member.guild.id, member.id)) {
    // A response-ambiguous DELETE owns the stable removal fence until its own
    // grace expires. Never race a new ADD from inside the same member lock.
    return false;
  }
  const pendingIntent = await readWelcomeRoleGrantIntent(member.guild.id, member.id, kind);
  if (pendingIntent) {
    operation.intent = pendingIntent;
    provenance.preexisting = false;
    provenance.addBegan = true;
    throw new WelcomeRoleReconcileRequiredError('durable_intent_pending');
  }

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const before = await loadFreshAutomaticRoleMutation(member, roleId, kind, lock, signal, guard);
      if (!before) {
        if (provenance.addBegan) throw new WelcomeRoleReconcileRequiredError('authority_changed');
        return false;
      }
      if (before.roles.cache.has(roleId)) {
        if (!provenance.addBegan) provenance.preexisting = true;
        return true;
      }
      if (provenance.preexisting === null) provenance.preexisting = false;
      if (!operation.intent) {
        const generation = membershipGeneration(before.joinedTimestamp);
        if (!isAuthoritativeMembershipGeneration(generation)) return false;
        const prepared = await prepareWelcomeRoleGrantIntent({
          guildId: member.guild.id,
          userId: member.id,
          roleId,
          kind,
          policy: operation.policy,
          membershipGeneration: generation,
        });
        operation.intent = prepared.intent;
        provenance.addBegan = true;
        if (!prepared.created) {
          throw new WelcomeRoleReconcileRequiredError('durable_intent_raced');
        }
      }
      const finalBaseline = await loadFreshAutomaticRoleMutation(
        member,
        roleId,
        kind,
        lock,
        signal,
        guard,
      );
      if (!finalBaseline) {
        throw new WelcomeRoleReconcileRequiredError('authority_changed_after_prepare');
      }
      if (finalBaseline.roles.cache.has(roleId)) {
        // The role appeared before a dispatch record existed, therefore this
        // operation cannot claim it. Keep it and retire only our prepared row.
        const terminalBaseline = await loadFreshAutomaticRoleMutation(
          member,
          roleId,
          kind,
          lock,
          signal,
          guard,
        );
        if (!terminalBaseline || !terminalBaseline.roles.cache.has(roleId) ||
            membershipGeneration(terminalBaseline.joinedTimestamp) !==
              operation.intent.membershipGeneration) {
          throw new WelcomeRoleReconcileRequiredError('prepared_terminal_state_changed');
        }
        const completed = await completeWelcomeRoleGrantIntent(operation.intent);
        if (!completed) throw new WelcomeRoleReconcileRequiredError('intent_replaced');
        operation.intent = null;
        provenance.preexisting = true;
        provenance.addBegan = false;
        return true;
      }
      // The final instruction before every Discord write is the distributed
      // fence plus a durable token-CAS dispatch record. A crash from this point
      // is recoverable without relying on process memory.
      await assertWelcomeRoleFence(lock, signal);
      operation.intent = await recordWelcomeRoleGrantDispatch(operation.intent);
      const mutation = await runWelcomePostDispatchRoleMutation({
        intent: operation.intent,
        dispatchedAt: operation.intent.dispatchedAt,
        maxDispatchAgeMs: WELCOME_ROLE_LATE_APPLY_GRACE_MS,
        signal,
        loadAuthoritativeState: (active) =>
          loadFreshAutomaticRoleMutation(member, roleId, kind, lock, signal, guard)
            .then((current) => ({ current, active })),
        mutationAllowed: ({ current, active }) => Boolean(
          current && !current.roles.cache.has(roleId) &&
          membershipGeneration(current.joinedTimestamp) === active.membershipGeneration,
        ),
        assertLockOwned: () => assertWelcomeRoleFence(lock, signal),
        assertIntentCurrent: (active) => assertWelcomeRoleGrantIntentCurrent(active),
        mutate: async ({ current }) => {
          if (!current) return;
          await current.roles.add(roleId, reason);
        },
      });
      if (mutation !== 'mutated') {
        throw new WelcomeRoleReconcileRequiredError(`post_dispatch_${mutation}`);
      }

      await abortableDelay(500, signal);
      const verified = await loadFreshAutomaticRoleMutation(member, roleId, kind, lock, signal, guard);
      if (!verified) throw new WelcomeRoleReconcileRequiredError('authority_changed_after_add');
      if (verified.roles.cache.has(roleId)) {
        log.info(`✓ Роль ${roleId} подтверждена у ${tag} (попытка ${attempt}/${MAX_ATTEMPTS})`);
        return true;
      }
      log.warn(
        `Роль ${roleId} не обнаружена у ${tag} после roles.add (попытка ${attempt}/${MAX_ATTEMPTS}) — повтор`,
      );
    } catch (err: any) {
      if (err?.name === 'WelcomeRoleReconcileRequiredError') throw err;
      if (err?.name === 'WelcomeRoleGrantIntentFencedError' && operation.intent) {
        throw new WelcomeRoleReconcileRequiredError(err);
      }
      if ((err?.name === 'AbortError' || err?.name === 'WelcomeRoleFenceLostError') &&
          provenance.addBegan) {
        throw new WelcomeRoleReconcileRequiredError(err);
      }
      if (err?.name === 'AbortError' || err?.name === 'WelcomeRoleFenceLostError') throw err;
      try {
        const verified = await loadFreshAutomaticRoleMutation(member, roleId, kind, lock, signal, guard);
        if (!verified) {
          if (provenance.addBegan) throw new WelcomeRoleReconcileRequiredError('authority_changed');
          return false;
        }
        if (verified.roles.cache.has(roleId)) return true;
      } catch (verificationError: any) {
        if (verificationError?.name === 'WelcomeRoleReconcileRequiredError') throw verificationError;
        if (verificationError?.name === 'AbortError' ||
            verificationError?.name === 'WelcomeRoleFenceLostError') {
          if (provenance.addBegan) throw new WelcomeRoleReconcileRequiredError(verificationError);
          throw verificationError;
        }
      }
      log.warn(
        `assignRoleReliably ${roleId} → ${tag}: попытка ${attempt}/${MAX_ATTEMPTS} ошибка: ${err.message}`,
      );
    }

    if (attempt < MAX_ATTEMPTS) await abortableDelay(BASE_DELAY_MS * attempt, signal);
  }

  if (provenance.addBegan) throw new WelcomeRoleReconcileRequiredError('retry_exhausted');
  log.error(`✗ Не удалось выдать роль ${roleId} пользователю ${tag} после ${MAX_ATTEMPTS} попыток`);
  return false;
}

export async function assignRoleReliably(
  member: GuildMember,
  roleId: string,
  kind: WelcomeAutomaticRoleKind,
  reason: string,
  signal?: AbortSignal,
  guard?: WelcomeRoleGrantGuard,
  policy: WelcomeRoleGrantPolicy = kind === 'auto' ? 'join' : 'rules',
): Promise<boolean> {
  if (kind === 'auto') {
    const pendingRemoval = await readWelcomeAutoRoleRemovalIntent(member.guild.id, member.id);
    if (pendingRemoval) {
      const removal = await settleWelcomeAutoRoleRemovalIntent(
        member.client,
        pendingRemoval,
        signal,
      );
      if (removal.status === 'pending' || removal.status === 'fenced') return false;
    }
  }
  const provenance: WelcomeRoleGrantProgress = { preexisting: null, addBegan: false };
  const operation: WelcomeRoleGrantOperation = { intent: null, policy };
  return runWelcomeRoleGrantSaga(
    provenance,
    () => withMemberRoleLock(
      member.guild.id,
      member.id,
      (lock) => assignRoleReliablyLocked(
        member,
        roleId,
        kind,
        reason,
        lock,
        provenance,
        operation,
        signal,
        guard,
      ),
      signal,
    ),
    // This callback runs only after the original lock callback settles. Its
    // persisted UUID intent survives crashes and is settled under a new lease.
    async () => {
      if (!operation.intent) return false;
      throwIfWelcomeAborted(signal);
      const result = await settleWelcomeRoleGrantIntent(member.client, operation.intent, signal);
      return result.roleGranted;
    },
  );
}

// ═══════════════════════════════════════════════
//  Компоненты (кнопки)
// ═══════════════════════════════════════════════

/** Кнопки начального приветствия */
/** Symmetric, response-loss-safe removal used by event handling and repair. */
export async function removeRoleReliably(
  member: GuildMember,
  roleId: string,
  reason: string,
  lock: MemberRoleLock,
  signal?: AbortSignal,
): Promise<boolean> {
  const result = await prepareAndDispatchWelcomeAutoRoleRemoval(
    member,
    roleId,
    reason,
    lock,
    signal,
  );
  return result.roleAbsent;
}

function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  throwIfWelcomeAborted(signal);
  if (!signal) return new Promise((resolve) => setTimeout(resolve, ms));
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

export function buildWelcomeButtons(userId: string, locale: string): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`${PREFIX}:join:${userId}`)
      .setLabel(i18n.t('welcome.btn_join', locale))
      .setEmoji('🎖️')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`${PREFIX}:other:${userId}`)
      .setLabel(i18n.t('welcome.btn_other', locale))
      .setEmoji('❓')
      .setStyle(ButtonStyle.Secondary),
  );
}

/** Кнопки ознакомления с правилами */
function buildRulesButtons(
  userId: string,
  serverRead: boolean,
  regimentRead: boolean,
  locale: string,
): ActionRowBuilder<ButtonBuilder> {
  const allRead = serverRead && regimentRead;

  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`${PREFIX}:rules_server:${userId}`)
      .setLabel(i18n.t('welcome.btn_server_rules', locale))
      .setEmoji('📜')
      .setStyle(serverRead ? ButtonStyle.Secondary : ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`${PREFIX}:rules_regiment:${userId}`)
      .setLabel(i18n.t('welcome.btn_regiment_rules', locale))
      .setEmoji('⚔️')
      .setStyle(regimentRead ? ButtonStyle.Secondary : ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`${PREFIX}:rules_done:${userId}`)
      .setLabel(i18n.t('welcome.btn_rules_done', locale))
      .setEmoji('✅')
      .setStyle(ButtonStyle.Success)
      .setDisabled(!allRead),
  );
}

/** Кнопка «Назад к прогрессу» — показывается поверх страницы с правилами */
function buildBackButton(userId: string, locale: string): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`${PREFIX}:rules_back:${userId}`)
      .setLabel(i18n.t('welcome.btn_back', locale))
      .setStyle(ButtonStyle.Secondary),
  );
}

// ═══════════════════════════════════════════════
//  Центральный обработчик кнопок
// ═══════════════════════════════════════════════

export async function handleWelcomeButton(
  interaction: ButtonInteraction,
  client: BublikClient,
  signal?: AbortSignal,
): Promise<void> {
  const customId = interaction.customId;

  // Все наши кнопки: welcome:<action>:<userId>
  if (!customId.startsWith(`${PREFIX}:`)) return;

  if (!interaction.inGuild() || !interaction.guild || !interaction.guildId) {
    await interaction.reply({ content: 'This onboarding action is only available in a server.' }).catch(() => {});
    return;
  }

  const parts = customId.split(':');
  if (parts.length !== 3) {
    await interaction.reply({ content: 'Invalid onboarding action.', ephemeral: true }).catch(() => {});
    return;
  }

  const [, action, targetUserId] = parts;

  // Защита: только целевой пользователь может нажать
  if (interaction.user.id !== targetUserId) {
    await interaction.deferReply({ ephemeral: true });
    const locale = await getGuildLocale(interaction.guildId);
    await interaction.editReply({
      content: i18n.t('welcome.error_not_for_you', locale),
    });
    return;
  }

  // Rate-limit: не чаще раза в 1.5 секунды (double-click protection)
  if (isButtonRateLimited(interaction.guildId, interaction.user.id)) {
    await interaction.deferReply({ ephemeral: true });
    const locale = await getGuildLocale(interaction.guildId);
    await interaction.editReply({
      content: i18n.t('welcome.error_rate_limit', locale),
    });
    return;
  }

  try {
    switch (action) {
      case 'join':
        await handleJoin(interaction, client, signal);
        break;
      case 'other':
        await handleOther(interaction, client, signal);
        break;
      case 'rules_server':
        await handleRulesServer(interaction, signal);
        break;
      case 'rules_regiment':
        await handleRulesRegiment(interaction, signal);
        break;
      case 'rules_back':
        await handleRulesBack(interaction, signal);
        break;
      case 'rules_done':
        await handleRulesDone(interaction, client, signal);
        break;
      default:
        log.warn(`Неизвестное welcome-действие: ${action}`);
        await interaction.reply({ content: 'Invalid onboarding action.', ephemeral: true }).catch(() => {});
    }
  } catch (err) {
    if ((err as { name?: string })?.name === 'AbortError') return;
    // Транзиентные ошибки (Unknown interaction, EAI_AGAIN) — не шумим
    if (isTransientInteractionError(err)) {
      log.warn('Транзиентная ошибка в welcome interaction (пропускаем)', { error: String(err) });
      return;
    }

    log.error(`Ошибка обработки welcome-кнопки "${action}"`, err);
    errorReporter.componentError(err, interaction, `welcome:${action}`);
    const locale = await getGuildLocale(interaction.guildId);
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({
        content: i18n.t('welcome.error_generic', locale),
        ephemeral: true,
      }).catch(() => {});
    } else if (interaction.deferred && !interaction.replied && (action === 'join' || action === 'other')) {
      // deferReply() leaves a visible loading state until editReply(). Rule
      // actions use deferUpdate(), where editing would destroy retryable UI.
      await interaction.editReply({
        content: i18n.t('welcome.error_generic', locale),
        embeds: [],
        components: [],
      }).catch(() => {});
    } else {
      await interaction.followUp({
        content: i18n.t('welcome.error_generic', locale),
        ephemeral: true,
      }).catch(() => {});
    }
  }
}

// ═══════════════════════════════════════════════
//  Обработчики отдельных действий
// ═══════════════════════════════════════════════

/** «Вступление в полк» — показать правила, сохранить кнопки на публичном сообщении */
async function handleJoin(
  interaction: ButtonInteraction,
  _client: BublikClient,
  signal?: AbortSignal,
): Promise<void> {
  await interaction.deferReply({ ephemeral: true });
  throwIfWelcomeAborted(signal);
  const userId = interaction.user.id;
  const member = await withWelcomeLifecycleLock(
    interaction.guildId!,
    userId,
    async (lock) => {
      throwIfWelcomeAborted(signal);
      const current = await interaction.guild!.members.fetch({ user: userId, force: true });
      await lock.assertOwned();
      throwIfWelcomeAborted(signal);
      const generation = membershipGeneration(current.joinedTimestamp);
      if (!isAuthoritativeMembershipGeneration(generation)) {
        throw new Error(`Welcome membership generation is unknown for ${interaction.guildId}:${userId}`);
      }
      await setState(interaction.guildId!, userId, {
        serverRules: false,
        regimentRules: false,
        originChannelId: interaction.channelId,
        originMessageId: interaction.message.id,
        membershipGeneration: generation,
      });
      await lock.assertOwned();
      return current;
    },
    signal,
  );
  throwIfWelcomeAborted(signal);
  const locale = await getGuildLocale(interaction.guildId);
  throwIfWelcomeAborted(signal);

  // Сначала ephemeral reply — только так гарантировано виден пользователю
  await interaction.editReply({
    embeds: [buildRulesPromptEmbed(false, false, locale)],
    components: [buildRulesButtons(userId, false, false, locale)],
  });
  throwIfWelcomeAborted(signal);

  // Редактируем публичное сообщение — показываем статус, но СОХРАНЯЕМ кнопки,
  // чтобы пользователь мог повторить попытку если ephemeral-взаимодействие
  // сломалось (shard reconnect, таймаут и т.п.)
  await interaction.message.edit({
    embeds: [buildWelcomeChosenEmbed(member, true, locale)],
    components: [buildWelcomeButtons(userId, locale)],
  }).catch((err) => log.warn('Не удалось обновить welcome-сообщение', err));

  log.info(`[Welcome] ${interaction.user.tag} выбрал вступление в полк`);
}

async function loadFreshTicketHandoffChannel(
  guild: Guild,
  ticketChannelId: string,
  userId: string,
  isRecruit: boolean,
  generation: string,
  signal?: AbortSignal,
): Promise<TextChannel> {
  throwIfWelcomeAborted(signal);
  if (!isAuthoritativeMembershipGeneration(generation)) {
    throw new Error(`Ticket handoff requires an authoritative membership generation`);
  }
  const config = await getGuildConfigFresh(guild.id);
  if (config.ticketChannelId !== ticketChannelId) {
    throw new Error(`Ticket handoff channel configuration changed for ${guild.id}`);
  }
  if (isRecruit && (!config.recruitRoleId || !areWelcomeRoleIdsDistinct([
    config.autoRoleId,
    config.memberRoleId,
    config.recruitRoleId,
  ]))) {
    throw new Error(`Ticket handoff role configuration is unsafe for ${guild.id}`);
  }
  if ((await loadUnavailableUserIds(guild.id, [userId])).has(userId)) {
    throw new Error(`Ticket handoff blocked for unavailable member ${guild.id}:${userId}`);
  }
  const channel = await guild.channels.fetch(ticketChannelId, { force: true });
  if (!channel?.isTextBased()) throw new Error(`Ticket channel ${ticketChannelId} is not text-based`);
  throwIfWelcomeAborted(signal);
  await guild.roles.fetch(undefined, { force: true });
  throwIfWelcomeAborted(signal);
  const [botMember, targetMember] = await Promise.all([
    guild.members.fetch({ user: guild.client.user.id, force: true }),
    guild.members.fetch({ user: userId, force: true }),
  ]);
  throwIfWelcomeAborted(signal);
  if (membershipGeneration(targetMember.joinedTimestamp) !== generation) {
    throw new Error(`Ticket handoff membership generation changed for ${guild.id}:${userId}`);
  }
  if (isRecruit && !targetMember.roles.cache.has(config.recruitRoleId!)) {
    throw new Error(`Member ${userId} no longer has the configured recruit role`);
  }
  if (!channel.permissionsFor(botMember)?.has([
    PermissionsBitField.Flags.ViewChannel,
    PermissionsBitField.Flags.SendMessages,
    PermissionsBitField.Flags.EmbedLinks,
  ])) throw new Error(`Missing ticket channel permissions in ${ticketChannelId}`);
  if (!hasTicketPanelMemberAccess(channel.permissionsFor(targetMember))) {
    throw new Error(`Member ${userId} cannot view the ADIR panel in ${ticketChannelId}`);
  }
  return channel as TextChannel;
}

async function sendTicketPanelPing(
  guild: Guild,
  ticketChannelId: string,
  userId: string,
  isRecruit: boolean,
  locale: string,
  generation: string,
  signal?: AbortSignal,
): Promise<void> {

  const nonce = welcomeMessageNonce(
    isRecruit ? 'ticket-recruit' : 'ticket-other',
    guild.id,
    userId,
    generation,
  );
  const payload = {
    content: `<@${userId}>`,
    embeds: [buildTicketPingEmbed(userId, isRecruit, locale)],
    allowedMentions: { users: [userId], roles: [], repliedUser: false },
    nonce,
    enforceNonce: true,
  } as const;
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    throwIfWelcomeAborted(signal);
    try {
      await runValidatedTicketHandoffAttempt(
        () => loadFreshTicketHandoffChannel(
          guild,
          ticketChannelId,
          userId,
          isRecruit,
          generation,
          signal,
        ),
        (channel) => channel.send(payload).then(() => undefined),
      );
      return;
    } catch (err) {
      if ((err as { name?: string })?.name === 'AbortError') throw err;
      lastError = err;
      if (attempt < 3) await abortableDelay(2_000 * attempt, signal);
    }
  }
  throw lastError;
}

/** «Другой вопрос» — перенаправить в тикеты */
async function handleOther(
  interaction: ButtonInteraction,
  _client: BublikClient,
  signal?: AbortSignal,
): Promise<void> {
  await interaction.deferReply({ ephemeral: true });
  throwIfWelcomeAborted(signal);
  const member = await interaction.guild!.members.fetch({ user: interaction.user.id, force: true });
  throwIfWelcomeAborted(signal);
  const locale = await getGuildLocale(interaction.guildId);
  throwIfWelcomeAborted(signal);

  const cfg = await getGuildConfigFresh(interaction.guildId!);
  throwIfWelcomeAborted(signal);
  const ticketChannelId = cfg.ticketChannelId;

  // Ephemeral reply — гарантированно виден пользователю
  if (!ticketChannelId) {
    await interaction.editReply({
      content: i18n.t('welcome.error_no_ticket_channel', locale),
    });
    return;
  }

  await sendTicketPanelPing(
    interaction.guild!,
    ticketChannelId,
    interaction.user.id,
    false,
    locale,
    membershipGeneration(member.joinedTimestamp),
    signal,
  );
  throwIfWelcomeAborted(signal);

  await interaction.editReply({
    embeds: [buildOtherQuestionEmbed(ticketChannelId, locale)],
  });
  throwIfWelcomeAborted(signal);

  // Редактируем публичное сообщение
  await interaction.message.edit({
    embeds: [buildWelcomeChosenEmbed(member, false, locale)],
    components: [],
  }).catch((err) => log.warn('Не удалось обновить welcome-сообщение', err));

  log.info(`[Welcome] ${interaction.user.tag} выбрал "другой вопрос" → тикеты`);
}

/** «Правила сервера» — заменить ephemeral на сами правила + кнопка «Назад» */
async function handleRulesServer(interaction: ButtonInteraction, signal?: AbortSignal): Promise<void> {
  await interaction.deferUpdate();
  throwIfWelcomeAborted(signal);
  const userId = interaction.user.id;
  const locale = await getGuildLocale(interaction.guildId);
  throwIfWelcomeAborted(signal);
  const state = await getState(interaction.guildId!, userId);
  state.serverRules = true;
  throwIfWelcomeAborted(signal);
  await setState(interaction.guildId!, userId, state);
  throwIfWelcomeAborted(signal);

  // Заменяем одно и то же ephemeral-сообщение — нет накопления
  await interaction.editReply({
    embeds: buildServerRulesEmbeds(locale),
    components: [buildBackButton(userId, locale)],
  });
}

/** «Правила полка» — заменить ephemeral на сами правила + кнопка «Назад» */
async function handleRulesRegiment(interaction: ButtonInteraction, signal?: AbortSignal): Promise<void> {
  await interaction.deferUpdate();
  throwIfWelcomeAborted(signal);
  const userId = interaction.user.id;
  const locale = await getGuildLocale(interaction.guildId);
  throwIfWelcomeAborted(signal);
  const state = await getState(interaction.guildId!, userId);
  state.regimentRules = true;
  throwIfWelcomeAborted(signal);
  await setState(interaction.guildId!, userId, state);
  throwIfWelcomeAborted(signal);

  await interaction.editReply({
    embeds: [buildRegimentRulesEmbed(locale)],
    components: [buildBackButton(userId, locale)],
  });
}

/** «Назад к прогрессу» — вернуть экран прогресса с текущим статусом */
async function handleRulesBack(interaction: ButtonInteraction, signal?: AbortSignal): Promise<void> {
  await interaction.deferUpdate();
  throwIfWelcomeAborted(signal);
  const userId = interaction.user.id;
  const locale = await getGuildLocale(interaction.guildId);
  throwIfWelcomeAborted(signal);
  const state = await getState(interaction.guildId!, userId);
  throwIfWelcomeAborted(signal);

  await interaction.editReply({
    embeds: [buildRulesPromptEmbed(state.serverRules, state.regimentRules, locale)],
    components: [buildRulesButtons(userId, state.serverRules, state.regimentRules, locale)],
  });
}

/** «Ознакомился с правилами» — выдать роль, перенаправить в тикеты */
function messageTargetsWelcomeUser(message: Message, userId: string): boolean {
  if (message.author.id !== message.client.user?.id) return false;
  const expected = new Set([
    `${PREFIX}:join:${userId}`,
    `${PREFIX}:other:${userId}`,
  ]);
  return message.components.some((component) => {
    const row = component.toJSON() as { components?: Array<{ custom_id?: string }> };
    return row.components?.some((child) => expected.has(child.custom_id ?? '')) ?? false;
  });
}

async function fetchTrackedWelcomeMessage(
  guild: Guild,
  userId: string,
  state: RulesState,
  fallbackChannelId?: string | null,
  signal?: AbortSignal,
): Promise<Message | null> {
  throwIfWelcomeAborted(signal);
  if (state.originChannelId && state.originMessageId) {
    const channel = await guild.channels.fetch(state.originChannelId).catch(() => null);
    throwIfWelcomeAborted(signal);
    if (channel?.isTextBased()) {
      const message = await (channel as TextChannel).messages.fetch(state.originMessageId).catch(() => null);
      throwIfWelcomeAborted(signal);
      if (message && messageTargetsWelcomeUser(message, userId)) return message;
    }
  }

  // Temporary compatibility for state created before exact message IDs were stored.
  if (!fallbackChannelId) return null;
  const fallback = await guild.channels.fetch(fallbackChannelId).catch(() => null);
  throwIfWelcomeAborted(signal);
  if (!fallback?.isTextBased()) return null;
  const messages = await (fallback as TextChannel).messages.fetch({ limit: 50 });
  throwIfWelcomeAborted(signal);
  return messages.find((message) => messageTargetsWelcomeUser(message, userId)) ?? null;
}

export async function disableTrackedWelcomeMessage(
  guild: Guild,
  userId: string,
  signal?: AbortSignal,
): Promise<void> {
  throwIfWelcomeAborted(signal);
  const state = await getState(guild.id, userId);
  throwIfWelcomeAborted(signal);
  const cfg = await getGuildConfigFresh(guild.id);
  throwIfWelcomeAborted(signal);
  const message = await fetchTrackedWelcomeMessage(guild, userId, state, cfg.welcomeChannelId, signal);
  throwIfWelcomeAborted(signal);
  if (message) await message.edit({ components: [] });
}

async function handleRulesDone(
  interaction: ButtonInteraction,
  _client: BublikClient,
  signal?: AbortSignal,
): Promise<void> {
  const userId = interaction.user.id;

  // 0. Немедленно подтверждаем взаимодействие — до любых REST-вызовов
  //    Без этого token истекает за <3с и вызов update() падает с Unknown interaction.
  await interaction.deferUpdate();
  throwIfWelcomeAborted(signal);
  const locale = await getGuildLocale(interaction.guildId);
  throwIfWelcomeAborted(signal);

  // Проверяем, что оба документа действительно прочитаны
  const state = await getState(interaction.guildId!, userId);
  throwIfWelcomeAborted(signal);
  if (!state.serverRules || !state.regimentRules) {
    await interaction.followUp({
      content: i18n.t('welcome.error_read_both_docs', locale),
      ephemeral: true,
    });
    return;
  }

  const cfg = await getGuildConfigFresh(interaction.guildId!);
  throwIfWelcomeAborted(signal);
  const ticketChannelId = cfg.ticketChannelId;
  const recruitRoleId   = cfg.recruitRoleId;

  if (!areWelcomeRoleIdsDistinct([cfg.autoRoleId, cfg.memberRoleId, cfg.recruitRoleId])) {
    await interaction.editReply({
      embeds: [buildRulesPromptEmbed(true, true, locale)],
      components: [buildRulesButtons(userId, true, true, locale)],
    });
    await interaction.followUp({
      content: i18n.t('welcome.error_role_failed', locale),
      ephemeral: true,
    });
    log.error(`Welcome onboarding blocked by overlapping role configuration for ${interaction.guildId}`);
    return;
  }

  if (!ticketChannelId) {
    await interaction.editReply({
      embeds: [buildRulesPromptEmbed(true, true, locale)],
      components: [buildRulesButtons(userId, true, true, locale)],
    });
    await interaction.followUp({
      content: i18n.t('welcome.error_no_ticket_channel', locale),
      ephemeral: true,
    });
    return;
  }

  if (!recruitRoleId || !interaction.guild) {
    await interaction.editReply({
      embeds: [buildRulesPromptEmbed(true, true, locale)],
      components: [buildRulesButtons(userId, true, true, locale)],
    });
    await interaction.followUp({
      content: i18n.t('welcome.error_role_failed', locale),
      ephemeral: true,
    });
    log.error(`Welcome onboarding не завершён: recruitRoleId не настроен для ${interaction.guildId}`);
    return;
  }

  // 1. Выдаем роль — надёжный метод с retry + верификацией
  //    Discord API может вернуть 5xx / rate-limit → без retry роль «выборочно» не выдаётся
  const member = await interaction.guild.members.fetch({ user: userId, force: true }).catch(() => null);
  const roleAssigned = member &&
    state.membershipGeneration === membershipGeneration(member.joinedTimestamp)
    ? await assignRoleReliably(
      member,
      recruitRoleId,
      'recruit',
      'Ознакомлен с правилами полка — Bublik Bot',
      signal,
      (freshMember, freshConfig) =>
        state.membershipGeneration === membershipGeneration(freshMember.joinedTimestamp) &&
        (!freshConfig.memberRoleId ||
          !freshMember.roles.cache.has(freshConfig.memberRoleId)),
    )
    : false;

  if (!roleAssigned) {
    // Не показываем успех и не удаляем Redis-state: пользователь сможет
    // безопасно повторить действие после восстановления Discord/API/настроек.
    await interaction.editReply({
      embeds: [buildRulesPromptEmbed(true, true, locale)],
      components: [buildRulesButtons(userId, true, true, locale)],
    });
    await interaction.followUp({
      content: i18n.t('welcome.error_role_failed', locale),
      ephemeral: true,
    }).catch(() => {});
    return;
  }
  throwIfWelcomeAborted(signal);

  // Economic completion is the durable side effect. It must happen before any
  // UI/Redis terminalization so a transient DB failure remains safely retryable.
  const ecoConfig = await getEcoConfig(interaction.guildId!);
  throwIfWelcomeAborted(signal);
  if (ecoConfig?.enabled && ecoConfig.welcomeBonus > 0) {
    const bonus = await grantWelcomeBonusOnce(
      interaction.guildId!,
      userId,
      ecoConfig.welcomeBonus,
      'Стартовый капитал',
    );
    log.info(bonus.granted
      ? `[Welcome] ${interaction.user.tag} получил стартовый капитал: ${ecoConfig.welcomeBonus}₪`
      : `[Welcome] Повторное начисление стартового капитала ${interaction.user.tag} предотвращено`);
  }
  throwIfWelcomeAborted(signal);

  // Handoff delivery is terminal: do not clear the state/UI until Discord has
  // confirmed the ping. The nonce makes a response-loss retry idempotent.
  await sendTicketPanelPing(
    interaction.guild,
    ticketChannelId,
    userId,
    true,
    locale,
    state.membershipGeneration!,
    signal,
  );
  throwIfWelcomeAborted(signal);

  await interaction.editReply({
    embeds: [buildJoinCompleteEmbed(ticketChannelId, locale)],
    components: [],
  }).catch((err) => log.warn('Не удалось обновить итоговый onboarding UI', err));
  throwIfWelcomeAborted(signal);

  if (member) {
    try {
      const welcomeMessage = await fetchTrackedWelcomeMessage(
        interaction.guild,
        userId,
        state,
        cfg.welcomeChannelId,
        signal,
      );
      throwIfWelcomeAborted(signal);
      if (welcomeMessage) {
        await welcomeMessage.edit({
          embeds: [buildWelcomeChosenEmbed(member, true, locale)],
          components: [],
        });
      }
    } catch (err) {
      log.debug(`Не удалось очистить публичное welcome-сообщение: ${String(err)}`);
    }
  }

  throwIfWelcomeAborted(signal);
  await clearState(interaction.guildId!, userId)
    .catch((err) => log.warn('Не удалось очистить welcome state после успешного завершения', err));

  log.info(`[Welcome] ${interaction.user.tag} завершил ознакомление, роль выдана → тикеты`);
}
