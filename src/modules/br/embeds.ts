// ═══════════════════════════════════════════════
//  BR — Embeds
// ═══════════════════════════════════════════════

import { EmbedBuilder } from 'discord.js';
import { Config } from '../../config';
import { i18n } from '../../core/I18n';
import {
  CATEGORIES,
  CATEGORY_EMOJI,
  PRIORITIES,
  PRIORITY_EMOJI,
  PRIORITY_ANSI,
  ANSI_RESET,
  Category,
  Priority,
  I18N_CATEGORY_KEY,
  I18N_PRIORITY_KEY,
  getBrColor,
  getBrEmoji,
} from './constants';
import {
  RotationPeriod,
  RotationSnapshot,
  formatLongDate,
  formatShortDate,
  getRotationDisplayBr,
  isRotationStale,
} from './rotation';

type Entry = { id?: number; category: string; priority: string; name: string };

interface RenderOpts {
  filterCategory?: Category | null; // null = все категории
}

/** ANSI-блок с приоритетами для одной категории */
function renderCategoryBlock(entries: Entry[], locale: string): string {
  const lines: string[] = [];

  for (const pri of PRIORITIES) {
    const list = entries.filter((e) => e.priority === pri).map((e) => e.name);
    if (list.length === 0) continue;
    const ansi = PRIORITY_ANSI[pri];
    const label = i18n.t(I18N_PRIORITY_KEY[pri], locale);
    lines.push(`${ansi}▸ ${label}${ANSI_RESET}`);
    for (const name of list) {
      lines.push(`  ${ansi}${name}${ANSI_RESET}`);
    }
  }

  if (lines.length === 0) return '```\n—\n```';
  return '```ansi\n' + lines.join('\n') + '\n```';
}

export function buildBrEmbed(
  guildName: string,
  br: string,
  entries: Entry[],
  locale: string,
  opts: RenderOpts = {},
): EmbedBuilder {
  const total = entries.length;
  const emoji = getBrEmoji(br);
  const color = getBrColor(br);

  const filter = opts.filterCategory ?? null;

  const description =
    total === 0
      ? i18n.t('br.embed_empty', locale)
      : i18n.t('br.embed_total', locale, { count: String(total) });

  const embed = new EmbedBuilder()
    .setTitle(`${emoji} ${i18n.t('br.embed_title', locale, { br })}`)
    .setDescription(`${description}\n${'━'.repeat(28)}`)
    .setColor(color);

  const cats: Category[] = filter ? [filter] : [...CATEGORIES];

  for (const cat of cats) {
    const catEntries = entries.filter((e) => e.category === cat);
    const count = catEntries.length;
    const catLabel = i18n.t(I18N_CATEGORY_KEY[cat], locale);
    const block = renderCategoryBlock(catEntries, locale);

    embed.addFields({
      name: `${CATEGORY_EMOJI[cat]} ${catLabel} (${count})`,
      value: block.length > 1024 ? block.slice(0, 1018) + '\n…```' : block,
      inline: false,
    });
  }

  return embed;
}

export function buildSearchEmbed(query: string, results: Array<{ br: string; category: string; priority: string; name: string }>, locale: string): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setTitle(i18n.t('br.search_title', locale, { query }))
    .setColor(0x5865f2);

  if (results.length === 0) {
    embed.setDescription(i18n.t('br.search_empty', locale));
    return embed;
  }

  // Группируем по БР
  const byBr = new Map<string, typeof results>();
  for (const r of results) {
    if (!byBr.has(r.br)) byBr.set(r.br, []);
    byBr.get(r.br)!.push(r);
  }

  const lines: string[] = [];
  for (const [br, items] of byBr) {
    const emoji = getBrEmoji(br);
    lines.push(`\n${emoji} **${i18n.t('br.embed_title', locale, { br })}**`);
    for (const it of items) {
      const cat = i18n.t(I18N_CATEGORY_KEY[it.category as Category] ?? 'br.cat_tanks', locale);
      const pri = PRIORITY_EMOJI[it.priority as Priority] ?? '⚪';
      lines.push(`  ${pri} \`${it.name}\` — ${cat}`);
    }
  }

  let desc = lines.join('\n').trim();
  if (desc.length > 4000) desc = desc.slice(0, 3990) + '\n…';

  embed.setDescription(desc);
  embed.setFooter({ text: i18n.t('br.search_footer', locale, { count: String(results.length) }) });
  return embed;
}

export function buildPanelEmbed(locale: string, defaultBr: string | null): EmbedBuilder {
  return new EmbedBuilder()
    .setTitle(i18n.t('br.panel_title', locale))
    .setDescription(
      i18n.t('br.panel_description', locale) +
      (defaultBr ? `\n\n${i18n.t('br.panel_default_br', locale, { br: defaultBr })}` : ''),
    )
    .setColor(0x5865f2);
}

export function buildPanelHubEmbed(
  locale: string,
  snapshot: RotationSnapshot,
  periods: RotationPeriod[],
  fallbackBr: string | null,
): EmbedBuilder {
  const stale = isRotationStale(snapshot, periods);
  const displayBr = getRotationDisplayBr(snapshot, periods) ?? fallbackBr;

  const embed = new EmbedBuilder()
    .setTitle(i18n.t('br.hub_title', locale))
    .setDescription(i18n.t('br.hub_desc', locale))
    .setColor(displayBr ? getBrColor(displayBr) : 0x5865f2);

  embed.addFields({
    name: i18n.t('br.hub_current_br_label', locale),
    value: displayBr
      ? i18n.t('br.hub_current_br_value', locale, { br: displayBr })
      : i18n.t('br.rotation_no_data', locale),
    inline: true,
  });

  embed.addFields({
    name: i18n.t('br.hub_next_change_label', locale),
    value: snapshot.next
      ? i18n.t('br.rotation_next_value', locale, {
          date: formatLongDate(snapshot.next.start),
          br: snapshot.next.rating,
        })
      : i18n.t('br.rotation_end', locale),
    inline: true,
  });

  if (snapshot.current) {
    embed.addFields({
      name: i18n.t('br.hub_progress_label', locale),
      value: i18n.t('br.rotation_progress_value', locale, {
        bar: snapshot.progressBar,
        days: String(snapshot.daysLeft),
      }),
      inline: false,
    });
  }

  if (stale) {
    embed.addFields({
      name: i18n.t('br.hub_stale_title', locale),
      value: i18n.t('br.hub_stale_text', locale),
      inline: false,
    });
  }

  embed.setFooter({ text: Config.footer });
  return embed;
}

export function buildRotationStatusEmbed(locale: string, snapshot: RotationSnapshot): EmbedBuilder {
  const current = snapshot.current;
  const next = snapshot.next;

  const embed = new EmbedBuilder()
    .setTitle(i18n.t('br.rotation_title', locale))
    .setColor(current ? getBrColor(current.rating) : 0x5865f2);

  if (!current) {
    embed.setDescription(i18n.t('br.rotation_no_current', locale));
    if (next) {
      embed.addFields({
        name: i18n.t('br.rotation_next_label', locale),
        value: i18n.t('br.rotation_next_value', locale, {
          date: formatLongDate(next.start),
          br: next.rating,
        }),
        inline: false,
      });
    }
    return embed;
  }

  embed.addFields(
    {
      name: i18n.t('br.rotation_current_label', locale),
      value: i18n.t('br.rotation_current_value', locale, {
        br: current.rating,
        start: formatShortDate(current.start),
        end: formatShortDate(current.end),
      }),
      inline: false,
    },
    {
      name: i18n.t('br.rotation_progress_label', locale),
      value: i18n.t('br.rotation_progress_value', locale, {
        bar: snapshot.progressBar,
        days: String(snapshot.daysLeft),
      }),
      inline: false,
    },
    {
      name: i18n.t('br.rotation_next_label', locale),
      value: next
        ? i18n.t('br.rotation_next_value', locale, {
            date: formatLongDate(next.start),
            br: next.rating,
          })
        : i18n.t('br.rotation_end', locale),
      inline: false,
    },
  );

  return embed;
}

export function buildRotationGraphEmbed(locale: string, periods: RotationPeriod[], todayIso: string): EmbedBuilder {
  const lines: string[] = [];
  periods.forEach((p) => {
    const line = `${p.start <= todayIso && todayIso <= p.end ? '▶' : '•'} ${i18n.t('br.embed_title', locale, { br: p.rating })} (${formatShortDate(p.start)} — ${formatShortDate(p.end)})`;
    lines.push(line);
  });

  const desc = lines.length > 0 ? lines.join('\n') : i18n.t('br.rotation_no_data', locale);

  return new EmbedBuilder()
    .setTitle(i18n.t('br.rotation_graph_title', locale))
    .setDescription(desc.slice(0, 4000))
    .setColor(0x5865f2);
}

export function buildRotationNotifyEmbed(
  locale: string,
  kind: 'warning' | 'final',
  currentBr: string,
  currentStart: string,
  currentEnd: string,
  next: RotationPeriod | null,
): EmbedBuilder {
  const title = kind === 'warning' ? i18n.t('br.rotation_warn_title', locale) : i18n.t('br.rotation_final_title', locale);
  const description = kind === 'warning'
    ? i18n.t('br.rotation_warn_desc', locale, { date: formatLongDate(currentStart), br: currentBr })
    : i18n.t('br.rotation_final_desc', locale, { br: currentBr });

  const embed = new EmbedBuilder()
    .setTitle(title)
    .setDescription(description)
    .setColor(kind === 'warning' ? 0xe67e22 : 0x57f287);

  embed.addFields({
    name: i18n.t('br.rotation_current_label', locale),
    value: i18n.t('br.rotation_current_value', locale, {
      br: currentBr,
      start: formatShortDate(currentStart),
      end: formatShortDate(currentEnd),
    }),
    inline: false,
  });

  embed.addFields({
    name: i18n.t('br.rotation_next_label', locale),
    value: next
      ? i18n.t('br.rotation_next_value', locale, {
          date: formatLongDate(next.start),
          br: next.rating,
        })
      : i18n.t('br.rotation_end', locale),
    inline: false,
  });

  return embed;
}
