// ═══════════════════════════════════════════════
//  Minecraft Module — Cross-Chat Bridge Service
//  Discord ↔ Minecraft real-time chat relay
// ═══════════════════════════════════════════════

import type { Client, TextChannel, Message } from 'discord.js';
import { Events } from 'discord.js';
import { logger } from '../../../core/Logger';
import { getAllMinecraftConfigs } from '../database';
import { getDatabase } from '../../../core/Database';
import { getMinecraftGuildId, isMinecraftModuleConfigured } from '../constants';
import { executeRconCommand } from './rcon-service';
import { isValidMinecraftJavaUsername } from './link-service';

const log = logger.child('Minecraft:ChatBridge');
const CHAT_POLL_BASE_DELAY_MS = 3_000;
const CHAT_POLL_MAX_DELAY_MS = 5 * 60_000;

// --- Polling: MC logs → Discord ---
// We poll RCON for chat output by using KubeJS-written file via a dedicated
// RCON command trick: KubeJS writes recent chat to a file on each message,
// and we read it via exec on game-host. For now, Discord → MC is implemented
// fully; MC → Discord requires the KubeJS chat hook file polling (see below).

export type ChatPollResult = 'success' | 'failure' | 'idle';

export interface ChatBridgeOptions {
  poll?: (client: Client) => Promise<ChatPollResult>;
  baseDelayMs?: number;
  maxDelayMs?: number;
  environment?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}

interface ChatBridgeRuntime {
  client: Client;
  environment: NodeJS.ProcessEnv;
  preferredGuildId: string | null;
  signal?: AbortSignal;
  abortListener?: () => void;
  discordMessageListener: (...args: unknown[]) => void;
  poll: (client: Client) => Promise<ChatPollResult>;
  baseDelayMs: number;
  maxDelayMs: number;
  timer: NodeJS.Timeout | null;
  stopped: boolean;
  currentPoll: Promise<void> | null;
  messageTasks: Set<Promise<void>>;
  consecutiveFailures: number;
  lastRoutingWarningKey: string | null;
}

let bridgeRuntime: ChatBridgeRuntime | null = null;

export function getChatPollDelayMs(
  consecutiveFailures: number,
  baseDelayMs = CHAT_POLL_BASE_DELAY_MS,
  maxDelayMs = CHAT_POLL_MAX_DELAY_MS
): number {
  const safeFailures = Math.max(0, Math.floor(consecutiveFailures));
  const exponent = Math.min(safeFailures, 20);
  return Math.min(maxDelayMs, baseDelayMs * (2 ** exponent));
}

export function selectMinecraftChatConfig<T extends {
  guildId: string;
  chatChannelId: string | null;
}>(
  configs: readonly T[],
  preferredGuildId: string | null = process.env.MINECRAFT_GUILD_ID?.trim() || null
): T | null {
  const activeConfigs = configs.filter((config) => config.chatChannelId);
  if (activeConfigs.length === 0) return null;

  if (preferredGuildId) {
    return activeConfigs.find((config) => config.guildId === preferredGuildId) ?? null;
  }

  return activeConfigs.length === 1 ? activeConfigs[0] : null;
}

export function buildDiscordTellrawCommand(
  nickname: string,
  text: string,
  replyContext = ''
): string {
  const components: Array<string | Record<string, string | boolean>> = [
    '',
    { text: '💬 [Discord] ', color: 'blue' },
    { text: nickname, color: 'aqua', bold: true },
    { text: ' » ', color: 'dark_gray' },
  ];
  if (replyContext) {
    components.push({ text: replyContext, color: 'gray', italic: true });
  }
  components.push({ text, color: 'white' });
  return `tellraw @a ${JSON.stringify(components)}`;
}

export async function startChatBridge(
  client: Client,
  options: ChatBridgeOptions = {}
): Promise<boolean> {
  await stopChatBridge();

  const environment = options.environment ?? process.env;
  if (!isMinecraftModuleConfigured(environment) || options.signal?.aborted) {
    log.warn('Кросс-чат отключён: Minecraft/RCON не настроен');
    return false;
  }

  const runtime: ChatBridgeRuntime = {
    client,
    environment,
    preferredGuildId: getMinecraftGuildId(environment),
    signal: options.signal,
    discordMessageListener: () => undefined,
    poll: options.poll ?? ((pollClient) => pollMinecraftChat(
      pollClient,
      environment,
      options.signal,
    )),
    baseDelayMs: options.baseDelayMs ?? CHAT_POLL_BASE_DELAY_MS,
    maxDelayMs: options.maxDelayMs ?? CHAT_POLL_MAX_DELAY_MS,
    timer: null,
    stopped: false,
    currentPoll: null,
    messageTasks: new Set(),
    consecutiveFailures: 0,
    lastRoutingWarningKey: null,
  };

  // --- Discord → Minecraft ---
  runtime.discordMessageListener = (...args: unknown[]) => {
    const task = relayDiscordMessage(runtime, args[0] as Message);
    runtime.messageTasks.add(task);
    void task.finally(() => runtime.messageTasks.delete(task));
  };

  bridgeRuntime = runtime;
  if (options.signal) {
    runtime.abortListener = () => {
      void stopBridgeRuntime(runtime);
    };
    options.signal.addEventListener('abort', runtime.abortListener, { once: true });
  }
  client.on(
    Events.MessageCreate,
    runtime.discordMessageListener as Parameters<typeof client.on>[1],
  );

  // --- Minecraft → Discord: poll the RCON chat queue file ---
  scheduleNextPoll(runtime, runtime.baseDelayMs);

  log.info('Кросс-чат мост запущен (Discord ↔ Minecraft)');
  return true;
}

async function relayDiscordMessage(
  runtime: ChatBridgeRuntime,
  msg: Message,
): Promise<void> {
  if (runtime.stopped || runtime.signal?.aborted || msg.author.bot || !msg.guildId) return;

  try {
    const configs = await getAllMinecraftConfigs();
    if (runtime.stopped || runtime.signal?.aborted) return;
    const config = selectMinecraftChatConfig(configs, runtime.preferredGuildId);
    if (
      !config
      || config.guildId !== msg.guildId
      || config.chatChannelId !== msg.channelId
    ) return;

    const nick = msg.member?.displayName ?? msg.author.username;
    let text = msg.content.replace(/`/g, "'").substring(0, 180);

    if (msg.attachments.size > 0) {
      const attachmentParts: string[] = [];
      for (const attachment of msg.attachments.values()) {
        const contentType = attachment.contentType ?? '';
        if (contentType.startsWith('image/')) attachmentParts.push('[📷 фото]');
        else if (contentType.startsWith('video/')) attachmentParts.push('[🎥 видео]');
        else if (contentType.startsWith('audio/')) attachmentParts.push('[🎵 аудио]');
        else attachmentParts.push('[📎 файл]');
      }
      text = [text, ...attachmentParts].filter(Boolean).join(' ');
    }

    if (msg.stickers.size > 0) {
      text = [text, '[🎭 стикер]'].filter(Boolean).join(' ');
    }
    if (!text.trim()) return;

    let replyPart = '';
    if (msg.reference?.messageId) {
      try {
        const replied = await msg.channel.messages.fetch(msg.reference.messageId);
        if (runtime.stopped || runtime.signal?.aborted) return;
        if (replied) {
          const replyAuthor = replied.member?.displayName ?? replied.author.username;
          const replyText = replied.content.replace(/`/g, "'").substring(0, 40);
          replyPart = replyText
            ? `↩ ${replyAuthor}: "${replyText}…" | `
            : `↩ ${replyAuthor} | `;
        }
      } catch {
        // A deleted or inaccessible referenced message does not block relay.
      }
    }

    if (runtime.stopped || runtime.signal?.aborted) return;
    const result = await executeRconCommand(
      buildDiscordTellrawCommand(nick, text, replyPart),
      {},
      runtime.environment,
    );
    if (result.success) {
      log.info('[ChatBridge] Discord → MC delivered', {
        author: msg.author.id,
        length: text.length,
      });
    } else if (!runtime.stopped && !runtime.signal?.aborted) {
      log.warn(`[ChatBridge] Discord → MC failed: ${result.error}`);
    }
  } catch (error) {
    if (!runtime.stopped && !runtime.signal?.aborted) {
      log.error('[ChatBridge] Discord → MC error', error);
    }
  }
}

async function stopBridgeRuntime(runtime: ChatBridgeRuntime): Promise<void> {
  if (!runtime.stopped) {
    runtime.stopped = true;
    if (bridgeRuntime === runtime) bridgeRuntime = null;
    runtime.lastRoutingWarningKey = null;
    if (runtime.timer) {
      clearTimeout(runtime.timer);
      runtime.timer = null;
    }
    if (runtime.signal && runtime.abortListener) {
      runtime.signal.removeEventListener('abort', runtime.abortListener);
    }
    runtime.client.off(
      Events.MessageCreate,
      runtime.discordMessageListener as Parameters<typeof runtime.client.off>[1],
    );
  }

  await Promise.allSettled([
    ...(runtime.currentPoll ? [runtime.currentPoll] : []),
    ...runtime.messageTasks,
  ]);
  log.info('Кросс-чат мост остановлен');
}

export async function stopChatBridge(): Promise<void> {
  const runtime = bridgeRuntime;
  if (runtime) await stopBridgeRuntime(runtime);
}

function scheduleNextPoll(runtime: ChatBridgeRuntime, delayMs: number): void {
  if (runtime.stopped || bridgeRuntime !== runtime || runtime.signal?.aborted) return;

  runtime.timer = setTimeout(() => {
    runtime.timer = null;
    void runScheduledPoll(runtime);
  }, delayMs);
}

async function runScheduledPoll(runtime: ChatBridgeRuntime): Promise<void> {
  if (
    runtime.stopped
    || bridgeRuntime !== runtime
    || runtime.signal?.aborted
    || runtime.currentPoll
  ) return;

  const poll = performScheduledPoll(runtime);
  runtime.currentPoll = poll;
  try {
    await poll;
  } finally {
    if (runtime.currentPoll === poll) runtime.currentPoll = null;
  }
}

async function performScheduledPoll(runtime: ChatBridgeRuntime): Promise<void> {
  let result: ChatPollResult = 'failure';

  try {
    result = await runtime.poll(runtime.client);
  } catch (error) {
    log.warn('[ChatBridge] Непредвиденная ошибка планировщика Minecraft-чата', error);
  }

  if (runtime.stopped || bridgeRuntime !== runtime || runtime.signal?.aborted) return;

  if (result === 'failure') {
    runtime.consecutiveFailures += 1;
  } else {
    runtime.consecutiveFailures = 0;
  }

  const nextDelay = getChatPollDelayMs(
    runtime.consecutiveFailures,
    runtime.baseDelayMs,
    runtime.maxDelayMs
  );
  if (
    result === 'failure'
    && (
      runtime.consecutiveFailures === 1
      || (runtime.consecutiveFailures & (runtime.consecutiveFailures - 1)) === 0
    )
  ) {
    log.warn(
      `[ChatBridge] erezcraft_chat_flush недоступен; следующая попытка через ${Math.ceil(nextDelay / 1000)} сек. `
      + `(ошибок подряд: ${runtime.consecutiveFailures})`
    );
  }

  scheduleNextPoll(runtime, nextDelay);
}

// Read chat queue written by KubeJS to a tmp file via RCON exec trick
async function pollMinecraftChat(
  client: Client,
  environment: NodeJS.ProcessEnv,
  signal?: AbortSignal,
): Promise<ChatPollResult> {
  try {
    const configs = await getAllMinecraftConfigs();
    if (signal?.aborted) return 'idle';
    const activeConfigs = configs.filter((config) => config.chatChannelId);
    if (activeConfigs.length === 0) return 'idle';

    const preferredGuildId = getMinecraftGuildId(environment);
    const config = selectMinecraftChatConfig(activeConfigs, preferredGuildId);
    if (!config) {
      const warningKey = [
        preferredGuildId || 'unset',
        ...activeConfigs.map((candidate) => candidate.guildId).sort(),
      ].join(':');

      const runtime = bridgeRuntime;
      if (runtime && runtime.lastRoutingWarningKey !== warningKey) {
        runtime.lastRoutingWarningKey = warningKey;
        log.error(
          '[ChatBridge] MC → Discord остановлен: настроено несколько чат-каналов. '
          + 'Укажите MINECRAFT_GUILD_ID владельца RCON-сервера, чтобы исключить утечку сообщений между серверами.'
        );
      }
      return 'idle';
    }
    if (bridgeRuntime) bridgeRuntime.lastRoutingWarningKey = null;

    // Use RCON to read & flush the chat queue file
    const readResult = await executeRconCommand(
      'erezcraft_chat_flush',
      {},
      environment,
    );
    if (!readResult.success) return 'failure';
    if (!readResult.response?.trim()) return 'success';

    const lines = readResult.response
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0);

    for (const line of lines) {
      if (signal?.aborted) return 'idle';
      // Expected format from KubeJS: "USERNAME|MESSAGE" or "REQUEST_BALANCE|USERNAME"
      const sep = line.indexOf('|');
      if (sep < 0) continue;
      const username = line.substring(0, sep);
      const message = line.substring(sep + 1);

      if (username === 'REQUEST_BALANCE') {
        const targetUsername = message.trim();
        if (!isValidMinecraftJavaUsername(targetUsername)) {
          log.warn('[ChatBridge] Отклонён некорректный Minecraft-ник в REQUEST_BALANCE');
          continue;
        }
        try {
          const db = getDatabase();
          const account = await db.minecraftAccount.findUnique({
            where: {
              guildId_minecraftUsername: {
                guildId: config.guildId,
                minecraftUsername: targetUsername,
              },
            },
          });
          if (signal?.aborted) return 'idle';

          if (!account?.isLinked) {
            const tellraw = `tellraw ${targetUsername} ["",{"text":"⚠️ [EREZCRAFT] Ваш аккаунт не привязан к Discord! Привяжите командой /link","color":"red"}]`;
            await executeRconCommand(tellraw, {}, environment).catch(() => {});
          } else {
            const profile = await db.economyProfile.findUnique({
              where: { guildId_userId: { guildId: account.guildId, userId: account.discordId } },
            });
            if (signal?.aborted) return 'idle';
            const wallet = profile?.wallet ?? 0;
            const tellraw = `tellraw ${targetUsername} ["",{"text":"₪ [EREZCRAFT] Баланс: ","color":"gold"},{"text":"${wallet} ₪","color":"green","bold":true},{"text":" (Шекелей). Магазин: /mc shop в Discord","color":"gray"}]`;
            await executeRconCommand(tellraw, {}, environment).catch(() => {});
          }
        } catch (err) {
          log.error('[ChatBridge] Error responding to REQUEST_BALANCE', err);
        }
        continue;
      }

      if (signal?.aborted) return 'idle';
      const channel = (await client.channels.fetch(config.chatChannelId!).catch(() => null)) as TextChannel | null;
      if (signal?.aborted || !channel || !channel.isTextBased()) continue;

      await channel
        .send({
          content: `🎮 **${username.slice(0, 64)}**: ${message.slice(0, 1_800)}`,
          allowedMentions: { parse: [] },
        })
        .catch(() => {});

      log.info('[ChatBridge] MC → Discord delivered', {
        username: username.slice(0, 64),
        length: message.length,
      });
    }
    return 'success';
  } catch (error) {
    if (signal?.aborted) return 'idle';
    log.warn('[ChatBridge] Ошибка опроса Minecraft-чата', error);
    return 'failure';
  }
}
