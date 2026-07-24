// ═══════════════════════════════════════════════
//  BR — Handlers
// ═══════════════════════════════════════════════

import {
  Interaction,
  ButtonInteraction,
  StringSelectMenuInteraction,
  ModalSubmitInteraction,
  PermissionsBitField,
  MessageFlags,
} from 'discord.js';
import { logger } from '../../core/Logger';
import { errorReporter } from '../../core/ErrorReporter';
import { i18n } from '../../core/I18n';
import { getGuildLocale } from '../../core/GuildConfig';
import { errorEmbed, successEmbed } from '../../core/EmbedBuilder';
import { isTransientInteractionError } from '../../utils/helpers';

import {
  BR_PREFIX,
  BR_SEP,
  Category,
  Priority,
  PRIORITIES,
  I18N_CATEGORY_KEY,
  I18N_PRIORITY_KEY,
} from './constants';
import {
  getEntriesForBr,
  getAvailableBrs,
  getAdjacentBrs,
  getPanel,
  addEntries,
  deleteEntriesByIds,
  replaceCategory,
  searchTech,
} from './database';
import {
  buildBrEmbed,
  buildPanelHubEmbed,
  buildRotationGraphEmbed,
  buildRotationStatusEmbed,
  buildSearchEmbed,
} from './embeds';
import {
  buildBrSelect,
  buildCategorySelect,
  buildNavButtons,
  buildAdminCategorySelect,
  buildAdminPrioritySelect,
  buildDeleteItemsSelect,
  buildAddModal,
  buildBulkModal,
  buildSearchModal,
  buildRotationActionButtons,
  buildPanelButtons,
  buildRotationUpdateModal,
} from './components';
import {
  getGuildRotation,
  getRotationDisplayBr,
  getRotationSnapshot,
  parseRotationJson,
  setGuildRotation,
} from './rotation';

const log = logger.child('BR:Handlers');

function isAdmin(interaction: ButtonInteraction | StringSelectMenuInteraction | ModalSubmitInteraction): boolean {
  return interaction.memberPermissions?.has(PermissionsBitField.Flags.ManageGuild) ?? false;
}

// ═══════════════════════════════════════════════
//  Router
// ═══════════════════════════════════════════════

export async function handleBrInteraction(interaction: Interaction): Promise<void> {
  try {
    if (!interaction.guildId) return;

    if (interaction.isButton()) {
      const parts = interaction.customId.split(BR_SEP);
      if (parts[0] !== BR_PREFIX) return;
      await routeButton(interaction, parts);
      return;
    }

    if (interaction.isStringSelectMenu()) {
      const parts = interaction.customId.split(BR_SEP);
      if (parts[0] !== BR_PREFIX) return;
      await routeSelect(interaction, parts);
      return;
    }

    if (interaction.isModalSubmit()) {
      const parts = interaction.customId.split(BR_SEP);
      if (parts[0] !== BR_PREFIX) return;
      await routeModal(interaction, parts);
      return;
    }
  } catch (err) {
    if (isTransientInteractionError(err)) return;
    log.error('Ошибка в обработчике BR', { error: String(err) });
    errorReporter.eventError(err, 'interactionCreate', 'br');
    if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
      const locale = await getGuildLocale(interaction.guildId);
      await interaction.reply({
        embeds: [errorEmbed(i18n.t('br.error_internal', locale))],
        flags: MessageFlags.Ephemeral,
      }).catch(() => null);
    }
  }
}

// ═══════════════════════════════════════════════
//  Button routes
// ═══════════════════════════════════════════════

async function routeButton(interaction: ButtonInteraction, parts: string[]): Promise<void> {
  const action = parts[1];

  switch (action) {
    case 'open':
      await openPanel(interaction);
      return;
    case 'search_modal':
      await interaction.showModal(buildSearchModal(await getGuildLocale(interaction.guildId)));
      return;
    case 'rotation':
      await handleRotationButton(interaction, parts);
      return;
    case 'nav':
      // br:nav:prev|next:<currentBr>
      await navigate(interaction, parts[2] as 'prev' | 'next', parts[3]);
      return;
    case 'admin':
      // br:admin:add|rm|bulk:<br>
      if (!isAdmin(interaction)) {
        const locale = await getGuildLocale(interaction.guildId);
        await interaction.reply({
          embeds: [errorEmbed(i18n.t('br.no_admin', locale))],
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      await startAdminFlow(interaction, parts[2] as 'add' | 'rm' | 'bulk', parts[3]);
      return;
  }
}

async function handleRotationButton(interaction: ButtonInteraction, parts: string[]): Promise<void> {
  const guildId = interaction.guildId!;
  const locale = await getGuildLocale(guildId);
  const action = parts[2];
  const periods = await getGuildRotation(guildId);
  const snapshot = getRotationSnapshot(periods);

  if (action === 'graph') {
    await interaction.reply({
      embeds: [buildRotationGraphEmbed(locale, periods, snapshot.today)],
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (action === 'update_modal') {
    if (!isAdmin(interaction)) {
      await interaction.reply({
        embeds: [errorEmbed(i18n.t('br.no_admin', locale))],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    await interaction.showModal(buildRotationUpdateModal(locale));
    return;
  }

  if (action === 'refresh_panel') {
    if (!isAdmin(interaction)) {
      await interaction.reply({
        embeds: [errorEmbed(i18n.t('br.no_admin', locale))],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    await refreshPanelMessage(interaction);
    return;
  }

  if (action === 'next') {
    await interaction.reply({
      embeds: [buildRotationStatusEmbed(locale, snapshot)],
      components: [buildRotationActionButtons(locale, snapshot.current?.rating ?? null, { includeNext: false })],
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (action === 'show') {
    const br = parts[3] && parts[3] !== 'na' ? parts[3] : getRotationDisplayBr(snapshot, periods);
    if (!br) {
      await interaction.reply({
        embeds: [errorEmbed(i18n.t('br.rotation_no_current', locale))],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    await openBrForRating(interaction, br);
  }
}

async function refreshPanelMessage(interaction: ButtonInteraction): Promise<void> {
  const guildId = interaction.guildId!;
  const locale = await getGuildLocale(guildId);
  const panel = await getPanel(guildId);

  if (!panel?.panelChannelId || !panel.panelMessageId) {
    await interaction.reply({
      embeds: [errorEmbed(i18n.t('br.panel_failed', locale))],
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const channel = await interaction.client.channels.fetch(panel.panelChannelId).catch(() => null);
  if (!channel?.isTextBased() || !('messages' in channel)) {
    await interaction.reply({
      embeds: [errorEmbed(i18n.t('br.panel_failed', locale))],
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const msg = await channel.messages.fetch(panel.panelMessageId).catch(() => null);
  if (!msg) {
    await interaction.reply({
      embeds: [errorEmbed(i18n.t('br.panel_failed', locale))],
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const periods = await getGuildRotation(guildId);
  const snapshot = getRotationSnapshot(periods);
  const brs = await getAvailableBrs(guildId);
  const fallbackBr = panel.defaultBr && brs.includes(panel.defaultBr) ? panel.defaultBr : (brs[0] ?? null);

  await msg.edit({
    embeds: [buildPanelHubEmbed(locale, snapshot, periods, fallbackBr)],
    components: buildPanelButtons(locale),
  });

  await interaction.reply({
    embeds: [successEmbed(i18n.t('br.panel_refreshed', locale))],
    flags: MessageFlags.Ephemeral,
  });
}

async function openPanel(interaction: ButtonInteraction): Promise<void> {
  const guildId = interaction.guildId!;
  const locale = await getGuildLocale(guildId);
  const brs = await getAvailableBrs(guildId);

  if (brs.length === 0) {
    await interaction.reply({
      embeds: [errorEmbed(i18n.t('br.no_data_yet', locale))],
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const periods = await getGuildRotation(guildId);
  const snapshot = getRotationSnapshot(periods);
  const rotationBr = getRotationDisplayBr(snapshot, periods);

  // Prefer BR from schedule; if reference table doesn't contain it yet, fallback to nearest known BR.
  let current = brs[0];
  if (rotationBr) {
    if (brs.includes(rotationBr)) {
      current = rotationBr;
    } else {
      const target = parseFloat(rotationBr);
      if (!Number.isNaN(target)) {
        let best = brs[0];
        let diff = Math.abs(parseFloat(best) - target);
        for (const br of brs) {
          const d = Math.abs(parseFloat(br) - target);
          if (d < diff) {
            best = br;
            diff = d;
          }
        }
        current = best;
      }
    }
  }

  const entries = await getEntriesForBr(guildId, current);
  const { prev, next } = await getAdjacentBrs(guildId, current);

  await interaction.reply({
    embeds: [buildBrEmbed(interaction.guild?.name ?? '', current, entries, locale)],
    components: [
      buildBrSelect(locale, brs, current),
      buildCategorySelect(locale, '__all__'),
      ...buildNavButtons(locale, current, prev, next, isAdmin(interaction)),
    ],
    flags: MessageFlags.Ephemeral,
  });
}

async function openBrForRating(
  interaction: ButtonInteraction | StringSelectMenuInteraction | ModalSubmitInteraction,
  targetBr: string,
): Promise<void> {
  const guildId = interaction.guildId!;
  const locale = await getGuildLocale(guildId);
  const all = await getAvailableBrs(guildId);

  if (!all.includes(targetBr)) {
    if ('reply' in interaction) {
      await interaction.reply({
        embeds: [errorEmbed(i18n.t('br.unknown_br', locale, { br: targetBr }))],
        flags: MessageFlags.Ephemeral,
      });
    }
    return;
  }

  const entries = await getEntriesForBr(guildId, targetBr);
  const { prev, next } = await getAdjacentBrs(guildId, targetBr);

  if (interaction.isButton() || interaction.isModalSubmit()) {
    await interaction.reply({
      embeds: [buildBrEmbed(interaction.guild?.name ?? '', targetBr, entries, locale)],
      components: [
        buildBrSelect(locale, all, targetBr),
        buildCategorySelect(locale, '__all__'),
        ...buildNavButtons(locale, targetBr, prev, next, isAdmin(interaction as ButtonInteraction | StringSelectMenuInteraction)),
      ],
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.update({
    embeds: [buildBrEmbed(interaction.guild?.name ?? '', targetBr, entries, locale)],
    components: [
      buildBrSelect(locale, all, targetBr),
      buildCategorySelect(locale, '__all__'),
      ...buildNavButtons(locale, targetBr, prev, next, isAdmin(interaction)),
    ],
  });
}

async function navigate(interaction: ButtonInteraction, direction: 'prev' | 'next', currentBr: string): Promise<void> {
  const guildId = interaction.guildId!;
  const locale = await getGuildLocale(guildId);
  const { prev, next } = await getAdjacentBrs(guildId, currentBr);
  const target = direction === 'prev' ? prev : next;
  if (!target) {
    await interaction.deferUpdate();
    return;
  }

  const entries = await getEntriesForBr(guildId, target);
  const adj = await getAdjacentBrs(guildId, target);
  const brs = await getAvailableBrs(guildId);

  await interaction.update({
    embeds: [buildBrEmbed(interaction.guild?.name ?? '', target, entries, locale)],
    components: [
      buildBrSelect(locale, brs, target),
      buildCategorySelect(locale, '__all__'),
      ...buildNavButtons(locale, target, adj.prev, adj.next, isAdmin(interaction)),
    ],
  });
}

// ═══════════════════════════════════════════════
//  Admin flow: add / rm / bulk
// ═══════════════════════════════════════════════

async function startAdminFlow(interaction: ButtonInteraction, action: 'add' | 'rm' | 'bulk', br: string): Promise<void> {
  const locale = await getGuildLocale(interaction.guildId);
  await interaction.reply({
    content: i18n.t('br.admin_pick_cat', locale, { br }),
    components: [buildAdminCategorySelect(locale, br, action)],
    flags: MessageFlags.Ephemeral,
  });
}

// ═══════════════════════════════════════════════
//  Select routes
// ═══════════════════════════════════════════════

async function routeSelect(interaction: StringSelectMenuInteraction, parts: string[]): Promise<void> {
  const kind = parts[1];

  // br:sel:br | br:sel:cat
  if (kind === 'sel') {
    const what = parts[2];
    if (what === 'br') {
      await onBrSelect(interaction);
      return;
    }
    if (what === 'cat') {
      await onCatSelect(interaction);
      return;
    }
    return;
  }

  // br:admin_sel:cat:add|rm|bulk:<br>
  // br:admin_sel:pri:add|rm:<br>:<cat>
  if (kind === 'admin_sel') {
    if (!isAdmin(interaction)) {
      const locale = await getGuildLocale(interaction.guildId);
      await interaction.reply({
        embeds: [errorEmbed(i18n.t('br.no_admin', locale))],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    const sub = parts[2];
    if (sub === 'cat') {
      await onAdminCatPicked(interaction, parts[3] as 'add' | 'rm' | 'bulk', parts[4]);
      return;
    }
    if (sub === 'pri') {
      await onAdminPriPicked(interaction, parts[3] as 'add' | 'rm', parts[4], parts[5] as Category);
      return;
    }
    return;
  }

  // br:admin_del:<br>:<cat>
  if (kind === 'admin_del') {
    if (!isAdmin(interaction)) return;
    await onAdminDeleteItems(interaction, parts[2], parts[3] as Category);
    return;
  }
}

async function onBrSelect(interaction: StringSelectMenuInteraction): Promise<void> {
  const guildId = interaction.guildId!;
  const locale = await getGuildLocale(guildId);
  const target = interaction.values[0];
  if (target === '__empty__') {
    await interaction.deferUpdate();
    return;
  }

  const entries = await getEntriesForBr(guildId, target);
  const adj = await getAdjacentBrs(guildId, target);
  const brs = await getAvailableBrs(guildId);

  await interaction.update({
    embeds: [buildBrEmbed(interaction.guild?.name ?? '', target, entries, locale)],
    components: [
      buildBrSelect(locale, brs, target),
      buildCategorySelect(locale, '__all__'),
      ...buildNavButtons(locale, target, adj.prev, adj.next, isAdmin(interaction)),
    ],
  });
}

async function onCatSelect(interaction: StringSelectMenuInteraction): Promise<void> {
  const guildId = interaction.guildId!;
  const locale = await getGuildLocale(guildId);
  const value = interaction.values[0];

  // Восстанавливаем текущий БР из embed (он в title) — самый дешёвый способ
  const titleMatch = interaction.message.embeds[0]?.title?.match(/(\d+(?:\.\d+)?)/);
  const br = titleMatch?.[1];
  if (!br) {
    await interaction.deferUpdate();
    return;
  }

  const entries = await getEntriesForBr(guildId, br);
  const adj = await getAdjacentBrs(guildId, br);
  const brs = await getAvailableBrs(guildId);

  const filterCat = value === '__all__' ? null : (value as Category);

  await interaction.update({
    embeds: [buildBrEmbed(interaction.guild?.name ?? '', br, entries, locale, { filterCategory: filterCat })],
    components: [
      buildBrSelect(locale, brs, br),
      buildCategorySelect(locale, value),
      ...buildNavButtons(locale, br, adj.prev, adj.next, isAdmin(interaction)),
    ],
  });
}

async function onAdminCatPicked(
  interaction: StringSelectMenuInteraction,
  action: 'add' | 'rm' | 'bulk',
  br: string,
): Promise<void> {
  const cat = interaction.values[0] as Category;
  const locale = await getGuildLocale(interaction.guildId);

  if (action === 'bulk') {
    // Сразу открываем модал с предзаполнением
    const entries = await getEntriesForBr(interaction.guildId!, br);
    const catEntries = entries.filter((e) => e.category === cat);
    const lines: string[] = [];
    for (const pri of PRIORITIES) {
      const list = catEntries.filter((e) => e.priority === pri);
      if (list.length === 0) continue;
      lines.push(`[${i18n.t(I18N_PRIORITY_KEY[pri], locale)}]`);
      for (const e of list) lines.push(e.name);
      lines.push('');
    }
    await interaction.showModal(buildBulkModal(locale, br, cat, lines.join('\n').trim()));
    return;
  }

  // add / rm — следующий шаг: выбор приоритета
  await interaction.update({
    content: i18n.t('br.admin_pick_pri', locale, {
      br,
      category: i18n.t(I18N_CATEGORY_KEY[cat], locale),
    }),
    components: [buildAdminPrioritySelect(locale, br, action, cat)],
  });
}

async function onAdminPriPicked(
  interaction: StringSelectMenuInteraction,
  action: 'add' | 'rm',
  br: string,
  cat: Category,
): Promise<void> {
  const priority = interaction.values[0] as Priority;
  const locale = await getGuildLocale(interaction.guildId);

  if (action === 'add') {
    await interaction.showModal(buildAddModal(locale, br, cat, priority));
    return;
  }

  // rm — показываем select элементов
  const entries = await getEntriesForBr(interaction.guildId!, br);
  const items = entries
    .filter((e) => e.category === cat && e.priority === priority)
    .map((e) => ({ id: e.id!, name: e.name, priority: e.priority }));

  await interaction.update({
    content: i18n.t('br.admin_pick_items', locale, {
      br,
      category: i18n.t(I18N_CATEGORY_KEY[cat], locale),
      priority: i18n.t(I18N_PRIORITY_KEY[priority], locale),
    }),
    components: [buildDeleteItemsSelect(locale, br, cat, items)],
  });
}

async function onAdminDeleteItems(
  interaction: StringSelectMenuInteraction,
  br: string,
  cat: Category,
): Promise<void> {
  const locale = await getGuildLocale(interaction.guildId);
  const ids = interaction.values.filter((v) => v !== '__empty__').map((v) => parseInt(v, 10)).filter((n) => !isNaN(n));
  if (ids.length === 0) {
    await interaction.deferUpdate();
    return;
  }
  const removed = await deleteEntriesByIds(interaction.guildId!, br, ids);
  await interaction.update({
    embeds: [successEmbed(i18n.t('br.admin_removed', locale, { count: String(removed), br, category: i18n.t(I18N_CATEGORY_KEY[cat], locale) }))],
    components: [],
  });
  log.info(`BR remove: guild=${interaction.guildId} br=${br} cat=${cat} count=${removed} by ${interaction.user.tag}`);
}

// ═══════════════════════════════════════════════
//  Modal routes
// ═══════════════════════════════════════════════

async function routeModal(interaction: ModalSubmitInteraction, parts: string[]): Promise<void> {
  const kind = parts[1];
  if (kind !== 'modal') return;

  const what = parts[2];
  const locale = await getGuildLocale(interaction.guildId);

  if (what === 'search') {
    const q = interaction.fields.getTextInputValue('query').trim();
    if (!q) {
      await interaction.reply({ embeds: [errorEmbed(i18n.t('br.search_empty_query', locale))], flags: MessageFlags.Ephemeral });
      return;
    }
    const results = await searchTech(interaction.guildId!, q, 30);
    await interaction.reply({ embeds: [buildSearchEmbed(q, results, locale)], flags: MessageFlags.Ephemeral });
    return;
  }

  if (what === 'rotation_update') {
    if (!isAdmin(interaction)) {
      await interaction.reply({ embeds: [errorEmbed(i18n.t('br.no_admin', locale))], flags: MessageFlags.Ephemeral });
      return;
    }

    const rawJson = interaction.fields.getTextInputValue('rotation_json').trim();
    try {
      const periods = parseRotationJson(rawJson);
      await setGuildRotation(interaction.guildId!, periods);

      await interaction.reply({
        embeds: [successEmbed(i18n.t('br.rotation_update_done', locale, { count: String(periods.length) }))],
        flags: MessageFlags.Ephemeral,
      });
    } catch {
      await interaction.reply({
        embeds: [errorEmbed(i18n.t('br.rotation_update_failed', locale))],
        flags: MessageFlags.Ephemeral,
      });
    }
    return;
  }

  if (!isAdmin(interaction)) {
    await interaction.reply({ embeds: [errorEmbed(i18n.t('br.no_admin', locale))], flags: MessageFlags.Ephemeral });
    return;
  }

  if (what === 'add') {
    const br = parts[3];
    const cat = parts[4] as Category;
    const pri = parts[5] as Priority;
    const raw = interaction.fields.getTextInputValue('names');
    const names = raw.split(/[,\n]/).map((s) => s.trim()).filter(Boolean);
    if (names.length === 0) {
      await interaction.reply({ embeds: [errorEmbed(i18n.t('br.add_empty', locale))], flags: MessageFlags.Ephemeral });
      return;
    }
    const added = await addEntries(interaction.guildId!, br, cat, pri, names);
    await interaction.reply({
      embeds: [successEmbed(
        i18n.t('br.admin_added', locale, {
          count: String(added),
          br,
          category: i18n.t(I18N_CATEGORY_KEY[cat], locale),
          priority: i18n.t(I18N_PRIORITY_KEY[pri], locale),
        }) + '\n' + names.slice(0, 10).map((n) => `• ${n}`).join('\n') + (names.length > 10 ? `\n…(+${names.length - 10})` : ''),
      )],
      flags: MessageFlags.Ephemeral,
    });
    log.info(`BR add: guild=${interaction.guildId} br=${br} cat=${cat} pri=${pri} count=${added} by ${interaction.user.tag}`);
    return;
  }

  if (what === 'bulk') {
    const br = parts[3];
    const cat = parts[4] as Category;
    const content = interaction.fields.getTextInputValue('content');

    // Парсим: [Высокий]\nA\nB\n[Средний]\nC ...
    let currentPri: Priority | null = null;
    const toAdd: Array<{ pri: Priority; name: string }> = [];

    const headerMap = new Map<string, Priority>();
    for (const p of PRIORITIES) {
      headerMap.set(i18n.t(I18N_PRIORITY_KEY[p], locale).toLowerCase(), p);
      headerMap.set(i18n.t(I18N_PRIORITY_KEY[p], 'ru').toLowerCase(), p);
      headerMap.set(i18n.t(I18N_PRIORITY_KEY[p], 'en').toLowerCase(), p);
      headerMap.set(p, p);
    }

    for (const rawLine of content.split('\n')) {
      const line = rawLine.trim();
      if (!line) continue;
      const headerMatch = line.match(/^\[(.+)\]$/);
      if (headerMatch) {
        const key = headerMatch[1].trim().toLowerCase();
        currentPri = headerMap.get(key) ?? null;
        continue;
      }
      if (currentPri) {
        toAdd.push({ pri: currentPri, name: line });
      }
    }

    if (toAdd.length === 0) {
      await interaction.reply({
        embeds: [errorEmbed('Не распознано ни одной записи. Текущая категория не изменена.')],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const total = await replaceCategory(
      interaction.guildId!,
      br,
      cat,
      toAdd.map(({ pri, name }) => ({ priority: pri, name })),
    );

    await interaction.reply({
      embeds: [successEmbed(i18n.t('br.admin_bulk_done', locale, {
        count: String(total),
        br,
        category: i18n.t(I18N_CATEGORY_KEY[cat], locale),
      }))],
      flags: MessageFlags.Ephemeral,
    });
    log.info(`BR bulk: guild=${interaction.guildId} br=${br} cat=${cat} count=${total} by ${interaction.user.tag}`);
    return;
  }
}
