// ═══════════════════════════════════════════════
//  RegBattle — Embeds и компоненты
// ═══════════════════════════════════════════════

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  GuildMember,
  StringSelectMenuBuilder,
  UserSelectMenuBuilder,
} from 'discord.js';
import { BublikEmbed } from '../../core/EmbedBuilder';
import { i18n } from '../../core/I18n';
import {
  FULL_SUGGEST_INTERVAL_MS,
  INDIVIDUAL_PING_INTERVAL_MS,
  RB_PREFIX,
  RB_SEP,
  ROLE_PING_INTERVAL_MS,
} from './constants';
import type { PbPingerDisplayStatus } from './pingerDisplayStatus';

// ═══════════════════════════════════════════════
//  Панель управления отрядом
// ═══════════════════════════════════════════════

export function buildControlPanelEmbed(
  squadNumber: number,
  ownerTag: string,
  memberCount: number,
  squadSize: number,
  hasAir: boolean,
  locale: string,
): BublikEmbed {
  return new BublikEmbed()
    .setTitle(i18n.t('regbattle.panel_title', locale, { n: squadNumber }))
    .setDescription(
      `${i18n.t('regbattle.panel_commander', locale, { tag: ownerTag })}\n` +
      `${i18n.t('regbattle.panel_members', locale, { count: memberCount, size: squadSize })}${hasAir ? ` ${i18n.t('regbattle.panel_with_air', locale)}` : ''}\n\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
      `${i18n.t('regbattle.panel_desc_orders', locale)}\n\n` +
      `${i18n.t('regbattle.panel_desc_kick', locale)}\n\n` +
      `${i18n.t('regbattle.panel_desc_mute', locale)}\n\n` +
      `${i18n.t('regbattle.panel_desc_dmping', locale)}\n\n` +
      `${i18n.t('regbattle.panel_desc_aviation', locale)}\n\n` +
      `${i18n.t('regbattle.panel_desc_transfer', locale)}\n\n` +
      `${i18n.t('regbattle.panel_desc_reprimand', locale)}\n\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
    )
    .setColor(0x2b5e2b);
}

export function buildControlPanelButtons(
  squadId: string,
  hasAir: boolean,
  locale: string,
  notificationsEnabled: boolean = true,
): ActionRowBuilder<ButtonBuilder>[] {
  const row1 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`${RB_PREFIX}${RB_SEP}orders${RB_SEP}${squadId}`)
      .setLabel(i18n.t('regbattle.btn_orders', locale))
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId(`${RB_PREFIX}${RB_SEP}kick${RB_SEP}${squadId}`)
      .setLabel(i18n.t('regbattle.btn_kick', locale))
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`${RB_PREFIX}${RB_SEP}mutetoggle${RB_SEP}${squadId}`)
      .setLabel(i18n.t('regbattle.btn_mute', locale))
      .setStyle(ButtonStyle.Secondary),
  );

  const row2 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`${RB_PREFIX}${RB_SEP}dmping${RB_SEP}${squadId}`)
      .setLabel(i18n.t('regbattle.btn_dmping', locale))
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`${RB_PREFIX}${RB_SEP}aviation${RB_SEP}${squadId}`)
      .setLabel(i18n.t('regbattle.btn_aviation', locale))
      .setStyle(ButtonStyle.Success)
      .setDisabled(hasAir),
  );

  const row3 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`${RB_PREFIX}${RB_SEP}transfer${RB_SEP}${squadId}`)
      .setLabel(i18n.t('regbattle.btn_transfer', locale))
      .setStyle(ButtonStyle.Secondary),
  );

  const row4 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`${RB_PREFIX}${RB_SEP}reprimand${RB_SEP}${squadId}`)
      .setLabel(i18n.t('regbattle.btn_reprimand', locale))
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId(`${RB_PREFIX}${RB_SEP}notifytoggle${RB_SEP}${squadId}`)
      .setLabel(notificationsEnabled ? i18n.t('regbattle.btn_notify_on', locale) : i18n.t('regbattle.btn_notify_off', locale))
      .setStyle(notificationsEnabled ? ButtonStyle.Success : ButtonStyle.Secondary),
  );

  return [row1, row2, row3, row4];
}

// ═══════════════════════════════════════════════
//  Селекторы (кик, передача прав)
// ═══════════════════════════════════════════════

export function buildKickSelect(
  squadId: string,
  members: { id: string; displayName: string }[],
  locale: string,
): ActionRowBuilder<StringSelectMenuBuilder> {
  const select = new StringSelectMenuBuilder()
    .setCustomId(`${RB_PREFIX}${RB_SEP}sel${RB_SEP}kick${RB_SEP}${squadId}`)
    .setPlaceholder(i18n.t('regbattle.select_kick_placeholder', locale))
    .setMinValues(1)
    .setMaxValues(1)
    .addOptions(
      members.map((m) => ({
        label: m.displayName.slice(0, 100),
        value: m.id,
      })),
    );

  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);
}

export function buildTransferSelect(
  squadId: string,
  members: { id: string; displayName: string }[],
  locale: string,
): ActionRowBuilder<StringSelectMenuBuilder> {
  const select = new StringSelectMenuBuilder()
    .setCustomId(`${RB_PREFIX}${RB_SEP}sel${RB_SEP}transfer${RB_SEP}${squadId}`)
    .setPlaceholder(i18n.t('regbattle.select_transfer_placeholder', locale))
    .setMinValues(1)
    .setMaxValues(1)
    .addOptions(
      members.map((m) => ({
        label: m.displayName.slice(0, 100),
        value: m.id,
      })),
    );

  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);
}

/**
 * Селектор мьюта — показывает участников с текущим статусом мьюта.
 * Выбор тогглит состояние.
 */
export function buildMuteToggleSelect(
  squadId: string,
  members: { id: string; displayName: string; muted: boolean }[],
  locale: string,
): ActionRowBuilder<StringSelectMenuBuilder> {
  const select = new StringSelectMenuBuilder()
    .setCustomId(`${RB_PREFIX}${RB_SEP}sel${RB_SEP}mutetoggle${RB_SEP}${squadId}`)
    .setPlaceholder(i18n.t('regbattle.select_mute_placeholder', locale))
    .setMinValues(1)
    .setMaxValues(1)
    .addOptions(
      members.map((m) => ({
        label: `${m.muted ? '🔇' : '🔊'} ${m.displayName}`.slice(0, 100),
        description: m.muted ? i18n.t('regbattle.select_mute_desc_muted', locale) : i18n.t('regbattle.select_mute_desc_unmuted', locale),
        value: m.id,
      })),
    );

  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);
}

/**
 * UserSelect для выбора нарушителя (выговор)
 */
export function buildReprimandUserSelect(
  squadId: string,
  locale: string,
): ActionRowBuilder<UserSelectMenuBuilder> {
  const select = new UserSelectMenuBuilder()
    .setCustomId(`${RB_PREFIX}${RB_SEP}sel${RB_SEP}rep_user${RB_SEP}${squadId}`)
    .setPlaceholder(i18n.t('regbattle.select_reprimand_user_placeholder', locale))
    .setMinValues(1)
    .setMaxValues(1);

  return new ActionRowBuilder<UserSelectMenuBuilder>().addComponents(select);
}

/**
 * Селектор типа выговора (роли)
 */
export function buildReprimandTypeSelect(
  squadId: string,
  offenderId: string,
  types: { roleId: string; roleName: string }[],
  locale: string,
): ActionRowBuilder<StringSelectMenuBuilder> {
  const select = new StringSelectMenuBuilder()
    .setCustomId(`${RB_PREFIX}${RB_SEP}sel${RB_SEP}rep_type${RB_SEP}${squadId}${RB_SEP}${offenderId}`)
    .setPlaceholder(i18n.t('regbattle.select_reprimand_type_placeholder', locale))
    .setMinValues(1)
    .setMaxValues(1)
    .addOptions(
      types.map((t) => ({
        label: t.roleName.slice(0, 100),
        value: t.roleId,
      })),
    );

  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);
}

// ═══════════════════════════════════════════════
//  Объявления (пинг-канал)
// ═══════════════════════════════════════════════

export function buildSquadCreatedEmbed(
  squadNumber: number,
  commander: GuildMember,
  voiceChannelId: string,
  locale: string,
): BublikEmbed {
  return new BublikEmbed()
    .setTitle(i18n.t('regbattle.squad_created_title', locale, { n: squadNumber }))
    .setDescription(
      i18n.t('regbattle.squad_created_desc', locale, { n: squadNumber, commander: commander.toString(), channel: `<#${voiceChannelId}>` }),
    )
    .setColor(0xff6600)
    .setThumbnail(commander.displayAvatarURL({ size: 128 }));
}

export function buildRecruitPingEmbed(
  squads: { number: number; count: number; size: number; voiceChannelId: string; ownerTag: string }[],
  locale: string,
): BublikEmbed {
  const lines = squads.map((s) => {
    const status = s.count >= s.size ? '✅' : '⚠️';
    return i18n.t('regbattle.recruit_ping_line', locale, { status, n: s.number, count: s.count, size: s.size, owner: s.ownerTag, channel: `<#${s.voiceChannelId}>` });
  });

  const unfilled = squads.filter((s) => s.count < s.size);
  const needed = unfilled.reduce((sum, s) => sum + (s.size - s.count), 0);

  return new BublikEmbed()
    .setTitle(i18n.t('regbattle.recruit_ping_title', locale))
    .setDescription(
      lines.join('\n') + '\n\n' +
      i18n.t('regbattle.recruit_ping_needed', locale, { count: needed }),
    )
    .setColor(0xff9900);
}

export function buildFullSuggestEmbed(
  reserveChannelId: string,
  locale: string,
): BublikEmbed {
  return new BublikEmbed()
    .setTitle(i18n.t('regbattle.full_suggest_title', locale))
    .setDescription(
      i18n.t('regbattle.full_suggest_desc', locale, { channel: `<#${reserveChannelId}>` }),
    )
    .setColor(0x57f287);
}

export function buildIndividualPingMessage(
  member: GuildMember,
  squads: { number: number; count: number; size: number; voiceChannelId: string }[],
  locale: string,
): string {
  const unfilled = squads.filter((s) => s.count < s.size);
  if (unfilled.length === 0) return '';

  const targets = unfilled
    .map((s) => i18n.t('regbattle.individual_ping_squad', locale, { n: s.number, count: s.count, size: s.size, channel: `<#${s.voiceChannelId}>` }))
    .join(', ');

  return i18n.t('regbattle.individual_ping_msg', locale, { member: member.toString(), targets });
}

// ═══════════════════════════════════════════════
//  DM-пинг
// ═══════════════════════════════════════════════

export function buildDmPingEmbed(
  squadNumber: number,
  commanderName: string,
  voiceChannelId: string,
  guildName: string,
  customMessage: string,
  locale: string,
): BublikEmbed {
  return new BublikEmbed()
    .setTitle(i18n.t('regbattle.dmping_embed_title', locale))
    .setDescription(customMessage)
    .setColor(0xff6600);
}

export function buildDmPingPreview(
  targetCount: number,
  isCustom: boolean,
  messageText: string,
  locale: string,
): BublikEmbed {
  const typeLabel = isCustom
    ? i18n.t('regbattle.dmping_preview_custom', locale)
    : i18n.t('regbattle.dmping_preview_standard', locale);

  const preview = messageText.length > 500
    ? messageText.slice(0, 497) + '…'
    : messageText;

  return new BublikEmbed()
    .setTitle(i18n.t('regbattle.dmping_preview_title', locale))
    .setDescription(
      `${i18n.t('regbattle.dmping_preview_recipients', locale, { count: targetCount })}\n` +
      `${i18n.t('regbattle.dmping_preview_type', locale, { type: typeLabel })}\n\n` +
      `>>> ${preview}`,
    )
    .setColor(0x5865f2);
}

export function buildDmPingProgress(
  sent: number,
  total: number,
  locale: string,
): BublikEmbed {
  const pct = Math.round((sent / total) * 100);
  const bar = '█'.repeat(Math.round(pct / 5)) + '░'.repeat(20 - Math.round(pct / 5));

  return new BublikEmbed()
    .setTitle(i18n.t('regbattle.dmping_progress_title', locale))
    .setDescription(
      `${bar} **${pct}%**\n` +
      i18n.t('regbattle.dmping_progress_desc', locale, { sent, total }),
    )
    .setColor(0xfee75c);
}

export function buildDmPingReport(
  delivered: string[],
  failed: string[],
  locale: string,
): BublikEmbed {
  const lines: string[] = [];

  if (delivered.length > 0) {
    lines.push(i18n.t('regbattle.dmping_delivered', locale, { count: delivered.length }));
    lines.push(delivered.map((tag) => `> ${tag}`).join('\n'));
  }

  if (failed.length > 0) {
    if (lines.length > 0) lines.push('');
    lines.push(i18n.t('regbattle.dmping_failed', locale, { count: failed.length }));
    lines.push(failed.map((tag) => `> ${tag} ${i18n.t('regbattle.dmping_dm_closed', locale)}`).join('\n'));
  }

  let description = lines.join('\n');
  if (description.length > 4000) {
    description = description.slice(0, 3950) + `\n\n${i18n.t('regbattle.dmping_truncated', locale)}`;
  }

  return new BublikEmbed()
    .setTitle(i18n.t('regbattle.dmping_report_title', locale))
    .setDescription(description || i18n.t('regbattle.dmping_no_recipients', locale))
    .setColor(failed.length === 0 ? 0x57f287 : 0xfee75c);
}

// ═══════════════════════════════════════════════
//  Распоряжения (мьют)
// ═══════════════════════════════════════════════

export function buildOrdersActiveEmbed(secondsLeft: number, locale: string): BublikEmbed {
  return new BublikEmbed()
    .setTitle(i18n.t('regbattle.orders_active_embed_title', locale))
    .setDescription(
      i18n.t('regbattle.orders_active_embed_desc', locale, { seconds: secondsLeft }),
    )
    .setColor(0xed4245);
}

export function buildOrdersEndedEmbed(locale: string): BublikEmbed {
  return new BublikEmbed()
    .setDescription(i18n.t('regbattle.orders_ended', locale))
    .setColor(0x57f287);
}

// ═══════════════════════════════════════════════
//  Хелперы
// ═══════════════════════════════════════════════

export function rbSuccess(text: string, _locale: string): BublikEmbed {
  return new BublikEmbed().setDescription(`✅ ${text}`).setColor(0x57f287);
}

export function rbError(text: string, _locale: string): BublikEmbed {
  return new BublikEmbed().setDescription(`❌ ${text}`).setColor(0xed4245);
}

export function rbWarn(text: string, _locale: string): BublikEmbed {
  return new BublikEmbed().setDescription(`⚠️ ${text}`).setColor(0xfee75c);
}

export function rbInfo(text: string, _locale: string): BublikEmbed {
  return new BublikEmbed().setDescription(`ℹ️ ${text}`).setColor(0x5865f2);
}

// ═══════════════════════════════════════════════
//  Лог расформирования
// ═══════════════════════════════════════════════

export function buildSquadDisbandedEmbed(squadNumber: number, locale: string): BublikEmbed {
  return new BublikEmbed()
    .setTitle(i18n.t('regbattle.squad_disbanded_title', locale, { n: squadNumber }))
    .setDescription(i18n.t('regbattle.squad_disbanded_desc', locale))
    .setColor(0x99aab5);
}

// ═══════════════════════════════════════════════
//  Статус-панель рекрутинга (persistent в announce-канале)
// ═══════════════════════════════════════════════

export interface StatusPanelSquad {
  number: number;
  count: number;
  size: number;
  voiceChannelId: string;
  ownerTag: string;
  members: { id: string; displayName: string }[];
  notifyOff: boolean;
}

export interface StatusPanelAbsentee {
  id: string;
  displayName: string;
  minutesIgnoring: number;
  redZone: boolean;
  online: boolean;
}

const DISCORD_EMBED_FIELD_VALUE_LIMIT = 1_024;
const DISCORD_EMBED_TOTAL_TEXT_LIMIT = 6_000;
const DISCORD_EMBED_FIELD_COUNT_LIMIT = 25;

interface StatusPanelField {
  name: string;
  value: string;
}

function chunkStatusPanelLines(lines: readonly string[]): string[] {
  const chunks: string[] = [];
  let current = '';
  for (const rawLine of lines) {
    const line = rawLine.length <= DISCORD_EMBED_FIELD_VALUE_LIMIT
      ? rawLine
      : `${rawLine.slice(0, DISCORD_EMBED_FIELD_VALUE_LIMIT - 1)}…`;
    const candidate = current ? `${current}\n\n${line}` : line;
    if (candidate.length > DISCORD_EMBED_FIELD_VALUE_LIMIT) {
      if (current) chunks.push(current);
      current = line;
    } else {
      current = candidate;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

function embedTextLength(embed: BublikEmbed): number {
  const data = embed.toJSON();
  return (data.title?.length ?? 0) +
    (data.description?.length ?? 0) +
    (data.author?.name.length ?? 0) +
    (data.footer?.text.length ?? 0) +
    (data.fields ?? []).reduce(
      (sum, field) => sum + field.name.length + field.value.length,
      0,
    );
}

function moreSquadsKey(count: number, locale: string): string {
  if (!locale.toLowerCase().startsWith('ru')) {
    return count === 1
      ? 'regbattle.status_more_squads_one'
      : 'regbattle.status_more_squads_many';
  }

  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return 'regbattle.status_more_squads_one';
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) {
    return 'regbattle.status_more_squads_few';
  }
  return 'regbattle.status_more_squads_many';
}

function buildStatusPanelSquadFields(
  squadLines: readonly string[],
  fieldName: string,
  locale: string,
  maxFields: number,
  textBudget: number,
): StatusPanelField[] {
  if (maxFields <= 0 || textBudget <= 0) return [];

  // Prefer complete squad blocks. If the installation has more squads than a
  // single Discord embed can represent, keep the panel valid and show exactly
  // how many additional squads were collapsed.
  for (let visibleCount = squadLines.length; visibleCount >= 0; visibleCount--) {
    const hiddenCount = squadLines.length - visibleCount;
    const visibleLines = squadLines.slice(0, visibleCount);
    if (hiddenCount > 0) {
      visibleLines.push(
        `*${i18n.t(moreSquadsKey(hiddenCount, locale), locale, { count: hiddenCount })}*`,
      );
    }

    const chunks = chunkStatusPanelLines(visibleLines);
    if (chunks.length > maxFields) continue;
    const fields = chunks.map((value, index) => ({
      name: index === 0 ? fieldName : `${fieldName} · ${index + 1}`,
      value,
    }));
    const usedText = fields.reduce(
      (sum, field) => sum + field.name.length + field.value.length,
      0,
    );
    if (usedText <= textBudget) return fields;
  }

  return [];
}

function formatPositiveCount(value: number): number {
  return Number.isSafeInteger(value) && value > 0 ? value : 0;
}

function buildPingerExclusionSummary(
  status: PbPingerDisplayStatus,
  locale: string,
  translationKey = 'regbattle.status_exclusions',
): string | null {
  const parts: string[] = [];
  const exclusions = status.exclusions;
  const entries = [
    ['vacation', exclusions.vacation],
    ['played', exclusions.played],
    ['in_pb', exclusions.inPb],
    ['bot', exclusions.bot],
  ] as const;

  for (const [reason, rawCount] of entries) {
    const count = formatPositiveCount(rawCount);
    if (count > 0) {
      parts.push(i18n.t(`regbattle.status_exclusion_${reason}`, locale, { count }));
    }
  }

  return parts.length > 0
    ? i18n.t(translationKey, locale, { items: parts.join(', ') })
    : null;
}

function buildPingerStatusText(
  status: PbPingerDisplayStatus,
  locale: string,
): string {
  const roleMinutes = Math.max(1, Math.round(ROLE_PING_INTERVAL_MS / 60_000));
  const individualSeconds = Math.max(1, Math.round(INDIVIDUAL_PING_INTERVAL_MS / 1_000));
  const reserveMinutes = Math.max(1, Math.round(FULL_SUGGEST_INTERVAL_MS / 60_000));
  let primary: string;

  switch (status.mode) {
    case 'disabled':
      primary = i18n.t('regbattle.status_mode_disabled', locale);
      break;
    case 'role_mass':
      primary = i18n.t('regbattle.status_mode_role_mass', locale, { minutes: roleMinutes });
      break;
    case 'individual_safe':
      primary = status.reason === 'no_progress'
        ? i18n.t('regbattle.status_mode_individual_no_progress', locale, {
          count: status.noProgressCount,
          seconds: individualSeconds,
        })
        : i18n.t('regbattle.status_mode_individual_safe', locale, {
          count: status.eligibleIndividualCount,
          seconds: individualSeconds,
        });
      break;
    case 'cooldown':
      primary = i18n.t('regbattle.status_mode_cooldown', locale);
      break;
    case 'full_role':
      primary = i18n.t('regbattle.status_mode_full_role', locale, { minutes: reserveMinutes });
      break;
    case 'full_channel_only':
      primary = i18n.t('regbattle.status_mode_full_channel_only', locale);
      break;
    case 'no_targets':
      primary = i18n.t('regbattle.status_mode_no_targets', locale);
      break;
    case 'unavailable': {
      let reasonKey = 'checking';
      if (status.reason === 'ping_role_not_configured') reasonKey = 'ping_role_not_configured';
      else if (status.reason === 'ping_role_missing') reasonKey = 'ping_role_missing';
      else if (status.reason === 'reserve_channel_not_configured') {
        reasonKey = 'reserve_channel_not_configured';
      }
      primary = i18n.t(`regbattle.status_mode_${reasonKey}`, locale);
      break;
    }
  }

  const details: string[] = [primary];
  if (status.reason === 'mention_permission_missing') {
    details.push(i18n.t('regbattle.status_reason_mention_permission', locale));
  }
  if (status.reason === 'unsafe_population' || status.reason === 'no_eligible_targets') {
    const exclusions = buildPingerExclusionSummary(
      status,
      locale,
      status.reason === 'no_eligible_targets'
        ? 'regbattle.status_no_target_exclusions'
        : 'regbattle.status_exclusions',
    );
    if (exclusions) details.push(exclusions);
  }
  return details
    .flatMap((line) => line.split('\n'))
    .map((line) => `> ${line}`)
    .join('\n');
}

export function buildStatusPanelEmbed(
  squads: StatusPanelSquad[],
  onlineIgnoring: StatusPanelAbsentee[],
  playedToday: { id: string; displayName: string }[],
  offlineAbsent: { id: string; displayName: string }[],
  locale: string,
  pingerStatus: PbPingerDisplayStatus,
  onlineKosher = 0,
  totalKosher = 0,
): { embed: BublikEmbed; row: ActionRowBuilder<ButtonBuilder> } {
  const embed = new BublikEmbed()
    .setTitle(`⚔️ ${i18n.t('regbattle.status_panel_title', locale)}`)
    .setColor(0xff6600)
    .setTimestamp();

  // ── Онлайн кошерных ──
  if (totalKosher > 0) {
    embed.setDescription(
      `🟢 ${i18n.t('regbattle.status_online_kosher', locale, { online: onlineKosher, total: totalKosher })}`,
    );
  }

  // ── Отряды (скрыть пустые — они расформировываются) ──
  const activeSquads = squads.filter((s) => s.count > 0);
  const squadLines: string[] = [];
  for (const sq of activeSquads) {
    const bar = buildProgressBar(sq.count, sq.size);
    const notify = sq.notifyOff ? ' 🔕' : '';
    const memberList = sq.members.map((m) => m.displayName).join(', ');
    squadLines.push(
      `**${i18n.t('regbattle.status_squad_header', locale, { n: sq.number, status: `${sq.count}/${sq.size}`, owner: sq.ownerTag })}**${notify}\n` +
      `${bar}  <#${sq.voiceChannelId}>\n` +
      `👤 ${memberList}`,
    );
  }

  // Итого и прозрачный режим уведомлений
  const notificationSquads = squads.filter((squad) => !squad.notifyOff);
  const totalNeeded = notificationSquads.reduce(
    (sum, squad) => sum + Math.max(0, squad.size - squad.count),
    0,
  );
  const capacity = notificationSquads.length === 0
    ? i18n.t('regbattle.status_capacity_disabled', locale)
    : totalNeeded > 0
      ? i18n.t('regbattle.status_capacity_needed', locale, { count: totalNeeded })
      : i18n.t('regbattle.status_capacity_full', locale);
  const notificationField: StatusPanelField = {
    name: `🔔 ${i18n.t('regbattle.status_notifications_field', locale)}`,
    value: `${buildPingerStatusText(pingerStatus, locale)}\n\n${capacity}`,
  };

  if (squadLines.length > 0) {
    const existingFieldCount = embed.toJSON().fields?.length ?? 0;
    const maxSquadFields = Math.max(
      0,
      DISCORD_EMBED_FIELD_COUNT_LIMIT - existingFieldCount - 1,
    );
    const squadTextBudget = Math.max(
      0,
      DISCORD_EMBED_TOTAL_TEXT_LIMIT - embedTextLength(embed) -
        notificationField.name.length - notificationField.value.length,
    );
    const squadFields = buildStatusPanelSquadFields(
      squadLines,
      `📋 ${i18n.t('regbattle.status_squads_field', locale)}`,
      locale,
      maxSquadFields,
      squadTextBudget,
    );
    embed.addFields(squadFields);
  }

  embed.addFields({
    name: notificationField.name,
    value: notificationField.value,
  });

  // ── Кнопки для деталей (label ≤ 80 символов по лимиту Discord) ──
  const redCount = onlineIgnoring.filter((a) => a.redZone).length;
  const ignoringBase = `${i18n.t('regbattle.btn_ignoring', locale)} (${onlineIgnoring.length})`;
  const ignoringLabel = redCount > 0
    ? truncLabel(`👻 ${ignoringBase} 🔴${redCount}`)
    : truncLabel(`👻 ${ignoringBase}`);

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`${RB_PREFIX}${RB_SEP}sp_ignoring`)
      .setLabel(ignoringLabel)
      .setStyle(onlineIgnoring.length > 0 ? (redCount > 0 ? ButtonStyle.Danger : ButtonStyle.Primary) : ButtonStyle.Secondary)
      .setDisabled(onlineIgnoring.length === 0),
    new ButtonBuilder()
      .setCustomId(`${RB_PREFIX}${RB_SEP}sp_played`)
      .setLabel(truncLabel(`✅ ${i18n.t('regbattle.btn_played', locale)} (${playedToday.length})`))
      .setStyle(playedToday.length > 0 ? ButtonStyle.Success : ButtonStyle.Secondary)
      .setDisabled(playedToday.length === 0),
    new ButtonBuilder()
      .setCustomId(`${RB_PREFIX}${RB_SEP}sp_offline`)
      .setLabel(truncLabel(`📴 ${i18n.t('regbattle.btn_offline', locale)} (${offlineAbsent.length})`))
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(offlineAbsent.length === 0),
  );

  return { embed, row };
}

/** Эфемерный embed «Игнорируют» для кнопки sp_ignoring */
export function buildIgnoringDetailEmbed(
  absentees: StatusPanelAbsentee[],
  locale: string,
): BublikEmbed {
  const embed = new BublikEmbed()
    .setTitle(`👻 ${i18n.t('regbattle.btn_ignoring', locale)} (${absentees.length})`)
    .setColor(0xff4444);

  if (absentees.length === 0) {
    embed.setDescription(i18n.t('regbattle.sp_nobody', locale));
    return embed;
  }

  const lines = absentees.map((a) => {
    const time = formatIgnoreTime(a.minutesIgnoring);
    let prefix: string;
    if (a.redZone) prefix = '🔴';
    else if (a.minutesIgnoring >= 30) prefix = '🟡';
    else prefix = '⚪';
    return `${prefix} <@${a.id}> — ${time}`;
  });

  const chunks = chunkFieldValue(lines, 1000);
  chunks.forEach((chunk) => {
    embed.addFields({ name: '\u200b', value: chunk });
  });
  return embed;
}

/** Эфемерный embed «Играли сегодня» для кнопки sp_played */
export function buildPlayedDetailEmbed(
  playedToday: { id: string; displayName: string }[],
  locale: string,
): BublikEmbed {
  const embed = new BublikEmbed()
    .setTitle(`✅ ${i18n.t('regbattle.btn_played', locale)} (${playedToday.length})`)
    .setColor(0x57f287);

  if (playedToday.length === 0) {
    embed.setDescription(i18n.t('regbattle.sp_nobody', locale));
    return embed;
  }

  const text = playedToday.map((p) => p.displayName).join(', ');
  const chunks = chunkFieldValue([text], 1000);
  chunks.forEach((chunk) => {
    embed.addFields({ name: '\u200b', value: chunk });
  });
  return embed;
}

/** Эфемерный embed «Оффлайн» для кнопки sp_offline */
export function buildOfflineDetailEmbed(
  offlineAbsent: { id: string; displayName: string }[],
  locale: string,
): BublikEmbed {
  const embed = new BublikEmbed()
    .setTitle(`📴 ${i18n.t('regbattle.btn_offline', locale)} (${offlineAbsent.length})`)
    .setColor(0x99aab5);

  if (offlineAbsent.length === 0) {
    embed.setDescription(i18n.t('regbattle.sp_nobody', locale));
    return embed;
  }

  const text = offlineAbsent.map((a) => a.displayName).join(', ');
  const chunks = chunkFieldValue([text], 1000);
  chunks.forEach((chunk) => {
    embed.addFields({ name: '\u200b', value: chunk });
  });
  return embed;
}

/** Обрезать label кнопки до 80 символов (лимит Discord) */
function truncLabel(label: string): string {
  return label.length > 80 ? label.slice(0, 77) + '...' : label;
}

function buildProgressBar(current: number, max: number): string {
  const filled = Math.min(current, max);
  const empty = max - filled;
  return '▓'.repeat(filled) + '░'.repeat(empty);
}

function formatIgnoreTime(minutes: number): string {
  if (minutes < 1) return '<1 \u043C\u0438\u043D';
  if (minutes < 60) return `${Math.floor(minutes)} \u043C\u0438\u043D`;
  const h = Math.floor(minutes / 60);
  const m = Math.floor(minutes % 60);
  return m > 0 ? `${h}\u0447 ${m}\u043C\u0438\u043D` : `${h}\u0447`;
}

function chunkFieldValue(lines: string[], maxLen: number): string[] {
  const chunks: string[] = [];
  let current = '';
  for (const line of lines) {
    if (current.length + line.length + 1 > maxLen && current.length > 0) {
      chunks.push(current);
      current = line;
    } else {
      current = current ? current + '\n' + line : line;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}
