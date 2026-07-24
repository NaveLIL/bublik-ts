// ═══════════════════════════════════════════════
//  Vacation — Эмбеды и UI-компоненты
// ═══════════════════════════════════════════════

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  GuildMember,
} from 'discord.js';
import type { VacationConfig, VacationRequest } from '@prisma/client';
import { BublikEmbed } from '../../core/EmbedBuilder';
import { i18n } from '../../core/I18n';
import { VAC_PREFIX, VAC_SEP, REASONS } from './constants';
import { formatDuration, formatDateMsk, formatTimeLeft } from './utils';

// ── Цвета ──────────────────────────────────────
const COLOR_PANEL    = 0x5865f2; // blurple
const COLOR_SUCCESS  = 0x57f287;
const COLOR_WARNING  = 0xfee75c;
const COLOR_DANGER   = 0xed4245;
const COLOR_VACATION = 0xe67e22; // orange
const COLOR_REVIEW   = 0x3498db; // blue
const COLOR_EXPIRED  = 0x99aab5; // grey

// ── CustomId ───────────────────────────────────
function cid(...parts: string[]): string {
  return [VAC_PREFIX, ...parts].join(VAC_SEP);
}

// ═══════════════════════════════════════════════
//  Панель (вечное сообщение)
// ═══════════════════════════════════════════════

export function buildPanelEmbed(config: VacationConfig, locale: string): BublikEmbed {
  const blockStart = (config.primeTimeStart - config.primeTimeBuffer + 24) % 24;
  const primeText = `${String(blockStart).padStart(2, '0')}:00 — ${String(config.primeTimeEnd).padStart(2, '0')}:00 МСК`;

  const cooldownText = config.cooldownDays > 0
    ? i18n.t('vacation.panel_cooldown_days', locale, { days: String(config.cooldownDays) })
    : i18n.t('vacation.panel_cooldown_none', locale);
  const monthLimitText = config.maxPerMonth > 0
    ? `${config.maxPerMonth}`
    : '∞';
  const quickLimitText = config.maxQuickPerWeek > 0
    ? `${config.maxQuickPerWeek}`
    : '∞';

  const embed = new BublikEmbed()
    .setColor(COLOR_PANEL)
    .setTitle(i18n.t('vacation.panel_title', locale))
    .setDescription(
      i18n.t('vacation.panel_intro', locale) + '\n\n' +

      `**${i18n.t('vacation.panel_how_title', locale)}**\n` +
      `> 1. ${i18n.t('vacation.panel_step1', locale)}\n` +
      `> 2. ${i18n.t('vacation.panel_step2', locale)}\n` +
      `> 3. ${i18n.t('vacation.panel_step3', locale)}\n` +
      `> 4. ${i18n.t('vacation.panel_step4', locale)}\n` +
      `> 5. ${i18n.t('vacation.panel_step5', locale)}\n\n` +

      `**${i18n.t('vacation.panel_quick_title', locale)}**\n` +
      `> ${i18n.t('vacation.panel_quick_desc', locale, { quickHours: String(config.quickDurationH) })}\n\n` +

      `**${i18n.t('vacation.panel_limits_title', locale)}**\n` +
      `> ${i18n.t('vacation.panel_limit_max_duration', locale, { maxDays: String(config.maxDurationDays) })}\n` +
      `> ${i18n.t('vacation.panel_limit_primetime', locale, { primeText })}\n` +
      `> ${i18n.t('vacation.panel_limit_cooldown', locale, { cooldownText })}\n` +
      `> ${i18n.t('vacation.panel_limit_month', locale, { monthLimit: monthLimitText })}\n` +
      `> ${i18n.t('vacation.panel_limit_quick', locale, { quickLimit: quickLimitText })}\n\n` +

      i18n.t('vacation.panel_auto_deny_note', locale) + '\n' +
      i18n.t('vacation.panel_reminder_note', locale),
    )
    .setTimestamp();

  if (config.imageUrl) {
    embed.setImage(config.imageUrl);
  }

  return embed;
}

export function buildPanelButtons(locale: string): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(cid('go'))
      .setLabel(i18n.t('vacation.btn_go', locale))
      .setEmoji('🚫')
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId(cid('return'))
      .setLabel(i18n.t('vacation.btn_return', locale))
      .setEmoji('🎉')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(cid('quick'))
      .setLabel(i18n.t('vacation.btn_quick', locale))
      .setEmoji('👋')
      .setStyle(ButtonStyle.Secondary),
  );
}

// ═══════════════════════════════════════════════
//  Выбор причины (StringSelectMenu)
// ═══════════════════════════════════════════════

export function buildReasonSelect(locale: string): ActionRowBuilder<StringSelectMenuBuilder> {
  const menu = new StringSelectMenuBuilder()
    .setCustomId(cid('sel', 'reason'))
    .setPlaceholder(i18n.t('vacation.reason_select_placeholder', locale))
    .setMinValues(1)
    .setMaxValues(1);

  for (const r of REASONS) {
    menu.addOptions({
      label: i18n.t(r.label, locale),
      value: r.value,
      emoji: r.emoji,
    });
  }

  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu);
}

// ═══════════════════════════════════════════════
//  Модальное окно длительности
// ═══════════════════════════════════════════════

export function buildDurationModal(reason: string, locale: string): ModalBuilder {
  const modal = new ModalBuilder()
    .setCustomId(cid('modal', 'duration', reason))
    .setTitle(i18n.t('vacation.modal_duration_title', locale));

  // Для «Другое» — добавляем поле причины
  if (reason === 'other') {
    modal.addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId('reason_text')
          .setLabel(i18n.t('vacation.modal_reason_label', locale))
          .setStyle(TextInputStyle.Short)
          .setPlaceholder(i18n.t('vacation.modal_reason_placeholder', locale))
          .setRequired(true)
          .setMaxLength(200),
      ),
    );
  }

  modal.addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder()
        .setCustomId('duration')
        .setLabel(i18n.t('vacation.modal_duration_label', locale))
        .setStyle(TextInputStyle.Short)
        .setPlaceholder('7d')
        .setRequired(true)
        .setMaxLength(30),
    ),
  );

  return modal;
}

// ═══════════════════════════════════════════════
//  Заявка на ревью (отправляется в канал проверки)
// ═══════════════════════════════════════════════

export function buildRequestEmbed(
  request: VacationRequest,
  member: GuildMember,
  locale: string,
  stats?: { totalAll: number; last30d: number; quickLast7d: number; lastEnd: Date | null },
): BublikEmbed {
  const endDate = new Date(Date.now() + request.durationMinutes * 60_000);

  let statsText = '';
  if (stats) {
    const lastEndText = stats.lastEnd
      ? formatDateMsk(stats.lastEnd)
      : i18n.t('vacation.request_stats_no_data', locale);
    statsText =
      `\n\n${i18n.t('vacation.request_stats_title', locale)}\n` +
      `> ${i18n.t('vacation.request_stats_total', locale, { count: String(stats.totalAll) })}\n` +
      `> ${i18n.t('vacation.request_stats_30d', locale, { count: String(stats.last30d) })}\n` +
      `> ${i18n.t('vacation.request_stats_quick7d', locale, { count: String(stats.quickLast7d) })}\n` +
      `> ${i18n.t('vacation.request_stats_last_end', locale, { date: lastEndText })}`;
  }

  return new BublikEmbed()
    .setColor(COLOR_REVIEW)
    .setAuthor({ name: i18n.t('vacation.request_author', locale), iconURL: member.displayAvatarURL() })
    .setDescription(
      `> ${i18n.t('vacation.request_member', locale, { member: member.toString(), tag: member.user.tag })}\n` +
      `> ${i18n.t('vacation.request_reason', locale, { reason: request.reason })}\n` +
      `> ${i18n.t('vacation.request_duration', locale, { duration: formatDuration(request.durationMinutes) })}\n` +
      `> ${i18n.t('vacation.request_until', locale, { date: formatDateMsk(endDate) })}\n\n` +
      i18n.t('vacation.request_auto_deny', locale) +
      statsText,
    )
    .setThumbnail(member.displayAvatarURL({ size: 128 }))
    .setTimestamp();
}

export function buildRequestButtons(requestId: string, locale: string): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(cid('approve', requestId))
      .setLabel(i18n.t('vacation.btn_approve', locale))
      .setEmoji('✅')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(cid('deny', requestId))
      .setLabel(i18n.t('vacation.btn_deny', locale))
      .setEmoji('❌')
      .setStyle(ButtonStyle.Danger),
  );
}

// ═══════════════════════════════════════════════
//  Обновлённые эмбеды заявки (после решения)
// ═══════════════════════════════════════════════

export function buildApprovedRequestEmbed(
  request: VacationRequest & { config: VacationConfig },
  member: GuildMember,
  reviewer: GuildMember,
  locale: string,
): BublikEmbed {
  return new BublikEmbed()
    .setColor(COLOR_SUCCESS)
    .setAuthor({ name: i18n.t('vacation.approved_author', locale), iconURL: member.displayAvatarURL() })
    .setDescription(
      `> ${i18n.t('vacation.request_member', locale, { member: member.toString(), tag: member.user.tag })}\n` +
      `> ${i18n.t('vacation.request_reason', locale, { reason: request.reason })}\n` +
      `> ${i18n.t('vacation.request_duration', locale, { duration: formatDuration(request.durationMinutes) })}\n` +
      `> ${i18n.t('vacation.approved_until', locale, { date: formatDateMsk(request.endDate!) })}\n` +
      `> ${i18n.t('vacation.approved_reviewer', locale, { reviewer: reviewer.toString() })}`,
    )
    .setTimestamp();
}

export function buildDeniedRequestEmbed(
  request: VacationRequest,
  member: GuildMember | null,
  reviewer: GuildMember | null,
  locale: string,
  selfCancel: boolean = false,
): BublikEmbed {
  const title = selfCancel
    ? i18n.t('vacation.recalled_author', locale)
    : i18n.t('vacation.denied_author', locale);
  const userText = member
    ? `${member.toString()} (${member.user.tag})`
    : `<@${request.userId}>`;

  const reviewerKey = selfCancel ? 'vacation.recalled_by' : 'vacation.denied_by';

  const embed = new BublikEmbed()
    .setColor(COLOR_DANGER)
    .setAuthor({
      name: title,
      ...(member ? { iconURL: member.displayAvatarURL() } : {}),
    })
    .setDescription(
      `> ${i18n.t('vacation.request_member', locale, { member: userText, tag: '' })}\n` +
      `> ${i18n.t('vacation.request_reason', locale, { reason: request.reason })}\n` +
      `> ${i18n.t('vacation.request_duration', locale, { duration: formatDuration(request.durationMinutes) })}\n` +
      (reviewer ? `> ${i18n.t(reviewerKey, locale, { reviewer: reviewer.toString() })}` : ''),
    )
    .setTimestamp();

  return embed;
}

export function buildExpiredRequestEmbed(
  request: VacationRequest,
  member: GuildMember | null,
  locale: string,
): BublikEmbed {
  const userText = member
    ? `${member.toString()} (${member.user.tag})`
    : `<@${request.userId}>`;

  return new BublikEmbed()
    .setColor(COLOR_EXPIRED)
    .setAuthor({ name: i18n.t('vacation.expired_author', locale) })
    .setDescription(
      `> ${i18n.t('vacation.request_member', locale, { member: userText, tag: '' })}\n` +
      `> ${i18n.t('vacation.request_reason', locale, { reason: request.reason })}\n` +
      `> ${i18n.t('vacation.request_duration', locale, { duration: formatDuration(request.durationMinutes) })}\n\n` +
      i18n.t('vacation.expired_text', locale),
    )
    .setTimestamp();
}

// ═══════════════════════════════════════════════
//  Логи (отправляются в лог-канал)
// ═══════════════════════════════════════════════

export function buildVacationStartLog(
  member: GuildMember,
  request: VacationRequest,
  savedRoles: string[],
  locale: string,
): BublikEmbed {
  const rolesText = savedRoles.length > 0
    ? savedRoles.map((id) => `<@&${id}>`).join(', ')
    : i18n.t('vacation.log_no_roles', locale);

  const typeLabel = request.type === 'quick' ? i18n.t('vacation.log_type_quick', locale) :
                    request.type === 'admin' ? i18n.t('vacation.log_type_admin', locale) : i18n.t('vacation.log_type_regular', locale);

  return new BublikEmbed()
    .setColor(COLOR_VACATION)
    .setAuthor({ name: i18n.t('vacation.log_start_author', locale, { type: typeLabel }), iconURL: member.displayAvatarURL() })
    .setDescription(
      `> ${i18n.t('vacation.request_member', locale, { member: member.toString(), tag: member.user.tag })}\n` +
      `> ${i18n.t('vacation.request_reason', locale, { reason: request.reason })}\n` +
      `> ${i18n.t('vacation.request_duration', locale, { duration: formatDuration(request.durationMinutes) })}\n` +
      `> ${i18n.t('vacation.approved_until', locale, { date: formatDateMsk(request.endDate!) })}\n` +
      `> ${i18n.t('vacation.log_saved_roles', locale, { roles: rolesText })}`,
    )
    .setTimestamp();
}

export function buildVacationEndLog(
  member: GuildMember,
  request: VacationRequest,
  early: boolean,
  locale: string,
): BublikEmbed {
  const actualMinutes = request.startDate
    ? Math.floor((Date.now() - request.startDate.getTime()) / 60_000)
    : request.durationMinutes;

  const rolesText = request.savedRoleIds.length > 0
    ? request.savedRoleIds.map((id) => `<@&${id}>`).join(', ')
    : i18n.t('vacation.log_no_roles', locale);

  return new BublikEmbed()
    .setColor(COLOR_SUCCESS)
    .setAuthor({
      name: early ? i18n.t('vacation.log_end_early', locale) : i18n.t('vacation.log_end_normal', locale),
      iconURL: member.displayAvatarURL(),
    })
    .setDescription(
      `> ${i18n.t('vacation.request_member', locale, { member: member.toString(), tag: member.user.tag })}\n` +
      `> ${i18n.t('vacation.log_was_on_vacation', locale, { duration: formatDuration(actualMinutes) })}\n` +
      `> ${i18n.t('vacation.log_restored_roles', locale, { roles: rolesText })}`,
    )
    .setTimestamp();
}

// ═══════════════════════════════════════════════
//  DM уведомления
// ═══════════════════════════════════════════════

export function buildDmApproved(request: VacationRequest, locale: string): BublikEmbed {
  return new BublikEmbed()
    .setColor(COLOR_SUCCESS)
    .setTitle(i18n.t('vacation.dm_approved_title', locale))
    .setDescription(
      `${i18n.t('vacation.dm_approved_reason', locale, { reason: request.reason })}\n` +
      `${i18n.t('vacation.dm_approved_duration', locale, { duration: formatDuration(request.durationMinutes) })}\n` +
      `${i18n.t('vacation.dm_approved_until', locale, { date: formatDateMsk(request.endDate!) })}\n\n` +
      `${i18n.t('vacation.dm_approved_roles_note', locale)}\n` +
      i18n.t('vacation.dm_approved_return_hint', locale),
    )
    .setTimestamp();
}

export function buildDmDenied(request: VacationRequest, locale: string): BublikEmbed {
  return new BublikEmbed()
    .setColor(COLOR_DANGER)
    .setTitle(i18n.t('vacation.dm_denied_title', locale))
    .setDescription(
      `${i18n.t('vacation.dm_denied_reason', locale, { reason: request.reason })}\n` +
      `${i18n.t('vacation.dm_denied_duration', locale, { duration: formatDuration(request.durationMinutes) })}\n\n` +
      i18n.t('vacation.dm_denied_contact', locale),
    )
    .setTimestamp();
}

export function buildDmExpired(request: VacationRequest, locale: string): BublikEmbed {
  return new BublikEmbed()
    .setColor(COLOR_EXPIRED)
    .setTitle(i18n.t('vacation.dm_expired_title', locale))
    .setDescription(
      `${i18n.t('vacation.dm_expired_text', locale)}\n\n` +
      `${i18n.t('vacation.dm_expired_reason', locale, { reason: request.reason })}\n` +
      `${i18n.t('vacation.dm_expired_duration', locale, { duration: formatDuration(request.durationMinutes) })}\n\n` +
      i18n.t('vacation.dm_expired_resubmit', locale),
    )
    .setTimestamp();
}

export function buildDmReminder(request: VacationRequest, locale: string): BublikEmbed {
  return new BublikEmbed()
    .setColor(COLOR_WARNING)
    .setTitle(i18n.t('vacation.dm_reminder_title', locale))
    .setDescription(
      `${i18n.t('vacation.dm_reminder_text', locale, { date: formatDateMsk(request.endDate!), timeLeft: formatTimeLeft(request.endDate!) })}\n\n` +
      `${i18n.t('vacation.dm_reminder_roles_note', locale)}\n` +
      i18n.t('vacation.dm_reminder_extend_hint', locale),
    )
    .setTimestamp();
}

// ═══════════════════════════════════════════════
//  Быстрые уведомления (ephemeral)
// ═══════════════════════════════════════════════

export function vacSuccess(text: string): BublikEmbed {
  return new BublikEmbed().setColor(COLOR_SUCCESS).setDescription(`✅ ${text}`);
}

export function vacError(text: string): BublikEmbed {
  return new BublikEmbed().setColor(COLOR_DANGER).setDescription(`❌ ${text}`);
}

export function vacWarn(text: string): BublikEmbed {
  return new BublikEmbed().setColor(COLOR_WARNING).setDescription(`⚠️ ${text}`);
}

export function vacInfo(text: string): BublikEmbed {
  return new BublikEmbed().setColor(COLOR_PANEL).setDescription(text);
}

// ═══════════════════════════════════════════════
//  Небесные Стражи — UI
// ═══════════════════════════════════════════════

import { NS_PREFIX } from './constants';

function nsCid(...parts: string[]): string {
  return [VAC_PREFIX, NS_PREFIX, ...parts].join(VAC_SEP);
}

// ── Кнопка на основной панели ──────────────────

export function buildNsMainButton(locale: string): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(nsCid('shield'))
      .setLabel(i18n.t('vacation.ns_btn_main', locale))
      .setEmoji('🛡️')
      .setStyle(ButtonStyle.Primary),
  );
}

// ── Предупреждение (эфемерное) ─────────────────

export function buildNsWarningEmbed(locale: string): BublikEmbed {
  return new BublikEmbed()
    .setColor(0xff9900)
    .setTitle(i18n.t('vacation.ns_warning_title', locale))
    .setDescription(i18n.t('vacation.ns_warning_text', locale));
}

export function buildNsWarningButtons(locale: string): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(nsCid('confirm'))
      .setLabel(i18n.t('vacation.ns_btn_confirm', locale))
      .setEmoji('✅')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(nsCid('troll'))
      .setLabel(i18n.t('vacation.ns_btn_troll', locale))
      .setEmoji('😈')
      .setStyle(ButtonStyle.Danger),
  );
}

// ── Отдельная панель НС ────────────────────────

export function buildNsPanelEmbed(locale: string): BublikEmbed {
  return new BublikEmbed()
    .setColor(0x9b59b6)
    .setTitle(i18n.t('vacation.ns_panel_title', locale))
    .setDescription(i18n.t('vacation.ns_panel_desc', locale))
    .setTimestamp();
}

export function buildNsPanelButtons(locale: string): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(nsCid('vac_go'))
      .setLabel(i18n.t('vacation.ns_btn_vac_go', locale))
      .setEmoji('🚫')
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId(nsCid('vac_return'))
      .setLabel(i18n.t('vacation.ns_btn_vac_return', locale))
      .setEmoji('🎉')
      .setStyle(ButtonStyle.Success),
  );
}

// ── Модал длительности НС-отпуска ──────────────

export function buildNsDurationModal(locale: string): ModalBuilder {
  return new ModalBuilder()
    .setCustomId(nsCid('vac_modal'))
    .setTitle(i18n.t('vacation.ns_modal_title', locale))
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId('duration')
          .setLabel(i18n.t('vacation.ns_modal_duration', locale))
          .setStyle(TextInputStyle.Short)
          .setPlaceholder('7d')
          .setRequired(true)
          .setMaxLength(30),
      ),
    );
}

// ── Лог НС-отпуска ────────────────────────────

export function buildNsVacationLog(member: GuildMember, durationText: string, endDateText: string, locale: string): BublikEmbed {
  return new BublikEmbed()
    .setColor(0x9b59b6)
    .setAuthor({ name: i18n.t('vacation.ns_log_start', locale), iconURL: member.displayAvatarURL() })
    .setDescription(
      `> ${i18n.t('vacation.request_member', locale, { member: member.toString(), tag: member.user.tag })}\n` +
      `> ${i18n.t('vacation.request_duration', locale, { duration: durationText })}\n` +
      `> ${i18n.t('vacation.approved_until', locale, { date: endDateText })}`,
    )
    .setTimestamp();
}

export function buildNsVacationEndLog(member: GuildMember, early: boolean, locale: string): BublikEmbed {
  return new BublikEmbed()
    .setColor(COLOR_SUCCESS)
    .setAuthor({
      name: early ? i18n.t('vacation.ns_log_end_early', locale) : i18n.t('vacation.ns_log_end', locale),
      iconURL: member.displayAvatarURL(),
    })
    .setDescription(
      `> ${i18n.t('vacation.request_member', locale, { member: member.toString(), tag: member.user.tag })}`,
    )
    .setTimestamp();
}
