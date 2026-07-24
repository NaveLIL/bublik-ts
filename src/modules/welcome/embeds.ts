import { GuildMember } from 'discord.js';
import { BublikEmbed } from '../../core/EmbedBuilder';
import { Config } from '../../config';
import { i18n } from '../../core/I18n';

// ── Цвета ──────────────────────────────────────
const COLOR_WELCOME  = 0xf5a623; // тёплый янтарь
const COLOR_RECRUIT  = 0x5865f2; // blurple
const COLOR_RULES    = 0xed4245; // красный — серьёзные правила
const COLOR_REGIMENT = 0x2ecc71; // зелёный — честь полка
const COLOR_SUCCESS  = 0x57f287; // зелёный — успех
const COLOR_OTHER    = 0x99aab5; // серый — прочее

// ═══════════════════════════════════════════════
//  1. Приветственное сообщение (публичное, в канале)
// ═══════════════════════════════════════════════

export function buildWelcomeEmbed(member: GuildMember, locale: string): BublikEmbed {
  return new BublikEmbed()
    .setColor(COLOR_WELCOME)
    .setAuthor({
      name: i18n.t('welcome.greeting_author', locale, { botName: Config.botName }),
      iconURL: member.guild.iconURL({ size: 64 }) ?? undefined,
    })
    .setThumbnail(member.user.displayAvatarURL({ size: 256 }))
    .setDescription(
      i18n.t('welcome.greeting_desc', locale, { userId: member.id, server: member.guild.name }),
    );
}

/** Обновлённый embed после выбора (публичный, без кнопок) */
export function buildWelcomeChosenEmbed(member: GuildMember, choiceJoin: boolean, locale: string): BublikEmbed {
  const choiceText = choiceJoin
    ? i18n.t('welcome.chosen_join', locale)
    : i18n.t('welcome.chosen_other', locale);

  return new BublikEmbed()
    .setColor(COLOR_WELCOME)
    .setAuthor({
      name: i18n.t('welcome.greeting_author', locale, { botName: Config.botName }),
      iconURL: member.guild.iconURL({ size: 64 }) ?? undefined,
    })
    .setThumbnail(member.user.displayAvatarURL({ size: 256 }))
    .setDescription(
      i18n.t('welcome.chosen_desc', locale, { userId: member.id, server: member.guild.name, choice: choiceText }),
    );
}

// ═══════════════════════════════════════════════
//  2. Промпт ознакомления с правилами (ephemeral)
// ═══════════════════════════════════════════════

export function buildRulesPromptEmbed(
  serverRead: boolean,
  regimentRead: boolean,
  locale: string,
): BublikEmbed {
  const sIcon = serverRead ? '✅' : '❌';
  const rIcon = regimentRead ? '✅' : '❌';
  const sText = serverRead
    ? i18n.t('welcome.rules_prompt_status_read', locale)
    : i18n.t('welcome.rules_prompt_status_unread', locale);
  const rText = regimentRead
    ? i18n.t('welcome.rules_prompt_status_read', locale)
    : i18n.t('welcome.rules_prompt_status_unread', locale);

  const allRead = serverRead && regimentRead;

  let description = i18n.t('welcome.rules_prompt_desc', locale);

  if (allRead) {
    description +=
      '\n\n' +
      '─────────────────────────────\n' +
      i18n.t('welcome.rules_prompt_all_read', locale);
  }

  return new BublikEmbed()
    .setColor(COLOR_RECRUIT)
    .setAuthor({ name: i18n.t('welcome.rules_prompt_author', locale) })
    .setDescription(description)
    .addFields({
      name: i18n.t('welcome.rules_prompt_field_name', locale),
      value: [
        i18n.t('welcome.rules_prompt_server_line', locale, { icon: sIcon, status: sText }),
        i18n.t('welcome.rules_prompt_regiment_line', locale, { icon: rIcon, status: rText }),
      ].join('\n'),
    });
}

// ═══════════════════════════════════════════════
//  3. ПРАВИЛА СЕРВЕРА EREZ (ephemeral)
// ═══════════════════════════════════════════════

export function buildServerRulesEmbeds(locale: string): BublikEmbed[] {
  // Embed 1: Основные положения + Коммуникационные запреты
  const embed1 = new BublikEmbed()
    .setColor(COLOR_RULES)
    .setAuthor({ name: i18n.t('welcome.server_rules_author', locale) })
    .setDescription(i18n.t('welcome.server_rules_disclaimer', locale))
    .addFields(
      {
        name: i18n.t('welcome.server_rules_general_title', locale),
        value: i18n.t('welcome.server_rules_general_value', locale),
      },
      {
        name: i18n.t('welcome.server_rules_comms_title', locale),
        value: i18n.t('welcome.server_rules_comms_value', locale),
      },
    );

  // Embed 2: Флуд, бан, профиль, дополнение
  const embed2 = new BublikEmbed()
    .setColor(COLOR_RULES)
    .addFields(
      {
        name: i18n.t('welcome.server_rules_spam_title', locale),
        value: i18n.t('welcome.server_rules_spam_value', locale),
      },
      {
        name: i18n.t('welcome.server_rules_zero_title', locale),
        value: i18n.t('welcome.server_rules_zero_value', locale),
        inline: true,
      },
      {
        name: i18n.t('welcome.server_rules_bots_title', locale),
        value: i18n.t('welcome.server_rules_bots_value', locale),
        inline: true,
      },
      {
        name: i18n.t('welcome.server_rules_profile_title', locale),
        value: i18n.t('welcome.server_rules_profile_value', locale),
      },
      {
        name: i18n.t('welcome.server_rules_note_title', locale),
        value: i18n.t('welcome.server_rules_note_value', locale),
      },
    );

  return [embed1, embed2];
}

// ═══════════════════════════════════════════════
//  4. ПРАВИЛА ПОЛКА EREZ (ephemeral)
// ═══════════════════════════════════════════════

export function buildRegimentRulesEmbed(locale: string): BublikEmbed {
  return new BublikEmbed()
    .setColor(COLOR_REGIMENT)
    .setAuthor({ name: i18n.t('welcome.regiment_rules_author', locale) })
    .addFields(
      {
        name: i18n.t('welcome.regiment_rules_duties_title', locale),
        value: i18n.t('welcome.regiment_rules_duties_value', locale),
      },
      {
        name: i18n.t('welcome.regiment_rules_rewards_title', locale),
        value: i18n.t('welcome.regiment_rules_rewards_value', locale),
        inline: true,
      },
      {
        name: i18n.t('welcome.regiment_rules_officers_title', locale),
        value: i18n.t('welcome.regiment_rules_officers_value', locale),
        inline: true,
      },
    )
    .setDescription(
      i18n.t('welcome.regiment_rules_quote', locale),
    );
}

// ═══════════════════════════════════════════════
//  5. Перенаправление в канал тикетов (ephemeral)
// ═══════════════════════════════════════════════

/** После "Ознакомился с правилами" */
export function buildJoinCompleteEmbed(ticketChannelId: string, locale: string): BublikEmbed {
  return new BublikEmbed()
    .setColor(COLOR_SUCCESS)
    .setAuthor({ name: i18n.t('welcome.join_complete_author', locale) })
    .setDescription(
      i18n.t('welcome.join_complete_desc', locale, { ticketChannel: ticketChannelId }),
    );
}

/** После "Другой вопрос" */
export function buildOtherQuestionEmbed(ticketChannelId: string, locale: string): BublikEmbed {
  return new BublikEmbed()
    .setColor(COLOR_OTHER)
    .setAuthor({ name: i18n.t('welcome.other_question_author', locale) })
    .setDescription(
      i18n.t('welcome.other_question_desc', locale, { ticketChannel: ticketChannelId }),
    );
}

// ═══════════════════════════════════════════════
//  6. Пинг в канале тикетов (публичное)
// ═══════════════════════════════════════════════

export function buildTicketPingEmbed(userId: string, isRecruit: boolean, locale: string): BublikEmbed {
  if (isRecruit) {
    return new BublikEmbed()
      .setColor(COLOR_SUCCESS)
      .setDescription(
        i18n.t('welcome.ticket_ping_recruit_desc', locale, { userId }),
      );
  }

  return new BublikEmbed()
    .setColor(COLOR_OTHER)
    .setDescription(
      i18n.t('welcome.ticket_ping_other_desc', locale, { userId }),
    );
}

// ═══════════════════════════════════════════════
//  7. Уведомление о выходе участника
// ═══════════════════════════════════════════════

export function buildMemberLeftEmbed(tag: string, userId: string, locale: string): BublikEmbed {
  return new BublikEmbed()
    .setColor(0xff6b6b) // мягкий красный
    .setDescription(i18n.t('welcome.member_left_desc', locale, { userId, tag }))
    .setTimestamp();
}

// ═══════════════════════════════════════════════
//  8. Напоминание для участника без ролей
// ═══════════════════════════════════════════════

export function buildReminderEmbed(userId: string, locale: string): BublikEmbed {
  return new BublikEmbed()
    .setColor(COLOR_WELCOME)
    .setAuthor({ name: i18n.t('welcome.reminder_author', locale) })
    .setDescription(
      i18n.t('welcome.reminder_desc', locale, { userId }),
    );
}
