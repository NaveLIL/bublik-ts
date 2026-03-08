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
import { ChannelState, PanelPage, TV_PREFIX, TV_SEP } from './constants';

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

function stateText(state: string): string {
  switch (state) {
    case ChannelState.Locked: return 'Закрыт';
    case ChannelState.Hidden: return 'Скрыт';
    default: return 'Открыт';
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
): BublikEmbed {
  const limitText = userLimit === 0 ? '∞' : String(userLimit);

  return new BublikEmbed()
    .setColor(stateColor(state))
    .setAuthor({ name: '🎙️ Управление каналом' })
    .setDescription(
      `**${channelName}**\n\n` +
      `> ${stateIcon(state)} Статус: **${stateText(state)}**\n` +
      `> 👑 Владелец: **${ownerTag}**\n` +
      `> 👥 Участники: **${memberCount}**/${limitText}\n` +
      `> 🎚️ Битрейт: **${Math.floor(bitrate / 1000)} кбит/с**`,
    )
    .addFields({
      name: '📖 Навигация',
      value: '`1/3` Основные — `◀ ▶` для переключения страниц',
    });
}

export function buildMainPageButtons(): ActionRowBuilder<ButtonBuilder>[] {
  const row1 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(cid('rename'))
      .setLabel('Имя')
      .setEmoji('✏️')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(cid('limit'))
      .setLabel('Лимит')
      .setEmoji('🔢')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(cid('lock'))
      .setLabel('Закрыть')
      .setEmoji('🔒')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(cid('hide'))
      .setLabel('Скрыть')
      .setEmoji('👻')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(cid('claim'))
      .setLabel('Забрать')
      .setEmoji('👑')
      .setStyle(ButtonStyle.Success),
  );

  const row2 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(cid('page', PanelPage.Access))
      .setLabel('Доступ ▶')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(cid('page', PanelPage.Settings))
      .setLabel('Настройки ▶▶')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(cid('delete'))
      .setLabel('Удалить')
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
): BublikEmbed {
  const trustedText = trustedList.length > 0
    ? trustedList.map((id) => `<@${id}>`).join(', ')
    : '*нет*';
  const blockedText = blockedList.length > 0
    ? blockedList.map((id) => `<@${id}>`).join(', ')
    : '*нет*';

  return new BublikEmbed()
    .setColor(stateColor(state))
    .setAuthor({ name: '🛡️ Управление доступом' })
    .setDescription(
      `${stateIcon(state)} Статус: **${stateText(state)}**\n\n` +
      `Используйте кнопки ниже для управления\n` +
      `доступом пользователей к каналу.`,
    )
    .addFields(
      {
        name: '✅ Доверенные',
        value: trustedText,
        inline: true,
      },
      {
        name: '⛔ Заблокированные',
        value: blockedText,
        inline: true,
      },
    )
    .addFields({
      name: '📖 Навигация',
      value: '`2/3` Доступ — `◀ ▶` для переключения страниц',
    });
}

export function buildAccessPageButtons(): ActionRowBuilder<ButtonBuilder>[] {
  const row1 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(cid('trust'))
      .setLabel('Доверить')
      .setEmoji('✅')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(cid('untrust'))
      .setLabel('Убрать доверие')
      .setEmoji('🚫')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(cid('block'))
      .setLabel('Заблокировать')
      .setEmoji('⛔')
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId(cid('unblock'))
      .setLabel('Разблокировать')
      .setEmoji('⭕')
      .setStyle(ButtonStyle.Secondary),
  );

  const row2 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(cid('kick'))
      .setLabel('Выгнать')
      .setEmoji('👢')
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId(cid('transfer'))
      .setLabel('Передать')
      .setEmoji('🔄')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(cid('invite'))
      .setLabel('Пригласить')
      .setEmoji('📨')
      .setStyle(ButtonStyle.Primary),
  );

  const row3 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(cid('page', PanelPage.Main))
      .setLabel('◀ Основные')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(cid('page', PanelPage.Settings))
      .setLabel('Настройки ▶')
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
): BublikEmbed {
  const regionLabel = region === 'auto' ? '🌐 Авто' : region;

  return new BublikEmbed()
    .setColor(stateColor(state))
    .setAuthor({ name: '⚙️ Настройки канала' })
    .setDescription(
      `Дополнительные настройки вашего канала.\n\n` +
      `> 🌐 Регион: **${regionLabel}**\n` +
      `> 🎚️ Битрейт: **${Math.floor(bitrate / 1000)} кбит/с**`,
    )
    .addFields(
      {
        name: '💡 Подсказка',
        value:
          '**Бустеры** получают доступ к переименованию, лимиту и битрейту.\n' +
          '**🏆 Наградная роль** (за активность в войсе) даёт ещё и смену региона. ' +
          'Используйте `/voice stats` для проверки прогресса.',
      },
    )
    .addFields({
      name: '📖 Навигация',
      value: '`3/3` Настройки — `◀ ▶` для переключения страниц',
    });
}

export function buildSettingsPageButtons(): ActionRowBuilder<ButtonBuilder>[] {
  const row1 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(cid('bitrate'))
      .setLabel('Битрейт')
      .setEmoji('🎚️')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(cid('region'))
      .setLabel('Регион')
      .setEmoji('🌐')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(cid('save'))
      .setLabel('Сохранить')
      .setEmoji('💾')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(cid('reset'))
      .setLabel('Сбросить')
      .setEmoji('🔄')
      .setStyle(ButtonStyle.Secondary),
  );

  const row2 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(cid('page', PanelPage.Main))
      .setLabel('◀ Основные')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(cid('page', PanelPage.Access))
      .setLabel('◀ Доступ')
      .setStyle(ButtonStyle.Secondary),
  );

  return [row1, row2];
}

// ═══════════════════════════════════════════════
//  Подтверждение удаления
// ═══════════════════════════════════════════════

export function buildDeleteConfirmEmbed(): BublikEmbed {
  return new BublikEmbed()
    .setColor(COLOR_DANGER)
    .setAuthor({ name: '🗑️ Удаление канала' })
    .setDescription(
      '**Вы уверены?**\n\n' +
      'Канал и все его настройки будут **безвозвратно удалены**.\n' +
      'Это действие нельзя отменить.',
    );
}

export function buildDeleteConfirmButtons(): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(cid('delete_yes'))
      .setLabel('Да, удалить')
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId(cid('delete_no'))
      .setLabel('Отмена')
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
): BublikEmbed {
  return new BublikEmbed()
    .setColor(COLOR_REWARD)
    .setAuthor({ name: '🏆 Награда за активность!', iconURL: member.displayAvatarURL() })
    .setDescription(
      `Поздравляем **${member.displayName}**! 🎉\n\n` +
      `Проведя **${totalHours} часов** в голосовых каналах, ` +
      `${member.toString()} заслужил роль <@&${rewardRoleId}>!\n\n` +
      `> 🎙️ Теперь доступны расширенные возможности в temp-каналах:\n` +
      `> ✏️ Переименование · 🔢 Лимит · 🎚️ Битрейт · 🌐 Регион\n\n` +
      `Общайтесь больше — получайте больше!`,
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
): ActionRowBuilder<StringSelectMenuBuilder> {
  const menu = new StringSelectMenuBuilder()
    .setCustomId(cid('sel', 'kick'))
    .setPlaceholder('Выберите участника…')
    .setMinValues(1)
    .setMaxValues(1);

  for (const m of members.slice(0, 25)) {
    menu.addOptions({ label: m.tag, value: m.id });
  }

  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu);
}

export function buildTransferSelect(
  members: { id: string; tag: string }[],
): ActionRowBuilder<StringSelectMenuBuilder> {
  const menu = new StringSelectMenuBuilder()
    .setCustomId(cid('sel', 'transfer'))
    .setPlaceholder('Выберите нового владельца…')
    .setMinValues(1)
    .setMaxValues(1);

  for (const m of members.slice(0, 25)) {
    menu.addOptions({ label: m.tag, value: m.id });
  }

  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu);
}
