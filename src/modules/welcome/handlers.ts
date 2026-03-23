import {
  ButtonInteraction,
  ButtonBuilder,
  ButtonStyle,
  ActionRowBuilder,
  GuildMember,
  TextChannel,
  BaseGuildTextChannel,
} from 'discord.js';
import type { BublikClient } from '../../bot';
import { Config } from '../../config';
import { cacheGet, cacheSet, cacheDel } from '../../core/Redis';
import { logger } from '../../core/Logger';
import { errorReporter } from '../../core/ErrorReporter';
import { isTransientInteractionError } from '../../utils/helpers';
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

// ── Rate-limit кнопок (защита от double-click) ───
const BUTTON_COOLDOWN_MS = 1_500; // 1.5с между нажатиями
const buttonCooldowns = new Map<string, number>();

function isButtonRateLimited(userId: string): boolean {
  const now = Date.now();
  const last = buttonCooldowns.get(userId);
  if (last && now - last < BUTTON_COOLDOWN_MS) return true;
  buttonCooldowns.set(userId, now);
  return false;
}

// Периодическая очистка устаревших записей (управляется модулем через start/stop)
let cooldownCleanupTimer: ReturnType<typeof setInterval> | null = null;

export function startCooldownCleanup(): void {
  if (cooldownCleanupTimer) return; // уже запущен
  cooldownCleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [key, ts] of buttonCooldowns) {
      if (now - ts > BUTTON_COOLDOWN_MS * 2) buttonCooldowns.delete(key);
    }
  }, 300_000);
}

export function stopCooldownCleanup(): void {
  if (cooldownCleanupTimer) {
    clearInterval(cooldownCleanupTimer);
    cooldownCleanupTimer = null;
  }
}

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
const REMINDED_TTL = 86_400; // не чаще 1 раза в 24 часа

export async function markReminded(userId: string): Promise<void> {
  await cacheSet(`welcome:reminded:${userId}`, true, REMINDED_TTL);
}

export async function isReminded(userId: string): Promise<boolean> {
  return (await cacheGet(`welcome:reminded:${userId}`)) !== null;
}

export async function clearReminded(userId: string): Promise<void> {
  await cacheDel(`welcome:reminded:${userId}`);
}

// ── Утилита: retry с exponential backoff ─────────
async function retryAsync<T>(
  fn: () => Promise<T>,
  label: string,
  maxAttempts = 3,
  baseDelayMs = 1_000,
): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt < maxAttempts) {
        const delay = baseDelayMs * attempt;
        log.warn(`${label}: попытка ${attempt}/${maxAttempts} не удалась, повтор через ${delay}мс`);
        await new Promise<void>((r) => setTimeout(r, delay));
      }
    }
  }
  throw lastErr;
}

// ═══════════════════════════════════════════════
//  Надёжная выдача роли (с retry + верификацией)
// ═══════════════════════════════════════════════

/**
 * Выдаёт роль участнику с максимальной надёжностью:
 * 1. Пытается roles.add() с retry (до MAX_ATTEMPTS попыток)
 * 2. После каждого "успешного" add — re-fetch member и проверяет что роль реально есть
 * 3. Если верификация провалилась — считает попытку неудачной и повторяет
 *
 * Это решает проблему «бот забывает выдавать роли» — Discord API иногда
 * молча проглатывает roles.add при 5xx / rate-limit без ошибки.
 */
export async function assignRoleReliably(
  member: GuildMember,
  roleId: string,
  reason: string,
): Promise<boolean> {
  const MAX_ATTEMPTS = 5;
  const BASE_DELAY_MS = 2_000;
  const tag = member.user?.tag ?? member.id;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      // Шаг 1: добавляем роль
      await member.roles.add(roleId, reason);

      // Шаг 2: верификация — re-fetch участника и проверяем
      // Небольшая пауза перед верификацией — Discord может обновлять кэш не мгновенно
      await new Promise<void>((r) => setTimeout(r, 500));
      const refreshed = await member.guild.members.fetch({ user: member.id, force: true });

      if (refreshed.roles.cache.has(roleId)) {
        log.info(`✓ Роль ${roleId} подтверждена у ${tag} (попытка ${attempt}/${MAX_ATTEMPTS})`);
        return true;
      }

      // roles.add не бросил ошибку, но роли нет — Discord проглотил запрос
      log.warn(
        `Роль ${roleId} не обнаружена у ${tag} после roles.add (попытка ${attempt}/${MAX_ATTEMPTS}) — повтор`,
      );
    } catch (err: any) {
      log.warn(
        `assignRoleReliably ${roleId} → ${tag}: попытка ${attempt}/${MAX_ATTEMPTS} ошибка: ${err.message}`,
      );
    }

    // Backoff перед следующей попыткой
    if (attempt < MAX_ATTEMPTS) {
      const delay = BASE_DELAY_MS * attempt;
      await new Promise<void>((r) => setTimeout(r, delay));
    }
  }

  log.error(`✗ Не удалось выдать роль ${roleId} пользователю ${tag} после ${MAX_ATTEMPTS} попыток`);
  return false;
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

  // Rate-limit: не чаще раза в 1.5 секунды (double-click protection)
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
    // Транзиентные ошибки (Unknown interaction, EAI_AGAIN) — не шумим
    if (isTransientInteractionError(err)) {
      log.warn('Транзиентная ошибка в welcome interaction (пропускаем)', { error: String(err) });
      return;
    }

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

/** «Вступление в полк» — показать правила, сохранить кнопки на публичном сообщении */
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

  // Редактируем публичное сообщение — показываем статус, но СОХРАНЯЕМ кнопки,
  // чтобы пользователь мог повторить попытку если ephemeral-взаимодействие
  // сломалось (shard reconnect, таймаут и т.п.)
  await interaction.message.edit({
    embeds: [buildWelcomeChosenEmbed(member, true)],
    components: [buildWelcomeButtons(userId)],
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

  // 1. Выдаем роль — надёжный метод с retry + верификацией
  //    Discord API может вернуть 5xx / rate-limit → без retry роль «выборочно» не выдаётся
  let roleAssigned = false;
  if (recruitRoleId && interaction.guild) {
    const member = await interaction.guild.members.fetch(userId).catch(() => null);
    if (member) {
      roleAssigned = await assignRoleReliably(
        member,
        recruitRoleId,
        'Ознакомлен с правилами полка — Bublik Bot',
      );
    }

    if (!roleAssigned) {
      // Уведомляем пользователя
      await interaction.followUp({
        content: '⚠️ Не удалось выдать роль кандидата. Попробуйте ещё раз или обратитесь к администрации.',
        ephemeral: true,
      }).catch(() => {});
    }
  }

  // 2. Обновляем ephemeral — убираем кнопки, показываем успех
  await interaction.editReply({
    embeds: [buildJoinCompleteEmbed(ticketChannelId)],
    components: [],
  });

  // 3. Убираем кнопки с публичного welcome-сообщения (роль выдана — повтор не нужен)
  if (roleAssigned) {
    const welcomeChannelId = Config.welcomeChannelId;
    if (welcomeChannelId && interaction.guild) {
      try {
        const welcomeChannel = await interaction.guild.channels.fetch(welcomeChannelId).catch(() => null);
        if (welcomeChannel && welcomeChannel.isTextBased()) {
          const messages = await (welcomeChannel as TextChannel).messages.fetch({ limit: 50 });
          const welcomeMsg = messages.find(
            (m) => m.author.id === interaction.client.user?.id &&
                   m.components.length > 0 &&
                   (m.components[0] as any)?.components?.[0]?.customId?.includes(userId),
          );
          if (welcomeMsg) {
            const member = interaction.member as GuildMember;
            await welcomeMsg.edit({
              embeds: [buildWelcomeChosenEmbed(member, true)],
              components: [],
            }).catch(() => {});
          }
        }
      } catch (err) {
        log.debug(`Не удалось очистить публичное welcome-сообщение: ${String(err)}`);
      }
    }
  }

  // 4. Скрытый embed в канале тикетов
  await sendTicketPing(client, ticketChannelId, userId, true);

  // 5. Чистим состояние из Redis
  await clearState(userId);

  log.info(`[Welcome] ${interaction.user.tag} завершил ознакомление, роль ${roleAssigned ? 'выдана' : 'НЕ ВЫДАНА'} → тикеты`);
}

// ═══════════════════════════════════════════════
//  Утилита: embed в канале тикетов
// ═══════════════════════════════════════════════

async function sendTicketPing(
  client: BublikClient,
  channelId: string,
  userId: string,
  isRecruit: boolean,
): Promise<void> {
  try {
    const channel = await client.channels.fetch(channelId).catch(() => null);
    if (!channel || !channel.isTextBased()) {
      log.error(`Канал тикетов ${channelId} не найден или не текстовый`);
      return;
    }

    await (channel as BaseGuildTextChannel).send({
      embeds: [buildTicketPingEmbed(userId, isRecruit)],
    });

    log.info(`Embed отправлен в канал тикетов для ${userId}`);
  } catch (err) {
    log.error('Ошибка отправки embed в тикет-канал', err);
  }
}
