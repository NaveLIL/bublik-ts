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
} from './handlers';

const log = logger.child('Module:welcome');

// ── Таймер напоминаний (хранится на уровне модуля) ──
let reminderTimer: ReturnType<typeof setInterval> | null = null;

const REMINDER_INTERVAL_MS = 60 * 60 * 1_000;       // 1 час (как задумано)
const MAX_REMINDERS_PER_CYCLE = 10;                  // макс. пингов за цикл
const DELAY_BETWEEN_MS = 2_000;                // 2 с задержка между пингами

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ═══════════════════════════════════════════════
//  Цикл напоминаний (раз в 24 часа)
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

    // Фетчим актуальный список участников
    const members = await guild.members.fetch();

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
  version: '1.1.0',
  author: 'NaveL',

  commands: [],

  events: [
    // ── Новый участник присоединился ─────────
    {
      event: 'guildMemberAdd',
      async execute(member: GuildMember) {
        log.info(`guildMemberAdd: ${member.user.tag} (${member.id})`);

        try {
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

          await (channel as TextChannel).send({
            content: `<@${member.id}>`,
            embeds: [buildWelcomeEmbed(member)],
            components: [buildWelcomeButtons(member.id)],
          });

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

          // Уведомляем в welcome-канале только о новичках / кандидатов
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

    // Запускаем цикл напоминаний (раз в час, до 3-х за цикл)
    reminderTimer = setInterval(() => {
      runReminderCycle(client as BublikClient).catch((e) =>
        log.error('Ошибка цикла напоминаний', e),
      );
    }, REMINDER_INTERVAL_MS);

    log.info('Модуль приветствия загружен ✓ (напоминания: каждый час, макс. 10/цикл)');
  },

  async onUnload(_client) {
    if (reminderTimer) {
      clearInterval(reminderTimer);
      reminderTimer = null;
    }

    log.info('Модуль приветствия выгружен');
  },
};

export default welcomeModule;
