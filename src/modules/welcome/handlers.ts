import {
  ButtonInteraction,
  ButtonBuilder,
  ButtonStyle,
  ActionRowBuilder,
  GuildMember,
  BaseGuildTextChannel,
} from 'discord.js';
import type { BublikClient } from '../../bot';
import { Config } from '../../config';
import { cacheGet, cacheSet, cacheDel } from '../../core/Redis';
import { logger } from '../../core/Logger';
import { errorReporter } from '../../core/ErrorReporter';
import {
  buildWelcomeChosenEmbed,
  buildRulesPromptEmbed,
  buildServerRulesEmbeds,
  buildRegimentRulesEmbed,
  buildJoinCompleteEmbed,
  buildOtherQuestionEmbed,
  buildTicketPingEmbed,
} from './embeds';

const log = logger.child('Welcome');

// ── Префикс customId ────────────────────────────
const PREFIX = 'welcome';

// ── Rate-limit кнопок (защита от спама) ──────────
const BUTTON_COOLDOWN_MS = 3_000; // 3 секунды между нажатиями
const buttonCooldowns = new Map<string, number>();

function isButtonRateLimited(userId: string): boolean {
  const now = Date.now();
  const last = buttonCooldowns.get(userId);
  if (last && now - last < BUTTON_COOLDOWN_MS) return true;
  buttonCooldowns.set(userId, now);
  return false;
}

// Периодическая очистка устаревших записей (каждые 5 мин)
setInterval(() => {
  const now = Date.now();
  for (const [key, ts] of buttonCooldowns) {
    if (now - ts > BUTTON_COOLDOWN_MS * 2) buttonCooldowns.delete(key);
  }
}, 300_000);

// ── Redis: состояние прочтения правил ────────────
interface RulesState {
  serverRules: boolean;
  regimentRules: boolean;
}

const STATE_TTL = 86_400; // 24 часа — запас если пользователь отвлёкся / бот перезапустился

async function getState(userId: string): Promise<RulesState> {
  const cached = await cacheGet<RulesState>(`welcome:state:${userId}`);
  return cached ?? { serverRules: false, regimentRules: false };
}

async function setState(userId: string, state: RulesState): Promise<void> {
  await cacheSet(`welcome:state:${userId}`, state, STATE_TTL);
}

export async function clearState(userId: string): Promise<void> {
  await cacheDel(`welcome:state:${userId}`);
}

// ── Redis: пометка «напомнили» (антиспам) ────────
const REMINDED_TTL = 3600; // не чаще 1 раза в час

export async function markReminded(userId: string): Promise<void> {
  await cacheSet(`welcome:reminded:${userId}`, true, REMINDED_TTL);
}

export async function isReminded(userId: string): Promise<boolean> {
  return (await cacheGet(`welcome:reminded:${userId}`)) !== null;
}

export async function clearReminded(userId: string): Promise<void> {
  await cacheDel(`welcome:reminded:${userId}`);
}

// ═══════════════════════════════════════════════
//  Компоненты (кнопки)
// ═══════════════════════════════════════════════

/** Кнопки начального приветствия */
export function buildWelcomeButtons(userId: string): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`${PREFIX}:join:${userId}`)
      .setLabel('Вступление в полк')
      .setEmoji('🎖️')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`${PREFIX}:other:${userId}`)
      .setLabel('Другой вопрос')
      .setEmoji('❓')
      .setStyle(ButtonStyle.Secondary),
  );
}

/** Кнопки ознакомления с правилами */
function buildRulesButtons(
  userId: string,
  serverRead: boolean,
  regimentRead: boolean,
): ActionRowBuilder<ButtonBuilder> {
  const allRead = serverRead && regimentRead;

  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`${PREFIX}:rules_server:${userId}`)
      .setLabel('Правила сервера')
      .setEmoji('📜')
      .setStyle(serverRead ? ButtonStyle.Secondary : ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`${PREFIX}:rules_regiment:${userId}`)
      .setLabel('Правила полка')
      .setEmoji('⚔️')
      .setStyle(regimentRead ? ButtonStyle.Secondary : ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`${PREFIX}:rules_done:${userId}`)
      .setLabel('Ознакомился с правилами')
      .setEmoji('✅')
      .setStyle(ButtonStyle.Success)
      .setDisabled(!allRead),
  );
}

/** Кнопка «Назад к прогрессу» — показывается поверх страницы с правилами */
function buildBackButton(userId: string): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`${PREFIX}:rules_back:${userId}`)
      .setLabel('← Назад к прогрессу')
      .setStyle(ButtonStyle.Secondary),
  );
}

// ═══════════════════════════════════════════════
//  Центральный обработчик кнопок
// ═══════════════════════════════════════════════

export async function handleWelcomeButton(
  interaction: ButtonInteraction,
  client: BublikClient,
): Promise<void> {
  const customId = interaction.customId;

  // Все наши кнопки: welcome:<action>:<userId>
  if (!customId.startsWith(`${PREFIX}:`)) return;

  const parts = customId.split(':');
  if (parts.length !== 3) return;

  const [, action, targetUserId] = parts;

  // Защита: только целевой пользователь может нажать
  if (interaction.user.id !== targetUserId) {
    await interaction.reply({
      content: '⛔ Эта кнопка предназначена не для вас.',
      ephemeral: true,
    });
    return;
  }

  // Rate-limit: не чаще раза в 3 секунды
  if (isButtonRateLimited(interaction.user.id)) {
    await interaction.reply({
      content: '⏳ Подождите немного перед следующим нажатием.',
      ephemeral: true,
    });
    return;
  }

  try {
    switch (action) {
      case 'join':
        await handleJoin(interaction, client);
        break;
      case 'other':
        await handleOther(interaction, client);
        break;
      case 'rules_server':
        await handleRulesServer(interaction);
        break;
      case 'rules_regiment':
        await handleRulesRegiment(interaction);
        break;
      case 'rules_back':
        await handleRulesBack(interaction);
        break;
      case 'rules_done':
        await handleRulesDone(interaction, client);
        break;
      default:
        log.warn(`Неизвестное welcome-действие: ${action}`);
    }
  } catch (err) {
    log.error(`Ошибка обработки welcome-кнопки "${action}"`, err);
    errorReporter.componentError(err, interaction, `welcome:${action}`);
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({
        content: '❌ Произошла ошибка. Попробуйте ещё раз.',
        ephemeral: true,
      }).catch(() => {});
    }
  }
}

// ═══════════════════════════════════════════════
//  Обработчики отдельных действий
// ═══════════════════════════════════════════════

/** «Вступление в полк» — показать правила, убрать кнопки из публичного сообщения */
async function handleJoin(interaction: ButtonInteraction, client: BublikClient): Promise<void> {
  const userId = interaction.user.id;
  const member = interaction.member as GuildMember;

  // Сбрасываем состояние чтения правил
  await setState(userId, { serverRules: false, regimentRules: false });

  // Сначала ephemeral reply — только так гарантировано виден пользователю
  await interaction.reply({
    ephemeral: true,
    embeds: [buildRulesPromptEmbed(false, false)],
    components: [buildRulesButtons(userId, false, false)],
  });

  // Потом редактируем публичное сообщение (убираем кнопки)
  await interaction.message.edit({
    embeds: [buildWelcomeChosenEmbed(member, true)],
    components: [],
  }).catch((err) => log.warn('Не удалось обновить welcome-сообщение', err));

  log.info(`[Welcome] ${interaction.user.tag} выбрал вступление в полк`);
}

/** «Другой вопрос» — перенаправить в тикеты */
async function handleOther(interaction: ButtonInteraction, client: BublikClient): Promise<void> {
  const userId = interaction.user.id;
  const member = interaction.member as GuildMember;

  const ticketChannelId = Config.ticketChannelId;

  // Ephemeral reply — гарантированно виден пользователю
  if (!ticketChannelId) {
    await interaction.reply({
      ephemeral: true,
      content: '⚠️ Канал тикетов не настроен. Обратитесь к администрации.',
    });
    return;
  }

  await interaction.reply({
    ephemeral: true,
    embeds: [buildOtherQuestionEmbed(ticketChannelId)],
  });

  // Редактируем публичное сообщение
  await interaction.message.edit({
    embeds: [buildWelcomeChosenEmbed(member, false)],
    components: [],
  }).catch((err) => log.warn('Не удалось обновить welcome-сообщение', err));

  // Пинг в канале тикетов
  await sendTicketPing(client, ticketChannelId, userId, false);

  log.info(`[Welcome] ${interaction.user.tag} выбрал "другой вопрос" → тикеты`);
}

/** «Правила сервера» — заменить ephemeral на сами правила + кнопка «Назад» */
async function handleRulesServer(interaction: ButtonInteraction): Promise<void> {
  const userId = interaction.user.id;
  const state = await getState(userId);
  state.serverRules = true;
  await setState(userId, state);

  // Заменяем одно и то же ephemeral-сообщение — нет накопления
  await interaction.update({
    embeds: buildServerRulesEmbeds(),
    components: [buildBackButton(userId)],
  });
}

/** «Правила полка» — заменить ephemeral на сами правила + кнопка «Назад» */
async function handleRulesRegiment(interaction: ButtonInteraction): Promise<void> {
  const userId = interaction.user.id;
  const state = await getState(userId);
  state.regimentRules = true;
  await setState(userId, state);

  await interaction.update({
    embeds: [buildRegimentRulesEmbed()],
    components: [buildBackButton(userId)],
  });
}

/** «Назад к прогрессу» — вернуть экран прогресса с текущим статусом */
async function handleRulesBack(interaction: ButtonInteraction): Promise<void> {
  const userId = interaction.user.id;
  const state = await getState(userId);

  await interaction.update({
    embeds: [buildRulesPromptEmbed(state.serverRules, state.regimentRules)],
    components: [buildRulesButtons(userId, state.serverRules, state.regimentRules)],
  });
}

/** «Ознакомился с правилами» — выдать роль, перенаправить в тикеты */
async function handleRulesDone(interaction: ButtonInteraction, client: BublikClient): Promise<void> {
  const userId = interaction.user.id;

  // 0. Немедленно подтверждаем взаимодействие — до любых REST-вызовов
  //    Без этого token истекает за <3с и вызов update() падает с Unknown interaction.
  await interaction.deferUpdate();

  // Проверяем, что оба документа действительно прочитаны
  const state = await getState(userId);
  if (!state.serverRules || !state.regimentRules) {
    await interaction.followUp({
      content: '⚠️ Сначала ознакомьтесь с обоими документами!',
      ephemeral: true,
    });
    return;
  }

  const ticketChannelId = Config.ticketChannelId;
  const recruitRoleId   = Config.recruitRoleId;

  if (!ticketChannelId) {
    await interaction.editReply({
      embeds: [buildRulesPromptEmbed(true, true)],
      components: [],
    });
    await interaction.followUp({
      content: '⚠️ Канал тикетов не настроен. Обратитесь к администрации.',
      ephemeral: true,
    });
    return;
  }

  // 1. Выдаем роль новобранца (если настроена)
  if (recruitRoleId && interaction.guild) {
    try {
      const member = await interaction.guild.members.fetch(userId);
      await member.roles.add(recruitRoleId, 'Ознакомлен с правилами полка — Bublik Bot');
      log.info(`Роль новобранца ${recruitRoleId} выдана пользователю ${userId}`);
    } catch (err) {
      log.error(`Не удалось выдать роль ${recruitRoleId} пользователю ${userId}`, err);
    }
  }

  // 2. Обновляем ephemeral — убираем кнопки, показываем успех (со ссылкой на тикет-канал)
  await interaction.editReply({
    embeds: [buildJoinCompleteEmbed(ticketChannelId)],
    components: [],
  });

  // 3. Скрытый пинг в канале тикетов — embed-уведомление для рекрутинга
  //    (@упоминание убрано — пользователь уже уведомлён через ephemeral выше)
  await sendTicketPing(client, ticketChannelId, userId, true);

  // 4. Чистим состояние из Redis
  await clearState(userId);

  log.info(`[Welcome] ${interaction.user.tag} завершил ознакомление, роль выдана → тикеты`);
}

// ═══════════════════════════════════════════════
//  Утилита: пинг в канале тикетов
// ═══════════════════════════════════════════════

async function sendTicketPing(
  client: BublikClient,
  channelId: string,
  userId: string,
  isRecruit: boolean,
): Promise<void> {
  try {
    // Фетчим канал — не из кэша
    const channel = await client.channels.fetch(channelId).catch(() => null);
    if (!channel || !channel.isTextBased()) {
      log.error(`Канал тикетов ${channelId} не найден или не текстовый`);
      return;
    }

    // Скрытый (не шумящий) embed — виден только тем, у кого есть доступ к каналу
    await (channel as BaseGuildTextChannel).send({
      embeds: [buildTicketPingEmbed(userId, isRecruit)],
    });

    log.info(`Пинг отправлен в канал тикетов для ${userId}`);
  } catch (err) {
    log.error('Ошибка отправки пинга в тикет-канал', err);
  }
}
