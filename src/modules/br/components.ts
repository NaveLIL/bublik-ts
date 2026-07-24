// ═══════════════════════════════════════════════
//  BR — UI builders (selects/buttons/modals)
// ═══════════════════════════════════════════════

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import { i18n } from '../../core/I18n';
import {
  BR_PREFIX,
  BR_SEP,
  CATEGORIES,
  CATEGORY_EMOJI,
  PRIORITIES,
  PRIORITY_EMOJI,
  Category,
  I18N_CATEGORY_KEY,
  I18N_PRIORITY_KEY,
} from './constants';

const cid = (...parts: string[]) => [BR_PREFIX, ...parts].join(BR_SEP);

// ── Главная панель: одна кнопка «Открыть БР» ──
export function buildPanelButtons(locale: string): ActionRowBuilder<ButtonBuilder>[] {
  const main = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(cid('open'))
      .setLabel(i18n.t('br.btn_open', locale))
      .setStyle(ButtonStyle.Primary)
      .setEmoji('🎯'),
    new ButtonBuilder()
      .setCustomId(cid('search_modal'))
      .setLabel(i18n.t('br.btn_search', locale))
      .setStyle(ButtonStyle.Secondary)
      .setEmoji('🔍'),
    new ButtonBuilder()
      .setCustomId(cid('rotation', 'graph'))
      .setLabel(i18n.t('br.btn_graph', locale))
      .setStyle(ButtonStyle.Secondary)
      .setEmoji('📊'),
    new ButtonBuilder()
      .setCustomId(cid('rotation', 'next'))
      .setLabel(i18n.t('br.btn_next_change', locale))
      .setStyle(ButtonStyle.Secondary)
      .setEmoji('⏰'),
  );

  const admin = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(cid('rotation', 'refresh_panel'))
      .setLabel(i18n.t('br.btn_refresh_panel', locale))
      .setStyle(ButtonStyle.Secondary)
      .setEmoji('🔄'),
    new ButtonBuilder()
      .setCustomId(cid('rotation', 'update_modal'))
      .setLabel(i18n.t('br.btn_update_schedule', locale))
      .setStyle(ButtonStyle.Success)
      .setEmoji('🧩'),
  );

  return [main, admin];
}

export function buildRotationActionButtons(
  locale: string,
  currentBr: string | null,
  opts?: { includeNext?: boolean },
): ActionRowBuilder<ButtonBuilder> {
  const includeNext = opts?.includeNext ?? true;
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(cid('rotation', 'graph'))
      .setLabel(i18n.t('br.btn_graph', locale))
      .setStyle(ButtonStyle.Primary)
      .setEmoji('📊'),
    new ButtonBuilder()
      .setCustomId(currentBr ? cid('rotation', 'show', currentBr) : cid('rotation', 'show', 'na'))
      .setLabel(i18n.t('br.btn_open_current', locale))
      .setStyle(ButtonStyle.Success)
      .setEmoji('🛡️')
      .setDisabled(!currentBr),
  );

  if (includeNext) {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(cid('rotation', 'next'))
        .setLabel(i18n.t('br.btn_next_change', locale))
        .setStyle(ButtonStyle.Secondary)
        .setEmoji('⏰'),
    );
  }

  return row;
}

export function buildRotationNotifyButton(locale: string, br: string): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(cid('rotation', 'show', br))
      .setLabel(i18n.t('br.btn_open_current', locale))
      .setStyle(ButtonStyle.Primary)
      .setEmoji('🛡️'),
  );
}

export function buildRotationUpdateModal(locale: string): ModalBuilder {
  return new ModalBuilder()
    .setCustomId(cid('modal', 'rotation_update'))
    .setTitle(i18n.t('br.modal_rotation_update_title', locale))
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId('rotation_json')
          .setLabel(i18n.t('br.modal_rotation_update_label', locale))
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(true)
          .setMaxLength(4000)
          .setPlaceholder(i18n.t('br.modal_rotation_update_placeholder', locale)),
      ),
    );
}

// ── Селект БР (для выбора текущего БР в ephemeral) ──
export function buildBrSelect(locale: string, brs: string[], current: string | null): ActionRowBuilder<StringSelectMenuBuilder> {
  const options = brs.slice(0, 25).map((b) =>
    new StringSelectMenuOptionBuilder()
      .setLabel(`БР ${b}`)
      .setValue(b)
      .setDefault(b === current),
  );
  if (options.length === 0) {
    options.push(new StringSelectMenuOptionBuilder().setLabel('—').setValue('__empty__'));
  }
  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(cid('sel', 'br'))
      .setPlaceholder(i18n.t('br.select_br', locale))
      .addOptions(options)
      .setDisabled(brs.length === 0),
  );
}

// ── Селект категории (для фильтра) ──
export function buildCategorySelect(locale: string, current: string): ActionRowBuilder<StringSelectMenuBuilder> {
  const options = [
    new StringSelectMenuOptionBuilder()
      .setLabel(i18n.t('br.cat_all', locale))
      .setValue('__all__')
      .setEmoji('📋')
      .setDefault(current === '__all__'),
    ...CATEGORIES.map((c) =>
      new StringSelectMenuOptionBuilder()
        .setLabel(i18n.t(I18N_CATEGORY_KEY[c], locale))
        .setValue(c)
        .setEmoji(CATEGORY_EMOJI[c])
        .setDefault(c === current),
    ),
  ];
  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(cid('sel', 'cat'))
      .setPlaceholder(i18n.t('br.select_cat', locale))
      .addOptions(options),
  );
}

// ── Кнопки навигации ◀ ▶ + админ ──
export function buildNavButtons(
  locale: string,
  br: string,
  prevBr: string | null,
  nextBr: string | null,
  isAdmin: boolean,
): ActionRowBuilder<ButtonBuilder>[] {
  const navRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(cid('nav', 'prev', br))
      .setLabel(prevBr ? `БР ${prevBr}` : '—')
      .setStyle(ButtonStyle.Secondary)
      .setEmoji('◀')
      .setDisabled(!prevBr),
    new ButtonBuilder()
      .setCustomId(cid('current'))
      .setLabel(`БР ${br}`)
      .setStyle(ButtonStyle.Success)
      .setEmoji('🎯')
      .setDisabled(true),
    new ButtonBuilder()
      .setCustomId(cid('nav', 'next', br))
      .setLabel(nextBr ? `БР ${nextBr}` : '—')
      .setStyle(ButtonStyle.Secondary)
      .setEmoji('▶')
      .setDisabled(!nextBr),
  );

  const rows = [navRow];
  if (isAdmin) {
    const adminRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(cid('admin', 'add', br))
        .setLabel(i18n.t('br.btn_add', locale))
        .setStyle(ButtonStyle.Success)
        .setEmoji('➕'),
      new ButtonBuilder()
        .setCustomId(cid('admin', 'rm', br))
        .setLabel(i18n.t('br.btn_remove', locale))
        .setStyle(ButtonStyle.Danger)
        .setEmoji('🗑️'),
      new ButtonBuilder()
        .setCustomId(cid('admin', 'bulk', br))
        .setLabel(i18n.t('br.btn_bulk', locale))
        .setStyle(ButtonStyle.Primary)
        .setEmoji('📝'),
    );
    rows.push(adminRow);
  }
  return rows;
}

// ── Селект категории для add/remove ──
export function buildAdminCategorySelect(locale: string, br: string, action: 'add' | 'rm' | 'bulk'): ActionRowBuilder<StringSelectMenuBuilder> {
  const options = CATEGORIES.map((c) =>
    new StringSelectMenuOptionBuilder()
      .setLabel(i18n.t(I18N_CATEGORY_KEY[c], locale))
      .setValue(c)
      .setEmoji(CATEGORY_EMOJI[c]),
  );
  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(cid('admin_sel', 'cat', action, br))
      .setPlaceholder(i18n.t('br.select_admin_cat', locale))
      .addOptions(options),
  );
}

// ── Селект приоритета (после категории, для add) ──
export function buildAdminPrioritySelect(locale: string, br: string, action: 'add' | 'rm', category: Category): ActionRowBuilder<StringSelectMenuBuilder> {
  const options = PRIORITIES.map((p) =>
    new StringSelectMenuOptionBuilder()
      .setLabel(i18n.t(I18N_PRIORITY_KEY[p], locale))
      .setValue(p)
      .setEmoji(PRIORITY_EMOJI[p]),
  );
  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(cid('admin_sel', 'pri', action, br, category))
      .setPlaceholder(i18n.t('br.select_admin_pri', locale))
      .addOptions(options),
  );
}

// ── Селект элементов для удаления ──
export function buildDeleteItemsSelect(
  locale: string,
  br: string,
  category: Category,
  items: Array<{ id: number; name: string; priority: string }>,
): ActionRowBuilder<StringSelectMenuBuilder> {
  const options = items.slice(0, 25).map((it) =>
    new StringSelectMenuOptionBuilder()
      .setLabel(it.name.slice(0, 100))
      .setValue(String(it.id))
      .setEmoji(PRIORITY_EMOJI[it.priority as keyof typeof PRIORITY_EMOJI] ?? '⚪'),
  );
  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(cid('admin_del', br, category))
      .setPlaceholder(i18n.t('br.select_to_remove', locale))
      .setMinValues(1)
      .setMaxValues(Math.min(items.length, 25))
      .addOptions(options.length > 0 ? options : [new StringSelectMenuOptionBuilder().setLabel('—').setValue('__empty__')])
      .setDisabled(items.length === 0),
  );
}

// ── Модал добавления ──
export function buildAddModal(locale: string, br: string, category: Category, priority: string): ModalBuilder {
  return new ModalBuilder()
    .setCustomId(cid('modal', 'add', br, category, priority))
    .setTitle(i18n.t('br.modal_add_title', locale))
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId('names')
          .setLabel(i18n.t('br.modal_add_label', locale))
          .setPlaceholder('T-80BVM, Leopard 2A6, M1A2 SEP')
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(true)
          .setMaxLength(1000),
      ),
    );
}

// ── Модал bulk-edit (с предзаполнением) ──
export function buildBulkModal(locale: string, br: string, category: Category, defaultText: string): ModalBuilder {
  return new ModalBuilder()
    .setCustomId(cid('modal', 'bulk', br, category))
    .setTitle(i18n.t('br.modal_bulk_title', locale))
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId('content')
          .setLabel(i18n.t('br.modal_bulk_label', locale))
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(false)
          .setMaxLength(4000)
          .setValue(defaultText.slice(0, 4000)),
      ),
    );
}

// ── Модал поиска ──
export function buildSearchModal(locale: string): ModalBuilder {
  return new ModalBuilder()
    .setCustomId(cid('modal', 'search'))
    .setTitle(i18n.t('br.modal_search_title', locale))
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId('query')
          .setLabel(i18n.t('br.modal_search_label', locale))
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(64),
      ),
    );
}
