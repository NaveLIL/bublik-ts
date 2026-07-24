// ═══════════════════════════════════════════════
//  Heist — движок коллективного налёта на банк
//
//  • createHeistSession — создаёт запись + панель
//  • handleJoinButton / handleCancelButton — кнопки
//  • resolveHeist — разрешает (атомарно: куш или штраф)
//  • startHeistScheduler — обходит зависшие assemble’ы
// ═══════════════════════════════════════════════

import {
  ButtonInteraction,
  ButtonBuilder,
  ButtonStyle,
  ActionRowBuilder,
  TextChannel,
  Client,
  MessageFlags,
  GuildMember,
} from 'discord.js';
import type { BublikClient } from '../../bot';
import { randomUUID } from 'node:crypto';
import { logger } from '../../core/Logger';
import { i18n } from '../../core/I18n';
import { getGuildLocale } from '../../core/GuildConfig';
import { getDatabase } from '../../core/Database';
import { scheduleTask, unscheduleTask } from '../../core/SchedulerManager';
import { isGuildAllowed } from '../../core/Whitelist';
import { getRedis } from '../../core/Redis';
import { BublikEmbed } from '../../core/EmbedBuilder';
import {
  getEcoConfig,
  getOrCreateProfile,
  invalidateProfileCache,
  getActiveHeistForInitiator,
  createHeist,
  getHeist,
  joinHeistMember,
  releaseHeistMembershipClaims,
  setHeistMessage,
  getExpiredAssemblingHeists,
  isSafeActive,
} from './database';
import { withFinancialLock, checkCooldown, formatCooldown, fmt } from './profile';
import { getUserPerks } from './perks';
import { getActiveBoosts, applyRobBoost, applyWantedMul } from './events';
import {
  ECO_PREFIX,
  ECO_SEP,
  HEIST_DEFAULTS,
  WANTED_DEFAULTS,
  SAFE_DEFAULTS,
  EMOJI,
  TX,
  DIRTY_DEFAULTS,
} from './constants';
import { ecoError, ecoLocked, buildCooldownEmbed } from './embeds';
import { pickPhrase } from './phrases';
import { newsHeistSuccess } from './news';
import { secureChancePercent, secureRandomFloat } from './random';

const log = logger.child('Economy:Heist');

// ── customId helpers ─────────────────────────
export const HEIST_BTN = `${ECO_PREFIX}${ECO_SEP}heist`;
export const heistJoinId = (id: string) => `${HEIST_BTN}${ECO_SEP}join${ECO_SEP}${id}`;
export const heistCancelId = (id: string) => `${HEIST_BTN}${ECO_SEP}cancel${ECO_SEP}${id}`;
export const heistStartId = (id: string) => `${HEIST_BTN}${ECO_SEP}start${ECO_SEP}${id}`;

// ═══════════════════════════════════════════════
//  Создание сессии (вызывается из /heist)
// ═══════════════════════════════════════════════

export interface HeistInitResult {
  ok: boolean;
  errorKey?: string;
  errorVars?: Record<string, any>;
  cooldownRemaining?: number;
  heistId?: string;
}

export async function createHeistSession(
  guildId: string,
  initiatorId: string,
  victimId: string,
  channelId: string,
): Promise<HeistInitResult> {
  const config = await getEcoConfig(guildId);
  if (!config?.enabled) return { ok: false, errorKey: 'economy.common.error_economy_disabled_short' };
  if (config.heistEnabled === false) return { ok: false, errorKey: 'economy.cmd.heist.error_disabled' };

  if (initiatorId === victimId) return { ok: false, errorKey: 'economy.cmd.heist.error_self' };

  const cdInit = Number(config.heistCooldownInit ?? HEIST_DEFAULTS.cooldownInit);
  const minVictimBank = config.heistMinVictimBank ?? HEIST_DEFAULTS.minVictimBank;

  return await withFinancialLock(guildId, initiatorId, async () => {
    const initiator = await getOrCreateProfile(guildId, initiatorId);

    // Кулдаун
    const remaining = checkCooldown(initiator.lastHeistInit, cdInit);
    if (remaining > 0) {
      return { ok: false, errorKey: '__cooldown__', cooldownRemaining: remaining };
    }

    // Уже идёт активный heist у этого инициатора?
    const active = await getActiveHeistForInitiator(guildId, initiatorId);
    if (active) {
      return { ok: false, errorKey: 'economy.cmd.heist.error_already_active' };
    }

    // Жертва
    const victim = await getOrCreateProfile(guildId, victimId);
    if (victim.bank < minVictimBank) {
      return {
        ok: false,
        errorKey: 'economy.cmd.heist.error_victim_empty',
        errorVars: { userId: victimId, minBank: fmt(minVictimBank) },
      };
    }

    // Если сейф жертвы блокирует целиком (mode=immune) — отказ ещё на старте
    const safeMode = (config.safeMode ?? SAFE_DEFAULTS.mode) as 'partial' | 'immune';
    if (safeMode === 'immune' && isSafeActive(victim)) {
      return { ok: false, errorKey: 'economy.cmd.heist.error_target_safe', errorVars: { userId: victimId } };
    }

    const assembleMs = Number(config.heistAssembleMs ?? HEIST_DEFAULTS.assembleMs);
    let heist;
    try {
      heist = await createHeist({
        guildId,
        initiatorId,
        victimId,
        channelId,
        expiresAt: new Date(Date.now() + assembleMs),
      });
    } catch (error) {
      if (error instanceof Error && error.message === 'heist_membership_active') {
        return { ok: false, errorKey: 'economy.cmd.heist.error_already_active' };
      }
      throw error;
    }

    return { ok: true, heistId: heist.id };
  }) ?? { ok: false, errorKey: 'economy.locked' };
}

// ═══════════════════════════════════════════════
//  Embed/UI панели сбора
// ═══════════════════════════════════════════════

export async function buildAssembleEmbed(heistId: string, locale: string): Promise<BublikEmbed> {
  const heist = await getHeist(heistId);
  if (!heist) {
    return new BublikEmbed().error().setDescription('Heist not found');
  }
  const config = await getEcoConfig(heist.guildId);
  const minMembers = config?.heistMinMembers ?? HEIST_DEFAULTS.minMembers;
  const maxMembers = config?.heistMaxMembers ?? HEIST_DEFAULTS.maxMembers;

  const memberLines = heist.members
    .map((m) => `${m.userId === heist.initiatorId ? '👑' : '▸'} <@${m.userId}>`)
    .join('\n');

  const remainingMs = Math.max(0, heist.expiresAt.getTime() - Date.now());

  return new BublikEmbed()
    .setColor(0xe67e22)
    .setTitle(`${EMOJI.HEIST} ${i18n.t('economy.cmd.heist.assemble_title', locale)}`)
    .setDescription(
      `${pickPhrase('economy.cmd.heist.phrase_open', locale, { robber: `<@${heist.initiatorId}>` })}\n\n` +
      `${EMOJI.ARROW_RIGHT} ${i18n.t('economy.cmd.heist.target', locale, { victim: `<@${heist.victimId}>` })}\n` +
      `${EMOJI.ARROW_RIGHT} ${i18n.t('economy.cmd.heist.team_size', locale, { current: heist.members.length, min: minMembers, max: maxMembers })}\n` +
      `${EMOJI.CLOCK} ${i18n.t('economy.cmd.heist.time_left', locale, { time: formatCooldown(remainingMs) })}\n\n` +
      `**${i18n.t('economy.cmd.heist.crew', locale)}**\n${memberLines}`,
    );
}

export function buildAssembleButtons(heistId: string, locale: string, canStart: boolean) {
  const row = new ActionRowBuilder<ButtonBuilder>();
  row.addComponents(
    new ButtonBuilder()
      .setCustomId(heistJoinId(heistId))
      .setStyle(ButtonStyle.Success)
      .setLabel(i18n.t('economy.cmd.heist.btn_join', locale))
      .setEmoji('🤝'),
  );
  if (canStart) {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(heistStartId(heistId))
        .setStyle(ButtonStyle.Primary)
        .setLabel(i18n.t('economy.cmd.heist.btn_start', locale))
        .setEmoji('🚨'),
    );
  }
  row.addComponents(
    new ButtonBuilder()
      .setCustomId(heistCancelId(heistId))
      .setStyle(ButtonStyle.Danger)
      .setLabel(i18n.t('economy.cmd.heist.btn_cancel', locale))
      .setEmoji('❌'),
  );
  return row;
}

async function refreshAssemblePanel(client: Client, heistId: string): Promise<void> {
  const heist = await getHeist(heistId);
  if (!heist || heist.status !== 'assembling') return;
  if (!heist.messageId) return;

  const config = await getEcoConfig(heist.guildId);
  const minMembers = config?.heistMinMembers ?? HEIST_DEFAULTS.minMembers;
  const locale = await getGuildLocale(heist.guildId);

  try {
    const channel = await client.channels.fetch(heist.channelId).catch(() => null);
    if (!channel || !(channel instanceof TextChannel)) return;
    const message = await channel.messages.fetch(heist.messageId).catch(() => null);
    if (!message) return;

    const embed = await buildAssembleEmbed(heistId, locale);
    const row = buildAssembleButtons(heistId, locale, heist.members.length >= minMembers);
    await message.edit({ embeds: [embed], components: [row] });
  } catch (err) {
    log.warn(`refreshAssemblePanel failed for ${heistId}`, { error: String(err) });
  }
}

// ═══════════════════════════════════════════════
//  Обработчики кнопок
// ═══════════════════════════════════════════════

export async function handleJoinButton(interaction: ButtonInteraction, heistId: string): Promise<void> {
  const locale = await getGuildLocale(interaction.guildId);
  const guildId = interaction.guildId!;
  const userId = interaction.user.id;

  const config = await getEcoConfig(guildId);
  if (config?.policeRoleId) {
    const member = interaction.member as GuildMember;
    if (member && member.roles.cache.has(config.policeRoleId)) {
      await interaction.reply({
        embeds: [ecoError('👮 **Полицейский не может участвовать в ограблениях банков!**\nВы на службе закона.')],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
  }

  const heist = await getHeist(heistId);
  if (!heist || heist.status !== 'assembling') {
    await interaction.reply({ embeds: [ecoError(i18n.t('economy.cmd.heist.error_not_assembling', locale))], flags: MessageFlags.Ephemeral });
    return;
  }
  if (heist.expiresAt.getTime() <= Date.now()) {
    await interaction.reply({ embeds: [ecoError(i18n.t('economy.cmd.heist.error_expired', locale))], flags: MessageFlags.Ephemeral });
    return;
  }
  if (userId === heist.victimId) {
    await interaction.reply({ embeds: [ecoError(i18n.t('economy.cmd.heist.error_join_victim', locale))], flags: MessageFlags.Ephemeral });
    return;
  }
  if (interaction.user.bot) return;
  if (heist.members.some((m) => m.userId === userId)) {
    await interaction.reply({ embeds: [ecoError(i18n.t('economy.cmd.heist.error_already_in', locale))], flags: MessageFlags.Ephemeral });
    return;
  }

  // config already fetched at start
  const maxMembers = config?.heistMaxMembers ?? HEIST_DEFAULTS.maxMembers;
  const cdMember = Number(config?.heistCooldownMember ?? HEIST_DEFAULTS.cooldownMember);
  const fineAmount = config?.heistFine ?? HEIST_DEFAULTS.fine;

  if (heist.members.length >= maxMembers) {
    await interaction.reply({ embeds: [ecoError(i18n.t('economy.cmd.heist.error_full', locale, { max: maxMembers }))], flags: MessageFlags.Ephemeral });
    return;
  }

  let result = null;
  const heistLockKey = `economy:heist_lock:${heistId}`;

  for (let attempt = 1; attempt <= 3; attempt++) {
    result = await withFinancialLock(guildId, userId, async () => {
      const r = getRedis();
      const lockToken = randomUUID();
      const lockAcquired = await r.set(heistLockKey, lockToken, 'EX', 10, 'NX');
      if (!lockAcquired) {
        return { type: 'locked_heist' as const };
      }

      try {
        const freshHeist = await getHeist(heistId);
        if (!freshHeist || freshHeist.status !== 'assembling') return { type: 'expired' as const };
        if (freshHeist.expiresAt.getTime() <= Date.now()) return { type: 'expired' as const };
        if (freshHeist.members.some((m) => m.userId === userId)) return { type: 'already' as const };
        if (freshHeist.members.length >= maxMembers) return { type: 'full' as const, max: maxMembers };

        const profile = await getOrCreateProfile(guildId, userId);

        const remaining = checkCooldown(profile.lastHeistMember, cdMember);
        if (remaining > 0) return { type: 'cooldown' as const, remaining };
        if (profile.wallet < fineAmount) return { type: 'poor' as const, fine: fineAmount };

        try {
          const joined = await joinHeistMember(heistId, userId, maxMembers);
          if (joined.type !== 'ok') return joined;
        } catch {
          // Race: уже вступил
          return { type: 'already' as const };
        }
        return { type: 'ok' as const };
      } finally {
        await r.eval(
          `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end`,
          1,
          heistLockKey,
          lockToken,
        );
      }
    });

    if (result === null) {
      // Это означает, что лок на userId был занят
      break;
    }
    if (result.type !== 'locked_heist') {
      break;
    }

    // Если лобби рейда было занято, подождем немного перед ретраем
    await new Promise((resolve) => setTimeout(resolve, 200 + Math.random() * 200));
  }

  if (result === null) {
    await interaction.reply({ embeds: [ecoLocked(locale)], flags: MessageFlags.Ephemeral });
    return;
  }

  switch (result.type) {
    case 'locked_heist':
      await interaction.reply({ embeds: [ecoError(i18n.t('economy.cmd.heist.error_lobby_busy', locale))], flags: MessageFlags.Ephemeral });
      return;
    case 'expired':
      await interaction.reply({ embeds: [ecoError(i18n.t('economy.cmd.heist.error_expired', locale))], flags: MessageFlags.Ephemeral });
      return;
    case 'full':
      await interaction.reply({ embeds: [ecoError(i18n.t('economy.cmd.heist.error_full', locale, { max: maxMembers }))], flags: MessageFlags.Ephemeral });
      return;
    case 'cooldown':
      await interaction.reply({
        embeds: [buildCooldownEmbed(i18n.t('economy.cmd.heist.cooldown_member', locale), result.remaining, locale)],
        flags: MessageFlags.Ephemeral,
      });
      return;
    case 'poor':
      await interaction.reply({
        embeds: [ecoError(i18n.t('economy.cmd.heist.error_poor_member', locale, { fine: fmt(result.fine) }))],
        flags: MessageFlags.Ephemeral,
      });
      return;
    case 'already':
      await interaction.reply({ embeds: [ecoError(i18n.t('economy.cmd.heist.error_already_in', locale))], flags: MessageFlags.Ephemeral });
      return;
    case 'ok': {
      await interaction.reply({
        content: pickPhrase('economy.cmd.heist.phrase_join', locale, { user: `<@${userId}>` }),
        flags: MessageFlags.Ephemeral,
      });
      await refreshAssemblePanel(interaction.client, heistId);

      // Если набрали maxMembers — стартуем сразу
      const fresh = await getHeist(heistId);
      if (fresh && fresh.members.length >= maxMembers) {
        await resolveHeist(interaction.client, heistId).catch((err) =>
          log.error(`resolveHeist auto-start failed (${heistId})`, err),
        );
      }
      return;
    }
  }
}

export async function handleCancelButton(interaction: ButtonInteraction, heistId: string): Promise<void> {
  const locale = await getGuildLocale(interaction.guildId);
  const heist = await getHeist(heistId);
  if (!heist || heist.status !== 'assembling') {
    await interaction.reply({ embeds: [ecoError(i18n.t('economy.cmd.heist.error_not_assembling', locale))], flags: MessageFlags.Ephemeral });
    return;
  }
  if (interaction.user.id !== heist.initiatorId) {
    await interaction.reply({ embeds: [ecoError(i18n.t('economy.cmd.heist.error_not_initiator', locale))], flags: MessageFlags.Ephemeral });
    return;
  }

  const cancelled = await getDatabase().$transaction(async (tx) => {
    const claimed = await tx.economyHeist.updateMany({
      where: { id: heistId, status: 'assembling' },
      data: { status: 'cancelled', resolvedAt: new Date() },
    });
    if (claimed.count !== 1) return false;
    const members = await tx.economyHeistMember.findMany({
      where: { heistId },
      select: { userId: true },
    });
    await releaseHeistMembershipClaims(heist.guildId, heist.id, members.map((member) => member.userId), tx);
    return true;
  });
  if (!cancelled) {
    await interaction.reply({
      embeds: [ecoError(i18n.t('economy.cmd.heist.error_not_assembling', locale))],
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  // Снять lastHeistInit (он не выставлялся при создании, но на всякий — нет)
  await interaction.update({
    embeds: [
      new BublikEmbed()
        .setColor(0x95a5a6)
        .setTitle(`${EMOJI.HEIST} ${i18n.t('economy.cmd.heist.cancelled_title', locale)}`)
        .setDescription(pickPhrase('economy.cmd.heist.phrase_cancel', locale, { robber: `<@${heist.initiatorId}>` })),
    ],
    components: [],
  });
}

export async function handleStartButton(interaction: ButtonInteraction, heistId: string): Promise<void> {
  const locale = await getGuildLocale(interaction.guildId);
  const heist = await getHeist(heistId);
  if (!heist || heist.status !== 'assembling') {
    await interaction.reply({ embeds: [ecoError(i18n.t('economy.cmd.heist.error_not_assembling', locale))], flags: MessageFlags.Ephemeral });
    return;
  }
  if (interaction.user.id !== heist.initiatorId) {
    await interaction.reply({ embeds: [ecoError(i18n.t('economy.cmd.heist.error_not_initiator', locale))], flags: MessageFlags.Ephemeral });
    return;
  }

  const config = await getEcoConfig(heist.guildId);
  const minMembers = config?.heistMinMembers ?? HEIST_DEFAULTS.minMembers;
  if (heist.members.length < minMembers) {
    await interaction.reply({
      embeds: [ecoError(i18n.t('economy.cmd.heist.error_too_few', locale, { current: heist.members.length, min: minMembers }))],
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.deferUpdate();
  await resolveHeist(interaction.client, heistId);
}

// ═══════════════════════════════════════════════
//  Resolution (атомарный куш / штраф)
// ═══════════════════════════════════════════════

async function cancelRunningHeist(heistId: string, guildId: string, memberIds: string[]): Promise<boolean> {
  return getDatabase().$transaction(async (tx) => {
    const cancelled = await tx.economyHeist.updateMany({
      where: { id: heistId, status: 'running' },
      data: { status: 'cancelled', resolvedAt: new Date() },
    });
    if (cancelled.count !== 1) return false;
    await releaseHeistMembershipClaims(guildId, heistId, memberIds, tx);
    return true;
  });
}

export const HEIST_RUN_LEASE_MS = 5 * 60_000;

export function isRecoverableRunningHeist(
  status: string,
  expiresAt: Date,
  nowMs = Date.now(),
): boolean {
  return status === 'running' && expiresAt.getTime() <= nowMs;
}

export async function resolveHeist(client: Client, heistId: string): Promise<void> {
  const db = getDatabase();
  let heist = await getHeist(heistId);
  if (!heist) return;
  if (heist.status !== 'assembling') return;

  const config = await getEcoConfig(heist.guildId);
  if (!config) return;
  const locale = await getGuildLocale(heist.guildId);

  const minMembers = config.heistMinMembers ?? HEIST_DEFAULTS.minMembers;
  const claimed = await db.economyHeist.updateMany({
    where: { id: heistId, status: 'assembling' },
    data: { status: 'running', expiresAt: new Date(Date.now() + HEIST_RUN_LEASE_MS) },
  });
  if (claimed.count === 0) return;
  heist = await getHeist(heistId);
  if (!heist || heist.status !== 'running') return;
  const memberIds = heist.members.map((member) => member.userId);

  const baseChance = config.heistBaseChance ?? HEIST_DEFAULTS.baseChance;
  const chancePerMember = config.heistChancePerMember ?? HEIST_DEFAULTS.chancePerMember;
  const safePenalty = config.heistSafePenalty ?? HEIST_DEFAULTS.safePenalty;
  const minPercent = config.heistMinPercent ?? HEIST_DEFAULTS.minPercent;
  const maxPercent = config.heistMaxPercent ?? HEIST_DEFAULTS.maxPercent;
  const fine = config.heistFine ?? HEIST_DEFAULTS.fine;
  const minVictimBank = config.heistMinVictimBank ?? HEIST_DEFAULTS.minVictimBank;
  const safeMode = (config.safeMode ?? SAFE_DEFAULTS.mode) as 'partial' | 'immune';
  const safePartialFactor = SAFE_DEFAULTS.partialFactor;

  // Недобрали — отмена без штрафа
  if (heist.members.length < minMembers) {
    await cancelRunningHeist(heistId, heist.guildId, memberIds);
    await editHeistMessage(client, heist.channelId, heist.messageId, () =>
      new BublikEmbed()
        .setColor(0x95a5a6)
        .setTitle(`${EMOJI.HEIST} ${i18n.t('economy.cmd.heist.expired_title', locale)}`)
        .setDescription(pickPhrase('economy.cmd.heist.phrase_too_few', locale, { robber: `<@${heist.initiatorId}>` })),
    );
    return;
  }

  // Свежее состояние жертвы
  const victim = await db.economyProfile.findUnique({
    where: { guildId_userId: { guildId: heist.guildId, userId: heist.victimId } },
  });

  if (!victim || victim.bank < minVictimBank) {
    await cancelRunningHeist(heistId, heist.guildId, memberIds);
    await editHeistMessage(client, heist.channelId, heist.messageId, () =>
      new BublikEmbed()
        .setColor(0x95a5a6)
        .setTitle(`${EMOJI.HEIST} ${i18n.t('economy.cmd.heist.cancelled_title', locale)}`)
        .setDescription(pickPhrase('economy.cmd.heist.phrase_target_empty', locale, { victim: `<@${heist.victimId}>` })),
    );
    return;
  }

  // Сейф у жертвы
  const victimHasSafe = isSafeActive(victim);
  if (victimHasSafe && safeMode === 'immune') {
    await cancelRunningHeist(heistId, heist.guildId, memberIds);
    await editHeistMessage(client, heist.channelId, heist.messageId, () =>
      new BublikEmbed()
        .setColor(0x3498db)
        .setTitle(`${EMOJI.SAFE} ${i18n.t('economy.cmd.heist.safe_title', locale)}`)
        .setDescription(pickPhrase('economy.cmd.heist.phrase_target_safe', locale, { victim: `<@${heist.victimId}>` })),
    );
    return;
  }

  // Шанс
  const extraMembers = Math.max(0, heist.members.length - minMembers);
  let chance = baseChance + extraMembers * chancePerMember;
  if (victimHasSafe) chance -= safePenalty;

  // Перки участников: средний robBonus + средний robDefense жертвы
  const memberPerksList = await Promise.all(
    heist.members.map((m) => getUserPerks(heist.guildId, m.userId)),
  );
  const victimPerks = await getUserPerks(heist.guildId, heist.victimId);
  const avgRobBonus = memberPerksList.reduce((s, p) => s + (p.robBonus ?? 0), 0) / Math.max(1, memberPerksList.length);
  chance += Math.round(avgRobBonus);
  chance -= (victimPerks.robDefense ?? 0);

  chance = Math.max(5, Math.min(95, chance));

  const isSuccess = secureChancePercent(chance);
  if (isSuccess) {
    // Event boosts — применяются к добыче и количеству звёзд
    const boosts = await getActiveBoosts(heist.guildId);
    // Куш: процент от банка жертвы
    const stealPercent = minPercent + secureRandomFloat() * (maxPercent - minPercent);
    let stolen = Math.floor((victim.bank * stealPercent) / 100);
    if (victimHasSafe && safeMode === 'partial') {
      stolen = Math.floor(stolen * safePartialFactor);
    }
    stolen = applyRobBoost(stolen, boosts);
    stolen = Math.max(1, Math.min(stolen, victim.bank));

    const sharePerMember = Math.floor(stolen / memberIds.length);
    const remainder = stolen - sharePerMember * memberIds.length;
    const dirtyExpireAt = new Date(Date.now() + Number(config.dirtyExpireMs ?? DIRTY_DEFAULTS.expireMs));
    const wantedEnabled = config.wantedEnabled !== false;
    const wantedStarsPerMember = wantedEnabled ? applyWantedMul(1, boosts) : 0;
    const baseWantedDecayMs = Number(config.wantedDecayMs ?? WANTED_DEFAULTS.decayMs);
    const dirtyShares = memberIds.map((_, index) => {
      if (config.dirtyEnabled === false) return 0;
      const share = sharePerMember + (index === 0 ? remainder : 0);
      return Math.max(0, Math.min(share, Math.floor(share * (memberPerksList[index]?.dirtyMul ?? 1))));
    });

    try {
      await db.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "economy_heists" WHERE "id" = ${heistId} FOR UPDATE`;
        const running = await tx.economyHeist.findUnique({
          where: { id: heistId },
          select: { status: true },
        });
        if (running?.status !== 'running') throw new Error('heist_not_running');

        const freshVictim = await tx.economyProfile.findUnique({
          where: { guildId_userId: { guildId: heist.guildId, userId: heist.victimId } },
        });
        if (!freshVictim || freshVictim.bank < stolen) throw new Error('insufficient_bank');

        const updatedVictim = await tx.economyProfile.update({
          where: { guildId_userId: { guildId: heist.guildId, userId: heist.victimId } },
          data: {
            bank: { decrement: stolen },
            totalSpent: { increment: BigInt(stolen) },
          },
        });
        if (updatedVictim.bank < 0) throw new Error('insufficient_bank');

        await tx.economyTransaction.create({
          data: {
            guildId: heist.guildId,
            userId: heist.victimId,
            type: TX.HEIST_VICTIM,
            amount: -stolen,
            balance: updatedVictim.bank,
            profileId: freshVictim.id,
            targetId: heist.initiatorId,
            details: `Heist by ${memberIds.join(', ')}`,
          },
        });

        for (let i = 0; i < memberIds.length; i++) {
          const uid = memberIds[i];
          const share = sharePerMember + (i === 0 ? remainder : 0);
          const dirtyShare = dirtyShares[i];
          const memberProfile = await tx.economyProfile.upsert({
            where: { guildId_userId: { guildId: heist.guildId, userId: uid } },
            create: { guildId: heist.guildId, userId: uid },
            update: {},
          });
          const wantedDecayMs = Math.max(
            60_000,
            Math.floor(baseWantedDecayMs * (memberPerksList[i]?.wantedDecayMul ?? 1)),
          );
          const updated = await tx.economyProfile.update({
            where: { guildId_userId: { guildId: heist.guildId, userId: uid } },
            data: {
              wallet: { increment: share },
              totalEarned: { increment: BigInt(share) },
              dirtyAmount: dirtyShare > 0 ? { increment: dirtyShare } : undefined,
              dirtyClearAt: dirtyShare > 0 ? dirtyExpireAt : undefined,
              wantedStars: wantedEnabled ? { increment: wantedStarsPerMember } : undefined,
              wantedNextDecay: wantedEnabled && !memberProfile.wantedNextDecay
                ? new Date(Date.now() + wantedDecayMs)
                : undefined,
              lastHeistInit: uid === heist.initiatorId ? new Date() : undefined,
              lastHeistMember: uid !== heist.initiatorId ? new Date() : undefined,
            },
          });
          await tx.economyTransaction.create({
            data: {
              guildId: heist.guildId,
              userId: uid,
              type: TX.HEIST_SUCCESS,
              amount: share,
              balance: updated.wallet,
              profileId: memberProfile.id,
              targetId: heist.victimId,
              details: `Heist share (${heist.members.length} ppl)`,
            },
          });
          await tx.economyHeistMember.update({
            where: { heistId_userId: { heistId, userId: uid } },
            data: { payout: share },
          });
        }

        await tx.economyHeist.update({
          where: { id: heistId },
          data: { status: 'success', resolvedAt: new Date(), stolenAmount: stolen },
        });
        await releaseHeistMembershipClaims(heist.guildId, heist.id, memberIds, tx);
      });
    } catch (err: any) {
      if (err?.message === 'heist_not_running') return;
      log.error(`Heist ${heistId} TX failed`, err);
      await db.$transaction(async (tx) => {
        const failed = await tx.economyHeist.updateMany({
          where: { id: heistId, status: 'running' },
          data: { status: 'fail', resolvedAt: new Date() },
        });
        if (failed.count === 1) await releaseHeistMembershipClaims(heist.guildId, heist.id, memberIds, tx);
      });
      return;
    }

    // Инвалидация кэша всех затронутых
    await invalidateProfileCache(heist.guildId, heist.victimId);
    for (const uid of memberIds) await invalidateProfileCache(heist.guildId, uid);

    // Грязные деньги: помечаем каждую долю как dirty (с учётом перка dirtyMul)
    // Сообщение об успехе
    const phraseKey =
      heist.members.length === 2 ? 'economy.cmd.heist.phrase_success_2'
      : heist.members.length === 3 ? 'economy.cmd.heist.phrase_success_3'
      : 'economy.cmd.heist.phrase_success_4';

    const membersList = memberIds.map((id) => `<@${id}>`).join(', ');
    await editHeistMessage(client, heist.channelId, heist.messageId, () =>
      new BublikEmbed()
        .setColor(0x2ecc71)
        .setTitle(`${EMOJI.HEIST} ${i18n.t('economy.cmd.heist.success_title', locale)}`)
        .setDescription(
          `${pickPhrase(phraseKey, locale, { members: membersList, amount: fmt(stolen) })}\n\n` +
          `${EMOJI.SHEKEL} ${i18n.t('economy.cmd.heist.share', locale, { amount: fmt(sharePerMember) })}\n` +
          `${EMOJI.WANTED} ${i18n.t('economy.cmd.heist.wanted_added', locale)}`,
        ),
    );

    await newsHeistSuccess(client, heist.guildId, memberIds, heist.victimId, stolen, locale).catch(() => {});
  } else {
    // Провал: штраф каждому
    try {
      await db.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "economy_heists" WHERE "id" = ${heistId} FOR UPDATE`;
        const running = await tx.economyHeist.findUnique({
          where: { id: heistId },
          select: { status: true },
        });
        if (running?.status !== 'running') throw new Error('heist_not_running');

        for (const uid of memberIds) {
          const memberProfile = await tx.economyProfile.upsert({
            where: { guildId_userId: { guildId: heist.guildId, userId: uid } },
            create: { guildId: heist.guildId, userId: uid },
            update: {},
          });
          const actualFine = Math.min(fine, memberProfile.wallet);
          const updated = await tx.economyProfile.update({
            where: { guildId_userId: { guildId: heist.guildId, userId: uid } },
            data: {
              wallet: { decrement: actualFine },
              dirtyAmount: Math.min(memberProfile.dirtyAmount, Math.max(0, memberProfile.wallet - actualFine)),
              totalSpent: actualFine > 0 ? { increment: BigInt(actualFine) } : undefined,
              lastHeistInit: uid === heist.initiatorId ? new Date() : undefined,
              lastHeistMember: uid !== heist.initiatorId ? new Date() : undefined,
            },
          });
          if (updated.wallet < 0) throw new Error('insufficient_wallet');
          if (actualFine > 0) {
            await tx.economyTransaction.create({
              data: {
                guildId: heist.guildId,
                userId: uid,
                type: TX.HEIST_FINE,
                amount: -actualFine,
                balance: updated.wallet,
                profileId: memberProfile.id,
                targetId: heist.victimId,
                details: `Heist fail`,
              },
            });
          }
          await tx.economyHeistMember.update({
            where: { heistId_userId: { heistId, userId: uid } },
            data: { payout: -actualFine },
          });
        }

        await tx.economyHeist.update({
          where: { id: heistId },
          data: { status: 'fail', resolvedAt: new Date() },
        });
        await releaseHeistMembershipClaims(heist.guildId, heist.id, memberIds, tx);
      });
    } catch (err: any) {
      if (err?.message === 'heist_not_running') return;
      log.error(`Heist ${heistId} fail TX failed`, err);
      await db.$transaction(async (tx) => {
        const failed = await tx.economyHeist.updateMany({
          where: { id: heistId, status: 'running' },
          data: { status: 'fail', resolvedAt: new Date() },
        });
        if (failed.count === 1) await releaseHeistMembershipClaims(heist.guildId, heist.id, memberIds, tx);
      });
    }

    for (const uid of memberIds) await invalidateProfileCache(heist.guildId, uid);

    const membersList = memberIds.map((id) => `<@${id}>`).join(', ');
    await editHeistMessage(client, heist.channelId, heist.messageId, () =>
      new BublikEmbed()
        .setColor(0xe74c3c)
        .setTitle(`${EMOJI.HEIST} ${i18n.t('economy.cmd.heist.fail_title', locale)}`)
        .setDescription(
          `${pickPhrase('economy.cmd.heist.phrase_fail', locale, { members: membersList, amount: fmt(fine) })}`,
        ),
    );
  }
}

async function editHeistMessage(
  client: Client,
  channelId: string,
  messageId: string | null,
  build: () => BublikEmbed,
): Promise<void> {
  if (!messageId) return;
  try {
    const channel = await client.channels.fetch(channelId).catch(() => null);
    if (!channel || !(channel instanceof TextChannel)) return;
    const msg = await channel.messages.fetch(messageId).catch(() => null);
    if (!msg) return;
    await msg.edit({ embeds: [build()], components: [] });
  } catch (err) {
    log.warn(`editHeistMessage failed`, { error: String(err) });
  }
}

// ═══════════════════════════════════════════════
//  Scheduler — собирает зависшие assemble’ы
// ═══════════════════════════════════════════════

export async function recoverStaleRunningHeists(client: Client): Promise<number> {
  const db = getDatabase();
  const now = new Date();
  const stale = await db.economyHeist.findMany({
    where: { status: 'running', expiresAt: { lte: now } },
    include: { members: { select: { userId: true } } },
    orderBy: { expiresAt: 'asc' },
    take: 100,
  });

  let recovered = 0;
  for (const candidate of stale) {
    if (!isGuildAllowed(candidate.guildId)) continue;
    try {
      const cancelled = await db.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "economy_heists" WHERE "id" = ${candidate.id} FOR UPDATE`;
        const fresh = await tx.economyHeist.findUnique({
          where: { id: candidate.id },
          include: { members: { select: { userId: true } } },
        });
        if (!fresh || fresh.status !== 'running' || fresh.expiresAt > now) return null;
        const changed = await tx.economyHeist.updateMany({
          where: { id: fresh.id, status: 'running', expiresAt: { lte: now } },
          data: { status: 'cancelled', resolvedAt: now },
        });
        if (changed.count !== 1) return null;
        const memberIds = fresh.members.map((member) => member.userId);
        await releaseHeistMembershipClaims(fresh.guildId, fresh.id, memberIds, tx);
        return fresh;
      });
      if (!cancelled) continue;
      recovered++;
      await editHeistMessage(client, cancelled.channelId, cancelled.messageId, () =>
        new BublikEmbed()
          .setColor(0x95a5a6)
          .setTitle('🏦 Ограбление отменено')
          .setDescription('Процесс выполнения был прерван. Средства не изменены, участники освобождены.'),
      );
      log.warn(`Recovered stale running heist ${cancelled.id} by cancelling it`);
    } catch (error) {
      log.error(`Failed to recover stale running heist ${candidate.id}; it will be retried`, error);
    }
  }
  return recovered;
}

const SCHED_TASK = 'economy:heistResolve';
const SCHED_INTERVAL = 30_000; // 30 секунд

export function startHeistScheduler(client: BublikClient): void {
  scheduleTask(SCHED_TASK, SCHED_INTERVAL, async () => {
    await recoverStaleRunningHeists(client);
    const expired = await getExpiredAssemblingHeists();
    for (const h of expired) {
      if (!isGuildAllowed(h.guildId)) continue;
      try {
        await resolveHeist(client, h.id);
      } catch (err) {
        log.error(`scheduler resolveHeist(${h.id})`, err);
      }
    }
  }, { exclusive: true, immediate: true });
  log.info(`Heist scheduler запущен (каждые ${SCHED_INTERVAL / 1000}с)`);
}

export function stopHeistScheduler(): void {
  unscheduleTask(SCHED_TASK);
}

// Утилита для /heist — отправить панель и записать messageId
export async function postHeistPanelAndStore(
  client: Client,
  channel: TextChannel,
  heistId: string,
  locale: string,
): Promise<void> {
  const heist = await getHeist(heistId);
  if (!heist) return;
  const config = await getEcoConfig(heist.guildId);
  const minMembers = config?.heistMinMembers ?? HEIST_DEFAULTS.minMembers;

  const embed = await buildAssembleEmbed(heistId, locale);
  const row = buildAssembleButtons(heistId, locale, heist.members.length >= minMembers);

  const msg = await channel.send({
    content: `<@${heist.victimId}> 🏦`,
    embeds: [embed],
    components: [row],
  });
  await setHeistMessage(heistId, msg.id);
}
