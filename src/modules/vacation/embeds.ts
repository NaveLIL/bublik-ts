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
import { VAC_PREFIX, VAC_SEP, REASONS, VacationStatus, getReasonLabel } from './constants';
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

export function buildPanelEmbed(config: VacationConfig): BublikEmbed {
  const embed = new BublikEmbed()
    .setColor(COLOR_PANEL)
    .setTitle('🏖️ Система Управления Отпусками')
    .setDescription(
      'Здесь вы можете официально уведомить о своём временном ' +
      'отсутствии в клане или досрочно вернуться из него.\n\n' +
      '⚠️ **Важно:** Все заявки на отпуск требуют одобрения от командования.',
    )
    .setFooter({
      text: `Бублик | Система автоматизации • Макс. срок: ${config.maxDurationDays} дн.`,
    })
    .setTimestamp();

  if (config.imageUrl) {
    embed.setImage(config.imageUrl);
  }

  return embed;
}

export function buildPanelButtons(): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(cid('go'))
      .setLabel('Уйти в отпуск')
      .setEmoji('🚫')
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId(cid('return'))
      .setLabel('Вернуться из отпуска')
      .setEmoji('🎉')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(cid('quick'))
      .setLabel('Не смогу сегодня')
      .setEmoji('👋')
      .setStyle(ButtonStyle.Secondary),
  );
}

// ═══════════════════════════════════════════════
//  Выбор причины (StringSelectMenu)
// ═══════════════════════════════════════════════

export function buildReasonSelect(): ActionRowBuilder<StringSelectMenuBuilder> {
  const menu = new StringSelectMenuBuilder()
    .setCustomId(cid('sel', 'reason'))
    .setPlaceholder('Выберите причину отпуска...')
    .setMinValues(1)
    .setMaxValues(1);

  for (const r of REASONS) {
    menu.addOptions({
      label: r.label,
      value: r.value,
      emoji: r.emoji,
    });
  }

  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu);
}

// ═══════════════════════════════════════════════
//  Модальное окно длительности
// ═══════════════════════════════════════════════

export function buildDurationModal(reason: string): ModalBuilder {
  const modal = new ModalBuilder()
    .setCustomId(cid('modal', 'duration', reason))
    .setTitle('Длительность отпуска');

  // Для «Другое» — добавляем поле причины
  if (reason === 'other') {
    modal.addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId('reason_text')
          .setLabel('Причина отпуска')
          .setStyle(TextInputStyle.Short)
          .setPlaceholder('Опишите вашу причину...')
          .setRequired(true)
          .setMaxLength(200),
      ),
    );
  }

  modal.addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder()
        .setCustomId('duration')
        .setLabel('Срок (например: 3d, 2w, 1m)')
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
): BublikEmbed {
  const endDate = new Date(Date.now() + request.durationMinutes * 60_000);

  return new BublikEmbed()
    .setColor(COLOR_REVIEW)
    .setAuthor({ name: '📋 Заявка на отпуск', iconURL: member.displayAvatarURL() })
    .setDescription(
      `> 👤 **Участник:** ${member.toString()} (${member.user.tag})\n` +
      `> 📝 **Причина:** ${request.reason}\n` +
      `> ⏳ **Срок:** ${formatDuration(request.durationMinutes)}\n` +
      `> 📅 **До:** ${formatDateMsk(endDate)}\n\n` +
      `⏰ Автоматическое отклонение через **3 часа**`,
    )
    .setThumbnail(member.displayAvatarURL({ size: 128 }))
    .setTimestamp();
}

export function buildRequestButtons(requestId: string): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(cid('approve', requestId))
      .setLabel('Одобрить')
      .setEmoji('✅')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(cid('deny', requestId))
      .setLabel('Отклонить')
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
): BublikEmbed {
  return new BublikEmbed()
    .setColor(COLOR_SUCCESS)
    .setAuthor({ name: '✅ Заявка одобрена', iconURL: member.displayAvatarURL() })
    .setDescription(
      `> 👤 **Участник:** ${member.toString()}\n` +
      `> 📝 **Причина:** ${request.reason}\n` +
      `> ⏳ **Срок:** ${formatDuration(request.durationMinutes)}\n` +
      `> 📅 **До:** ${formatDateMsk(request.endDate!)}\n` +
      `> 👮 **Одобрил:** ${reviewer.toString()}`,
    )
    .setTimestamp();
}

export function buildDeniedRequestEmbed(
  request: VacationRequest,
  member: GuildMember,
  reviewer: GuildMember | null,
  selfCancel: boolean = false,
): BublikEmbed {
  const title = selfCancel ? '🔙 Заявка отозвана' : '❌ Заявка отклонена';

  return new BublikEmbed()
    .setColor(COLOR_DANGER)
    .setAuthor({ name: title, iconURL: member.displayAvatarURL() })
    .setDescription(
      `> 👤 **Участник:** ${member.toString()}\n` +
      `> 📝 **Причина:** ${request.reason}\n` +
      `> ⏳ **Срок:** ${formatDuration(request.durationMinutes)}\n` +
      (reviewer ? `> 👮 **${selfCancel ? 'Отозвал' : 'Отклонил'}:** ${reviewer.toString()}` : ''),
    )
    .setTimestamp();
}

export function buildExpiredRequestEmbed(
  request: VacationRequest,
  member: GuildMember | null,
): BublikEmbed {
  const userText = member
    ? `${member.toString()} (${member.user.tag})`
    : `<@${request.userId}>`;

  return new BublikEmbed()
    .setColor(COLOR_EXPIRED)
    .setAuthor({ name: '⏰ Заявка истекла' })
    .setDescription(
      `> 👤 **Участник:** ${userText}\n` +
      `> 📝 **Причина:** ${request.reason}\n` +
      `> ⏳ **Срок:** ${formatDuration(request.durationMinutes)}\n\n` +
      `Заявка не была рассмотрена в течение 3 часов.`,
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
): BublikEmbed {
  const rolesText = savedRoles.length > 0
    ? savedRoles.map((id) => `<@&${id}>`).join(', ')
    : '*нет*';

  const typeLabel = request.type === 'quick' ? '⚡ Быстрый отпуск' :
                    request.type === 'admin' ? '👮 Принудительный' : '🏖️ Отпуск';

  return new BublikEmbed()
    .setColor(COLOR_VACATION)
    .setAuthor({ name: `${typeLabel} — уход`, iconURL: member.displayAvatarURL() })
    .setDescription(
      `> 👤 **Участник:** ${member.toString()}\n` +
      `> 📝 **Причина:** ${request.reason}\n` +
      `> ⏳ **Срок:** ${formatDuration(request.durationMinutes)}\n` +
      `> 📅 **До:** ${formatDateMsk(request.endDate!)}\n` +
      `> 🔄 **Снятые роли:** ${rolesText}`,
    )
    .setTimestamp();
}

export function buildVacationEndLog(
  member: GuildMember,
  request: VacationRequest,
  early: boolean,
): BublikEmbed {
  const actualMinutes = request.startDate
    ? Math.floor((Date.now() - request.startDate.getTime()) / 60_000)
    : request.durationMinutes;

  const rolesText = request.savedRoleIds.length > 0
    ? request.savedRoleIds.map((id) => `<@&${id}>`).join(', ')
    : '*нет*';

  return new BublikEmbed()
    .setColor(COLOR_SUCCESS)
    .setAuthor({
      name: early ? '🎉 Досрочный возврат' : '🎉 Отпуск завершён',
      iconURL: member.displayAvatarURL(),
    })
    .setDescription(
      `> 👤 **Участник:** ${member.toString()}\n` +
      `> ⏳ **Был в отпуске:** ${formatDuration(actualMinutes)}\n` +
      `> 🔄 **Восстановленные роли:** ${rolesText}`,
    )
    .setTimestamp();
}

// ═══════════════════════════════════════════════
//  DM уведомления
// ═══════════════════════════════════════════════

export function buildDmApproved(request: VacationRequest): BublikEmbed {
  return new BublikEmbed()
    .setColor(COLOR_SUCCESS)
    .setTitle('✅ Ваша заявка на отпуск одобрена!')
    .setDescription(
      `**Причина:** ${request.reason}\n` +
      `**Срок:** ${formatDuration(request.durationMinutes)}\n` +
      `**До:** ${formatDateMsk(request.endDate!)}\n\n` +
      `Ваши роли были временно сняты и будут восстановлены по возвращении.\n` +
      `Чтобы вернуться досрочно, нажмите **«Вернуться из отпуска»** на панели.`,
    )
    .setTimestamp();
}

export function buildDmDenied(request: VacationRequest): BublikEmbed {
  return new BublikEmbed()
    .setColor(COLOR_DANGER)
    .setTitle('❌ Ваша заявка на отпуск отклонена')
    .setDescription(
      `**Причина заявки:** ${request.reason}\n` +
      `**Срок:** ${formatDuration(request.durationMinutes)}\n\n` +
      `Обратитесь к командованию за подробностями.`,
    )
    .setTimestamp();
}

export function buildDmExpired(request: VacationRequest): BublikEmbed {
  return new BublikEmbed()
    .setColor(COLOR_EXPIRED)
    .setTitle('⏰ Заявка на отпуск истекла')
    .setDescription(
      `Ваша заявка не была рассмотрена в течение 3 часов и автоматически отклонена.\n\n` +
      `**Причина:** ${request.reason}\n` +
      `**Срок:** ${formatDuration(request.durationMinutes)}\n\n` +
      `Вы можете подать заявку повторно.`,
    )
    .setTimestamp();
}

export function buildDmReminder(request: VacationRequest): BublikEmbed {
  return new BublikEmbed()
    .setColor(COLOR_WARNING)
    .setTitle('⏳ Ваш отпуск скоро заканчивается!')
    .setDescription(
      `Ваш отпуск заканчивается **${formatDateMsk(request.endDate!)}** ` +
      `(осталось ${formatTimeLeft(request.endDate!)}).\n\n` +
      `По окончании ваши роли будут восстановлены автоматически.\n` +
      `Если нужно продлить — обратитесь к командованию.`,
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
