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
import { RB_PREFIX, RB_SEP } from './constants';

// ═══════════════════════════════════════════════
//  Панель управления отрядом
// ═══════════════════════════════════════════════

export function buildControlPanelEmbed(
  squadNumber: number,
  ownerTag: string,
  memberCount: number,
  squadSize: number,
  hasAir: boolean,
): BublikEmbed {
  return new BublikEmbed()
    .setTitle(`🏰 ОТРЯД ${squadNumber} — Панель командира`)
    .setDescription(
      `**Командир:** ${ownerTag}\n` +
      `**Бойцов:** ${memberCount}/${squadSize}${hasAir ? ' (с авиацией)' : ''}\n\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
      `📢 **РАСПОРЯЖЕНИЯ** — мьютит всех бойцов на 30 сек.\n` +
      `Командир отдаёт приказы, все слушают.\n\n` +
      `👢 **КИК** — выбор участника для отключения\n` +
      `из голосового канала отряда.\n\n` +
      `🔇 **МЬЮТ** — выбор участника для\n` +
      `мьюта/размьюта микрофона.\n\n` +
      `📩 **ПИНГ В ЛС** — рассылка в личные сообщения\n` +
      `всем доступным бойцам (кулдаун 5 мин).\n\n` +
      `✈️ **АВИАЦИЯ** — создать авиа-канал (до 4 чел.),\n` +
      `привязанный к этому отряду.\n\n` +
      `🔄 **ПЕРЕДАТЬ ПРАВА** — передать управление\n` +
      `отрядом другому бойцу.\n\n` +
      `⚠️ **ВЫГОВОР** — официальное дисциплинарное\n` +
      `взыскание с выбором типа и причины.\n\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
    )
    .setColor(0x2b5e2b);
}

export function buildControlPanelButtons(
  squadId: string,
  hasAir: boolean,
): ActionRowBuilder<ButtonBuilder>[] {
  const row1 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`${RB_PREFIX}${RB_SEP}orders${RB_SEP}${squadId}`)
      .setLabel('📢 РАСПОРЯЖЕНИЯ')
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId(`${RB_PREFIX}${RB_SEP}kick${RB_SEP}${squadId}`)
      .setLabel('👢 КИК')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`${RB_PREFIX}${RB_SEP}mutetoggle${RB_SEP}${squadId}`)
      .setLabel('🔇 МЬЮТ')
      .setStyle(ButtonStyle.Secondary),
  );

  const row2 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`${RB_PREFIX}${RB_SEP}dmping${RB_SEP}${squadId}`)
      .setLabel('📩 ПИНГ В ЛС')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`${RB_PREFIX}${RB_SEP}aviation${RB_SEP}${squadId}`)
      .setLabel('✈️ АВИАЦИЯ')
      .setStyle(ButtonStyle.Success)
      .setDisabled(hasAir),
  );

  const row3 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`${RB_PREFIX}${RB_SEP}transfer${RB_SEP}${squadId}`)
      .setLabel('🔄 ПЕРЕДАТЬ ПРАВА')
      .setStyle(ButtonStyle.Secondary),
  );

  const row4 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`${RB_PREFIX}${RB_SEP}reprimand${RB_SEP}${squadId}`)
      .setLabel('⚠️ ВЫГОВОР')
      .setStyle(ButtonStyle.Danger),
  );

  return [row1, row2, row3, row4];
}

// ═══════════════════════════════════════════════
//  Селекторы (кик, передача прав)
// ═══════════════════════════════════════════════

export function buildKickSelect(
  squadId: string,
  members: { id: string; displayName: string }[],
): ActionRowBuilder<StringSelectMenuBuilder> {
  const select = new StringSelectMenuBuilder()
    .setCustomId(`${RB_PREFIX}${RB_SEP}sel${RB_SEP}kick${RB_SEP}${squadId}`)
    .setPlaceholder('Выберите бойца для кика')
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
): ActionRowBuilder<StringSelectMenuBuilder> {
  const select = new StringSelectMenuBuilder()
    .setCustomId(`${RB_PREFIX}${RB_SEP}sel${RB_SEP}transfer${RB_SEP}${squadId}`)
    .setPlaceholder('Выберите нового командира')
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
): ActionRowBuilder<StringSelectMenuBuilder> {
  const select = new StringSelectMenuBuilder()
    .setCustomId(`${RB_PREFIX}${RB_SEP}sel${RB_SEP}mutetoggle${RB_SEP}${squadId}`)
    .setPlaceholder('Выберите бойца для мьюта/размьюта')
    .setMinValues(1)
    .setMaxValues(1)
    .addOptions(
      members.map((m) => ({
        label: `${m.muted ? '🔇' : '🔊'} ${m.displayName}`.slice(0, 100),
        description: m.muted ? 'Сейчас замьючен — нажмите для размьюта' : 'Не замьючен — нажмите для мьюта',
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
): ActionRowBuilder<UserSelectMenuBuilder> {
  const select = new UserSelectMenuBuilder()
    .setCustomId(`${RB_PREFIX}${RB_SEP}sel${RB_SEP}rep_user${RB_SEP}${squadId}`)
    .setPlaceholder('Выберите нарушителя')
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
): ActionRowBuilder<StringSelectMenuBuilder> {
  const select = new StringSelectMenuBuilder()
    .setCustomId(`${RB_PREFIX}${RB_SEP}sel${RB_SEP}rep_type${RB_SEP}${squadId}${RB_SEP}${offenderId}`)
    .setPlaceholder('Выберите тип выговора')
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
): BublikEmbed {
  return new BublikEmbed()
    .setTitle(`🏰 ОТРЯД ${squadNumber} — СБОР!`)
    .setDescription(
      `Создан **ОТРЯД ${squadNumber}** для полкового боя!\n\n` +
      `> 🎖️ **Командир:** ${commander.toString()}\n` +
      `> 🔊 **Канал:** <#${voiceChannelId}>\n\n` +
      `Бойцы, занимайте позиции!`,
    )
    .setColor(0xff6600)
    .setThumbnail(commander.displayAvatarURL({ size: 128 }));
}

export function buildRecruitPingEmbed(
  squads: { number: number; count: number; size: number; voiceChannelId: string; ownerTag: string }[],
): BublikEmbed {
  const lines = squads.map((s) => {
    const status = s.count >= s.size ? '✅' : '⚠️';
    return `${status} **ОТРЯД ${s.number}** — ${s.count}/${s.size} | Командир: ${s.ownerTag} | <#${s.voiceChannelId}>`;
  });

  const unfilled = squads.filter((s) => s.count < s.size);
  const needed = unfilled.reduce((sum, s) => sum + (s.size - s.count), 0);

  return new BublikEmbed()
    .setTitle('🔔 СБОР НА ПБ — нужны бойцы!')
    .setDescription(
      lines.join('\n') + '\n\n' +
      `Не хватает **${needed}** бойцов. Заходите в голосовой канал!`,
    )
    .setColor(0xff9900);
}

export function buildFullSuggestEmbed(
  reserveChannelId: string,
): BublikEmbed {
  return new BublikEmbed()
    .setTitle('✅ Отряды укомплектованы!')
    .setDescription(
      `Все отряды заполнены.\n\n` +
      `Запасные бойцы — переходите в <#${reserveChannelId}> и ожидайте.`,
    )
    .setColor(0x57f287);
}

export function buildIndividualPingMessage(
  member: GuildMember,
  squads: { number: number; count: number; size: number; voiceChannelId: string }[],
): string {
  const unfilled = squads.filter((s) => s.count < s.size);
  if (unfilled.length === 0) return '';

  const targets = unfilled
    .map((s) => `ОТРЯД ${s.number} (${s.count}/${s.size}) — <#${s.voiceChannelId}>`)
    .join(', ');

  return `${member.toString()}, нужна твоя помощь! Заходи: ${targets}`;
}

// ═══════════════════════════════════════════════
//  DM-пинг
// ═══════════════════════════════════════════════

export function buildDmPingEmbed(
  squadNumber: number,
  commanderName: string,
  voiceChannelId: string,
  guildName: string,
): BublikEmbed {
  return new BublikEmbed()
    .setTitle('🏰 СБОР НА ПОЛКОВОЙ БОЙ!')
    .setDescription(
      `**${guildName}** — требуются бойцы!\n\n` +
      `> 🎖️ **ОТРЯД ${squadNumber}** | Командир: ${commanderName}\n` +
      `> 🔊 Заходи в <#${voiceChannelId}>\n\n` +
      `Не заставляй отряд ждать!`,
    )
    .setColor(0xff6600);
}

export function buildDmPingReport(
  delivered: string[],
  failed: string[],
): BublikEmbed {
  const lines: string[] = [];

  if (delivered.length > 0) {
    lines.push(`✅ **Доставлено (${delivered.length}):**`);
    lines.push(delivered.map((tag) => `> ${tag}`).join('\n'));
  }

  if (failed.length > 0) {
    if (lines.length > 0) lines.push('');
    lines.push(`❌ **Не доставлено (${failed.length}):**`);
    lines.push(failed.map((tag) => `> ${tag} *(ЛС закрыты)*`).join('\n'));
  }

  let description = lines.join('\n');
  if (description.length > 4000) {
    description = description.slice(0, 3950) + '\n\n… и ещё';
  }

  return new BublikEmbed()
    .setTitle('📩 Результат рассылки в ЛС')
    .setDescription(description || 'Нет получателей.')
    .setColor(failed.length === 0 ? 0x57f287 : 0xfee75c);
}

// ═══════════════════════════════════════════════
//  Распоряжения (мьют)
// ═══════════════════════════════════════════════

export function buildOrdersActiveEmbed(secondsLeft: number): BublikEmbed {
  return new BublikEmbed()
    .setTitle('📢 РАСПОРЯЖЕНИЯ')
    .setDescription(
      `Все бойцы замьючены на **${secondsLeft} сек.**\n` +
      `Командир отдаёт приказы. Слушайте внимательно!`,
    )
    .setColor(0xed4245);
}

export function buildOrdersEndedEmbed(): BublikEmbed {
  return new BublikEmbed()
    .setDescription('📢 Распоряжения завершены. Микрофоны восстановлены.')
    .setColor(0x57f287);
}

// ═══════════════════════════════════════════════
//  Хелперы
// ═══════════════════════════════════════════════

export function rbSuccess(text: string): BublikEmbed {
  return new BublikEmbed().setDescription(`✅ ${text}`).setColor(0x57f287);
}

export function rbError(text: string): BublikEmbed {
  return new BublikEmbed().setDescription(`❌ ${text}`).setColor(0xed4245);
}

export function rbWarn(text: string): BublikEmbed {
  return new BublikEmbed().setDescription(`⚠️ ${text}`).setColor(0xfee75c);
}

export function rbInfo(text: string): BublikEmbed {
  return new BublikEmbed().setDescription(`ℹ️ ${text}`).setColor(0x5865f2);
}

// ═══════════════════════════════════════════════
//  Лог расформирования
// ═══════════════════════════════════════════════

export function buildSquadDisbandedEmbed(squadNumber: number): BublikEmbed {
  return new BublikEmbed()
    .setTitle(`🏰 ОТРЯД ${squadNumber} — расформирован`)
    .setDescription('Голосовой канал опустел. Отряд расформирован.')
    .setColor(0x99aab5);
}
