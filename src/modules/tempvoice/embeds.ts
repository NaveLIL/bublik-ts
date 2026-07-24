// ═══════════════════════════════════════════════
//  TempVoice — Embeds (панель управления и уведомления)
// ═══════════════════════════════════════════════

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  UserSelectMenuBuilder,
  GuildMember,
} from 'discord.js';
import { BublikEmbed } from '../../core/EmbedBuilder';
import { i18n } from '../../core/I18n';
import { ChannelState, PanelPage, TV_PREFIX, TV_SEP, BR_VALUES, WT_NATIONS, WT_MODES } from './constants';

// ── Цвета ──────────────────────────────────────
const COLOR_PANEL    = 0x5865f2; // blurple
const COLOR_SUCCESS  = 0x57f287;
const COLOR_WARNING  = 0xfee75c;
const COLOR_DANGER   = 0xed4245;
const COLOR_LOCKED   = 0xff9b21;
const COLOR_HIDDEN   = 0x99aab5;
const COLOR_REWARD   = 0xf1c40f; // gold

// ═══════════════════════════════════════════════
//  Утилита customId
// ═══════════════════════════════════════════════

function cid(...parts: string[]): string {
  return [TV_PREFIX, ...parts].join(TV_SEP);
}

// ═══════════════════════════════════════════════
//  Панель управления — страницы
// ═══════════════════════════════════════════════

/** Получить цвет по состоянию */
function stateColor(state: string): number {
  switch (state) {
    case ChannelState.Locked: return COLOR_LOCKED;
    case ChannelState.Hidden: return COLOR_HIDDEN;
    default: return COLOR_PANEL;
  }
}

function stateIcon(state: string): string {
  switch (state) {
    case ChannelState.Locked: return '🔒';
    case ChannelState.Hidden: return '👻';
    default: return '🔓';
  }
}

function stateText(state: string, locale: string): string {
  switch (state) {
    case ChannelState.Locked: return i18n.t('tempvoice.state.locked', locale);
    case ChannelState.Hidden: return i18n.t('tempvoice.state.hidden', locale);
    default: return i18n.t('tempvoice.state.unlocked', locale);
  }
}

// ══════════════════════════════════════
//  Страница 1: Основное управление
// ══════════════════════════════════════

export function buildMainPageEmbed(
  ownerTag: string,
  channelName: string,
  state: string,
  memberCount: number,
  userLimit: number,
  bitrate: number,
  locale: string,
): BublikEmbed {
  const limitText = userLimit === 0 ? '∞' : String(userLimit);

  return new BublikEmbed()
    .setColor(stateColor(state))
    .setAuthor({ name: i18n.t('tempvoice.panel.main_author', locale) })
    .setDescription(
      `**${channelName}**\n\n` +
      `> ${stateIcon(state)} ${i18n.t('tempvoice.panel.main_status', locale, { state: stateText(state, locale) })}\n` +
      `> 👑 ${i18n.t('tempvoice.panel.main_owner', locale, { ownerTag })}\n` +
      `> 👥 ${i18n.t('tempvoice.panel.main_members', locale, { memberCount: String(memberCount), limitText })}\n` +
      `> 🎚️ ${i18n.t('tempvoice.panel.main_bitrate', locale, { bitrate: String(Math.floor(bitrate / 1000)) })}`,
    )
    .addFields({
      name: i18n.t('tempvoice.panel.nav_label', locale),
      value: i18n.t('tempvoice.panel.nav_main', locale),
    });
}

export function buildMainPageButtons(locale: string): ActionRowBuilder<ButtonBuilder>[] {
  // Ряд 1: основные действия (rename, limit, lock, hide, BR)
  const row1 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(cid('rename'))
      .setLabel(i18n.t('tempvoice.btn.rename', locale))
      .setEmoji('✏️')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(cid('limit'))
      .setLabel(i18n.t('tempvoice.btn.limit', locale))
      .setEmoji('🔢')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(cid('lock'))
      .setLabel(i18n.t('tempvoice.btn.lock', locale))
      .setEmoji('🔒')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(cid('hide'))
      .setLabel(i18n.t('tempvoice.btn.hide', locale))
      .setEmoji('👻')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(cid('br'))
      .setLabel('Б.Р.')
      .setEmoji('🎯')
      .setStyle(ButtonStyle.Primary),
  );

  // Ряд 2: claim + навигация + удаление
  const row2 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(cid('claim'))
      .setLabel(i18n.t('tempvoice.btn.claim', locale))
      .setEmoji('👑')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(cid('page', PanelPage.Access))
      .setLabel(i18n.t('tempvoice.btn.access_next', locale))
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(cid('page', PanelPage.Settings))
      .setLabel(i18n.t('tempvoice.btn.settings_next', locale))
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(cid('delete'))
      .setLabel(i18n.t('tempvoice.btn.delete', locale))
      .setEmoji('🗑️')
      .setStyle(ButtonStyle.Danger),
  );

  return [row1, row2];
}

// ══════════════════════════════════════
//  Страница 2: Управление доступом
// ══════════════════════════════════════

export function buildAccessPageEmbed(
  trustedList: string[],
  blockedList: string[],
  state: string,
  locale: string,
): BublikEmbed {
  const trustedText = trustedList.length > 0
    ? trustedList.map((id) => `<@${id}>`).join(', ')
    : i18n.t('tempvoice.panel.access_empty', locale);
  const blockedText = blockedList.length > 0
    ? blockedList.map((id) => `<@${id}>`).join(', ')
    : i18n.t('tempvoice.panel.access_empty', locale);

  return new BublikEmbed()
    .setColor(stateColor(state))
    .setAuthor({ name: i18n.t('tempvoice.panel.access_author', locale) })
    .setDescription(
      `${stateIcon(state)} ${i18n.t('tempvoice.panel.main_status', locale, { state: stateText(state, locale) })}\n\n` +
      i18n.t('tempvoice.panel.access_description', locale),
    )
    .addFields(
      {
        name: i18n.t('tempvoice.panel.access_trusted_label', locale),
        value: trustedText,
        inline: true,
      },
      {
        name: i18n.t('tempvoice.panel.access_blocked_label', locale),
        value: blockedText,
        inline: true,
      },
    )
    .addFields({
      name: i18n.t('tempvoice.panel.nav_label', locale),
      value: i18n.t('tempvoice.panel.nav_access', locale),
    });
}

export function buildAccessPageButtons(locale: string): ActionRowBuilder<ButtonBuilder>[] {
  const row1 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(cid('trust'))
      .setLabel(i18n.t('tempvoice.btn.trust', locale))
      .setEmoji('✅')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(cid('untrust'))
      .setLabel(i18n.t('tempvoice.btn.untrust', locale))
      .setEmoji('🚫')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(cid('block'))
      .setLabel(i18n.t('tempvoice.btn.block', locale))
      .setEmoji('⛔')
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId(cid('unblock'))
      .setLabel(i18n.t('tempvoice.btn.unblock', locale))
      .setEmoji('⭕')
      .setStyle(ButtonStyle.Secondary),
  );

  const row2 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(cid('kick'))
      .setLabel(i18n.t('tempvoice.btn.kick', locale))
      .setEmoji('👢')
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId(cid('transfer'))
      .setLabel(i18n.t('tempvoice.btn.transfer', locale))
      .setEmoji('🔄')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(cid('invite'))
      .setLabel(i18n.t('tempvoice.btn.invite', locale))
      .setEmoji('📨')
      .setStyle(ButtonStyle.Primary),
  );

  const row3 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(cid('page', PanelPage.Main))
      .setLabel(i18n.t('tempvoice.btn.prev_main', locale))
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(cid('page', PanelPage.Settings))
      .setLabel(i18n.t('tempvoice.btn.settings_single', locale))
      .setStyle(ButtonStyle.Secondary),
  );

  return [row1, row2, row3];
}

// ══════════════════════════════════════
//  Страница 3: Настройки
// ══════════════════════════════════════

export function buildSettingsPageEmbed(
  state: string,
  region: string,
  bitrate: number,
  locale: string,
): BublikEmbed {
  const regionLabel = region === 'auto' ? i18n.t('tempvoice.panel.region_auto', locale) : region;

  return new BublikEmbed()
    .setColor(stateColor(state))
    .setAuthor({ name: i18n.t('tempvoice.panel.settings_author', locale) })
    .setDescription(
      `${i18n.t('tempvoice.panel.settings_description', locale)}\n\n` +
      `> 🌐 ${i18n.t('tempvoice.panel.settings_region', locale, { region: regionLabel })}\n` +
      `> 🎚️ ${i18n.t('tempvoice.panel.settings_bitrate', locale, { bitrate: String(Math.floor(bitrate / 1000)) })}`,
    )
    .addFields(
      {
        name: i18n.t('tempvoice.panel.settings_hint_label', locale),
        value: i18n.t('tempvoice.panel.settings_hint', locale),
      },
    )
    .addFields({
      name: i18n.t('tempvoice.panel.nav_label', locale),
      value: i18n.t('tempvoice.panel.nav_settings', locale),
    });
}

export function buildSettingsPageButtons(locale: string): ActionRowBuilder<ButtonBuilder>[] {
  const row1 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(cid('bitrate'))
      .setLabel(i18n.t('tempvoice.btn.bitrate', locale))
      .setEmoji('🎚️')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(cid('region'))
      .setLabel(i18n.t('tempvoice.btn.region', locale))
      .setEmoji('🌐')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(cid('save'))
      .setLabel(i18n.t('tempvoice.btn.save', locale))
      .setEmoji('💾')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(cid('reset'))
      .setLabel(i18n.t('tempvoice.btn.reset', locale))
      .setEmoji('🔄')
      .setStyle(ButtonStyle.Secondary),
  );

  const row2 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(cid('page', PanelPage.Main))
      .setLabel(i18n.t('tempvoice.btn.prev_main', locale))
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(cid('page', PanelPage.Access))
      .setLabel(i18n.t('tempvoice.btn.prev_access', locale))
      .setStyle(ButtonStyle.Secondary),
  );

  return [row1, row2];
}

// ═══════════════════════════════════════════════
//  Подтверждение удаления
// ═══════════════════════════════════════════════

export function buildDeleteConfirmEmbed(locale: string): BublikEmbed {
  return new BublikEmbed()
    .setColor(COLOR_DANGER)
    .setAuthor({ name: i18n.t('tempvoice.delete.author', locale) })
    .setDescription(i18n.t('tempvoice.delete.confirm_text', locale));
}

export function buildDeleteConfirmButtons(locale: string): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(cid('delete_yes'))
      .setLabel(i18n.t('tempvoice.delete.yes', locale))
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId(cid('delete_no'))
      .setLabel(i18n.t('tempvoice.delete.cancel', locale))
      .setStyle(ButtonStyle.Secondary),
  );
}

// ═══════════════════════════════════════════════
//  Быстрые уведомления (ephemeral)
// ═══════════════════════════════════════════════

export function tvSuccess(text: string): BublikEmbed {
  return new BublikEmbed().setColor(COLOR_SUCCESS).setDescription(`✅ ${text}`);
}

export function tvError(text: string): BublikEmbed {
  return new BublikEmbed().setColor(COLOR_DANGER).setDescription(`❌ ${text}`);
}

export function tvWarn(text: string): BublikEmbed {
  return new BublikEmbed().setColor(COLOR_WARNING).setDescription(`⚠️ ${text}`);
}

export function tvInfo(text: string): BublikEmbed {
  return new BublikEmbed().setColor(COLOR_PANEL).setDescription(text);
}

// ═══════════════════════════════════════════════
//  Объявление о награде
// ═══════════════════════════════════════════════

export function buildRewardAnnouncement(
  member: GuildMember,
  totalHours: number,
  rewardRoleId: string,
  locale: string,
): BublikEmbed {
  return new BublikEmbed()
    .setColor(COLOR_REWARD)
    .setAuthor({ name: i18n.t('tempvoice.reward.author', locale), iconURL: member.displayAvatarURL() })
    .setDescription(
      i18n.t('tempvoice.reward.description', locale, {
        displayName: member.displayName,
        totalHours: String(totalHours),
        userMention: member.toString(),
        roleMention: `<@&${rewardRoleId}>`,
      }),
    )
    .setThumbnail(member.displayAvatarURL({ size: 128 }))
    .setTimestamp();
}

// ═══════════════════════════════════════════════
//  Select Menu билдеры
// ═══════════════════════════════════════════════

export function buildUserSelect(action: string, placeholder: string): ActionRowBuilder<UserSelectMenuBuilder> {
  return new ActionRowBuilder<UserSelectMenuBuilder>().addComponents(
    new UserSelectMenuBuilder()
      .setCustomId(cid('sel', action))
      .setPlaceholder(placeholder)
      .setMinValues(1)
      .setMaxValues(1),
  );
}

export function buildKickSelect(
  members: { id: string; tag: string }[],
  locale: string,
): ActionRowBuilder<StringSelectMenuBuilder> {
  const menu = new StringSelectMenuBuilder()
    .setCustomId(cid('sel', 'kick'))
    .setPlaceholder(i18n.t('tempvoice.select.kick_placeholder', locale))
    .setMinValues(1)
    .setMaxValues(1);

  for (const m of members.slice(0, 25)) {
    menu.addOptions({ label: m.tag, value: m.id });
  }

  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu);
}

export function buildTransferSelect(
  members: { id: string; tag: string }[],
  locale: string,
): ActionRowBuilder<StringSelectMenuBuilder> {
  const menu = new StringSelectMenuBuilder()
    .setCustomId(cid('sel', 'transfer'))
    .setPlaceholder(i18n.t('tempvoice.select.transfer_placeholder', locale))
    .setMinValues(1)
    .setMaxValues(1);

  for (const m of members.slice(0, 25)) {
    menu.addOptions({ label: m.tag, value: m.id });
  }

  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu);
}

// ═══════════════════════════════════════════════
//  BR (Battle Rating) Select Menu билдеры
// ═══════════════════════════════════════════════

/** Сгенерировать страницу BR-опций (Discord ограничивает 25 опций) */
export function buildBrSelectMenus(): ActionRowBuilder<StringSelectMenuBuilder>[] {
  // Разбиваем BR_VALUES на группы по 25 для одного select menu
  // Но Discord показывает один select — просто берём все значения (их ~39, влезут)
  const menu = new StringSelectMenuBuilder()
    .setCustomId(`${TV_PREFIX}:sel:br`)
    .setPlaceholder('🎯 Выбери Боевой Рейтинг...')
    .addOptions(
      BR_VALUES.slice(0, 25).map((br) => ({ label: `BR ${br}`, value: br })),
    );

  const menu2 = new StringSelectMenuBuilder()
    .setCustomId(`${TV_PREFIX}:sel:br2`)
    .setPlaceholder(`🎯 BR ${BR_VALUES[25]} — ${BR_VALUES[BR_VALUES.length - 1]}`)
    .addOptions(
      BR_VALUES.slice(25).map((br) => ({ label: `BR ${br}`, value: br })),
    );

  return [
    new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu),
    new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu2),
  ];
}

export function buildNationSelectMenu(): ActionRowBuilder<StringSelectMenuBuilder> {
  const menu = new StringSelectMenuBuilder()
    .setCustomId(`${TV_PREFIX}:sel:nation`)
    .setPlaceholder('🌍 Выбери нацию (или пропусти)')
    .addOptions([
      ...WT_NATIONS.map((n) => ({ label: n.label, value: n.value })),
      { label: '⏭️ Пропустить', value: 'skip' },
    ]);

  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu);
}

export function buildModeSelectMenu(): ActionRowBuilder<StringSelectMenuBuilder> {
  const menu = new StringSelectMenuBuilder()
    .setCustomId(`${TV_PREFIX}:sel:mode`)
    .setPlaceholder('⚔️ Выбери род войск (или пропусти)')
    .addOptions([
      ...WT_MODES.map((m) => ({ label: m.label, value: m.value })),
      { label: '⏭️ Пропустить', value: 'skip' },
    ]);

  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu);
}
