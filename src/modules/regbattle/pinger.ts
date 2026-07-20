// ═══════════════════════════════════════════════
//  RegBattle — Система автоматических пингов
//
//  Стейт-машина на гильдию:
//  1. IDLE       — нет активных отрядов
//  2. RECRUITING — пинг роли каждые 5 мин
//  3. ESCALATED  — именные пинги каждые 30 сек
//  4. FULL       — все отряды полны → предложение
//                  перейти в запасные каждые 15 мин
//
//  Один setInterval (10 сек) проверяет все гильдии.
//  Состояние в памяти → пересчитывается при рестарте.
// ═══════════════════════════════════════════════

import { Guild, TextChannel, Message, PermissionFlagsBits } from 'discord.js';
import type { BublikClient } from '../../bot';
import { logger } from '../../core/Logger';
import { getGuildLocale } from '../../core/GuildConfig';
import { getRedis } from '../../core/Redis';
import { scheduleTask, unscheduleTask } from '../../core/SchedulerManager';
import { getAllowedGuildsList, isGuildAllowed } from '../../core/Whitelist';
import {
  assertCompleteGuildMemberSnapshotCurrent,
  getCompleteGuildMemberSnapshot,
  getCompleteGuildMembers,
} from '../../core/GuildMemberSnapshot';

import {
  PINGER_INTERVAL_MS,
  ROLE_PING_INTERVAL_MS,
  INDIVIDUAL_PING_INTERVAL_MS,
  INDIVIDUAL_ESCALATION_COOLDOWN_MS,
  FULL_SUGGEST_INTERVAL_MS,
  PING_AUTO_DELETE_MS,
} from './constants';

import { getConfig, getGuildSquads, getAllPbChannelIds, getSquadByAnyVoice } from './database';
import { getSquadMemberCount } from './utils';

import {
  buildRecruitPingEmbed,
  buildFullSuggestEmbed,
  buildIndividualPingMessage,
} from './embeds';

import { refreshStatusPanel, isNotifyOff } from './lifecycle';
import {
  buildPbMassRoleMentionPlan,
  isPbIndividualEscalationReady,
  isPbIndividualPingEligible,
  loadPbPingEligibilitySnapshot,
  pbPingCandidateFromMember,
} from './pingEligibility';
import { buildPbPingerMessage } from './pingerMessages';
import { isUnknownMemberError } from './safety';
import {
  buildPingerObservationSignature,
  canSendPingerFullSuggestion,
  completePingerRevision,
  hasPendingPingerRevision,
  isPingerActionDue,
  nextIndividualCandidateIndex,
  nextPingerRevision,
  runPingerTasksWithConcurrency,
  selectAllowedCachedGuildsToSeed,
  selectNotifyEnabledSquads,
  selectPingerPopulationPhase,
  selectPingerClaimSettlement,
  shouldAdvancePingerLocalCooldown,
  shouldEndEscalationAfterQueueRefresh,
  summarizePingerOccupancy,
  wasPingerRecalculatedSince,
  type IndividualQueueRefreshOutcome,
} from './pingerPolicy';
import {
  claimPingerCooldown,
  confirmPingerCooldown,
  finalizePingerCooldown,
  incrementPingerNoProgressCounter,
  isPingerEscalationCoolingDown,
  loadPingerNoProgressCounter,
  pingerActionCooldownKey,
  pingerIndividualUserCooldownKey,
  releasePingerCooldown,
  resetPingerNoProgressCounter,
  startPingerEscalationCooldown,
  type PingerCooldownClaim,
} from './pingerCooldown';

const log = logger.child('RegBattle:Pinger');

// ═══════════════════════════════════════════════
//  Типы
// ═══════════════════════════════════════════════

enum PingPhase {
  Idle = 'idle',
  Recruiting = 'recruiting',
  Escalated = 'escalated',
  Full = 'full',
}

interface GuildPingerState {
  phase: PingPhase;
  lastRolePingAt: number;
  lastIndividualPingAt: number;
  lastFullSuggestAt: number;
  lastEscalationEndedAt: number; // когда закончился последний цикл именных пингов
  rolePingsWithoutProgress: number;
  lastKnownTotal: number;
  individualQueue: string[];     // userIds для именного пинга
  individualIndex: number;
  lastObservationSignature: string | null;
  requestedRevision: number;
  processedRevision: number;
}

interface SquadInfo {
  number: number;
  count: number;
  size: number;
  voiceChannelId: string;
  airChannelId: string | null;
  ownerTag: string;
  ownerId: string;
  squadId: string;
}

interface SquadObservation {
  all: SquadInfo[];
  active: SquadInfo[];
  notifyOffSquadIds: Set<string>;
}

async function observePingerSquads(
  guild: Guild,
  config: any,
  knownSquads?: readonly any[],
): Promise<SquadObservation> {
  const squads = knownSquads ?? await getGuildSquads(guild.id);
  const all: SquadInfo[] = squads.map((s: any) => ({
    number: s.number as number,
    count: getSquadMemberCount(guild, s.voiceChannelId, s.airChannelId),
    size: config.squadSize as number,
    voiceChannelId: s.voiceChannelId as string,
    airChannelId: (s.airChannelId as string | null | undefined) ?? null,
    ownerTag: guild.members.cache.get(s.ownerId)?.user.tag ?? 'Неизвестный',
    ownerId: s.ownerId as string,
    squadId: s.id as string,
  }));
  const notifyFlags = await Promise.all(all.map((squad) => isNotifyOff(squad.squadId)));
  const notifyOffSquadIds = new Set(
    all.filter((_, index) => notifyFlags[index]).map((squad) => squad.squadId),
  );
  return {
    all,
    active: selectNotifyEnabledSquads(all, notifyOffSquadIds),
    notifyOffSquadIds,
  };
}

// ═══════════════════════════════════════════════
//  Глобальное состояние
// ═══════════════════════════════════════════════

const guildStates = new Map<string, GuildPingerState>();
const startupSeededGuildIds = new Set<string>();
let pingerClient: BublikClient | null = null;

// ═══════════════════════════════════════════════
//  Start / Stop
// ═══════════════════════════════════════════════

export function startPinger(client: BublikClient): void {
  pingerClient = client;
  seedAllowedCachedGuilds(client);

  scheduleTask('regbattle:pinger', PINGER_INTERVAL_MS, async () => {
    await runPingerCycle();
  }, { immediate: true });

  log.info('Пингер ПБ запущен (интервал 10с)');
}

export function stopPinger(): void {
  unscheduleTask('regbattle:pinger');
  pingerClient = null;
  guildStates.clear();
  startupSeededGuildIds.clear();
  log.info('Пингер ПБ остановлен');
}

/**
 * Вызывается из lifecycle при изменении состава отрядов.
 * Повышает ревизию, чтобы следующий тик пересчитал фазу без lost wakeup.
 */
export function recalculatePinger(guildId: string): void {
  const state = guildStates.get(guildId);
  if (state) {
    state.requestedRevision = nextPingerRevision(state.requestedRevision);
  } else {
    // Создаём новый стейт — будет инициализирован на следующем тике
    guildStates.set(guildId, createEmptyState());
  }
}

function createEmptyState(): GuildPingerState {
  return {
    phase: PingPhase.Idle,
    lastRolePingAt: 0,
    lastIndividualPingAt: 0,
    lastFullSuggestAt: 0,
    lastEscalationEndedAt: 0,
    rolePingsWithoutProgress: 0,
    lastKnownTotal: 0,
    individualQueue: [],
    individualIndex: 0,
    lastObservationSignature: null,
    requestedRevision: 1,
    processedRevision: 0,
  };
}

function seedAllowedCachedGuilds(client: BublikClient): void {
  const allowedGuildIds = getAllowedGuildsList();
  const allowedSet = new Set(allowedGuildIds);
  const cachedGuildIds = new Set(client.guilds.cache.keys());

  for (const guildId of startupSeededGuildIds) {
    if (!allowedSet.has(guildId) || !cachedGuildIds.has(guildId)) {
      startupSeededGuildIds.delete(guildId);
    }
  }

  for (const guildId of selectAllowedCachedGuildsToSeed(
    allowedGuildIds,
    cachedGuildIds,
    startupSeededGuildIds,
  )) {
    startupSeededGuildIds.add(guildId);
    if (!guildStates.has(guildId)) guildStates.set(guildId, createEmptyState());
  }
}

function discardOrResetGuildState(
  guildId: string,
  state: GuildPingerState,
  observedRevision: number,
): void {
  if (guildStates.get(guildId) !== state) return;
  if (!wasPingerRecalculatedSince(observedRevision, state.requestedRevision)) {
    guildStates.delete(guildId);
    return;
  }

  const requestedRevision = state.requestedRevision;
  const processedRevision = completePingerRevision(state.processedRevision, observedRevision);
  Object.assign(state, createEmptyState(), {
    requestedRevision,
    processedRevision,
  });
}

// ═══════════════════════════════════════════════
//  Основной цикл
// ═══════════════════════════════════════════════

async function runPingerCycle(): Promise<void> {
  if (!pingerClient) return;
  seedAllowedCachedGuilds(pingerClient);

  await runPingerTasksWithConcurrency([...guildStates.entries()], 2, async ([guildId, state]) => {
    if (!isGuildAllowed(guildId)) {
      guildStates.delete(guildId);
      startupSeededGuildIds.delete(guildId);
      return;
    }
    await processGuild(guildId, state);
  }, ([guildId], err) => {
    log.error(`Ошибка пингера для гильдии ${guildId}`, { error: String(err) });
  });
}

async function processGuild(guildId: string, state: GuildPingerState): Promise<void> {
  const client = pingerClient!;
  const guild = client.guilds.cache.get(guildId);
  if (!guild) {
    guildStates.delete(guildId);
    startupSeededGuildIds.delete(guildId);
    return;
  }

  // Consume only the revision seen before async reads. A recalculation that
  // arrives during any await remains newer than processedRevision.
  const observedRevision = state.requestedRevision;

  const config = await getConfig(guildId);
  if (!config || !config.announceChannelId) {
    discardOrResetGuildState(guildId, state, observedRevision);
    return;
  }

  const squads = await getGuildSquads(guildId);
  if (squads.length === 0) {
    discardOrResetGuildState(guildId, state, observedRevision);
    return;
  }

  const observation = await observePingerSquads(guild, config, squads);
  const squadInfos = observation.all;
  const activeSquadInfos = observation.active;
  const { notifyOffSquadIds } = observation;
  const redis = getRedis();
  state.rolePingsWithoutProgress = await loadPingerNoProgressCounter(redis, guild.id);
  const observationSignature = buildPingerObservationSignature(
    squadInfos.map((squad) => ({
      squadId: squad.squadId,
      count: squad.count,
      size: squad.size,
      notifyOff: notifyOffSquadIds.has(squad.squadId),
    })),
  );

  const { occupiedSlots: activeOccupiedSlots } = summarizePingerOccupancy(activeSquadInfos);
  const populationPhase = selectPingerPopulationPhase(activeSquadInfos);

  const now = Date.now();
  const phaseAtCycleStart = state.phase;

  // Recruiting progress belongs only to squads that currently accept
  // notifications. Apply it before phase/action selection so a join cannot be
  // followed by one stale individual ping. Interrupted escalation gets the
  // same cooldown and queue cleanup as a completed round.
  if (state.lastObservationSignature !== null && activeOccupiedSlots > state.lastKnownTotal) {
    const wasEscalated = state.phase === PingPhase.Escalated;
    state.rolePingsWithoutProgress = 0;
    await resetPingerNoProgressCounter(redis, guild.id);
    if (wasEscalated) {
      state.lastEscalationEndedAt = Date.now();
      state.individualQueue = [];
      state.individualIndex = 0;
      await startPingerEscalationCooldown(
        redis,
        guild.id,
        INDIVIDUAL_ESCALATION_COOLDOWN_MS,
      );
    }
  }

  // Пересчёт фазы для последней полностью наблюдавшейся ревизии.
  if (
    hasPendingPingerRevision(observedRevision, state.processedRevision) ||
    state.lastObservationSignature !== observationSignature
  ) {
    if (populationPhase === 'full') {
      state.phase = PingPhase.Full;
    } else if (populationPhase === 'recruiting') {
      // Проверить, нужна ли эскалация
      const escalateAfter = config.pingEscalateAfter ?? 6;
      const cooledDown = isPbIndividualEscalationReady(now, state.lastEscalationEndedAt) &&
        !(await isPingerEscalationCoolingDown(redis, guild.id));

      if (state.rolePingsWithoutProgress >= escalateAfter && cooledDown) {
        state.phase = PingPhase.Escalated;
      } else {
        state.phase = PingPhase.Recruiting;
      }
    } else {
      state.phase = PingPhase.Idle;
    }
    state.processedRevision = completePingerRevision(
      state.processedRevision,
      observedRevision,
    );
  }

  if (phaseAtCycleStart === PingPhase.Escalated && state.phase !== PingPhase.Escalated) {
    state.rolePingsWithoutProgress = 0;
    state.lastEscalationEndedAt = Date.now();
    state.individualQueue = [];
    state.individualIndex = 0;
    await Promise.all([
      resetPingerNoProgressCounter(redis, guild.id),
      startPingerEscalationCooldown(
        redis,
        guild.id,
        INDIVIDUAL_ESCALATION_COOLDOWN_MS,
      ),
    ]);
  }

  // Обработка по фазе
  switch (state.phase) {
    case PingPhase.Recruiting:
      await handleRecruiting(guild, config, state, now, observedRevision);
      break;

    case PingPhase.Escalated:
      await handleEscalated(guild, config, state, now, observedRevision);
      break;

    case PingPhase.Full:
      await handleFull(guild, config, state, now, observedRevision);
      break;
  }

  state.lastKnownTotal = activeOccupiedSlots;
  state.lastObservationSignature = observationSignature;
}

// ═══════════════════════════════════════════════
//  Авто-удаление пинг-сообщений
// ═══════════════════════════════════════════════

function scheduleAutoDelete(msg: Message, delayMs: number = PING_AUTO_DELETE_MS): void {
  setTimeout(() => {
    const guildId = msg.guildId;
    if (!guildId || !isGuildAllowed(guildId) || !pingerClient?.guilds.cache.has(guildId)) return;
    msg.delete().catch(() => null);
  }, delayMs);
}

// ═══════════════════════════════════════════════
//  Фаза: RECRUITING — пинг роли каждые 5 мин
// ═══════════════════════════════════════════════

async function handleRecruiting(
  guild: Guild,
  config: any,
  state: GuildPingerState,
  now: number,
  observedRevision: number,
): Promise<void> {
  if (now - state.lastRolePingAt < ROLE_PING_INTERVAL_MS) return;
  const redis = getRedis();
  const claim = await claimPingerCooldown(
    redis,
    pingerActionCooldownKey(guild.id, 'role'),
    ROLE_PING_INTERVAL_MS,
  );
  if (!claim) return;
  let claimOwnershipLost = false;
  let sendAttempted = false;
  let retrySafeAbort = false;

  try {
    // One complete population is shared by the status panel and role-mention
    // policy; Discord's full member request is not issued twice back-to-back.
    const memberSnapshot = await getCompleteGuildMemberSnapshot(guild);
    const members = memberSnapshot.members;
    await refreshStatusPanel(guild, pingerClient!, true, members);

    const locale = await getGuildLocale(guild.id);
    const channel = await guild.client.channels.fetch(config.announceChannelId) as TextChannel;
    if (!channel) return;

    const pingRoleId = typeof config.pingRoleId === 'string' ? config.pingRoleId : null;
    let pingRoleMembers: ReturnType<typeof pbPingCandidateFromMember>[] = [];
    let mention: ReturnType<typeof buildPbMassRoleMentionPlan> = null;

    // Avoid renewing a claim whose long preliminary panel/channel work already
    // became stale. A token-guarded release below leaves no local cooldown.
    const preliminary = await observePingerSquads(guild, config);
    if (
      state.requestedRevision !== observedRevision ||
      !preliminary.active.some((squad) => squad.count < squad.size)
    ) {
      retrySafeAbort = true;
      return;
    }

    // Prove ownership before the last mutable external-state reads. The claim
    // keeps its conservative lease until the terminal send/failure finalizer.
    if (!(await confirmPingerCooldown(redis, claim))) {
      claimOwnershipLost = true;
      return;
    }

    // Discord role mentions are all-or-nothing. Rebuild every mutable policy
    // input after claim confirmation.
    const pingRole = pingRoleId
      ? await guild.roles.fetch(pingRoleId, { force: true })
      : null;
    const fresh = await observePingerSquads(guild, config);
    const eligibility = pingRoleId && pingRole
      ? await loadPbPingEligibilitySnapshot(guild.id)
      : null;

    // Eligibility is the final await. Reassert the exact complete-cache gateway
    // generation captured above, then keep the occupancy/role/send fence fully
    // synchronous. A disconnect fails closed instead of silently crossing into
    // a new generation with stale policy reads.
    assertCompleteGuildMemberSnapshotCurrent(guild, memberSnapshot.token);

    // Refresh gateway occupancy synchronously so a late join/full squad aborts
    // before the send call.
    const finalActive = fresh.active.map((squad) => ({
      ...squad,
      count: getSquadMemberCount(guild, squad.voiceChannelId, squad.airChannelId),
    }));
    const freshUnfilled = finalActive.filter((squad) => squad.count < squad.size);
    if (state.requestedRevision !== observedRevision || freshUnfilled.length === 0) {
      retrySafeAbort = true;
      return;
    }

    if (pingRoleId && pingRole && eligibility) {
      const pbChannelIds = new Set<string>();
      for (const squad of fresh.all) {
        pbChannelIds.add(squad.voiceChannelId);
        if (squad.airChannelId) pbChannelIds.add(squad.airChannelId);
      }
      if (config.reserveChannelId) pbChannelIds.add(config.reserveChannelId);
      const policy = {
        pingRoleId,
        playedTodayRoleId: config.playedTodayRoleId ?? null,
        pbChannelIds,
      };
      // Role.members is derived from the live guild member cache. The complete
      // fetch above establishes coverage; this synchronous read also catches a
      // role mutation that arrived while the final DB/topology reads ran.
      pingRoleMembers = pingRole.members.map(pbPingCandidateFromMember);
      const unavailablePingRoleState = new Map<string, boolean>();
      for (const userId of eligibility.excludedUserIds) {
        unavailablePingRoleState.set(
          userId,
          guild.members.cache.get(userId)?.roles.cache.has(pingRoleId) === true,
        );
      }
      mention = buildPbMassRoleMentionPlan(
        policy,
        eligibility,
        unavailablePingRoleState,
        pingRoleMembers,
        pingRole.mentionable || Boolean(
          guild.members.me &&
          channel.permissionsFor(guild.members.me)?.has(PermissionFlagsBits.MentionEveryone),
        ),
      );
    }

    sendAttempted = true;
    const sendPromise = channel.send(buildPbPingerMessage(
      buildRecruitPingEmbed(finalActive, locale),
      mention,
    ));
    const sent = await sendPromise;

    // Автоудаление пинг-сообщения
    scheduleAutoDelete(sent);

    if (!mention) {
      // Preserve the informational embed, but never count it as a role ping.
      // Eligible users will instead be re-checked one by one on the next tick.
      if (
        pingRoleMembers.length > 0 &&
        isPbIndividualEscalationReady(Date.now(), state.lastEscalationEndedAt) &&
        !(await isPingerEscalationCoolingDown(redis, guild.id))
      ) {
        state.phase = PingPhase.Escalated;
        state.individualQueue = [];
        state.individualIndex = 0;
        log.warn(`Pinger ${guild.id}: unsafe mass role population; using individual pings`);
      } else if (pingRoleMembers.length > 0) {
        log.warn(
          `Pinger ${guild.id}: unsafe mass role population; individual-ping cooldown is active`,
        );
      }
      if (!pingRoleId || !pingRole) {
        log.warn(`Pinger ${guild.id}: configured ping role is unavailable; role mention skipped`);
      }
      return;
    }

    state.rolePingsWithoutProgress = await incrementPingerNoProgressCounter(redis, guild.id);

    // Проверить эскалацию
    const escalateAfter = config.pingEscalateAfter ?? 6;
    const cooledDown = isPbIndividualEscalationReady(
      Date.now(),
      state.lastEscalationEndedAt,
      INDIVIDUAL_ESCALATION_COOLDOWN_MS,
    ) && !(await isPingerEscalationCoolingDown(redis, guild.id));

    if (state.rolePingsWithoutProgress >= escalateAfter && cooledDown) {
      state.phase = PingPhase.Escalated;
      state.individualQueue = [];
      state.individualIndex = 0;
      log.info(`Пингер гильдии ${guild.id}: эскалация к именным пингам`);
    }
  } catch (err) {
    log.error('Ошибка пинга роли', { error: String(err) });
  } finally {
    let localOutcome: Parameters<typeof shouldAdvancePingerLocalCooldown>[0];
    let settled = false;
    const settlement = selectPingerClaimSettlement(
      sendAttempted,
      claimOwnershipLost,
      retrySafeAbort,
    );
    if (settlement === 'finalize') {
      localOutcome = sendAttempted ? 'sent-or-ambiguous' : 'retained-without-send';
      settled = await finalizePingerCooldown(redis, claim).catch(() => false);
    } else if (settlement === 'ownership-lost') {
      localOutcome = 'ownership-lost';
      settled = true;
    } else {
      try {
        settled = await releasePingerCooldown(redis, claim);
        localOutcome = settled ? 'released' : 'ownership-lost';
      } catch {
        localOutcome = 'retained-without-send';
      }
    }
    if (shouldAdvancePingerLocalCooldown(localOutcome)) {
      state.lastRolePingAt = Date.now();
    }
    if (!settled && localOutcome !== 'ownership-lost') {
      log.warn(`Pinger ${guild.id}: role cooldown claim retained until its safety TTL`);
    }
  }
}

// ═══════════════════════════════════════════════
//  Фаза: ESCALATED — именные пинги каждые 30 сек
// ═══════════════════════════════════════════════

async function finishIndividualEscalation(
  guildId: string,
  state: GuildPingerState,
): Promise<void> {
  const endedAt = Date.now();
  state.phase = PingPhase.Recruiting;
  state.rolePingsWithoutProgress = 0;
  state.lastEscalationEndedAt = endedAt;
  state.individualQueue = [];
  state.individualIndex = 0;
  const redis = getRedis();
  await Promise.all([
    resetPingerNoProgressCounter(redis, guildId),
    startPingerEscalationCooldown(
      redis,
      guildId,
      INDIVIDUAL_ESCALATION_COOLDOWN_MS,
    ),
  ]);
}

async function handleEscalated(
  guild: Guild,
  config: any,
  state: GuildPingerState,
  now: number,
  observedRevision: number,
): Promise<void> {
  if (!isPingerActionDue(now, state.lastIndividualPingAt, INDIVIDUAL_PING_INTERVAL_MS)) return;

  // Очередь исчерпана → один круг завершён, кулдаун 30 мин
  if (state.individualQueue.length > 0 && state.individualIndex >= state.individualQueue.length) {
    await finishIndividualEscalation(guild.id, state);
    log.info(`Пингер гильдии ${guild.id}: именные пинги завершены (1 круг), кулдаун 30 мин`);
    return;
  }

  // Заполнить очередь при первом входе в фазу
  if (state.individualQueue.length === 0) {
    const refreshOutcome = await refreshIndividualQueue(guild, config, state);
    if (refreshOutcome === 'retry') {
      state.lastIndividualPingAt = Date.now();
      return;
    }
    if (shouldEndEscalationAfterQueueRefresh(refreshOutcome)) {
      // Нет доступных бойцов → вернуться к ролевым пингам
      await finishIndividualEscalation(guild.id, state);
      log.info(`Пингер гильдии ${guild.id}: нет бойцов для именных пингов, кулдаун 30 мин`);
      return;
    }
  }

  const userId = state.individualQueue[state.individualIndex];
  let cooldownManagedByClaim = false;

  try {
    let member;
    try {
      member = await guild.members.fetch({ user: userId, force: true });
    } catch (error) {
      if (!isUnknownMemberError(error)) throw error;
      state.individualIndex = nextIndividualCandidateIndex(
        state.individualIndex,
        'authoritative-skip',
      );
      state.lastIndividualPingAt = Date.now();
      return;
    }

    // Queue entries are hints only. Vacation/role/voice state is re-read before
    // every individual mention so a newly-started vacation is fail-closed.
    const pbIds = new Set(await getAllPbChannelIds(guild.id));
    if (config.reserveChannelId) pbIds.add(config.reserveChannelId);
    const eligibility = await loadPbPingEligibilitySnapshot(guild.id, [member.id]);
    if (!isPbIndividualPingEligible(
      pbPingCandidateFromMember(member),
      {
        pingRoleId: config.pingRoleId,
        playedTodayRoleId: config.playedTodayRoleId,
        pbChannelIds: pbIds,
      },
      eligibility,
    )) {
      state.individualIndex = nextIndividualCandidateIndex(
        state.individualIndex,
        'authoritative-skip',
      );
      state.lastIndividualPingAt = Date.now();
      return;
    }

    const channel = await guild.client.channels.fetch(config.announceChannelId) as TextChannel;
    if (!channel) {
      state.lastIndividualPingAt = Date.now();
      return;
    }

    const locale = await getGuildLocale(guild.id);

    const fresh = await observePingerSquads(guild, config);
    const unfilled = fresh.active.filter((squad) => squad.count < squad.size);
    const finalEligibility = await loadPbPingEligibilitySnapshot(guild.id, [member.id]);
    if (
      state.requestedRevision !== observedRevision ||
      unfilled.length === 0 ||
      !isPbIndividualPingEligible(
        pbPingCandidateFromMember(member),
        {
          pingRoleId: config.pingRoleId,
          playedTodayRoleId: config.playedTodayRoleId,
          pbChannelIds: pbIds,
        },
        finalEligibility,
      )
    ) {
      return;
    }

    const text = buildIndividualPingMessage(member, unfilled, locale);
    if (!text) {
      state.lastIndividualPingAt = Date.now();
      return;
    }

    const redis = getRedis();
    const actionClaim = await claimPingerCooldown(
      redis,
      pingerActionCooldownKey(guild.id, 'individual'),
      INDIVIDUAL_PING_INTERVAL_MS,
    );
    if (!actionClaim) return;
    cooldownManagedByClaim = true;
    let userClaim: PingerCooldownClaim | null = null;
    let sendAttempted = false;
    let finalFenceAbort = false;
    let actionShouldRetain = false;
    let actionClaimOwnershipLost = false;
    try {
      userClaim = await claimPingerCooldown(
        redis,
        pingerIndividualUserCooldownKey(guild.id, member.id),
        INDIVIDUAL_ESCALATION_COOLDOWN_MS,
      );
      if (!userClaim) {
        actionShouldRetain = true;
        state.individualIndex = nextIndividualCandidateIndex(
          state.individualIndex,
          'authoritative-skip',
        );
        return;
      }
      const userCooldownOwned = await confirmPingerCooldown(redis, userClaim);
      if (!userCooldownOwned) {
        // A previous/parallel worker owns this recipient. Throttle the guild
        // action and move on without touching the successor's claim.
        userClaim = null;
        actionShouldRetain = true;
        state.individualIndex = nextIndividualCandidateIndex(
          state.individualIndex,
          'authoritative-skip',
        );
        return;
      }

      if (!(await confirmPingerCooldown(redis, actionClaim))) {
        actionClaimOwnershipLost = true;
        return;
      }

      // Redis claims add awaits after the initial preflight. Re-read every
      // mutable eligibility/count input once more, with no await between the
      // final decision and the Discord send call.
      const sendMember = await guild.members.fetch({ user: member.id, force: true });
      const observedVoiceChannelId = sendMember.voice.channelId;
      const sendPbIds = new Set(await getAllPbChannelIds(guild.id));
      if (config.reserveChannelId) sendPbIds.add(config.reserveChannelId);
      const currentVoiceSquad = observedVoiceChannelId
        ? await getSquadByAnyVoice(observedVoiceChannelId)
        : null;
      if (currentVoiceSquad?.guildId === guild.id) {
        sendPbIds.add(currentVoiceSquad.voiceChannelId);
        if (currentVoiceSquad.airChannelId) sendPbIds.add(currentVoiceSquad.airChannelId);
      }
      const sendObservation = await observePingerSquads(guild, config);
      const sendEligibility = await loadPbPingEligibilitySnapshot(guild.id, [sendMember.id]);
      const sendUnfilled = sendObservation.active
        .map((squad) => ({
          ...squad,
          count: getSquadMemberCount(guild, squad.voiceChannelId, squad.airChannelId),
        }))
        .filter((squad) => squad.count < squad.size);
      if (
        state.requestedRevision !== observedRevision ||
        sendMember.voice.channelId !== observedVoiceChannelId ||
        sendUnfilled.length === 0
      ) {
        finalFenceAbort = true;
        return;
      }
      if (!isPbIndividualPingEligible(
        pbPingCandidateFromMember(sendMember),
        {
          pingRoleId: config.pingRoleId,
          playedTodayRoleId: config.playedTodayRoleId,
          pbChannelIds: sendPbIds,
        },
        sendEligibility,
      )) {
        finalFenceAbort = true;
        state.individualIndex = nextIndividualCandidateIndex(
          state.individualIndex,
          'authoritative-skip',
        );
        return;
      }
      const sendText = buildIndividualPingMessage(sendMember, sendUnfilled, locale);
      if (!sendText) {
        finalFenceAbort = true;
        return;
      }
      sendAttempted = true;
      const sendPromise = channel.send({
        content: sendText,
        allowedMentions: {
          parse: [], roles: [], users: [sendMember.id], repliedUser: false,
        },
      });
      const sent = await sendPromise;
      scheduleAutoDelete(sent);
      state.individualIndex = nextIndividualCandidateIndex(state.individualIndex, 'sent');
    } catch (error) {
      actionShouldRetain = true;
      // Discord send failures are ambiguous. Retain the confirmed per-user
      // claim and move on rather than risk a duplicate mention after a lost
      // REST response. Pre-send failures safely release that recipient.
      if (userClaim && sendAttempted) {
        state.individualIndex = nextIndividualCandidateIndex(state.individualIndex, 'sent');
      }
      throw error;
    } finally {
      if (userClaim) {
        if (sendAttempted) {
          await finalizePingerCooldown(redis, userClaim).catch(() => false);
        } else {
          await releasePingerCooldown(redis, userClaim).catch(() => false);
        }
      }

      let localOutcome: Parameters<typeof shouldAdvancePingerLocalCooldown>[0];
      if (sendAttempted) {
        localOutcome = 'sent-or-ambiguous';
        await finalizePingerCooldown(redis, actionClaim).catch(() => false);
      } else if (actionClaimOwnershipLost) {
        localOutcome = 'ownership-lost';
      } else if (finalFenceAbort || !actionShouldRetain) {
        try {
          const released = await releasePingerCooldown(redis, actionClaim);
          localOutcome = released ? 'released' : 'ownership-lost';
        } catch {
          localOutcome = 'retained-without-send';
        }
      } else {
        try {
          const finalized = await finalizePingerCooldown(redis, actionClaim);
          localOutcome = finalized ? 'retained-without-send' : 'ownership-lost';
        } catch {
          localOutcome = 'retained-without-send';
        }
      }
      if (shouldAdvancePingerLocalCooldown(localOutcome)) {
        state.lastIndividualPingAt = Date.now();
      }
    }
  } catch (err) {
    // Keep the same candidate on transient Discord/Redis/DB/send failures and
    // retry it after the normal individual-ping interval.
    state.individualIndex = nextIndividualCandidateIndex(state.individualIndex, 'retry');
    if (!cooldownManagedByClaim) state.lastIndividualPingAt = Date.now();
    log.error(`Ошибка именного пинга для ${userId}`, { error: String(err) });
  }
}

/**
 * Обновить очередь бойцов для именного пинга.
 * Берёт всех с pingRoleId, исключая уже находящихся в ПБ.
 */
async function refreshIndividualQueue(
  guild: Guild,
  config: any,
  state: GuildPingerState,
): Promise<IndividualQueueRefreshOutcome> {
  if (!config.pingRoleId) {
    state.individualQueue = [];
    state.individualIndex = 0;
    return 'empty';
  }

  let role;
  try {
    role = await guild.roles.fetch(config.pingRoleId, { force: true });
  } catch (error) {
    if (
      error &&
      typeof error === 'object' &&
      ((error as { code?: unknown }).code === 10011 ||
       (error as { code?: unknown }).code === '10011')
    ) {
      state.individualQueue = [];
      state.individualIndex = 0;
      return 'empty';
    }
    log.warn(`Пингер гильдии ${guild.id}: роль очереди будет перечитана`, {
      error: String(error),
    });
    return 'retry';
  }

  if (!role) {
    state.individualQueue = [];
    state.individualIndex = 0;
    return 'empty';
  }

  try {
    await getCompleteGuildMembers(guild);
    const pbChannelIds = new Set(await getAllPbChannelIds(guild.id));
    if (config.reserveChannelId) pbChannelIds.add(config.reserveChannelId);
    const eligibility = await loadPbPingEligibilitySnapshot(
      guild.id,
      [...role.members.keys()],
    );

    const available = role.members
      .filter((member) => isPbIndividualPingEligible(
        pbPingCandidateFromMember(member),
        {
          pingRoleId: config.pingRoleId,
          playedTodayRoleId: config.playedTodayRoleId,
          pbChannelIds,
        },
        eligibility,
      ))
      .map((m) => m.id);

    // Перемешать (чтобы не пинговать одних и тех же первыми)
    for (let i = available.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [available[i], available[j]] = [available[j], available[i]];
    }

    state.individualQueue = available;
    state.individualIndex = 0;
    return available.length > 0 ? 'ready' : 'empty';
  } catch (error) {
    log.warn(`Пингер гильдии ${guild.id}: очередь именных пингов будет перечитана`, {
      error: String(error),
    });
    return 'retry';
  }
}

// ═══════════════════════════════════════════════
//  Фаза: FULL — предложение запасных каждые 15 мин
// ═══════════════════════════════════════════════

async function handleFull(
  guild: Guild,
  config: any,
  state: GuildPingerState,
  now: number,
  observedRevision: number,
): Promise<void> {
  if (!config.reserveChannelId) return;
  if (!isPingerActionDue(now, state.lastFullSuggestAt, FULL_SUGGEST_INTERVAL_MS)) return;
  const redis = getRedis();
  const claim = await claimPingerCooldown(
    redis,
    pingerActionCooldownKey(guild.id, 'full'),
    FULL_SUGGEST_INTERVAL_MS,
  );
  if (!claim) return;
  let claimOwnershipLost = false;
  let sendAttempted = false;
  let retrySafeAbort = false;

  // A forced panel refresh belongs to the due FULL action; it must not run on
  // every 10-second pinger tick.
  try {
    // Share one complete population with the status panel and the role-mention
    // safety policy. This avoids duplicate Discord member requests.
    const memberSnapshot = await getCompleteGuildMemberSnapshot(guild);
    const members = memberSnapshot.members;
    await refreshStatusPanel(guild, pingerClient!, true, members);
    const locale = await getGuildLocale(guild.id);
    const channel = await guild.client.channels.fetch(config.announceChannelId) as TextChannel;
    if (!channel) return;

    const pingRoleId = typeof config.pingRoleId === 'string' ? config.pingRoleId : null;
    let mention: ReturnType<typeof buildPbMassRoleMentionPlan> = null;

    const preliminary = await observePingerSquads(guild, config);
    if (!canSendPingerFullSuggestion(
      observedRevision,
      state.requestedRevision,
      preliminary.active,
    )) {
      retrySafeAbort = true;
      return;
    }

    if (!(await confirmPingerCooldown(redis, claim))) {
      claimOwnershipLost = true;
      return;
    }

    const pingRole = pingRoleId
      ? await guild.roles.fetch(pingRoleId, { force: true })
      : null;
    const fresh = await observePingerSquads(guild, config);
    const eligibility = pingRoleId && pingRole
      ? await loadPbPingEligibilitySnapshot(guild.id)
      : null;

    // Eligibility is the final await. From this point through channel.send(),
    // keep the gateway generation, occupancy and role population fence fully
    // synchronous so a late change fails closed.
    assertCompleteGuildMemberSnapshotCurrent(guild, memberSnapshot.token);

    const finalOccupancy = fresh.active.map((squad) => ({
      ...squad,
      count: getSquadMemberCount(guild, squad.voiceChannelId, squad.airChannelId),
    }));
    if (!canSendPingerFullSuggestion(
      observedRevision,
      state.requestedRevision,
      finalOccupancy,
    )) {
      retrySafeAbort = true;
      return;
    }

    if (pingRoleId && pingRole && eligibility) {
      const pbChannelIds = new Set<string>();
      for (const squad of fresh.all) {
        pbChannelIds.add(squad.voiceChannelId);
        if (squad.airChannelId) pbChannelIds.add(squad.airChannelId);
      }
      pbChannelIds.add(config.reserveChannelId);
      const pingRoleMembers = pingRole.members.map(pbPingCandidateFromMember);
      const unavailablePingRoleState = new Map<string, boolean>();
      for (const userId of eligibility.excludedUserIds) {
        unavailablePingRoleState.set(
          userId,
          guild.members.cache.get(userId)?.roles.cache.has(pingRoleId) === true,
        );
      }
      mention = buildPbMassRoleMentionPlan(
        {
          pingRoleId,
          playedTodayRoleId: config.playedTodayRoleId ?? null,
          pbChannelIds,
        },
        eligibility,
        unavailablePingRoleState,
        pingRoleMembers,
        pingRole.mentionable || Boolean(
          guild.members.me &&
          channel.permissionsFor(guild.members.me)?.has(PermissionFlagsBits.MentionEveryone),
        ),
      );
    }

    sendAttempted = true;
    const sendPromise = channel.send(buildPbPingerMessage(
      buildFullSuggestEmbed(config.reserveChannelId, locale),
      mention,
    ));
    const sent = await sendPromise;

    scheduleAutoDelete(sent);

    if (!mention) {
      log.warn(
        `Pinger ${guild.id}: FULL reserve suggestion sent without unsafe/unavailable role mention`,
      );
    }
  } catch (err) {
    log.error('Ошибка предложения запасных', { error: String(err) });
  } finally {
    let localOutcome: Parameters<typeof shouldAdvancePingerLocalCooldown>[0];
    let settled = false;
    const settlement = selectPingerClaimSettlement(
      sendAttempted,
      claimOwnershipLost,
      retrySafeAbort,
    );
    if (settlement === 'finalize') {
      localOutcome = sendAttempted ? 'sent-or-ambiguous' : 'retained-without-send';
      settled = await finalizePingerCooldown(redis, claim).catch(() => false);
    } else if (settlement === 'ownership-lost') {
      localOutcome = 'ownership-lost';
      settled = true;
    } else {
      try {
        settled = await releasePingerCooldown(redis, claim);
        localOutcome = settled ? 'released' : 'ownership-lost';
      } catch {
        localOutcome = 'retained-without-send';
      }
    }
    if (shouldAdvancePingerLocalCooldown(localOutcome)) {
      state.lastFullSuggestAt = Date.now();
    }
    if (!settled && localOutcome !== 'ownership-lost') {
      log.warn(`Pinger ${guild.id}: FULL cooldown claim retained until its safety TTL`);
    }
  }
}

// (конец файла)
