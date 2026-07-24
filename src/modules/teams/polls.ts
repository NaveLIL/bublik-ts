import {
  ActionRowBuilder,
  ButtonInteraction,
  Guild,
  ModalBuilder,
  ModalSubmitInteraction,
  SendableChannels,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import type { BublikClient } from '../../bot';
import { logger } from '../../core/Logger';
import { isGuildAllowed } from '../../core/Whitelist';
import { scheduleTask, unscheduleTask } from '../../core/SchedulerManager';

import {
  POLL_AUTO_CHECK_MS,
  POLL_MAX_AGE_MS,
  PollStatus,
  TeamStatus,
  TM_SEP,
} from './constants';
import * as db from './database';
import {
  buildPollButtons,
  buildPollEmbed,
  POLL_TIME_MODAL_ID,
  POLL_VOTE_MODAL_ID,
  tmError,
  tmSuccess,
  tmWarn,
} from './embeds';
import { canCastPollVote, componentTreeContainsCustomId, normalizeReadyTime, projectPollVotes } from './policy';

const log = logger.child('Teams:Polls');

type PollWithVotes = NonNullable<Awaited<ReturnType<typeof db.getPoll>>>;

function projectPoll(poll: PollWithVotes) {
  const rawTimes = poll.voteTimes;
  const legacyTimes: Record<string, string | null> = {};
  if (rawTimes && typeof rawTimes === 'object' && !Array.isArray(rawTimes)) {
    for (const [userId, value] of Object.entries(rawTimes)) {
      if (typeof value === 'string' || value === null) legacyTimes[userId] = value;
    }
  }
  return projectPollVotes(poll.votes, {
    yesUserIds: poll.yesUserIds,
    noUserIds: poll.noUserIds,
    voteTimes: legacyTimes,
  });
}

async function fetchChannelIfExists(guild: Guild, channelId: string) {
  const cached = guild.channels.cache.get(channelId);
  if (cached) return cached;
  try {
    return await guild.channels.fetch(channelId);
  } catch (err) {
    if ((err as { code?: number }).code === 10003) return null;
    throw err;
  }
}

export async function handlePollCreate(
  interaction: ButtonInteraction,
  teamId: string,
  _client: BublikClient,
): Promise<void> {
  const team = await db.getTeam(teamId);
  if (
    !team || team.guildId !== interaction.guildId || team.status !== TeamStatus.ACTIVE ||
    interaction.user.id !== team.leaderId
  ) {
    await interaction.reply({ embeds: [tmError('Только действующий лидер активной команды может создать опрос.')], ephemeral: true });
    return;
  }

  if (await db.getActivePoll(teamId)) {
    await interaction.reply({ embeds: [tmWarn('У команды уже есть активный опрос.')], ephemeral: true });
    return;
  }

  const modal = new ModalBuilder()
    .setCustomId(`${POLL_TIME_MODAL_ID}${TM_SEP}${teamId}`)
    .setTitle('Опрос на ПБ — Время')
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId('poll_time')
          .setLabel('Примерное время начала (МСК)')
          .setStyle(TextInputStyle.Short)
          .setPlaceholder('Например: 18:00 или 19:30')
          .setRequired(false)
          .setMaxLength(10),
      ),
    );
  await interaction.showModal(modal);
}

export async function handlePollTimeModal(
  interaction: ModalSubmitInteraction,
  _client: BublikClient,
): Promise<void> {
  const teamId = interaction.customId.split(TM_SEP).at(-1)!;
  await interaction.deferReply({ ephemeral: true });

  // Authorization is intentionally repeated at modal submit: leadership can
  // change while the modal is open.
  const team = await db.getTeam(teamId);
  if (
    !team || team.guildId !== interaction.guildId || team.status !== TeamStatus.ACTIVE ||
    interaction.user.id !== team.leaderId
  ) {
    await interaction.editReply({ embeds: [tmError('Вы больше не можете создавать опрос этой команды.')] });
    return;
  }

  const config = await db.getConfig(team.guildId);
  if (!config?.pollChannelId) {
    await interaction.editReply({ embeds: [tmError('Канал для опросов не настроен. Используйте `/team setup poll_channel`.')] });
    return;
  }

  const guild = interaction.guild!;
  const channel = guild.channels.cache.get(config.pollChannelId) ??
    await guild.channels.fetch(config.pollChannelId).catch(() => null);
  if (!channel?.isSendable()) {
    await interaction.editReply({ embeds: [tmError('Настроенный канал для опросов недоступен боту.')] });
    return;
  }

  const rawTime = interaction.fields.getTextInputValue('poll_time')?.trim() || null;
  const normalizedTime = normalizeReadyTime(rawTime);
  if (rawTime && !normalizedTime) {
    await interaction.editReply({ embeds: [tmError('Время должно быть в формате ЧЧ:ММ, например 18:30.')] });
    return;
  }
  const scheduledAt = normalizedTime ? nextMskOccurrence(normalizedTime) : undefined;

  try {
    const created = await publishPoll(
      guild,
      channel,
      team,
      'manual',
      scheduledAt,
      normalizedTime,
      `<@&${team.roleId}>`,
    );
    if (!created) {
      await interaction.editReply({ embeds: [tmWarn('У команды уже есть активный опрос.')] });
      return;
    }
    await interaction.editReply({ embeds: [tmSuccess('Опрос опубликован!')] });
    log.info(`Опрос создан: «${team.name}» ${normalizedTime ? `в ${normalizedTime}` : ''}`);
  } catch (err) {
    log.error('Ошибка создания опроса', { error: String(err), teamId });
    await interaction.editReply({ embeds: [tmError('Ошибка при создании опроса; незавершённые изменения отменены.')] });
  }
}

async function publishPoll(
  guild: Guild,
  channel: SendableChannels,
  team: { id: string; guildId: string; name: string; roleId: string },
  type: 'manual' | 'auto',
  scheduledAt: Date | undefined,
  timeLabel: string | null,
  content: string,
  dedupKey?: string,
): Promise<PollWithVotes | null> {
  let poll: PollWithVotes;
  try {
    poll = await db.createPoll({ teamId: team.id, channelId: channel.id, type, scheduledAt, dedupKey });
  } catch (err) {
    // Both activeKey and dedupKey are DB-enforced. A concurrent publisher is a
    // normal conflict; actual DB errors are rethrown.
    if ((err as { code?: string }).code === 'P2002') return null;
    throw err;
  }

  let message: Awaited<ReturnType<typeof channel.send>> | null = null;
  try {
    message = await channel.send({
      content,
      embeds: [buildPollEmbed(team.name, timeLabel, [], [], {})],
      components: [buildPollButtons(poll.id)],
    });
    poll = await db.setPollMessage(poll.id, channel.id, message.id);
    return poll;
  } catch (err) {
    if (message) {
      await message.delete().catch(cleanupErr =>
        log.error('Не удалось удалить сообщение неопубликованного опроса', { error: String(cleanupErr), messageId: message?.id }),
      );
    }
    await db.deleteUnpublishedPoll(poll.id).catch(cleanupErr =>
      log.error('Не удалось удалить неопубликованный опрос', { error: String(cleanupErr), pollId: poll.id, guildId: guild.id }),
    );
    throw err;
  }
}

export async function handlePollVote(
  interaction: ButtonInteraction,
  vote: 'yes' | 'no',
  pollId: string,
  _client: BublikClient,
): Promise<void> {
  const authorized = await authorizeVoter(interaction.guildId, interaction.user.id, pollId);
  if (!authorized.allowed) {
    await interaction.reply({ embeds: [tmWarn(authorized.reason)], ephemeral: true });
    return;
  }

  if (vote === 'yes') {
    const modal = new ModalBuilder()
      .setCustomId(`${POLL_VOTE_MODAL_ID}${TM_SEP}${pollId}`)
      .setTitle('Иду на ПБ!')
      .addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder()
            .setCustomId('vote_time')
            .setLabel('Во сколько сможешь? (МСК, необязательно)')
            .setStyle(TextInputStyle.Short)
            .setPlaceholder('Например: 18:00 или 19:30')
            .setRequired(false)
            .setMaxLength(10),
        ),
      );
    await interaction.showModal(modal);
    return;
  }

  await interaction.deferUpdate();
  await applyVote(interaction, pollId, 'no', null);
}

export async function handlePollVoteModal(
  interaction: ModalSubmitInteraction,
  _client: BublikClient,
): Promise<void> {
  const pollId = interaction.customId.split(TM_SEP).at(-1)!;
  await interaction.deferUpdate();

  const rawTime = interaction.fields.getTextInputValue('vote_time')?.trim() || null;
  const readyTime = normalizeReadyTime(rawTime);
  if (rawTime && !readyTime) {
    await interaction.followUp({ embeds: [tmError('Время должно быть в формате ЧЧ:ММ, например 18:30.')], ephemeral: true });
    return;
  }
  await applyVote(interaction, pollId, 'yes', readyTime);
}

async function authorizeVoter(
  guildId: string | null,
  userId: string,
  pollId: string,
): Promise<{ allowed: true; poll: PollWithVotes } | { allowed: false; reason: string }> {
  const poll = await db.getPoll(pollId);
  if (!poll || poll.team.guildId !== guildId) return { allowed: false, reason: 'Опрос не найден на этом сервере.' };
  const isMember = guildId ? await db.isMemberOfTeam(userId, poll.teamId, guildId) : false;
  if (!canCastPollVote(poll.status, isMember)) {
    return {
      allowed: false,
      reason: poll.status !== PollStatus.ACTIVE ? 'Опрос завершён.' : 'Голосовать могут только текущие участники команды.',
    };
  }
  return { allowed: true, poll };
}

async function applyVote(
  interaction: ButtonInteraction | ModalSubmitInteraction,
  pollId: string,
  vote: 'yes' | 'no',
  readyTime: string | null,
): Promise<void> {
  // Repeat membership and active-state checks at the actual write, including
  // after a modal was left open.
  const authorized = await authorizeVoter(interaction.guildId, interaction.user.id, pollId);
  if (!authorized.allowed) {
    await interaction.followUp({ embeds: [tmWarn(authorized.reason)], ephemeral: true });
    return;
  }

  const poll = await db.upsertPollVoteIfActive(pollId, interaction.user.id, vote, readyTime);
  if (!poll) {
    await interaction.followUp({ embeds: [tmWarn('Опрос уже завершён.')], ephemeral: true });
    return;
  }

  const projection = projectPoll(poll);
  const embed = buildPollEmbed(
    poll.team.name,
    poll.scheduledAt ? formatMskTime(poll.scheduledAt) : null,
    projection.yesUserIds,
    projection.noUserIds,
    projection.voteTimes,
  );

  if (poll.messageId && poll.channelId && interaction.guild) {
    try {
      const channel = interaction.guild.channels.cache.get(poll.channelId) ??
        await interaction.guild.channels.fetch(poll.channelId);
      if (channel?.isTextBased()) {
        const message = await channel.messages.fetch(poll.messageId);
        await message.edit({ embeds: [embed], components: [buildPollButtons(pollId)] });
      }
    } catch (err) {
      log.error('Голос сохранён, но сообщение опроса не обновилось', { error: String(err), pollId });
    }
  }

  if (vote === 'yes' && interaction.guild) {
    await checkAndNotify(interaction.guild, poll, projection.yesUserIds, projection.voteTimes);
  }
}

async function checkAndNotify(
  guild: Guild,
  poll: PollWithVotes,
  yesUserIds: string[],
  voteTimes: Record<string, string | null>,
): Promise<void> {
  if (!poll.channelId) return;
  const channel = guild.channels.cache.get(poll.channelId) ?? await guild.channels.fetch(poll.channelId).catch(() => null);
  if (!channel?.isSendable()) return;

  const timeGroups = new Map<string, string[]>();
  for (const userId of yesUserIds) {
    const readyTime = voteTimes[userId];
    if (!readyTime) continue;
    const users = timeGroups.get(readyTime) ?? [];
    users.push(userId);
    timeGroups.set(readyTime, users);
  }

  for (const [time, users] of timeGroups) {
    if (users.length < 8) continue;
    const key = `slot:${time}:8`;
    if (!await db.claimPollNotification(poll.id, key)) continue;
    try {
      await channel.send({
        content:
          `<@&${poll.team.roleId}> 🔔 **Собралось ${users.length} человек на ${time} МСК!**\n` +
          `Команда «${poll.team.name}» готова к ПБ — создавайте отряд!`,
      });
    } catch (err) {
      await db.releasePollNotification(poll.id, key).catch(() => null);
      log.error('Не удалось отправить уведомление слота опроса', { error: String(err), pollId: poll.id, key });
    }
  }

  const anySlotHas8 = [...timeGroups.values()].some(users => users.length >= 8);
  const totalKey = 'total:8';
  if (!anySlotHas8 && yesUserIds.length >= 8 && await db.claimPollNotification(poll.id, totalKey)) {
    try {
      await channel.send({
        content:
          `<@&${poll.team.roleId}> ✅ **Собралось ${yesUserIds.length} человек!**\n` +
          `Команда «${poll.team.name}» готова к ПБ! Договоритесь о времени.`,
      });
    } catch (err) {
      await db.releasePollNotification(poll.id, totalKey).catch(() => null);
      log.error('Не удалось отправить общее уведомление опроса', { error: String(err), pollId: poll.id });
    }
  }
}

export async function handlePollClose(
  interaction: ButtonInteraction,
  pollId: string,
  client: BublikClient,
): Promise<void> {
  await interaction.deferUpdate();
  const poll = await db.getPoll(pollId);
  if (!poll || poll.team.guildId !== interaction.guildId || poll.team.leaderId !== interaction.user.id) {
    await interaction.followUp({ embeds: [tmError('Завершить опрос может только текущий лидер команды.')], ephemeral: true });
    return;
  }

  const result = await db.closePoll(pollId);
  if (!result.poll) {
    await interaction.followUp({ embeds: [tmError('Опрос не найден.')], ephemeral: true });
    return;
  }
  try {
    await syncClosedPollMessage(client, result.poll);
  } catch (err) {
    log.error('Опрос закрыт в БД, но кнопки пока не сняты', { error: String(err), pollId });
    await interaction.followUp({
      embeds: [tmError('Опрос закрыт, но интерфейс Discord пока не обновлён. Система повторит автоматически.')],
      ephemeral: true,
    });
    return;
  }
  await interaction.followUp({
    embeds: [result.changed ? tmSuccess('Опрос завершён.') : tmWarn('Опрос уже был завершён.')],
    ephemeral: true,
  });
}

async function syncClosedPollMessage(client: BublikClient, poll: PollWithVotes): Promise<void> {
  if (!poll.messageId || !poll.channelId) {
    await db.markPollUiClosed(poll.id);
    return;
  }

  const guild = client.guilds.cache.get(poll.team.guildId);
  if (!guild) throw new Error(`Guild ${poll.team.guildId} is unavailable while closing poll ${poll.id}`);
  try {
    const channel = guild.channels.cache.get(poll.channelId) ?? await guild.channels.fetch(poll.channelId);
    if (!channel?.isTextBased()) {
      await db.markPollUiClosed(poll.id);
      return;
    }
    const message = await channel.messages.fetch(poll.messageId);
    const projection = projectPoll(poll);
    const embed = buildPollEmbed(
      poll.team.name,
      poll.scheduledAt ? formatMskTime(poll.scheduledAt) : null,
      projection.yesUserIds,
      projection.noUserIds,
      projection.voteTimes,
    ).setFooter({ text: 'Опрос завершён' });
    await message.edit({ embeds: [embed], components: [] });
    await db.markPollUiClosed(poll.id);
  } catch (err) {
    const code = (err as { code?: number }).code;
    if (code === 10003 || code === 10008) {
      await db.markPollUiClosed(poll.id);
      return;
    }
    throw err;
  }
}

const AUTO_POLL_TASK = 'teams:autoPoll';

export function startAutoPollChecker(client: BublikClient): void {
  unscheduleTask(AUTO_POLL_TASK);
  scheduleTask(AUTO_POLL_TASK, POLL_AUTO_CHECK_MS, async () => {
    await maintainPolls(client);
  }, { exclusive: true, immediate: true });
}

export function stopAutoPollChecker(): void {
  unscheduleTask(AUTO_POLL_TASK);
}

async function maintainPolls(client: BublikClient): Promise<void> {
  const unpublishedCutoff = new Date(Date.now() - 5 * 60_000);
  for (const poll of await db.getStaleUnpublishedPolls(unpublishedCutoff)) {
    if (!isGuildAllowed(poll.team.guildId)) continue;
    try {
      const guild = client.guilds.cache.get(poll.team.guildId);
      if (!guild) continue;
      const channelId = poll.channelId ?? poll.team.config.pollChannelId;
      const channel = channelId
        ? await fetchChannelIfExists(guild, channelId)
        : null;
      if (channel?.isTextBased()) {
        const recent = await channel.messages.fetch({ limit: 100 });
        const expectedId = `tm:poll:yes:${poll.id}`;
        const message = recent.find(candidate =>
          candidate.components.some(component => componentTreeContainsCustomId(component, expectedId)),
        );
        if (message) {
          await db.setPollMessage(poll.id, message.channelId, message.id);
          continue;
        }
      }
      await db.deleteUnpublishedPoll(poll.id);
      log.warn('Удалён незавершённый опрос без Discord-сообщения', { pollId: poll.id });
    } catch (err) {
      log.error('Не удалось восстановить незавершённый опрос', { error: String(err), pollId: poll.id });
    }
  }

  const cutoff = new Date(Date.now() - POLL_MAX_AGE_MS);
  for (const poll of await db.getExpiredActivePolls(cutoff)) {
    if (!isGuildAllowed(poll.team.guildId)) continue;
    const closed = await db.closePoll(poll.id);
    if (closed.poll) {
      await syncClosedPollMessage(client, closed.poll).catch(err =>
        log.error('Не удалось убрать кнопки авто-закрытого опроса', { error: String(err), pollId: poll.id }),
      );
    }
  }

  for (const poll of await db.getPollsPendingUiClosure()) {
    if (!isGuildAllowed(poll.team.guildId)) continue;
    await syncClosedPollMessage(client, poll).catch(err =>
      log.error('Не удалось восстановить закрытый UI опроса', { error: String(err), pollId: poll.id }),
    );
  }

  await checkAutoPolls(client);
}

async function checkAutoPolls(client: BublikClient): Promise<void> {
  for (const [guildId, guild] of client.guilds.cache) {
    if (!isGuildAllowed(guildId)) continue;
    const config = await db.getConfig(guildId);
    if (!config?.pollChannelId) continue;

    const now = new Date();
    const mskHour = (now.getUTCHours() + 3) % 24;
    const mskTotal = mskHour * 60 + now.getUTCMinutes();
    const triggerMinutes = 16 * 60 + 30 - (config.pollAutoHoursBefore ?? 2) * 60;
    if (mskTotal < triggerMinutes || mskTotal >= triggerMinutes + 5) continue;

    const channel = guild.channels.cache.get(config.pollChannelId) ??
      await guild.channels.fetch(config.pollChannelId).catch(() => null);
    if (!channel?.isSendable()) continue;

    const dayKey = mskDateKey(now);
    const teams = await db.getGuildTeams(guildId, [TeamStatus.ACTIVE]);
    for (const team of teams) {
      try {
        const poll = await publishPoll(
          guild,
          channel,
          team,
          'auto',
          undefined,
          null,
          `<@&${team.roleId}> 📊 Автоматический опрос: идём на ПБ сегодня?`,
          `auto:${team.id}:${dayKey}`,
        );
        if (poll) log.info(`Авто-опрос создан: «${team.name}»`);
      } catch (err) {
        log.error(`Ошибка авто-опроса для «${team.name}»`, { error: String(err) });
      }
    }
  }
}

function nextMskOccurrence(time: string, now = new Date()): Date {
  const [hours, minutes] = time.split(':').map(Number);
  const mskNow = new Date(now.getTime() + 3 * 3_600_000);
  let timestamp = Date.UTC(
    mskNow.getUTCFullYear(),
    mskNow.getUTCMonth(),
    mskNow.getUTCDate(),
    hours - 3,
    minutes,
    0,
    0,
  );
  if (timestamp <= now.getTime()) timestamp += 86_400_000;
  return new Date(timestamp);
}

function mskDateKey(date: Date): string {
  return new Date(date.getTime() + 3 * 3_600_000).toISOString().slice(0, 10);
}

function formatMskTime(date: Date): string {
  const mskHours = (date.getUTCHours() + 3) % 24;
  return `${mskHours.toString().padStart(2, '0')}:${date.getUTCMinutes().toString().padStart(2, '0')}`;
}
