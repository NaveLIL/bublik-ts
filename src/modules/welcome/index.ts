import { GuildMember, PartialGuildMember, Interaction, TextChannel } from 'discord.js';
import type { BublikClient } from '../../bot';
import { BublikModule } from '../../types';
import { Config } from '../../config';
import { logger } from '../../core/Logger';
import {
  buildWelcomeEmbed,
  buildMemberLeftEmbed,
  buildReminderEmbed,
} from './embeds';
import {
  buildWelcomeButtons,
  handleWelcomeButton,
  clearState,
  clearReminded,
  markReminded,
  isReminded,
  startCooldownCleanup,
  stopCooldownCleanup,
  assignRoleReliably,
} from './handlers';

const log = logger.child('Module:welcome');

// ── Таймер напоминаний (хранится на уровне модуля) ──
let reminderTimer: ReturnType<typeof setInterval> | null = null;

const REMINDER_INTERVAL_MS = 60 * 60 * 1_000; // 1 час
const MAX_REMINDERS_PER_CYCLE = 10;                  // макс. пингов за цикл
const DELAY_BETWEEN_MS = 2_000;                // 2 с задержка между пингами

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ═══════════════════════════════════════════════
//  Цикл напоминаний (раз в час)
// ═══════════════════════════════════════════════

/**
 * Ищет участников без единой роли (только @everyone),
 * которых ещё не уведомляли, и отправляет до
 * MAX_REMINDERS_PER_CYCLE напоминаний (с кнопками)
 * с задержкой между ними для защиты от рейт-лимитов.
 */
async function runReminderCycle(client: BublikClient): Promise<void> {
  const channelId = Config.welcomeChannelId;
  if (!channelId) return;

  try {
    const guild = client.guilds.cache.first();
    if (!guild) return;

    // Используем кэш (GuildMembers intent включён, кэш актуален)
    const members = guild.members.cache;

    // ── Safety net: авто-роль ────────────────────────
    // Если у кого-то из участников отсутствует авто-роль — довыдаём.
    // Это страхует от ситуации, когда guildMemberAdd не сработал
    // (сетевой сбой, перезапуск бота в момент входа участника и т.п.)
    const autoRoleId = Config.autoRoleId;
    if (autoRoleId) {
      const missingAutoRole = members.filter(
        (m) => !m.user.bot && !m.roles.cache.has(autoRoleId),
      );

      let autoFixed = 0;
      for (const [id, m] of missingAutoRole) {
        if (autoFixed >= 5) break; // не больше 5 довыдач за цикл
        try {
          const ok = await assignRoleReliably(m, autoRoleId, 'Safety net — Bublik Bot');
          if (ok) autoFixed++;
        } catch (err) {
          log.warn(`Safety net: ошибка довыдачи авто-роли для ${id}`, err as Error);
        }
        if (autoFixed < 5) await sleep(DELAY_BETWEEN_MS);
      }
      if (autoFixed > 0) {
        log.info(`Safety net: авто-роль довыдана ${autoFixed} участникам`);
      }
    }

    // ── Напоминания для участников без ролей ─────────
    // Без ролей (только @everyone), не бот
    const roleless = members.filter(
      (m) => !m.user.bot && m.roles.cache.size <= 1,
    );

    if (roleless.size === 0) return;

    const channel = await guild.channels.fetch(channelId).catch(() => null);
    if (!channel || !channel.isTextBased()) return;
    const textChannel = channel as TextChannel;

    let sent = 0;

    for (const [id, member] of roleless) {
      if (sent >= MAX_REMINDERS_PER_CYCLE) break;

      // Не спамим — у каждого пользователя Redis-флаг на 1 час
      if (await isReminded(id)) continue;

      try {
        // Отправляем напоминание с полным набором кнопок —
        // пользователь может продолжить даже если его старое
        // welcome-сообщение потерялось (после перезапуска и т.п.)
        await textChannel.send({
          content: `<@${id}>`,
          embeds: [buildReminderEmbed(id)],
          components: [buildWelcomeButtons(id)],
        });
        await markReminded(id);
        sent++;
        log.info(`Напоминание → ${member.user.tag} (${id})`);

        if (sent < MAX_REMINDERS_PER_CYCLE) {
          await sleep(DELAY_BETWEEN_MS);
        }
      } catch (err) {
        log.warn(`Не удалось отправить напоминание для ${id}`, err as Error);
      }
    }

    if (sent > 0) {
      log.info(`Цикл напоминаний: ${sent}/${roleless.size} уведомлены`);
    }
  } catch (err) {
    log.error('Ошибка цикла напоминаний', err);
  }
}

// ═══════════════════════════════════════════════
//  Определение модуля
// ═══════════════════════════════════════════════

const welcomeModule: BublikModule = {
  name: 'welcome',
  descriptionKey: 'modules.welcome.description',
  version: '1.2.0',
  author: 'NaveL',

  commands: [],

  events: [
    // ── Новый участник присоединился ─────────
    {
      event: 'guildMemberAdd',
      async execute(member: GuildMember) {
        log.info(`guildMemberAdd: ${member.user.tag} (${member.id})`);

        try {
          // ── 1. Мгновенная авто-роль ──────────────────────
          // Назначается ДО welcome-сообщения, чтобы роль была гарантирована
          const autoRoleId = Config.autoRoleId;
          if (autoRoleId) {
            const assigned = await assignRoleReliably(
              member,
              autoRoleId,
              'Авто-роль при входе на сервер — Bublik Bot',
            );
            if (!assigned) {
              log.error(`⚠ Авто-роль ${autoRoleId} НЕ выдана ${member.user.tag} (${member.id})!`);
            }
          }

          // ── 2. Welcome-сообщение ─────────────────────────
          const channelId = Config.welcomeChannelId;
          if (!channelId) {
            log.warn('WELCOME_CHANNEL_ID не задан — пропускаем');
            return;
          }

          const channel = await member.guild.channels.fetch(channelId).catch(() => null);
          if (!channel || !channel.isTextBased()) {
            log.error(`Welcome-канал ${channelId} не найден или не текстовый`);
            return;
          }

          // Retry для channel.send — Discord API может вернуть 5xx / rate-limit
          let sent = false;
          for (let attempt = 1; attempt <= 3; attempt++) {
            try {
              await (channel as TextChannel).send({
                content: `<@${member.id}>`,
                embeds: [buildWelcomeEmbed(member)],
                components: [buildWelcomeButtons(member.id)],
              });
              sent = true;
              break;
            } catch (sendErr: any) {
              log.warn(`channel.send attempt ${attempt}/3 failed: ${sendErr.message}`);
              if (attempt < 3) await new Promise((r) => setTimeout(r, 2000 * attempt));
            }
          }
          if (!sent) {
            log.error(`Не удалось отправить приветствие для ${member.user.tag} после 3 попыток`);
            return;
          }

          // Ставим флаг «напомнили» — первое напоминание не раньше чем через час
          await markReminded(member.id);

          log.info(`Приветствие отправлено для ${member.user.tag}`);
        } catch (err) {
          log.error(`Ошибка приветствия ${member.user.tag}`, err);
        }
      },
    },

    // ── Участник покинул сервер ──────────────
    {
      event: 'guildMemberRemove',
      async execute(member: GuildMember | PartialGuildMember) {
        const tag = member.user?.tag ?? `ID:${member.id}`;
        log.info(`guildMemberRemove: ${tag} (${member.id})`);

        try {
          // Чистим все Redis-данные этого пользователя
          await clearState(member.id);
          await clearReminded(member.id);

          // Уведомляем в welcome-канале только о новичках / кандидатах
          // При Partial member roles.cache может быть пустым — трактуем как "без ролей"
          const recruitRoleId = Config.recruitRoleId;
          const hasRoles = member.roles?.cache ? member.roles.cache.size > 1 : false;
          const isCandidate = recruitRoleId
            ? (member.roles?.cache?.has(recruitRoleId) ?? false)
            : false;

          if (!hasRoles || isCandidate) {
            const channelId = Config.welcomeChannelId;
            if (!channelId) return;

            const channel = await member.guild.channels.fetch(channelId).catch(() => null);
            if (!channel || !channel.isTextBased()) return;

            await (channel as TextChannel).send({
              embeds: [buildMemberLeftEmbed(tag, member.id)],
            });

            log.info(`Уведомление о выходе ${tag} отправлено`);
          }
        } catch (err) {
          log.error(`Ошибка обработки выхода ${tag}`, err);
        }
      },
    },

    // ── Обработка нажатий кнопок ─────────────
    {
      event: 'interactionCreate',
      async execute(interaction: Interaction) {
        if (!interaction.isButton()) return;
        if (!interaction.customId.startsWith('welcome:')) return;

        const client = interaction.client as unknown as BublikClient;
        await handleWelcomeButton(interaction, client);
      },
    },
  ],

  async onLoad(client) {
    const wId = Config.welcomeChannelId;
    const tId = Config.ticketChannelId;
    const rId = Config.recruitRoleId;

    if (!wId) log.warn('⚠ WELCOME_CHANNEL_ID не задан — приветствия отключены');
    else      log.info(`Welcome-канал: ${wId}`);

    if (!tId) log.warn('⚠ TICKET_CHANNEL_ID не задан — тикеты не будут работать');
    else      log.info(`Тикет-канал: ${tId}`);

    if (!rId) log.warn('⚠ RECRUIT_ROLE_ID не задан — роль кандидата не будет выдаваться');

    const aId = Config.autoRoleId;
    if (!aId) log.warn('⚠ AUTO_ROLE_ID не задан — авто-роль при входе отключена');
    else      log.info(`Авто-роль: ${aId}`);

    // Запускаем цикл напоминаний (раз в час, до 10-ти за цикл)
    reminderTimer = setInterval(() => {
      runReminderCycle(client as BublikClient).catch((e) =>
        log.error('Ошибка цикла напоминаний', e),
      );
    }, REMINDER_INTERVAL_MS);

    // Запускаем периодическую чистку кулдаунов кнопок
    startCooldownCleanup();

    log.info('Модуль приветствия загружен ✓ (v1.2.0 — авто-роль + safety net)');
  },

  async onUnload(_client) {
    if (reminderTimer) {
      clearInterval(reminderTimer);
      reminderTimer = null;
    }

    stopCooldownCleanup();

    log.info('Модуль приветствия выгружен');
  },
};

export default welcomeModule;
