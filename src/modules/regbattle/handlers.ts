// ═══════════════════════════════════════════════
//  RegBattle — Обработчики интеракций
//
//  Кнопки панели управления отрядом:
//  1. РАСПОРЯЖЕНИЯ — мьют на 30 сек
//  2. КИК — выбор + отключение из войса
//  3. МЬЮТ — toggle мьюта отдельного бойца
//  4. ПИНГ В ЛС — рассылка DM + отчёт
//  5. АВИАЦИЯ — создание авиа-канала
//  6. ПЕРЕДАТЬ ПРАВА — передача командования
//  7. ВЫГОВОР — дисциплинарная система (4 шага)
// ═══════════════════════════════════════════════

import {
  Interaction,
  ButtonInteraction,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuInteraction,
  UserSelectMenuInteraction,
  ModalSubmitInteraction,
  Guild,
  GuildMember,
  VoiceChannel,
  TextChannel,
  CategoryChannel,
  ChannelType,
  PermissionsBitField,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
} from 'discord.js';
import type { BublikClient } from '../../bot';
import { logger } from '../../core/Logger';
import { errorReporter } from '../../core/ErrorReporter';
import { BublikEmbed } from '../../core/EmbedBuilder';
import { getRedis } from '../../core/Redis';
import { i18n } from '../../core/I18n';
import { getGuildLocale } from '../../core/GuildConfig';
import { fetchSafeAutomaticRole, hasDangerousAssignablePermissions } from '../../core/RolePolicy';
import { getCompleteGuildMembers } from '../../core/GuildMemberSnapshot';

import {
  RB_PREFIX,
  RB_SEP,
  ORDERS_MUTE_DURATION_MS,
  DM_PING_COOLDOWN_MS,
  DM_SEND_DELAY_MS,
  APPEAL_COOLDOWN_MS,
} from './constants';

import {
  getSquad,
  updateSquad,
  getConfig,
  getAllPbChannelIds,
  getSquadByAnyVoice,
  createReprimand,
  getReprimand,
  updateReprimandStatusCas,
  deleteReprimandStatusCas,
  hasOtherLiveReprimand,
} from './database';

import {
  airName,
  getSquadMembers,
} from './utils';

import {
  buildKickSelect,
  buildTransferSelect,
  buildMuteToggleSelect,
  buildReprimandUserSelect,
  buildReprimandTypeSelect,
  buildOrdersActiveEmbed,
  buildDmPingEmbed,
  buildDmPingReport,
  buildDmPingPreview,
  buildDmPingProgress,
  buildControlPanelButtons,
  buildIgnoringDetailEmbed,
  buildPlayedDetailEmbed,
  buildOfflineDetailEmbed,
  rbSuccess,
  rbError,
  rbWarn,
} from './embeds';

import {
  updateControlPanel,
  toggleNotifications,
  refreshStatusPanel,
  getStatusPanelData,
  deleteTrackedChannel,
} from './lifecycle';
import {
  applyNotifyToggle,
  runForCurrentNotifyControlPanel,
  type CurrentNotifyControlPanelResult,
  type NotifyToggleOutcome,
  type NotifyToggleProjection,
} from './notifyToggle';
import { recalculatePinger } from './pinger';
import { fetchGuildMemberIfPresent, isTransientInteractionError } from '../../utils/helpers';
import { isUnknownChannelError, isUnknownMessageError } from './safety';
import {
  consumeDmPingPreviewAndClaim,
  createDmPingPreviewToken,
  dmPingCooldownSecondsLeft,
  finalizeDmPingCooldown,
  isDmPingPreviewToken,
  MAX_DM_PING_PREVIEW_TARGETS,
  serializeDmPingPreviewEnvelope,
} from './dmPingCooldown';
import {
  type OrdersMuteRecord,
  captureOrdersMuteRuntime,
  claimOrdersMute,
  scheduleOrdersMuteRecovery,
  selectOrdersMuteCandidateIds,
  trackOrdersMuteMutation,
  trackOrdersMuteHandler,
  updateOrdersMuteRecord,
} from './ordersMutes';
import {
  isPbIndividualPingEligible,
  loadPbPingEligibilitySnapshot,
  pbPingCandidateFromMember,
} from './pingEligibility';

const log = logger.child('RegBattle:Handlers');

// ═══════════════════════════════════════════════
//  Роутер интеракций
// ═══════════════════════════════════════════════

export async function handleRegBattleInteraction(
  interaction: Interaction,
  client: BublikClient,
): Promise<void> {
  try {
    // ── Кнопки ──────────────────────
    if (interaction.isButton()) {
      const parts = interaction.customId.split(RB_SEP);
      if (parts[0] !== RB_PREFIX) return;

      const action = parts[1];
      const squadId = parts[2];

      switch (action) {
        case 'orders':
          {
            const isRuntimeCurrent = captureOrdersMuteRuntime();
            await trackOrdersMuteHandler(() =>
              handleOrders(interaction, squadId, client, isRuntimeCurrent));
          }
          break;
        case 'kick':
          await handleKick(interaction, squadId, client);
          break;
        case 'mutetoggle':
          await handleMuteToggle(interaction, squadId, client);
          break;
        case 'dmping':
          await handleDmPing(interaction, squadId, client);
          break;
        case 'dmping_confirm':
          await handleDmPingConfirm(interaction, squadId, parts[3], client);
          break;
        case 'dmping_cancel':
          await handleDmPingCancel(interaction, squadId, parts[3]);
          break;
        case 'aviation':
          await handleAviation(interaction, squadId, client);
          break;
        case 'transfer':
          await handleTransfer(interaction, squadId, client);
          break;
        case 'reprimand':
          await handleReprimand(interaction, squadId, client);
          break;
        case 'rep_appeal':
          await handleReprimandAppeal(interaction, squadId, client);
          break;
        case 'rep_annul':
          await handleReprimandAnnul(interaction, squadId, client);
          break;
        case 'rep_appeal_accept':
          await handleReprimandAppealDecisionButton(interaction, squadId, 'accept', client);
          break;
        case 'rep_appeal_reject':
          await handleReprimandAppealDecisionButton(interaction, squadId, 'reject', client);
          break;
        case 'notifytoggle':
          await handleNotifyToggle(interaction, squadId, client);
          break;
        case 'sp_ignoring':
          await handleStatusPanelButton(interaction, 'ignoring', client);
          break;
        case 'sp_played':
          await handleStatusPanelButton(interaction, 'played', client);
          break;
        case 'sp_offline':
          await handleStatusPanelButton(interaction, 'offline', client);
          break;
      }
      return;
    }

    // ── StringSelectMenu ────────────
    if (interaction.isStringSelectMenu()) {
      const parts = interaction.customId.split(RB_SEP);
      if (parts[0] !== RB_PREFIX || parts[1] !== 'sel') return;

      const selType = parts[2];
      const squadId = parts[3];

      switch (selType) {
        case 'kick':
          await handleKickSelect(interaction as StringSelectMenuInteraction, squadId, client);
          break;
        case 'transfer':
          await handleTransferSelect(interaction as StringSelectMenuInteraction, squadId, client);
          break;
        case 'mutetoggle':
          await handleMuteToggleSelect(interaction as StringSelectMenuInteraction, squadId, client);
          break;
        case 'rep_type': {
          // customId: rb:sel:rep_type:squadId:offenderId
          const offenderId = parts[4];
          await handleReprimandTypeSelect(interaction as StringSelectMenuInteraction, squadId, offenderId, client);
          break;
        }
      }
      return;
    }

    // ── UserSelectMenu ──────────────
    if (interaction.isUserSelectMenu()) {
      const parts = interaction.customId.split(RB_SEP);
      if (parts[0] !== RB_PREFIX || parts[1] !== 'sel') return;

      const selType = parts[2];
      const squadId = parts[3];

      if (selType === 'rep_user') {
        await handleReprimandUserSelect(interaction as UserSelectMenuInteraction, squadId, client);
      }
      return;
    }

    // ── ModalSubmit ─────────────────
    if (interaction.isModalSubmit()) {
      const parts = interaction.customId.split(RB_SEP);
      if (parts[0] !== RB_PREFIX) return;

      if (parts[1] === 'rep_modal') {
        // customId: rb:rep_modal:squadId:offenderId:typeRoleId
        const squadId = parts[2];
        const offenderId = parts[3];
        const typeRoleId = parts[4];
        await handleReprimandModal(interaction as ModalSubmitInteraction, squadId, offenderId, typeRoleId, client);
      } else if (parts[1] === 'rep_appeal_decision_modal') {
        // customId: rb:rep_appeal_decision_modal:reprimandId:accept|reject
        const reprimandId = parts[2];
        const decision = parts[3] as 'accept' | 'reject';
        await handleReprimandAppealDecisionModal(interaction as ModalSubmitInteraction, reprimandId, decision, client);
      } else if (parts[1] === 'dmping_modal') {
        // customId: rb:dmping_modal:squadId
        const squadId = parts[2];
        await handleDmPingModal(interaction as ModalSubmitInteraction, squadId, client);
      }
      return;
    }
  } catch (err) {
    if (isTransientInteractionError(err)) {
      log.warn('Транзиентная ошибка в regbattle interaction (пропускаем репорт)', { error: String(err) });
      return;
    }

    log.error('Ошибка в обработчике regbattle', { error: String(err) });
    errorReporter.eventError(err, 'interactionCreate', 'regbattle');

    const errLocale = await getGuildLocale(interaction.guildId).catch(() => 'ru');
    const errEmbed = rbError(i18n.t('regbattle.error_internal', errLocale), errLocale);
    try {
      if (interaction.isRepliable()) {
        if (interaction.deferred || interaction.replied) {
          await interaction.editReply({ embeds: [errEmbed], components: [] });
        } else {
          await interaction.reply({ embeds: [errEmbed], ephemeral: true });
        }
      }
    } catch { /* interaction expired */ }
  }
}

// ═══════════════════════════════════════════════
//  Проверка владельца
// ═══════════════════════════════════════════════

async function checkOwner(interaction: ButtonInteraction | StringSelectMenuInteraction | ModalSubmitInteraction, squadId: string, locale: string): Promise<any | null> {
  const squad = await getSquad(squadId);
  if (!squad) {
    await interaction.reply({ embeds: [rbError(i18n.t('regbattle.error_squad_not_found', locale), locale)], ephemeral: true });
    return null;
  }

  if (squad.ownerId !== interaction.user.id) {
    await interaction.reply({ embeds: [rbError(i18n.t('regbattle.error_owner_only', locale), locale)], ephemeral: true });
    return null;
  }

  return squad;
}

// ═══════════════════════════════════════════════
//  📢 РАСПОРЯЖЕНИЯ — мьют на 30 сек
// ═══════════════════════════════════════════════

async function handleOrders(
  interaction: ButtonInteraction,
  squadId: string,
  client: BublikClient,
  isRuntimeCurrent: () => boolean,
): Promise<void> {
  const locale = await getGuildLocale(interaction.guildId);
  const squad = await checkOwner(interaction, squadId, locale);
  if (!squad) return;

  await interaction.deferReply({ ephemeral: true });

  const guild = interaction.guild!;
  const config = squad.config;

  // Собрать участников из основного + авиа канала
  const members = getSquadMembers(guild, squad.voiceChannelId, squad.airChannelId);
  const toMute: GuildMember[] = [];

  for (const member of members) {
    if (member.id === squad.ownerId) continue; // Командир не мьютится

    // muteRoleIds — список ролей-исключений (например офицеры, которые НЕ мьютятся)
    // Если muteRoleIds пуст — мьютятся все кроме командира
    // Если muteRoleIds задан — НЕ мьютятся те, у кого есть одна из этих ролей
    if (config.muteRoleIds.length > 0) {
      const isExempt = config.muteRoleIds.some((id: string) => member.roles.cache.has(id));
      if (isExempt) continue;
    }

    toMute.push(member);
  }

  const now = Date.now();
  let muteRecord: OrdersMuteRecord = {
    version: 1,
    status: 'muting',
    guildId: guild.id,
    squadId,
    ownerId: squad.ownerId,
    // Persist intent before Discord mutations. This closes the crash window
    // that previously left members server-muted forever.
    userIds: selectOrdersMuteCandidateIds(toMute.map((member) => ({
      id: member.id,
      serverMute: member.voice.serverMute,
    }))),
    createdAt: now,
    // A crash while Discord requests are in flight is recovered after this
    // bounded lease. A completed batch replaces it with the exact 30s TTL.
    expiresAt: now + Math.max(90_000, ORDERS_MUTE_DURATION_MS * 3),
    notificationChannelId: null,
    notificationMessageId: null,
    cleanupToken: null,
  };

  if (muteRecord.userIds.length === 0) {
    await interaction.editReply({
      embeds: [rbSuccess(i18n.t('regbattle.orders_success', locale, { count: 0 }), locale)],
    });
    return;
  }

  if (!(await claimOrdersMute(muteRecord))) {
    await interaction.editReply({ embeds: [rbWarn(i18n.t('regbattle.orders_already_active', locale), locale)] });
    return;
  }

  // Замьютить
  const muted: GuildMember[] = [];
  muteRecord = await trackOrdersMuteMutation(async () => {
    let current = muteRecord;
    let processedMuteRequests = 0;
    const claimedUserIds = new Set(muteRecord.userIds);
    for (const member of toMute) {
      if (!isRuntimeCurrent()) break;
      // Only members explicitly observed unmuted before the durable claim are
      // ours to mutate and later unmute. `null` is an unknown voice state.
      if (!claimedUserIds.has(member.id)) continue;
      try {
        if (member.voice.serverMute === false) {
          await member.voice.setMute(true, 'ПБ: Распоряжения командира');
          muted.push(member);
        }
      } catch {
        // A REST response can be lost after Discord applied the mute. Keep every
        // pre-authorised candidate in the durable record so recovery is safe.
        if (member.voice.serverMute) muted.push(member);
      }
      processedMuteRequests++;
      if (processedMuteRequests % 5 === 0) {
        current = await updateOrdersMuteRecord(current, {
          expiresAt: Date.now() + Math.max(90_000, ORDERS_MUTE_DURATION_MS * 3),
        });
      }
    }
    return updateOrdersMuteRecord(current, {
      status: 'active',
      expiresAt: Date.now() + ORDERS_MUTE_DURATION_MS,
    });
  });

  // Unload invalidates the handler generation before waiting for in-flight
  // work. Leave the exact durable row for bounded shutdown recovery instead of
  // publishing notifications or a timer owned by an obsolete module instance.
  if (!isRuntimeCurrent()) return;

  // Уведомить в канале
  const vc = guild.channels.cache.get(squad.voiceChannelId) as VoiceChannel | undefined;
  let notifMsg: any = null;
  if (vc && muted.length > 0) {
    notifMsg = await vc.send({ embeds: [buildOrdersActiveEmbed(30, locale)] }).catch(() => null);
  }

  if (notifMsg) {
    muteRecord = await updateOrdersMuteRecord(muteRecord, {
      notificationChannelId: vc?.id ?? null,
      notificationMessageId: notifMsg.id,
    });
  }

  scheduleOrdersMuteRecovery(muteRecord, client, isRuntimeCurrent);

  await interaction.editReply({
    embeds: [rbSuccess(i18n.t('regbattle.orders_success', locale, { count: muted.length }), locale)],
  });

}

// ═══════════════════════════════════════════════
//  👢 КИК — выбор участника
// ═══════════════════════════════════════════════

async function handleKick(
  interaction: ButtonInteraction,
  squadId: string,
  _client: BublikClient,
): Promise<void> {
  const locale = await getGuildLocale(interaction.guildId);
  const squad = await checkOwner(interaction, squadId, locale);
  if (!squad) return;

  const guild = interaction.guild!;
  const members = getSquadMembers(guild, squad.voiceChannelId, squad.airChannelId);

  // Исключить владельца из списка
  const kickable = members
    .filter((m) => m.id !== squad.ownerId)
    .map((m) => ({ id: m.id, displayName: m.displayName }));

  if (kickable.length === 0) {
    await interaction.reply({ embeds: [rbWarn(i18n.t('regbattle.kick_no_members', locale), locale)], ephemeral: true });
    return;
  }

  // Ограничить до 25 (лимит SelectMenu)
  const limited = kickable.slice(0, 25);

  await interaction.reply({
    embeds: [rbWarn(i18n.t('regbattle.kick_prompt', locale), locale)],
    components: [buildKickSelect(squadId, limited, locale)],
    ephemeral: true,
  });
}

async function handleKickSelect(
  interaction: StringSelectMenuInteraction,
  squadId: string,
  _client: BublikClient,
): Promise<void> {
  const locale = await getGuildLocale(interaction.guildId);
  const squad = await getSquad(squadId);
  if (!squad) {
    await interaction.reply({ embeds: [rbError(i18n.t('regbattle.error_squad_not_found', locale), locale)], ephemeral: true });
    return;
  }
  if (squad.ownerId !== interaction.user.id) {
    await interaction.reply({ embeds: [rbError(i18n.t('regbattle.kick_owner_only', locale), locale)], ephemeral: true });
    return;
  }

  const targetId = interaction.values[0];
  const guild = interaction.guild!;
  const member = await guild.members.fetch(targetId).catch(() => null);

  if (!member || !member.voice.channelId) {
    await interaction.update({ embeds: [rbWarn(i18n.t('regbattle.kick_already_left', locale), locale)], components: [] });
    return;
  }

  await member.voice.disconnect('ПБ: кик командиром').catch(() => null);

  await interaction.update({
    embeds: [rbSuccess(i18n.t('regbattle.kick_success', locale, { name: member.displayName }), locale)],
    components: [],
  });

  log.info(`Кик из ПБ: ${member.user.tag} командиром ${interaction.user.tag}`);
}

// ═══════════════════════════════════════════════
//  🔇 МЬЮТ — toggle мьюта отдельного бойца
// ═══════════════════════════════════════════════

async function handleMuteToggle(
  interaction: ButtonInteraction,
  squadId: string,
  _client: BublikClient,
): Promise<void> {
  const locale = await getGuildLocale(interaction.guildId);
  const squad = await checkOwner(interaction, squadId, locale);
  if (!squad) return;

  const guild = interaction.guild!;
  const members = getSquadMembers(guild, squad.voiceChannelId, squad.airChannelId);

  // Исключить командира
  const muteable = members
    .filter((m) => m.id !== squad.ownerId)
    .map((m) => ({
      id: m.id,
      displayName: m.displayName,
      muted: !!m.voice.serverMute,
    }));

  if (muteable.length === 0) {
    await interaction.reply({ embeds: [rbWarn(i18n.t('regbattle.mute_no_members', locale), locale)], ephemeral: true });
    return;
  }

  const limited = muteable.slice(0, 25);

  await interaction.reply({
    embeds: [rbWarn(i18n.t('regbattle.mute_prompt', locale), locale)],
    components: [buildMuteToggleSelect(squadId, limited, locale)],
    ephemeral: true,
  });
}

async function handleMuteToggleSelect(
  interaction: StringSelectMenuInteraction,
  squadId: string,
  _client: BublikClient,
): Promise<void> {
  const locale = await getGuildLocale(interaction.guildId);
  const squad = await getSquad(squadId);
  if (!squad) {
    await interaction.reply({ embeds: [rbError(i18n.t('regbattle.error_squad_not_found', locale), locale)], ephemeral: true });
    return;
  }
  if (squad.ownerId !== interaction.user.id) {
    await interaction.reply({ embeds: [rbError(i18n.t('regbattle.mute_owner_only', locale), locale)], ephemeral: true });
    return;
  }

  const targetId = interaction.values[0];
  const guild = interaction.guild!;
  const member = await guild.members.fetch(targetId).catch(() => null);

  if (!member || !member.voice.channelId) {
    await interaction.update({ embeds: [rbWarn(i18n.t('regbattle.kick_already_left', locale), locale)], components: [] });
    return;
  }

  const wasMuted = member.voice.serverMute;

  try {
    await member.voice.setMute(!wasMuted, `ПБ: ${wasMuted ? 'размьют' : 'мьют'} командиром`);

    await interaction.update({
      embeds: [rbSuccess(
        wasMuted
          ? i18n.t('regbattle.mute_unmuted', locale, { name: member.displayName })
          : i18n.t('regbattle.mute_muted', locale, { name: member.displayName }),
        locale,
      )],
      components: [],
    });

    log.info(`Мьют-toggle ПБ: ${member.user.tag} → ${wasMuted ? 'unmuted' : 'muted'} (командир ${interaction.user.tag})`);
  } catch {
    await interaction.update({
      embeds: [rbError(i18n.t('regbattle.mute_error', locale), locale)],
      components: [],
    });
  }
}

// ═══════════════════════════════════════════════
//  📩 ПИНГ В ЛС — модалка → превью → рассылка DM
// ═══════════════════════════════════════════════

export type DmPingSquadSnapshot = NonNullable<Awaited<ReturnType<typeof getSquad>>>;

export interface DmPingDispatchFenceDependencies {
  getSquadById(squadId: string): ReturnType<typeof getSquad>;
  getPbChannelIds(guildId: string): ReturnType<typeof getAllPbChannelIds>;
  getSquadByVoice(channelId: string): ReturnType<typeof getSquadByAnyVoice>;
  fetchMember(guild: Guild, memberId: string): Promise<GuildMember | null>;
  loadEligibility(
    guildId: string,
    memberIds: readonly string[],
  ): ReturnType<typeof loadPbPingEligibilitySnapshot>;
  fetchVoiceChannel(guild: Guild, channelId: string): Promise<VoiceChannel | null>;
}

export type DmPingDispatchFenceResult =
  | { status: 'send'; member: GuildMember; squad: DmPingSquadSnapshot }
  | { status: 'skip-recipient'; reason: 'missing' | 'ineligible' }
  | {
      status: 'stop-batch';
      reason: 'target-missing' | 'target-changed' | 'target-channel-missing' |
        'target-topology-mismatch' | 'target-full' | 'target-config-invalid';
    };

const defaultDmPingDispatchFenceDependencies: DmPingDispatchFenceDependencies = {
  getSquadById: getSquad,
  getPbChannelIds: getAllPbChannelIds,
  getSquadByVoice: getSquadByAnyVoice,
  fetchMember: fetchGuildMemberIfPresent,
  loadEligibility: loadPbPingEligibilitySnapshot,
  fetchVoiceChannel: async (guild, channelId) => {
    try {
      const channel = await guild.channels.fetch(channelId, { force: true });
      return channel?.type === ChannelType.GuildVoice ? channel as VoiceChannel : null;
    } catch (error) {
      if (isUnknownChannelError(error)) return null;
      throw error;
    }
  },
};

function isOwnedDmPingTarget(
  squad: DmPingSquadSnapshot | null,
  guildId: string,
  commanderId: string,
): squad is DmPingSquadSnapshot {
  return Boolean(
    squad && squad.guildId === guildId && squad.ownerId === commanderId,
  );
}

function isSameDmPingTarget(
  initial: DmPingSquadSnapshot,
  current: DmPingSquadSnapshot,
): boolean {
  return initial.id === current.id &&
    initial.guildId === current.guildId &&
    initial.voiceChannelId === current.voiceChannelId &&
    initial.airChannelId === current.airChannelId;
}

function countDmPingTargetMembers(
  mainChannel: VoiceChannel,
  airChannel: VoiceChannel | null,
): number {
  const memberIds = new Set<string>();
  for (const channel of airChannel ? [mainChannel, airChannel] : [mainChannel]) {
    for (const member of channel.members.values()) {
      if (!member.user.bot) memberIds.add(member.id);
    }
  }
  return memberIds.size;
}

/**
 * Rebuild every mutable dispatch input for one recipient. Member voice is
 * double-read around sequential topology/exact-voice/vacation reads; after
 * they settle, the decision is synchronous and `member.send` has no async gap.
 */
export async function resolveDmPingDispatchFence(
  guild: Guild,
  squadId: string,
  commanderId: string,
  memberId: string,
  dependencies: DmPingDispatchFenceDependencies = defaultDmPingDispatchFenceDependencies,
): Promise<DmPingDispatchFenceResult> {
  const initialSquad = await dependencies.getSquadById(squadId);
  if (!isOwnedDmPingTarget(initialSquad, guild.id, commanderId)) {
    return { status: 'stop-batch', reason: 'target-missing' };
  }

  // Read the member before topology. If the member moves while the later DB/
  // Discord reads run, the synchronous double-read below rejects the snapshot.
  // This prevents an old topology result from authorising a newly joined PB.
  const member = await dependencies.fetchMember(guild, memberId);
  if (!member || member.id !== memberId || member.guild.id !== guild.id) {
    return { status: 'skip-recipient', reason: 'missing' };
  }
  const observedVoiceChannelId = member.voice.channelId;

  const [mainChannel, airChannel] = await Promise.all([
    dependencies.fetchVoiceChannel(guild, initialSquad.voiceChannelId),
    initialSquad.airChannelId
      ? dependencies.fetchVoiceChannel(guild, initialSquad.airChannelId)
      : Promise.resolve(null),
  ]);
  const currentSquad = await dependencies.getSquadById(squadId);
  if (!isOwnedDmPingTarget(currentSquad, guild.id, commanderId)) {
    return { status: 'stop-batch', reason: 'target-missing' };
  }
  if (!isSameDmPingTarget(initialSquad, currentSquad)) {
    return { status: 'stop-batch', reason: 'target-changed' };
  }
  if (!mainChannel || mainChannel.id !== currentSquad.voiceChannelId ||
      mainChannel.guildId !== guild.id ||
      (currentSquad.airChannelId &&
        (!airChannel || airChannel.id !== currentSquad.airChannelId ||
          airChannel.guildId !== guild.id))) {
    return { status: 'stop-batch', reason: 'target-channel-missing' };
  }

  // Sequential final classification: the broad topology is followed by an
  // exact lookup of the voice observed above. A newly-created PB is therefore
  // detected even if it was absent from the broad list. Vacation is read last.
  const currentPbChannelIds = await dependencies.getPbChannelIds(guild.id);
  const currentVoiceSquad = observedVoiceChannelId
    ? await dependencies.getSquadByVoice(observedVoiceChannelId)
    : null;
  const eligibility = await dependencies.loadEligibility(guild.id, [memberId]);

  // No await below this point. In particular, this catches a recipient who
  // joined a PB channel created while a long DM batch was in progress.
  if (member.voice.channelId !== observedVoiceChannelId) {
    return { status: 'skip-recipient', reason: 'ineligible' };
  }
  const pbChannelIds = new Set(currentPbChannelIds);
  if (!pbChannelIds.has(currentSquad.voiceChannelId) ||
      (currentSquad.airChannelId && !pbChannelIds.has(currentSquad.airChannelId))) {
    return { status: 'stop-batch', reason: 'target-topology-mismatch' };
  }
  if (currentSquad.config.reserveChannelId) {
    pbChannelIds.add(currentSquad.config.reserveChannelId);
  }
  if (currentVoiceSquad) {
    const exactVoiceMatches = currentVoiceSquad.guildId === guild.id &&
      (currentVoiceSquad.voiceChannelId === observedVoiceChannelId ||
        currentVoiceSquad.airChannelId === observedVoiceChannelId);
    if (!exactVoiceMatches) {
      return { status: 'skip-recipient', reason: 'ineligible' };
    }
    pbChannelIds.add(currentVoiceSquad.voiceChannelId);
    if (currentVoiceSquad.airChannelId) pbChannelIds.add(currentVoiceSquad.airChannelId);
  }

  const squadSize = currentSquad.config.squadSize;
  if (!currentSquad.config.pingRoleId || !Number.isSafeInteger(squadSize) || squadSize <= 0) {
    return { status: 'stop-batch', reason: 'target-config-invalid' };
  }
  if (countDmPingTargetMembers(mainChannel, airChannel) >= squadSize) {
    return { status: 'stop-batch', reason: 'target-full' };
  }
  if (!isPbIndividualPingEligible(
    pbPingCandidateFromMember(member),
    {
      pingRoleId: currentSquad.config.pingRoleId,
      playedTodayRoleId: currentSquad.config.playedTodayRoleId,
      pbChannelIds,
    },
    eligibility,
  )) {
    return { status: 'skip-recipient', reason: 'ineligible' };
  }

  return { status: 'send', member, squad: currentSquad };
}

/** An outcome-ambiguous Discord send keeps the conservative batch claim. */
export function shouldFinalizeDmPingCooldown(hadAmbiguousSend: boolean): boolean {
  return !hadAmbiguousSend;
}

/** A concrete Discord 4xx/API rejection proves that no DM was accepted. */
export function isDmPingSendOutcomeAmbiguous(error: unknown): boolean {
  if (!error || typeof error !== 'object') return true;
  const candidate = error as { status?: unknown; code?: unknown };
  const status = Number(candidate.status);
  if (Number.isSafeInteger(status) && status >= 400 && status < 500) return false;

  const code = Number(candidate.code);
  // Discord JSON error codes are four or more digits. Node transport codes
  // are strings such as ECONNRESET and HTTP 5xx must remain ambiguous.
  if (Number.isSafeInteger(code) && code >= 1_000) return false;
  return true;
}

async function handleDmPing(
  interaction: ButtonInteraction,
  squadId: string,
  _client: BublikClient,
): Promise<void> {
  const locale = await getGuildLocale(interaction.guildId);
  const squad = await checkOwner(interaction, squadId, locale);
  if (!squad) return;

  // Кулдаун (Redis)
  const r = getRedis();
  const cooldownKey = `rb:dmcd:${squadId}`;
  const cooldown = await r.get(cooldownKey);
  if (cooldown) {
    const leftSec = dmPingCooldownSecondsLeft(cooldown) ?? 1;
    await interaction.reply({
      embeds: [rbWarn(i18n.t('regbattle.dmping_cooldown', locale, { seconds: Math.max(leftSec, 1) }), locale)],
      ephemeral: true,
    });
    return;
  }

  // Стандартный текст для предзаполнения модалки
  const defaultText = i18n.t('regbattle.dmping_embed_desc', locale, {
    guild: interaction.guild!.name,
    n: squad.number,
    commander: interaction.user.tag,
    channel: `<#${squad.voiceChannelId}>`,
  });

  const modal = new ModalBuilder()
    .setCustomId(`${RB_PREFIX}${RB_SEP}dmping_modal${RB_SEP}${squadId}`)
    .setTitle(i18n.t('regbattle.dmping_modal_title', locale));

  const msgInput = new TextInputBuilder()
    .setCustomId('dmping_message')
    .setLabel(i18n.t('regbattle.dmping_modal_label', locale))
    .setPlaceholder(i18n.t('regbattle.dmping_modal_placeholder', locale))
    .setValue(defaultText)
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(true)
    .setMaxLength(1500);

  modal.addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(msgInput),
  );

  await interaction.showModal(modal);
}

/** Обработка модалки DM-пинга → превью с кнопкой подтверждения */
async function handleDmPingModal(
  interaction: ModalSubmitInteraction,
  squadId: string,
  _client: BublikClient,
): Promise<void> {
  const locale = await getGuildLocale(interaction.guildId);
  const squad = await checkOwner(interaction, squadId, locale);
  if (!squad) return;

  await interaction.deferReply({ ephemeral: true });

  const guild = interaction.guild!;
  const config = squad.config;
  const customMessage = interaction.fields.getTextInputValue('dmping_message');

  if (!config.pingRoleId) {
    await interaction.editReply({ embeds: [rbError(i18n.t('regbattle.dmping_no_role_set', locale), locale)] });
    return;
  }

  const role = await guild.roles.fetch(config.pingRoleId, { force: true });
  if (!role) {
    await interaction.editReply({ embeds: [rbError(i18n.t('regbattle.dmping_role_not_found', locale), locale)] });
    return;
  }

  const members = await getCompleteGuildMembers(guild);
  const roleMembers = members.filter((member) => member.roles.cache.has(config.pingRoleId));
  const pbChannelIds = new Set(await getAllPbChannelIds(guild.id));
  if (config.reserveChannelId) pbChannelIds.add(config.reserveChannelId);
  const eligibility = await loadPbPingEligibilitySnapshot(
    guild.id,
    [...roleMembers.keys()],
  );
  const targets = roleMembers.filter((member) => isPbIndividualPingEligible(
    pbPingCandidateFromMember(member),
    {
      pingRoleId: config.pingRoleId,
      playedTodayRoleId: config.playedTodayRoleId,
      pbChannelIds,
    },
    eligibility,
  ));

  if (targets.size === 0) {
    await interaction.editReply({ embeds: [rbWarn(i18n.t('regbattle.dmping_no_targets', locale), locale)] });
    return;
  }
  if (targets.size > MAX_DM_PING_PREVIEW_TARGETS) {
    await interaction.editReply({
      embeds: [rbError(i18n.t('regbattle.dmping_too_many_targets', locale, {
        count: targets.size,
        max: MAX_DM_PING_PREVIEW_TARGETS,
      }), locale)],
    });
    return;
  }

  // Сохраняем nonce-bound preview с точным списком адресатов (TTL 5 мин)
  const r = getRedis();
  const previewToken = createDmPingPreviewToken();
  const msgKey = `rb:dmmsg:${squadId}:${interaction.user.id}:${previewToken}`;
  const previewEnvelope = serializeDmPingPreviewEnvelope(
    previewToken,
    customMessage,
    [...targets.keys()],
  );
  await r.setex(msgKey, 300, previewEnvelope);

  // Стандартный ли текст?
  const defaultText = i18n.t('regbattle.dmping_embed_desc', locale, {
    guild: guild.name,
    n: squad.number,
    commander: interaction.user.tag,
    channel: `<#${squad.voiceChannelId}>`,
  });
  const isCustom = customMessage !== defaultText;

  // Превью
  const previewEmbed = buildDmPingPreview(
    targets.size,
    isCustom,
    customMessage,
    locale,
  );

  const confirmRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`${RB_PREFIX}${RB_SEP}dmping_confirm${RB_SEP}${squadId}${RB_SEP}${previewToken}`)
      .setLabel(i18n.t('regbattle.dmping_confirm_btn', locale))
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`${RB_PREFIX}${RB_SEP}dmping_cancel${RB_SEP}${squadId}${RB_SEP}${previewToken}`)
      .setLabel(i18n.t('regbattle.dmping_cancel_btn', locale))
      .setStyle(ButtonStyle.Secondary),
  );

  await interaction.editReply({
    embeds: [previewEmbed],
    components: [confirmRow],
  });
}

/** Подтверждение рассылки DM-пинга */
async function handleDmPingConfirm(
  interaction: ButtonInteraction,
  squadId: string,
  previewToken: string | undefined,
  _client: BublikClient,
): Promise<void> {
  const locale = await getGuildLocale(interaction.guildId);
  const squad = await checkOwner(interaction, squadId, locale);
  if (!squad) return;

  if (!isDmPingPreviewToken(previewToken)) {
    await interaction.update({
      embeds: [rbError(i18n.t('regbattle.dmping_expired', locale), locale)],
      components: [],
    });
    return;
  }

  // Кулдаун (может уже нажали)
  const r = getRedis();
  const cooldownKey = `rb:dmcd:${squadId}`;
  const cooldown = await r.get(cooldownKey);
  if (cooldown) {
    const leftSec = dmPingCooldownSecondsLeft(cooldown) ?? 1;
    await interaction.update({
      embeds: [rbWarn(i18n.t('regbattle.dmping_cooldown', locale, { seconds: Math.max(leftSec, 1) }), locale)],
      components: [],
    });
    return;
  }

  // The nonce-bound envelope is consumed atomically below. A legacy preview
  // containing only message text deliberately expires without sending.
  const msgKey = `rb:dmmsg:${squadId}:${interaction.user.id}:${previewToken}`;

  // deferUpdate — чтобы editReply работал для прогресса
  await interaction.deferUpdate();

  const guild = interaction.guild!;
  const config = squad.config;

  const role = config.pingRoleId
    ? await guild.roles.fetch(config.pingRoleId, { force: true })
    : null;
  if (!role) {
    await interaction.editReply({
      embeds: [rbError(i18n.t('regbattle.dmping_role_not_found', locale), locale)],
      components: [],
    });
    return;
  }

  // The NX claim is the authoritative cooldown gate. The earlier GET is only
  // a fast user-facing check and cannot serialize two concurrent confirms.
  const previewClaim = await consumeDmPingPreviewAndClaim(
    r,
    cooldownKey,
    msgKey,
    previewToken,
  );
  if (previewClaim.status === 'cooldown') {
    const activeCooldown = await r.get(cooldownKey);
    const leftSec = dmPingCooldownSecondsLeft(activeCooldown) ??
      Math.ceil(DM_PING_COOLDOWN_MS / 1000);
    await interaction.editReply({
      embeds: [rbWarn(i18n.t('regbattle.dmping_cooldown', locale, { seconds: leftSec }), locale)],
      components: [],
    });
    return;
  }
  if (previewClaim.status === 'expired') {
    await interaction.editReply({
      embeds: [rbError(i18n.t('regbattle.dmping_expired', locale), locale)],
      components: [],
    });
    return;
  }
  const { claim: cooldownClaim, preview } = previewClaim;
  const { message: customMessage, targetIds } = preview;

  // Показать начало рассылки
  await interaction.editReply({
    embeds: [buildDmPingProgress(0, targetIds.length, locale)],
    components: [],
  });

  // Рассылка с прогрессом
  const delivered: string[] = [];
  const failed: string[] = [];
  let skipped = 0;
  let hadAmbiguousSend = false;
  const PROGRESS_UPDATE_EVERY = 5;

  for (let targetIndex = 0; targetIndex < targetIds.length; targetIndex++) {
    const memberId = targetIds[targetIndex];
    let dispatch: DmPingDispatchFenceResult;
    try {
      dispatch = await resolveDmPingDispatchFence(
        guild,
        squadId,
        interaction.user.id,
        memberId,
      );
    } catch (error) {
      skipped++;
      log.warn(`DM-пинг ПБ пропущен для ${memberId}: eligibility snapshot недоступен`, {
        error: String(error),
      });
      continue;
    }

    if (dispatch.status === 'stop-batch') {
      skipped += targetIds.length - targetIndex;
      log.warn(`DM-ping PB batch ${squadId} stopped by ${dispatch.reason} fence`);
      break;
    }
    if (dispatch.status === 'skip-recipient') {
      skipped++;
      continue;
    }

    const { member, squad: sendSquad } = dispatch;
    const payload = {
      embeds: [buildDmPingEmbed(
        sendSquad.number,
        interaction.user.tag,
        sendSquad.voiceChannelId,
        guild.name,
        customMessage,
        locale,
      )],
    };
    let sendAttempted = false;
    try {
      // No await is allowed between the final fresh fence above and this call.
      sendAttempted = true;
      await member.send(payload);
      delivered.push(member.user.tag);
    } catch (error) {
      // A rejected REST call can still mean that Discord accepted the DM and
      // the response was lost. Keep the long batch claim in that case.
      if (sendAttempted && isDmPingSendOutcomeAmbiguous(error)) {
        hadAmbiguousSend = true;
      }
      failed.push(member.user.tag);
    }

    // Обновление прогресса каждые N отправок
    const total = delivered.length + failed.length + skipped;
    if (total % PROGRESS_UPDATE_EVERY === 0 && total < targetIds.length) {
      try {
        await interaction.editReply({
          embeds: [buildDmPingProgress(total, targetIds.length, locale)],
        });
      } catch { /* прогресс не критичен */ }
    }

    // Задержка между DM (антиспам)
    await new Promise((resolve) => setTimeout(resolve, DM_SEND_DELAY_MS));
  }

  const cooldownFinalized = shouldFinalizeDmPingCooldown(hadAmbiguousSend) &&
    await finalizeDmPingCooldown(r, cooldownKey, cooldownClaim).catch(() => false);
  if (!cooldownFinalized) {
    // Keeping the conservative batch claim is safer than allowing a duplicate
    // delivery after an ambiguous send or when finalization was unavailable.
    log.warn(`DM-ping PB cooldown claim ${squadId} retained with conservative TTL`);
  }

  await interaction.editReply({
    embeds: [buildDmPingReport(delivered, failed, locale)],
  });

  log.info(`DM-пинг ПБ: ${delivered.length} доставлено, ${failed.length} неудач, ${skipped} исключено политикой (командир ${interaction.user.tag})`);
}

/** Отмена рассылки DM-пинга */
async function handleDmPingCancel(
  interaction: ButtonInteraction,
  squadId: string,
  previewToken: string | undefined,
): Promise<void> {
  const locale = await getGuildLocale(interaction.guildId);
  if (!isDmPingPreviewToken(previewToken)) {
    await interaction.update({
      embeds: [rbError(i18n.t('regbattle.dmping_expired', locale), locale)],
      components: [],
    });
    return;
  }
  // Удалить сохранённый текст
  const r = getRedis();
  const msgKey = `rb:dmmsg:${squadId}:${interaction.user.id}:${previewToken}`;
  const deleted = await r.del(msgKey);

  if (deleted !== 1) {
    await interaction.update({
      embeds: [rbError(i18n.t('regbattle.dmping_expired', locale), locale)],
      components: [],
    });
    return;
  }

  await interaction.update({
    embeds: [rbWarn(i18n.t('regbattle.dmping_cancelled', locale), locale)],
    components: [],
  });
}

// ═══════════════════════════════════════════════
//  ✈️ АВИАЦИЯ — создание авиа-канала
// ═══════════════════════════════════════════════

async function handleAviation(
  interaction: ButtonInteraction,
  squadId: string,
  client: BublikClient,
): Promise<void> {
  const locale = await getGuildLocale(interaction.guildId);
  const squad = await checkOwner(interaction, squadId, locale);
  if (!squad) return;

  if (squad.airChannelId) {
    await interaction.reply({ embeds: [rbWarn(i18n.t('regbattle.aviation_already_exists', locale), locale)], ephemeral: true });
    return;
  }

  await interaction.deferReply({ ephemeral: true });

  const guild = interaction.guild!;
  const config = squad.config;
  const name = airName(squad.number);

  // Получить категорию основного канала
  const mainVc = guild.channels.cache.get(squad.voiceChannelId) as VoiceChannel | undefined;
  const parentId = mainVc?.parentId || config.categoryId;
  const inheritedOverwrites = mainVc
    ? mainVc.permissionOverwrites.cache.map((ow) => ({
        id: ow.id,
        type: ow.type,
        allow: ow.allow,
        deny: ow.deny,
      }))
    : [];

  try {
    const airVc = await guild.channels.create({
      name,
      type: ChannelType.GuildVoice,
      parent: parentId || undefined,
      userLimit: config.airSize,
      permissionOverwrites: inheritedOverwrites,
    });

    // Обновить БД
    const updated = await updateSquad(squad.id, { airChannelId: airVc.id });

    // Обновить панель (кнопка авиации становится disabled)
    await updateControlPanel(updated, guild, client);

    await interaction.editReply({
      embeds: [rbSuccess(i18n.t('regbattle.aviation_success', locale, { name, size: config.airSize, channel: `<#${airVc.id}>` }), locale)],
    });

    recalculatePinger(guild.id);
    log.info(`Авиа-канал создан: ${name} (${airVc.id}) для отряда ${squad.number}`);
  } catch (err) {
    log.error('Ошибка создания авиа-канала', { error: String(err) });
    await interaction.editReply({ embeds: [rbError(i18n.t('regbattle.aviation_error', locale), locale)] });
  }
}

// ═══════════════════════════════════════════════
//  🔄 ПЕРЕДАТЬ ПРАВА — выбор нового командира
// ═══════════════════════════════════════════════

async function handleTransfer(
  interaction: ButtonInteraction,
  squadId: string,
  _client: BublikClient,
): Promise<void> {
  const locale = await getGuildLocale(interaction.guildId);
  const squad = await checkOwner(interaction, squadId, locale);
  if (!squad) return;

  const guild = interaction.guild!;
  const members = getSquadMembers(guild, squad.voiceChannelId, squad.airChannelId);

  // Исключить текущего владельца
  const candidates = members
    .filter((m) => m.id !== squad.ownerId)
    .map((m) => ({ id: m.id, displayName: m.displayName }));

  if (candidates.length === 0) {
    await interaction.reply({ embeds: [rbWarn(i18n.t('regbattle.transfer_no_members', locale), locale)], ephemeral: true });
    return;
  }

  const limited = candidates.slice(0, 25);

  await interaction.reply({
    embeds: [rbWarn(i18n.t('regbattle.transfer_prompt', locale), locale)],
    components: [buildTransferSelect(squadId, limited, locale)],
    ephemeral: true,
  });
}

async function handleTransferSelect(
  interaction: StringSelectMenuInteraction,
  squadId: string,
  client: BublikClient,
): Promise<void> {
  const locale = await getGuildLocale(interaction.guildId);
  const squad = await getSquad(squadId);
  if (!squad) {
    await interaction.reply({ embeds: [rbError(i18n.t('regbattle.error_squad_not_found', locale), locale)], ephemeral: true });
    return;
  }
  if (squad.ownerId !== interaction.user.id) {
    await interaction.reply({ embeds: [rbError(i18n.t('regbattle.transfer_owner_only', locale), locale)], ephemeral: true });
    return;
  }

  const newOwnerId = interaction.values[0];
  const guild = interaction.guild!;
  const newOwner = await guild.members.fetch(newOwnerId).catch(() => null);

  if (!newOwner) {
    await interaction.update({ embeds: [rbError(i18n.t('regbattle.transfer_user_not_found', locale), locale)], components: [] });
    return;
  }

  // Проверить: новый командир всё ещё в этом отряде?
  const voiceId = newOwner.voice.channelId;
  const isInSquad = voiceId === squad.voiceChannelId || (squad.airChannelId && voiceId === squad.airChannelId);
  if (!isInSquad) {
    await interaction.update({ embeds: [rbError(i18n.t('regbattle.transfer_left_channel', locale), locale)], components: [] });
    return;
  }

  // Обновить владельца
  const updated = await updateSquad(squad.id, { ownerId: newOwnerId });

  // Обновить панель
  await updateControlPanel(updated, guild, client);

  await interaction.update({
    embeds: [rbSuccess(i18n.t('regbattle.transfer_success', locale, { name: newOwner.displayName }), locale)],
    components: [],
  });

  // Уведомить нового командира
  const vc = guild.channels.cache.get(squad.voiceChannelId) as VoiceChannel | undefined;
  if (vc) {
    await vc.send({
      content: `${newOwner.toString()}`,
      embeds: [rbSuccess(i18n.t('regbattle.transfer_notify', locale, { n: squad.number }), locale)],
    }).catch(() => null);
  }

  log.info(`Передача прав ПБ: отряд ${squad.number} — ${interaction.user.tag} → ${newOwner.user.tag}`);
}

// ═══════════════════════════════════════════════
//  ⚠️ ВЫГОВОР — дисциплинарная система
// ═══════════════════════════════════════════════

/**
 * Шаг 1: Кнопка ВЫГОВОР → UserSelect (поиск по серверу)
 */
async function handleReprimand(
  interaction: ButtonInteraction,
  squadId: string,
  _client: BublikClient,
): Promise<void> {
  const locale = await getGuildLocale(interaction.guildId);
  const squad = await checkOwner(interaction, squadId, locale);
  if (!squad) return;

  const config = squad.config;

  if (!config.reprimandChannelId) {
    await interaction.reply({
      embeds: [rbError(i18n.t('regbattle.reprimand_channel_not_set', locale), locale)],
      ephemeral: true,
    });
    return;
  }

  if (config.reprimandTypeRoleIds.length === 0) {
    await interaction.reply({
      embeds: [rbError(i18n.t('regbattle.reprimand_types_not_set', locale), locale)],
      ephemeral: true,
    });
    return;
  }

  await interaction.reply({
    embeds: [rbWarn(i18n.t('regbattle.reprimand_select_offender', locale), locale)],
    components: [buildReprimandUserSelect(squadId, locale)],
    ephemeral: true,
  });
}

/**
 * Шаг 2: UserSelect → пользователь выбран → показать типы выговоров
 */
async function handleReprimandUserSelect(
  interaction: UserSelectMenuInteraction,
  squadId: string,
  _client: BublikClient,
): Promise<void> {
  const locale = await getGuildLocale(interaction.guildId);
  const squad = await getSquad(squadId);
  if (!squad) {
    await interaction.reply({ embeds: [rbError(i18n.t('regbattle.error_squad_not_found', locale), locale)], ephemeral: true });
    return;
  }
  if (squad.ownerId !== interaction.user.id) {
    await interaction.reply({ embeds: [rbError(i18n.t('regbattle.reprimand_owner_only', locale), locale)], ephemeral: true });
    return;
  }

  const offenderId = interaction.values[0];
  const guild = interaction.guild!;
  const offender = await guild.members.fetch(offenderId).catch(() => null);

  if (!offender) {
    await interaction.update({ embeds: [rbError(i18n.t('regbattle.reprimand_user_not_found', locale), locale)], components: [] });
    return;
  }

  if (offender.user.bot) {
    await interaction.update({ embeds: [rbError(i18n.t('regbattle.reprimand_no_bot', locale), locale)], components: [] });
    return;
  }

  const config = squad.config;

  // Собрать роли-типы выговоров
  const types: { roleId: string; roleName: string }[] = [];
  for (const roleId of config.reprimandTypeRoleIds) {
    const role = guild.roles.cache.get(roleId);
    if (role) types.push({ roleId: role.id, roleName: role.name });
  }

  if (types.length === 0) {
    await interaction.update({ embeds: [rbError(i18n.t('regbattle.reprimand_no_types', locale), locale)], components: [] });
    return;
  }

  await interaction.update({
    embeds: [rbWarn(
      i18n.t('regbattle.reprimand_select_type', locale, { offender: offender.toString() }),
      locale,
    )],
    components: [buildReprimandTypeSelect(squadId, offenderId, types, locale)],
  });
}

/**
 * Шаг 3: Тип выбран → модальное окно для причины
 */
async function handleReprimandTypeSelect(
  interaction: StringSelectMenuInteraction,
  squadId: string,
  offenderId: string,
  _client: BublikClient,
): Promise<void> {
  const locale = await getGuildLocale(interaction.guildId);
  const squad = await getSquad(squadId);
  if (!squad) {
    await interaction.reply({ embeds: [rbError(i18n.t('regbattle.error_squad_not_found', locale), locale)], ephemeral: true });
    return;
  }
  if (squad.ownerId !== interaction.user.id) {
    await interaction.reply({ embeds: [rbError(i18n.t('regbattle.reprimand_owner_only', locale), locale)], ephemeral: true });
    return;
  }

  const typeRoleId = interaction.values[0];

  // Показать модальное окно для причины
  const modal = new ModalBuilder()
    .setCustomId(`${RB_PREFIX}${RB_SEP}rep_modal${RB_SEP}${squadId}${RB_SEP}${offenderId}${RB_SEP}${typeRoleId}`)
    .setTitle(i18n.t('regbattle.reprimand_modal_title', locale));

  const reasonInput = new TextInputBuilder()
    .setCustomId('reason')
    .setLabel(i18n.t('regbattle.reprimand_modal_label', locale))
    .setPlaceholder(i18n.t('regbattle.reprimand_modal_placeholder', locale))
    .setStyle(TextInputStyle.Paragraph)
    .setMinLength(5)
    .setMaxLength(1000)
    .setRequired(true);

  modal.addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(reasonInput),
  );

  await interaction.showModal(modal);
}

/**
 * Шаг 4: Модальное окно → создание выговора + отправка эмбеда
 */
async function removeReprimandTypeRoleIfUnused(
  guild: any,
  reprimand: any,
  reason: string,
): Promise<boolean> {
  if (await hasOtherLiveReprimand(
    reprimand.id,
    reprimand.guildId,
    reprimand.offenderId,
    reprimand.typeRoleId,
  )) return true;

  let fetchError: unknown = null;
  const offender = guild.members.cache.get(reprimand.offenderId) ??
    await guild.members.fetch(reprimand.offenderId).catch((error: unknown) => {
      fetchError = error;
      return null;
    });
  if (!offender) return !fetchError || (fetchError as any).code === 10007;
  if (!offender.roles.cache.has(reprimand.typeRoleId)) return true;
  try {
    await offender.roles.remove(reprimand.typeRoleId, reason);
    return true;
  } catch (error) {
    log.warn(`Не удалось снять роль выговора у ${offender.user.tag}`, { error: String(error) });
    return false;
  }
}

async function handleReprimandModal(
  interaction: ModalSubmitInteraction,
  squadId: string,
  offenderId: string,
  typeRoleId: string,
  _client: BublikClient,
): Promise<void> {
  const locale = await getGuildLocale(interaction.guildId);
  const guild = interaction.guild!;
  const reason = interaction.fields.getTextInputValue('reason');

  // Проверить, что инициатор — командир отряда
  const squad = await getSquad(squadId);
  if (!squad || squad.ownerId !== interaction.user.id) {
    await interaction.reply({ embeds: [rbError(i18n.t('regbattle.reprimand_owner_only_modal', locale), locale)], ephemeral: true });
    return;
  }

  // Получить конфиг
  const config = await getConfig(guild.id);
  if (!config || !config.reprimandChannelId) {
    await interaction.reply({ embeds: [rbError(i18n.t('regbattle.reprimand_channel_not_set', locale), locale)], ephemeral: true });
    return;
  }

  const offender = await guild.members.fetch(offenderId).catch(() => null);
  if (!offender) {
    await interaction.reply({ embeds: [rbError(i18n.t('regbattle.reprimand_offender_not_found', locale), locale)], ephemeral: true });
    return;
  }

  const typeRole = await guild.roles.fetch(typeRoleId, { force: true }).catch(() => null);
  const typeName = typeRole?.name ?? i18n.t('regbattle.reprimand_type_unknown', locale);

  await interaction.deferReply({ ephemeral: true });

  const repChannel = await guild.channels.fetch(config.reprimandChannelId).catch(() => null);
  if (
    !repChannel || !repChannel.isTextBased() || !typeRole ||
    hasDangerousAssignablePermissions(typeRole.permissions)
  ) {
    await interaction.editReply({ embeds: [rbError(i18n.t('regbattle.reprimand_channel_not_found', locale), locale)] });
    return;
  }

  const expiresAt = config.reprimandDurationDays > 0
    ? new Date(Date.now() + config.reprimandDurationDays * 24 * 60 * 60 * 1000)
    : null;

  const reprimand = await createReprimand({
    guildId: guild.id,
    offenderId,
    issuerId: interaction.user.id,
    typeRoleId,
    reason,
    channelId: config.reprimandChannelId,
    expiresAt,
    status: 'granting',
  });

  try {
    const safeTypeRole = await fetchSafeAutomaticRole(guild, typeRoleId);
    await offender.roles.add(safeTypeRole, `Выговор: ${reason.slice(0, 100)}`);
  } catch (err) {
    await deleteReprimandStatusCas(reprimand.id, ['granting']);
    log.warn(`Не удалось выдать роль выговора ${typeName} для ${offender.user.tag}`, { error: String(err) });
    await interaction.editReply({ embeds: [rbError('Не удалось выдать роль взыскания; операция отменена без изменения состояния.', locale)] });
    return;
  }

  const embed = buildReprimandEmbed(
    offender,
    interaction.user,
    typeName,
    reason,
    reprimand.id,
    reprimand.createdAt,
    reprimand.expiresAt,
    locale,
  );

  const buttons = buildReprimandButtons(reprimand.id, locale);

  let msg: any;
  try {
    msg = await (repChannel as any).send({
      content: `${offender.toString()}`,
      embeds: [embed],
      components: buttons,
    });
  } catch (error) {
    await updateReprimandStatusCas(reprimand.id, ['granting'], { status: 'grant_cleanup' });
    const rolledBack = await removeReprimandTypeRoleIfUnused(guild, reprimand, 'RegBattle: rollback failed reprimand message');
    if (rolledBack) await deleteReprimandStatusCas(reprimand.id, ['grant_cleanup']);
    log.warn(`Не удалось опубликовать выговор ${reprimand.id}`, { error: String(error) });
    await interaction.editReply({ embeds: [rbError('Не удалось опубликовать взыскание; изменения откачены.', locale)] });
    return;
  }

  // Publish the external message and activate the record in one CAS. A crash
  // before this point remains a recoverable `granting` transition.
  if (!(await updateReprimandStatusCas(reprimand.id, ['granting'], {
    status: 'active',
    messageId: msg.id,
  }))) {
    await msg.delete().catch(() => null);
    await updateReprimandStatusCas(reprimand.id, ['granting'], { status: 'grant_cleanup' });
    if (await removeReprimandTypeRoleIfUnused(guild, reprimand, 'RegBattle: rollback failed reprimand CAS')) {
      await deleteReprimandStatusCas(reprimand.id, ['grant_cleanup']);
    }
    await interaction.editReply({ embeds: [rbError('Состояние взыскания изменилось конкурентно; операция отменена.', locale)] });
    return;
  }

  await interaction.editReply({
    embeds: [rbSuccess(
      i18n.t('regbattle.reprimand_success', locale, { name: offender.displayName, type: typeName, reason: reason.slice(0, 200) }),
      locale,
    )],
  });

  log.info(`Выговор: ${offender.user.tag} — ${typeName} — от ${interaction.user.tag} (${reprimand.id})`);
}

// ═══════════════════════════════════════════════
//  Выговор — кнопки (аппеляция / аннуляция)
// ═══════════════════════════════════════════════

/**
 * Кнопка «Не согласен» — апелляция (только нарушитель)
 */
async function handleReprimandAppeal(
  interaction: ButtonInteraction,
  reprimandId: string,
  client: BublikClient,
): Promise<void> {
  const locale = await getGuildLocale(interaction.guildId);
  const reprimand = await getReprimand(reprimandId);
  if (!reprimand) {
    await interaction.reply({ embeds: [rbError(i18n.t('regbattle.appeal_not_found', locale), locale)], ephemeral: true });
    return;
  }

  if (interaction.user.id !== reprimand.offenderId) {
    await interaction.reply({ embeds: [rbError(i18n.t('regbattle.appeal_offender_only', locale), locale)], ephemeral: true });
    return;
  }

  if (reprimand.status === 'appealing') {
    await interaction.reply({ embeds: [rbWarn(i18n.t('regbattle.appeal_already_submitted', locale), locale)], ephemeral: true });
    return;
  }

  if (reprimand.status === 'annulled') {
    await interaction.reply({ embeds: [rbWarn(i18n.t('regbattle.appeal_already_annulled', locale), locale)], ephemeral: true });
    return;
  }
  if (!['active', 'appealing'].includes(reprimand.status)) {
    await interaction.reply({ embeds: [rbWarn('Этот выговор уже завершён или обрабатывается.', locale)], ephemeral: true });
    return;
  }

  if (reprimand.status !== 'active') {
    await interaction.reply({ embeds: [rbWarn('Этот выговор уже завершён или обрабатывается.', locale)], ephemeral: true });
    return;
  }

  // Проверить кулдаун повторной апелляции (3 дня после отклонения)
  if (reprimand.nextAppealAt && new Date() < new Date(reprimand.nextAppealAt)) {
    const ts = Math.floor(new Date(reprimand.nextAppealAt).getTime() / 1000);
    await interaction.reply({
      embeds: [rbWarn(i18n.t('regbattle.appeal_cooldown', locale, { timestamp: `<t:${ts}:R> (<t:${ts}:F>)` }), locale)],
      ephemeral: true,
    });
    return;
  }

  await interaction.deferReply({ ephemeral: true });

  // Атомарная блокировка — защита от дабл-клика
  const lockKey = `rb:appeal:lock:${reprimandId}`;
  const locked = await getRedis().set(lockKey, '1', 'EX', 30, 'NX');
  if (!locked) {
    await interaction.editReply({ embeds: [rbWarn(i18n.t('regbattle.appeal_processing', locale), locale)] });
    return;
  }

  const guild = interaction.guild!;
  const config = await getConfig(guild.id);
  if (!config) {
    await getRedis().del(lockKey);
    await interaction.editReply({ embeds: [rbError(i18n.t('regbattle.appeal_config_not_found', locale), locale)] });
    return;
  }

  if (!(await updateReprimandStatusCas(reprimand.id, ['active'], { status: 'appeal_creating' }))) {
    await getRedis().del(lockKey);
    await interaction.editReply({ embeds: [rbWarn(i18n.t('regbattle.appeal_processing', locale), locale)] });
    return;
  }

  // Создать категорию для апелляции
  const categoryName = i18n.t('regbattle.appeal_category_name', locale, { id: reprimand.id.slice(-6) });

  // Разрешения: нарушитель + выдавший + annulRoleIds + бот
  const permissionOverwrites: any[] = [
    // Запретить всем по умолчанию
    {
      id: guild.id,
      deny: [PermissionsBitField.Flags.ViewChannel],
    },
    // Бот
    {
      id: client.user!.id,
      allow: [
        PermissionsBitField.Flags.ViewChannel,
        PermissionsBitField.Flags.SendMessages,
        PermissionsBitField.Flags.Connect,
        PermissionsBitField.Flags.Speak,
        PermissionsBitField.Flags.ManageChannels,
        PermissionsBitField.Flags.MuteMembers,
      ],
    },
    // Нарушитель
    {
      id: reprimand.offenderId,
      allow: [
        PermissionsBitField.Flags.ViewChannel,
        PermissionsBitField.Flags.SendMessages,
        PermissionsBitField.Flags.Connect,
        PermissionsBitField.Flags.Speak,
        PermissionsBitField.Flags.ReadMessageHistory,
      ],
    },
    // Выдавший выговор
    {
      id: reprimand.issuerId,
      allow: [
        PermissionsBitField.Flags.ViewChannel,
        PermissionsBitField.Flags.SendMessages,
        PermissionsBitField.Flags.Connect,
        PermissionsBitField.Flags.Speak,
        PermissionsBitField.Flags.ReadMessageHistory,
      ],
    },
  ];

  // Роли-аннуляторы
  for (const roleId of config.reprimandAnnulRoleIds) {
    permissionOverwrites.push({
      id: roleId,
      allow: [
        PermissionsBitField.Flags.ViewChannel,
        PermissionsBitField.Flags.SendMessages,
        PermissionsBitField.Flags.Connect,
        PermissionsBitField.Flags.Speak,
        PermissionsBitField.Flags.ReadMessageHistory,
      ],
    });
  }

  let category: CategoryChannel | null = null;
  let textChannel: TextChannel | null = null;
  let voiceChannel: VoiceChannel | null = null;
  let appealCommitted = false;
  try {
    category = await guild.channels.create({
      name: categoryName,
      type: ChannelType.GuildCategory,
      permissionOverwrites,
    }) as CategoryChannel;
    if (!(await updateReprimandStatusCas(reprimand.id, ['appeal_creating'], {
      appealCategoryId: category.id,
    }))) {
      await deleteTrackedChannel(guild, category.id, 'Апелляция потеряла CAS');
      await interaction.editReply({ embeds: [rbWarn(i18n.t('regbattle.appeal_processing', locale), locale)] });
      return;
    }

    textChannel = await guild.channels.create({
      name: i18n.t('regbattle.appeal_text_channel_name', locale),
      type: ChannelType.GuildText,
      parent: category.id,
    }) as TextChannel;
    if (!(await updateReprimandStatusCas(reprimand.id, ['appeal_creating'], {
      appealTextId: textChannel.id,
    }))) {
      await deleteTrackedChannel(guild, textChannel.id, 'Апелляция потеряла CAS');
      await deleteTrackedChannel(guild, category.id, 'Апелляция потеряла CAS');
      await interaction.editReply({ embeds: [rbWarn(i18n.t('regbattle.appeal_processing', locale), locale)] });
      return;
    }

    voiceChannel = await guild.channels.create({
      name: i18n.t('regbattle.appeal_voice_channel_name', locale),
      type: ChannelType.GuildVoice,
      parent: category.id,
    }) as VoiceChannel;
    if (!(await updateReprimandStatusCas(reprimand.id, ['appeal_creating'], {
      appealVoiceId: voiceChannel.id,
    }))) {
      await deleteTrackedChannel(guild, voiceChannel.id, 'Апелляция потеряла CAS');
      await deleteTrackedChannel(guild, textChannel.id, 'Апелляция потеряла CAS');
      await deleteTrackedChannel(guild, category.id, 'Апелляция потеряла CAS');
      await interaction.editReply({ embeds: [rbWarn(i18n.t('regbattle.appeal_processing', locale), locale)] });
      return;
    }

    // Отправить информацию в текстовый канал апелляции
    const typeRole = guild.roles.cache.get(reprimand.typeRoleId);
    const [issuer, offender] = await Promise.all([
      guild.members.fetch(reprimand.issuerId).catch(() => null),
      guild.members.fetch(reprimand.offenderId).catch(() => null),
    ]);

    const appealEmbed = buildAppealInfoEmbed(
      offender,
      issuer,
      typeRole?.name ?? i18n.t('regbattle.reprimand_type_unknown', locale),
      reprimand.reason,
      reprimand.id,
      reprimand.createdAt,
      locale,
    );

    // Пинг всех причастных: нарушитель + выдавший + роли-аннуляторы
    const pings: string[] = [
      offender?.toString() ?? `<@${reprimand.offenderId}>`,
      issuer?.toString() ?? `<@${reprimand.issuerId}>`,
      ...config.reprimandAnnulRoleIds.map((id: string) => `<@&${id}>`),
    ];

    await textChannel.send({
      content: i18n.t('regbattle.appeal_ping_message', locale, { mentions: pings.join(' ') }),
      embeds: [appealEmbed],
      components: buildAppealDecisionButtons(reprimand.id, locale),
    });

    // IDs and the decision message exist before the state becomes visible as
    // appealing. A crash before this CAS is fully compensatable.
    const committed = await updateReprimandStatusCas(reprimand.id, ['appeal_creating'], {
      status: 'appealing',
    });
    if (!committed) {
      await deleteTrackedChannel(guild, textChannel.id, 'Апелляция потеряла CAS');
      await deleteTrackedChannel(guild, voiceChannel.id, 'Апелляция потеряла CAS');
      await deleteTrackedChannel(guild, category.id, 'Апелляция потеряла CAS');
      await interaction.editReply({ embeds: [rbWarn(i18n.t('regbattle.appeal_processing', locale), locale)] });
      return;
    }
    appealCommitted = true;

    // Обновить оригинальное сообщение в канале выговоров
    await updateReprimandMessage(guild, reprimand, 'appealing', config, locale);

    await interaction.editReply({
      embeds: [rbSuccess(
        i18n.t('regbattle.appeal_success', locale, { textChannel: `<#${textChannel.id}>`, voiceChannel: `<#${voiceChannel.id}>` }),
        locale,
      )],
    });

    log.info(`Апелляция: ${interaction.user.tag} по выговору ${reprimand.id}`);
  } catch (err) {
    // Keep appeal_creating and every successfully persisted external ID. The
    // recovery scheduler will retry Discord-first compensation; it must not
    // hide a channel by prematurely returning the row to active.
    if (!appealCommitted && voiceChannel) {
      await deleteTrackedChannel(guild, voiceChannel.id, 'RegBattle: rollback failed appeal creation');
    }
    if (!appealCommitted && textChannel) {
      await deleteTrackedChannel(guild, textChannel.id, 'RegBattle: rollback failed appeal creation');
    }
    if (!appealCommitted && category) {
      await deleteTrackedChannel(guild, category.id, 'RegBattle: rollback failed appeal creation');
    }
    log.error('Ошибка создания категории апелляции', { error: String(err) });
    await interaction.editReply({ embeds: [rbError(i18n.t('regbattle.appeal_create_error', locale), locale)] });
  }
}

/**
 * Кнопка «Аннулировать» — только для ролей из annulRoleIds
 */
async function handleReprimandAnnul(
  interaction: ButtonInteraction,
  reprimandId: string,
  _client: BublikClient,
): Promise<void> {
  const locale = await getGuildLocale(interaction.guildId);
  const reprimand = await getReprimand(reprimandId);
  if (!reprimand) {
    await interaction.reply({ embeds: [rbError(i18n.t('regbattle.appeal_not_found', locale), locale)], ephemeral: true });
    return;
  }

  if (reprimand.status === 'annulled') {
    await interaction.reply({ embeds: [rbWarn(i18n.t('regbattle.appeal_already_annulled', locale), locale)], ephemeral: true });
    return;
  }
  if (!['active', 'appealing'].includes(reprimand.status)) {
    await interaction.reply({ embeds: [rbWarn('Этот выговор уже завершён или обрабатывается.', locale)], ephemeral: true });
    return;
  }

  const guild = interaction.guild!;
  const config = await getConfig(guild.id);
  if (!config) {
    await interaction.reply({ embeds: [rbError(i18n.t('regbattle.appeal_config_not_found', locale), locale)], ephemeral: true });
    return;
  }

  // Проверить права: пользователь должен иметь одну из annulRoleIds
  const member = await guild.members.fetch(interaction.user.id).catch(() => null);
  if (!member) {
    await interaction.reply({ embeds: [rbError(i18n.t('regbattle.annul_user_error', locale), locale)], ephemeral: true });
    return;
  }

  const hasAnnulRole = config.reprimandAnnulRoleIds.some((id: string) => member.roles.cache.has(id));
  if (!hasAnnulRole) {
    await interaction.reply({
      embeds: [rbError(i18n.t('regbattle.annul_no_rights', locale), locale)],
      ephemeral: true,
    });
    return;
  }

  // Запрет самоаннуляции: нарушитель не может сам себе аннулировать выговор
  if (interaction.user.id === reprimand.offenderId) {
    await interaction.reply({
      embeds: [rbError(i18n.t('regbattle.annul_self_forbidden', locale), locale)],
      ephemeral: true,
    });
    return;
  }

  await interaction.deferReply({ ephemeral: true });

  // Атомарная блокировка — защита от дабл-клика
  const lockKey = `rb:annul:lock:${reprimandId}`;
  const locked = await getRedis().set(lockKey, '1', 'EX', 30, 'NX');
  if (!locked) {
    await interaction.editReply({ embeds: [rbWarn(i18n.t('regbattle.annul_processing', locale), locale)] });
    return;
  }

  const annulledAt = new Date();
  if (!(await updateReprimandStatusCas(reprimand.id, ['active', 'appealing'], {
    status: 'annulling',
    annulledById: interaction.user.id,
    annulledAt,
  }))) {
    await interaction.editReply({ embeds: [rbWarn(i18n.t('regbattle.annul_processing', locale), locale)] });
    return;
  }

  if (!(await removeReprimandTypeRoleIfUnused(guild, reprimand, 'Выговор аннулирован'))) {
    await updateReprimandStatusCas(reprimand.id, ['annulling'], { status: reprimand.status });
    await interaction.editReply({ embeds: [rbError('Не удалось безопасно снять роль взыскания; операция будет доступна для повтора.', locale)] });
    return;
  }

  if (reprimand.appealCategoryId) {
    const textDeleted = !reprimand.appealTextId || await deleteTrackedChannel(
      guild,
      reprimand.appealTextId,
      'Выговор аннулирован',
    );
    const voiceDeleted = !reprimand.appealVoiceId || await deleteTrackedChannel(
      guild,
      reprimand.appealVoiceId,
      'Выговор аннулирован',
    );
    const categoryDeleted = textDeleted && voiceDeleted && await deleteTrackedChannel(
      guild,
      reprimand.appealCategoryId,
      'Выговор аннулирован',
    );
    if (!categoryDeleted) {
      await interaction.editReply({ embeds: [rbError('Каналы апелляции пока не удалены; recovery завершит аннуляцию.', locale)] });
      return;
    }
  }

  if (!(await updateReprimandMessage(
    guild,
    reprimand,
    'annulled',
    config,
    locale,
    interaction.user.tag,
  ))) {
    await interaction.editReply({ embeds: [rbWarn('Аннуляция применена; recovery повторит обновление сообщения.', locale)] });
    return;
  }

  if (!(await updateReprimandStatusCas(reprimand.id, ['annulling'], {
    status: 'annulled',
    annulledById: interaction.user.id,
    annulledAt,
    appealCategoryId: null,
    appealTextId: null,
    appealVoiceId: null,
  }))) {
    await interaction.editReply({ embeds: [rbWarn(i18n.t('regbattle.annul_processing', locale), locale)] });
    return;
  }
  if (!(await removeReprimandTypeRoleIfUnused(guild, reprimand, 'RegBattle: post-commit annulment cleanup'))) {
    await updateReprimandStatusCas(reprimand.id, ['annulled'], { status: 'annulling' });
  }

  await interaction.editReply({
    embeds: [rbSuccess(i18n.t('regbattle.annul_success', locale, { id: reprimand.id.slice(-6) }), locale)],
  });

  log.info(`Аннуляция выговора: ${reprimand.id} — аннулировал ${interaction.user.tag}`);
}

// ═══════════════════════════════════════════════
//  Апелляция — кнопки решения (принять / отклонить)
// ═══════════════════════════════════════════════

/**
 * Кнопка «Апелляция принята» или «Апелляция отклонена» → открывает модалку
 * Доступна только ролям из annulRoleIds, и запрещена нарушителю.
 */
async function handleReprimandAppealDecisionButton(
  interaction: ButtonInteraction,
  reprimandId: string,
  decision: 'accept' | 'reject',
  _client: BublikClient,
): Promise<void> {
  const locale = await getGuildLocale(interaction.guildId);
  const reprimand = await getReprimand(reprimandId);
  if (!reprimand) {
    await interaction.reply({ embeds: [rbError(i18n.t('regbattle.appeal_not_found', locale), locale)], ephemeral: true });
    return;
  }

  if (reprimand.status !== 'appealing') {
    await interaction.reply({ embeds: [rbWarn(i18n.t('regbattle.appeal_decision_already_resolved', locale), locale)], ephemeral: true });
    return;
  }

  const guild = interaction.guild!;
  const config = await getConfig(guild.id);
  if (!config) {
    await interaction.reply({ embeds: [rbError(i18n.t('regbattle.appeal_config_not_found', locale), locale)], ephemeral: true });
    return;
  }

  // Проверить права: пользователь должен иметь одну из annulRoleIds
  const member = await guild.members.fetch(interaction.user.id).catch(() => null);
  if (!member) {
    await interaction.reply({ embeds: [rbError(i18n.t('regbattle.annul_user_error', locale), locale)], ephemeral: true });
    return;
  }

  const hasAnnulRole = config.reprimandAnnulRoleIds.some((id: string) => member.roles.cache.has(id));
  if (!hasAnnulRole) {
    await interaction.reply({
      embeds: [rbError(i18n.t('regbattle.appeal_decision_no_rights', locale), locale)],
      ephemeral: true,
    });
    return;
  }

  // Нарушитель не может сам принять/отклонить свою апелляцию
  if (interaction.user.id === reprimand.offenderId) {
    await interaction.reply({
      embeds: [rbError(i18n.t('regbattle.appeal_decision_self_forbidden', locale), locale)],
      ephemeral: true,
    });
    return;
  }

  const title = decision === 'accept'
    ? i18n.t('regbattle.appeal_decision_modal_title_accept', locale)
    : i18n.t('regbattle.appeal_decision_modal_title_reject', locale);
  const label = decision === 'accept'
    ? i18n.t('regbattle.appeal_decision_modal_label_accept', locale)
    : i18n.t('regbattle.appeal_decision_modal_label_reject', locale);

  const modal = new ModalBuilder()
    .setCustomId(`${RB_PREFIX}${RB_SEP}rep_appeal_decision_modal${RB_SEP}${reprimandId}${RB_SEP}${decision}`)
    .setTitle(title);

  const reasonInput = new TextInputBuilder()
    .setCustomId('reason')
    .setLabel(label)
    .setPlaceholder(i18n.t('regbattle.appeal_decision_modal_placeholder', locale))
    .setStyle(TextInputStyle.Paragraph)
    .setMinLength(5)
    .setMaxLength(1000)
    .setRequired(true);

  modal.addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(reasonInput),
  );

  await interaction.showModal(modal);
}

/**
 * Модальное окно решения по апелляции
 */
async function handleReprimandAppealDecisionModal(
  interaction: ModalSubmitInteraction,
  reprimandId: string,
  decision: 'accept' | 'reject',
  _client: BublikClient,
): Promise<void> {
  const locale = await getGuildLocale(interaction.guildId);
  const reason = interaction.fields.getTextInputValue('reason');

  const reprimand = await getReprimand(reprimandId);
  if (!reprimand) {
    await interaction.reply({ embeds: [rbError(i18n.t('regbattle.appeal_not_found', locale), locale)], ephemeral: true });
    return;
  }

  if (reprimand.status !== 'appealing') {
    await interaction.reply({ embeds: [rbWarn(i18n.t('regbattle.appeal_decision_already_resolved_modal', locale), locale)], ephemeral: true });
    return;
  }

  const guild = interaction.guild!;
  const config = await getConfig(guild.id);
  if (!config) {
    await interaction.reply({ embeds: [rbError(i18n.t('regbattle.appeal_config_not_found', locale), locale)], ephemeral: true });
    return;
  }

  // Re-check authorisation at submit time; roles may have changed after the
  // decision modal was opened.
  const reviewer = await guild.members.fetch(interaction.user.id).catch(() => null);
  const mayDecide = reviewer && config.reprimandAnnulRoleIds.some((id: string) => reviewer.roles.cache.has(id));
  if (!mayDecide || interaction.user.id === reprimand.offenderId) {
    await interaction.reply({ embeds: [rbError(i18n.t('regbattle.appeal_decision_no_rights', locale), locale)], ephemeral: true });
    return;
  }

  await interaction.deferReply({ ephemeral: true });

  // Атомарная блокировка
  const lockKey = `rb:appeal_decision:lock:${reprimandId}`;
  const locked = await getRedis().set(lockKey, '1', 'EX', 30, 'NX');
  if (!locked) {
    await interaction.editReply({ embeds: [rbWarn(i18n.t('regbattle.appeal_decision_processing', locale), locale)] });
    return;
  }

  const decisionAt = new Date();
  const nextAppealAt = decision === 'reject'
    ? new Date(decisionAt.getTime() + APPEAL_COOLDOWN_MS)
    : null;
  if (!(await updateReprimandStatusCas(reprimand.id, ['appealing'], {
    status: 'appeal_resolving',
    appealDecision: decision === 'accept' ? 'resolving_accept' : 'resolving_reject',
    appealDecisionById: interaction.user.id,
    appealDecisionReason: reason,
    appealDecisionAt: decisionAt,
    ...(nextAppealAt ? { nextAppealAt } : {}),
  }))) {
    await interaction.editReply({ embeds: [rbWarn(i18n.t('regbattle.appeal_decision_processing', locale), locale)] });
    return;
  }

  if (decision === 'accept') {
    if (!(await removeReprimandTypeRoleIfUnused(guild, reprimand, 'Апелляция принята'))) {
      await updateReprimandStatusCas(reprimand.id, ['appeal_resolving'], {
        status: 'appealing',
        appealDecision: null,
        appealDecisionById: null,
        appealDecisionReason: null,
        appealDecisionAt: null,
      });
      await interaction.editReply({ embeds: [rbError('Не удалось безопасно снять роль взыскания; решение не применено.', locale)] });
      return;
    }
  }

  // Notify before Discord-first cleanup while the channel is still available.
  if (reprimand.appealTextId) {
    try {
      const textCh = guild.channels.cache.get(reprimand.appealTextId);
      if (textCh && textCh.isTextBased()) {
        const decisionLabel = decision === 'accept'
          ? i18n.t('regbattle.appeal_channel_decision_accepted', locale, { user: interaction.user.toString(), reason: reason.slice(0, 300) })
          : i18n.t('regbattle.appeal_channel_decision_rejected', locale, { user: interaction.user.toString(), reason: reason.slice(0, 300) });
        await (textCh as any).send({
          embeds: [rbWarn(decisionLabel, locale)],
        });
      }
    } catch {
      // не страшно
    }
  }

  // Keep appeal_resolving until Discord confirms every deletion. Recovery can
  // repeat this safely after a crash or transient REST failure.
  if (reprimand.appealCategoryId) {
    const textDeleted = !reprimand.appealTextId || await deleteTrackedChannel(
      guild,
      reprimand.appealTextId,
      'Апелляция рассмотрена',
    );
    const voiceDeleted = !reprimand.appealVoiceId || await deleteTrackedChannel(
      guild,
      reprimand.appealVoiceId,
      'Апелляция рассмотрена',
    );
    const categoryDeleted = textDeleted && voiceDeleted && await deleteTrackedChannel(
      guild,
      reprimand.appealCategoryId,
      'Апелляция рассмотрена',
    );
    if (!categoryDeleted) {
      await interaction.editReply({ embeds: [rbWarn('Решение сохранено; recovery завершит очистку каналов.', locale)] });
      return;
    }
  }

  const uiStatus = decision === 'accept' ? 'appeal_accepted' : 'appeal_rejected';
  if (!(await updateReprimandMessage(
    guild,
    reprimand,
    uiStatus,
    config,
    locale,
    interaction.user.tag,
    reason,
  ))) {
    await interaction.editReply({ embeds: [rbWarn('Решение сохранено; recovery повторит обновление сообщения.', locale)] });
    return;
  }

  const committed = await updateReprimandStatusCas(reprimand.id, ['appeal_resolving'], decision === 'accept' ? {
    status: 'annulled',
    annulledById: interaction.user.id,
    annulledAt: decisionAt,
    appealDecision: 'accepted',
    appealCategoryId: null,
    appealTextId: null,
    appealVoiceId: null,
  } : {
    status: 'active',
    appealDecision: 'rejected',
    nextAppealAt,
    appealCategoryId: null,
    appealTextId: null,
    appealVoiceId: null,
  });
  if (!committed) {
    await interaction.editReply({ embeds: [rbWarn(i18n.t('regbattle.appeal_decision_processing', locale), locale)] });
    return;
  }

  if (decision === 'accept') {
    if (!(await removeReprimandTypeRoleIfUnused(guild, reprimand, 'RegBattle: post-commit accepted appeal cleanup'))) {
      await updateReprimandStatusCas(reprimand.id, ['annulled'], {
        status: 'appeal_resolving',
        appealDecision: 'resolving_accept',
      });
    }
    await interaction.editReply({
      embeds: [rbSuccess(
        i18n.t('regbattle.appeal_accepted_success', locale, { id: reprimand.id.slice(-6), reason: reason.slice(0, 200) }),
        locale,
      )],
    });
    log.info(`Апелляция принята: ${reprimand.id} — решение ${interaction.user.tag}`);
  } else {
    await interaction.editReply({
      embeds: [rbSuccess(
        i18n.t('regbattle.appeal_rejected_success', locale, { id: reprimand.id.slice(-6), reason: reason.slice(0, 200) }),
        locale,
      )],
    });
    log.info(`Апелляция отклонена: ${reprimand.id} — решение ${interaction.user.tag}`);
  }
}

// ═══════════════════════════════════════════════
//  Выговор — вспомогательные функции
// ═══════════════════════════════════════════════

function buildReprimandEmbed(
  offender: GuildMember,
  issuer: { id: string; tag: string; toString(): string },
  typeName: string,
  reason: string,
  reprimandId: string,
  createdAt: Date,
  expiresAt: Date | null | undefined,
  locale: string,
): BublikEmbed {
  const expiryLine = expiresAt
    ? `\n${i18n.t('regbattle.reprimand_field_expires', locale)} <t:${Math.floor(expiresAt.getTime() / 1000)}:F>`
    : '';

  return new BublikEmbed()
    .setTitle(i18n.t('regbattle.reprimand_embed_title', locale))
    .setDescription(
      `━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
      `${i18n.t('regbattle.reprimand_field_offender', locale)} ${offender.toString()} (${offender.user.tag})\n` +
      `${i18n.t('regbattle.reprimand_field_type', locale)} ${typeName}\n` +
      `${i18n.t('regbattle.reprimand_field_reason', locale)}\n> ${reason}\n\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
      `${i18n.t('regbattle.reprimand_field_issuer', locale)} <@${issuer.id}>\n` +
      `${i18n.t('regbattle.reprimand_field_date', locale)} <t:${Math.floor(createdAt.getTime() / 1000)}:F>${expiryLine}\n` +
      `${i18n.t('regbattle.reprimand_field_id', locale)} \`${reprimandId.slice(-6)}\`\n` +
      `${i18n.t('regbattle.reprimand_field_status', locale)} ${i18n.t('regbattle.reprimand_status_active', locale)}`,
    )
    .setColor(0xed4245)
    .setThumbnail(offender.displayAvatarURL({ size: 128 }));
}

function buildReprimandButtons(
  reprimandId: string,
  locale: string,
): ActionRowBuilder<ButtonBuilder>[] {
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`${RB_PREFIX}${RB_SEP}rep_appeal${RB_SEP}${reprimandId}`)
        .setLabel(i18n.t('regbattle.btn_appeal', locale))
        .setStyle(ButtonStyle.Danger),
      new ButtonBuilder()
        .setCustomId(`${RB_PREFIX}${RB_SEP}rep_annul${RB_SEP}${reprimandId}`)
        .setLabel(i18n.t('regbattle.btn_annul', locale))
        .setStyle(ButtonStyle.Success),
    ),
  ];
}

function buildAppealInfoEmbed(
  offender: GuildMember | null,
  issuer: GuildMember | null,
  typeName: string,
  reason: string,
  reprimandId: string,
  createdAt: Date,
  locale: string,
): BublikEmbed {
  return new BublikEmbed()
    .setTitle(i18n.t('regbattle.appeal_info_title', locale))
    .setDescription(
      `━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
      `${i18n.t('regbattle.reprimand_field_offender', locale)} ${offender?.toString() ?? '*неизвестен*'}\n` +
      `${i18n.t('regbattle.reprimand_field_type', locale)} ${typeName}\n` +
      `${i18n.t('regbattle.reprimand_field_reason', locale)}\n> ${reason}\n\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
      `${i18n.t('regbattle.reprimand_field_issuer', locale)} ${issuer?.toString() ?? '*неизвестен*'}\n` +
      `${i18n.t('regbattle.appeal_field_issuer_date', locale)} <t:${Math.floor(createdAt.getTime() / 1000)}:F>\n` +
      `${i18n.t('regbattle.appeal_field_id', locale)} \`${reprimandId.slice(-6)}\`\n\n` +
      i18n.t('regbattle.appeal_info_footer', locale),
    )
    .setColor(0xfee75c);
}

/**
 * Кнопки решения по апелляции (принять / отклонить)
 */
function buildAppealDecisionButtons(
  reprimandId: string,
  locale: string,
): ActionRowBuilder<ButtonBuilder>[] {
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`${RB_PREFIX}${RB_SEP}rep_appeal_accept${RB_SEP}${reprimandId}`)
        .setLabel(i18n.t('regbattle.btn_appeal_accept', locale))
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`${RB_PREFIX}${RB_SEP}rep_appeal_reject${RB_SEP}${reprimandId}`)
        .setLabel(i18n.t('regbattle.btn_appeal_reject', locale))
        .setStyle(ButtonStyle.Danger),
    ),
  ];
}

/**
 * Обновить оригинальное сообщение выговора (статус)
 */
export async function updateReprimandMessage(
  guild: any,
  reprimand: any,
  newStatus: string,
  config: any,
  locale: string,
  decisionByTag?: string,
  decisionReason?: string,
): Promise<boolean> {
  if (!reprimand.messageId || !reprimand.channelId) return true;

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
    const typeName = typeRole?.name ?? i18n.t('regbattle.reprimand_type_unknown', locale);

    let statusLine: string;
    let color: number;
    let decisionBlock = '';

    if (newStatus === 'appealing') {
      statusLine = i18n.t('regbattle.reprimand_status_appealing', locale);
      color = 0xfee75c;
    } else if (newStatus === 'annulled') {
      statusLine = decisionByTag
        ? i18n.t('regbattle.reprimand_status_annulled_by', locale, { by: decisionByTag })
        : i18n.t('regbattle.reprimand_status_annulled', locale);
      color = 0x57f287;
    } else if (newStatus === 'appeal_accepted') {
      statusLine = i18n.t('regbattle.reprimand_status_appeal_accepted', locale);
      color = 0x57f287;
      if (decisionByTag && decisionReason) {
        decisionBlock = `\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
          i18n.t('regbattle.reprimand_decision_accepted', locale, { by: decisionByTag, reason: decisionReason });
      }
    } else if (newStatus === 'appeal_rejected') {
      statusLine = i18n.t('regbattle.reprimand_status_appeal_rejected', locale);
      color = 0xed4245;
      if (decisionByTag && decisionReason) {
        decisionBlock = `\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
          i18n.t('regbattle.reprimand_decision_rejected', locale, { by: decisionByTag, reason: decisionReason });
      }
    } else if (newStatus === 'expired') {
      statusLine = i18n.t('regbattle.reprimand_status_expired', locale);
      color = 0x99aab5;
    } else {
      statusLine = i18n.t('regbattle.reprimand_status_active', locale);
      color = 0xed4245;
    }

    // Строка истечения срока
    const expiresAt = reprimand.expiresAt ? new Date(reprimand.expiresAt) : null;
    const expiryLine = expiresAt
      ? `\n${i18n.t('regbattle.reprimand_field_expires', locale)} <t:${Math.floor(expiresAt.getTime() / 1000)}:F>`
      : '';

    const embed = new BublikEmbed()
      .setTitle(i18n.t('regbattle.reprimand_embed_title', locale))
      .setDescription(
        `━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
        `${i18n.t('regbattle.reprimand_field_offender', locale)} ${offender?.toString() ?? `<@${reprimand.offenderId}>`} (${offender?.user.tag ?? 'N/A'})\n` +
        `${i18n.t('regbattle.reprimand_field_type', locale)} ${typeName}\n` +
        `${i18n.t('regbattle.reprimand_field_reason', locale)}\n> ${reprimand.reason}\n\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
        `${i18n.t('regbattle.reprimand_field_issuer', locale)} <@${reprimand.issuerId}>\n` +
        `${i18n.t('regbattle.reprimand_field_date', locale)} <t:${Math.floor(reprimand.createdAt.getTime() / 1000)}:F>${expiryLine}\n` +
        `${i18n.t('regbattle.reprimand_field_id', locale)} \`${reprimand.id.slice(-6)}\`\n` +
        `${i18n.t('regbattle.reprimand_field_status', locale)} ${statusLine}${decisionBlock}`,
      )
      .setColor(color);

    if (offender) embed.setThumbnail(offender.displayAvatarURL({ size: 128 }));

    // Если аннулирован/истёк/апелляция принята — убрать кнопки
    const terminalStatuses = ['annulled', 'appeal_accepted', 'expired'];
    const components = terminalStatuses.includes(newStatus) ? [] : buildReprimandButtons(reprimand.id, locale);

    await msg.edit({ embeds: [embed], components });
    return true;
  } catch (err) {
    if (isUnknownChannelError(err) || isUnknownMessageError(err)) return true;
    log.warn(`Не удалось обновить сообщение выговора ${reprimand.id}`, { error: String(err) });
    return false;
  }
}

// ═══════════════════════════════════════════════
//  Кнопка: Toggle уведомлений
// ═══════════════════════════════════════════════

async function handleNotifyToggle(
  interaction: ButtonInteraction,
  squadId: string,
  client: BublikClient,
): Promise<void> {
  const locale = await getGuildLocale(interaction.guildId!);
  const squad = await checkOwner(interaction, squadId, locale);
  if (!squad) return;

  let guardedResult: CurrentNotifyControlPanelResult<NotifyToggleOutcome>;
  try {
    guardedResult = await runForCurrentNotifyControlPanel(
      squad.panelMessageId,
      interaction.message.id,
      async () => {
        await interaction.deferReply({ flags: 64 });
        return applyNotifyToggle(
          squadId,
          () => toggleNotifications(squadId),
          (notificationsEnabled) => {
            const projections: NotifyToggleProjection[] = [
              {
                name: 'pinger',
                run: () => recalculatePinger(interaction.guildId!),
              },
              {
                name: 'control-panel',
                run: async () => {
                  const buttons = buildControlPanelButtons(
                    squadId,
                    !!squad.airChannelId,
                    locale,
                    notificationsEnabled,
                  );
                  await interaction.message.edit({ components: buttons });
                },
              },
            ];

            if (interaction.guild) {
              projections.push({
                name: 'status-panel',
                run: () => refreshStatusPanel(interaction.guild!, client, true),
              });
            }
            return projections;
          },
        );
      },
    );
  } catch (error) {
    log.error(`Не удалось сохранить настройку уведомлений отряда ${squadId}`, {
      error: String(error),
    });
    const errorPayload = {
      embeds: [rbError(i18n.t('regbattle.notify_toggle_failed', locale), locale)],
    };
    const response = interaction.deferred || interaction.replied
      ? interaction.editReply(errorPayload)
      : interaction.reply({ ...errorPayload, flags: 64 });
    await response.catch((replyError) => {
      log.warn('Не удалось сообщить об ошибке переключения уведомлений', {
        error: String(replyError),
      });
    });
    return;
  }

  if (guardedResult.status === 'stale-panel') {
    await interaction.reply({
      embeds: [rbWarn(i18n.t('regbattle.notify_stale_panel', locale), locale)],
      flags: 64,
    }).catch((error) => {
      log.warn(`Не удалось сообщить об устаревшей панели отряда ${squadId}`, {
        error: String(error),
      });
    });
    await interaction.message.edit({ components: [] }).catch((error) => {
      log.warn(`Не удалось очистить устаревшую панель отряда ${squadId}`, {
        error: String(error),
      });
    });
    return;
  }

  const outcome = guardedResult.value;

  for (const failure of outcome.projectionFailures) {
    log.warn(`Настройка уведомлений сохранена, но проекция ${failure.name} не обновилась`, {
      error: String(failure.error),
      squadId,
    });
  }

  if (
    interaction.guild &&
    outcome.projectionFailures.some((failure) => failure.name === 'control-panel')
  ) {
    const repairTimer = setTimeout(() => {
      void getSquad(squadId)
        .then((freshSquad) => freshSquad && updateControlPanel(freshSquad, interaction.guild!, client))
        .catch((error) => {
          log.warn(`Повторное обновление панели уведомлений отряда ${squadId} не удалось`, {
            error: String(error),
          });
        });
    }, 1_000);
    repairTimer.unref?.();
  }

  const key = outcome.notificationsEnabled
    ? 'regbattle.notify_toggled_on'
    : 'regbattle.notify_toggled_off';
  const confirmation = i18n.t(key, locale);
  const hasDelayedProjection = outcome.projectionFailures.length > 0;
  const responseText = hasDelayedProjection
    ? `${confirmation}\n\n${i18n.t('regbattle.notify_sync_delayed', locale)}`
    : confirmation;
  await interaction.editReply({
    embeds: [hasDelayedProjection ? rbWarn(responseText, locale) : rbSuccess(responseText, locale)],
  }).catch((error) => {
    // The setting is already committed. A Discord response failure must not be
    // reclassified by the outer router as a failed notification toggle.
    log.warn(`Настройка уведомлений отряда ${squadId} сохранена без подтверждения`, {
      error: String(error),
    });
  });
}

// ═══════════════════════════════════════════════
//  Кнопки статус-панели (ephemeral)
// ═══════════════════════════════════════════════

async function handleStatusPanelButton(
  interaction: ButtonInteraction,
  type: 'ignoring' | 'played' | 'offline',
  client: BublikClient,
): Promise<void> {
  if (!interaction.guild) return;

  // Полный снимок участников может ждать gateway → сначала defer
  await interaction.deferReply({ flags: 64 });

  try {
    const locale = await getGuildLocale(interaction.guildId!);
    const data = await getStatusPanelData(interaction.guild, client);

    let embed;
    switch (type) {
      case 'ignoring':
        embed = buildIgnoringDetailEmbed(data.onlineIgnoring, locale);
        break;
      case 'played':
        embed = buildPlayedDetailEmbed(data.playedToday, locale);
        break;
      case 'offline':
        embed = buildOfflineDetailEmbed(data.offlineAbsent, locale);
        break;
    }

    await interaction.editReply({ embeds: [embed] });
  } catch (err) {
    log.error('Ошибка обработки кнопки статус-панели', { error: String(err) });
    await interaction.editReply({ content: '❌ Ошибка загрузки данных.' }).catch(() => null);
  }
}
