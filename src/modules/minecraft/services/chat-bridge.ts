// ═══════════════════════════════════════════════
//  Minecraft Module — Cross-Chat Bridge Service
//  Discord ↔ Minecraft real-time chat relay
// ═══════════════════════════════════════════════

import type { Client, TextChannel, Message } from 'discord.js';
import { Events } from 'discord.js';
import { logger } from '../../../core/Logger';
import { getAllMinecraftConfigs } from '../database';
import { getDatabase } from '../../../core/Database';
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
}

interface ChatBridgeRuntime {
  client: Client;
  discordMessageListener: (...args: unknown[]) => void;
  poll: (client: Client) => Promise<ChatPollResult>;
  baseDelayMs: number;
  maxDelayMs: number;
  timer: NodeJS.Timeout | null;
  stopped: boolean;
  pollInFlight: boolean;
  consecutiveFailures: number;
}

let bridgeRuntime: ChatBridgeRuntime | null = null;
let lastRoutingWarningKey: string | null = null;

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
): Promise<void> {
  stopChatBridge();

  // --- Discord → Minecraft ---
  const discordMessageListener = async (...args: unknown[]) => {
    const msg = args[0] as Message;
    if (msg.author.bot) return;
    if (!msg.guildId) return;

    try {
      const configs = await getAllMinecraftConfigs();
      const config = selectMinecraftChatConfig(configs);
      if (
        !config
        || config.guildId !== msg.guildId
        || config.chatChannelId !== msg.channelId
      ) return;

      const nick = msg.member?.displayName ?? msg.author.username;

      // Build text content — handle attachments & stickers
      let text = msg.content
        .replace(/`/g, "'")
        .substring(0, 180);

      // Add attachment type indicators
      if (msg.attachments.size > 0) {
        const attParts: string[] = [];
        for (const att of msg.attachments.values()) {
          const ct = att.contentType ?? '';
          if (ct.startsWith('image/')) attParts.push('[📷 фото]');
          else if (ct.startsWith('video/')) attParts.push('[🎥 видео]');
          else if (ct.startsWith('audio/')) attParts.push('[🎵 аудио]');
          else attParts.push('[📎 файл]');
        }
        text = [text, ...attParts].filter(Boolean).join(' ');
      }

      // Add sticker indicator
      if (msg.stickers.size > 0) {
        text = [text, '[🎭 стикер]'].filter(Boolean).join(' ');
      }

      if (!text.trim()) return;

      // Check for reply — show quoted excerpt in MC
      let replyPart = '';
      if (msg.reference?.messageId) {
        try {
          const replied = await msg.channel.messages.fetch(msg.reference.messageId);
          if (replied) {
            const replyAuthor = replied.member?.displayName ?? replied.author.username;
            const replyText = replied.content
              .replace(/`/g, "'")
              .substring(0, 40);
            replyPart = replyText
              ? `↩ ${replyAuthor}: "${replyText}…" | `
              : `↩ ${replyAuthor} | `;
          }
        } catch {
          // Ignore if replied message not found
        }
      }

      // Build tellraw payload
      const tellraw = buildDiscordTellrawCommand(nick, text, replyPart);

      const result = await executeRconCommand(tellraw);
      if (result.success) {
        log.info(`[ChatBridge] Discord → MC: <${nick}> ${replyPart}${text}`);
      } else {
        log.warn(`[ChatBridge] Discord → MC failed: ${result.error}`);
      }

    } catch (err) {
      log.error('[ChatBridge] Discord → MC error', err);
    }
  };

  client.on(Events.MessageCreate, discordMessageListener as Parameters<typeof client.on>[1]);

  const runtime: ChatBridgeRuntime = {
    client,
    discordMessageListener,
    poll: options.poll ?? pollMinecraftChat,
    baseDelayMs: options.baseDelayMs ?? CHAT_POLL_BASE_DELAY_MS,
    maxDelayMs: options.maxDelayMs ?? CHAT_POLL_MAX_DELAY_MS,
    timer: null,
    stopped: false,
    pollInFlight: false,
    consecutiveFailures: 0,
  };
  bridgeRuntime = runtime;

  // --- Minecraft → Discord: poll the RCON chat queue file ---
  scheduleNextPoll(runtime, runtime.baseDelayMs);

  log.info('Кросс-чат мост запущен (Discord ↔ Minecraft)');
}

export function stopChatBridge(): void {
  const runtime = bridgeRuntime;
  bridgeRuntime = null;
  lastRoutingWarningKey = null;

  if (runtime) {
    runtime.stopped = true;
    if (runtime.timer) {
      clearTimeout(runtime.timer);
      runtime.timer = null;
    }
    runtime.client.off(
      Events.MessageCreate,
      runtime.discordMessageListener as Parameters<typeof runtime.client.off>[1]
    );
  }

  log.info('Кросс-чат мост остановлен');
}

function scheduleNextPoll(runtime: ChatBridgeRuntime, delayMs: number): void {
  if (runtime.stopped || bridgeRuntime !== runtime) return;

  runtime.timer = setTimeout(() => {
    runtime.timer = null;
    void runScheduledPoll(runtime);
  }, delayMs);
}

async function runScheduledPoll(runtime: ChatBridgeRuntime): Promise<void> {
  if (runtime.stopped || bridgeRuntime !== runtime || runtime.pollInFlight) return;

  runtime.pollInFlight = true;
  let result: ChatPollResult = 'failure';

  try {
    result = await runtime.poll(runtime.client);
  } catch (error) {
    log.warn('[ChatBridge] Непредвиденная ошибка планировщика Minecraft-чата', error);
  } finally {
    runtime.pollInFlight = false;
  }

  if (runtime.stopped || bridgeRuntime !== runtime) return;

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
async function pollMinecraftChat(client: Client): Promise<ChatPollResult> {
  try {
    const configs = await getAllMinecraftConfigs();
    const activeConfigs = configs.filter((config) => config.chatChannelId);
    if (activeConfigs.length === 0) return 'idle';

    const config = selectMinecraftChatConfig(activeConfigs);
    if (!config) {
      const warningKey = [
        process.env.MINECRAFT_GUILD_ID?.trim() || 'unset',
        ...activeConfigs.map((candidate) => candidate.guildId).sort(),
      ].join(':');

      if (lastRoutingWarningKey !== warningKey) {
        lastRoutingWarningKey = warningKey;
        log.error(
          '[ChatBridge] MC → Discord остановлен: настроено несколько чат-каналов. '
          + 'Укажите MINECRAFT_GUILD_ID владельца RCON-сервера, чтобы исключить утечку сообщений между серверами.'
        );
      }
      return 'idle';
    }
    lastRoutingWarningKey = null;

    // Use RCON to read & flush the chat queue file
    const readResult = await executeRconCommand('erezcraft_chat_flush');
    if (!readResult.success) return 'failure';
    if (!readResult.response?.trim()) return 'success';

    const lines = readResult.response
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0);

    for (const line of lines) {
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

          if (!account?.isLinked) {
            const tellraw = `tellraw ${targetUsername} ["",{"text":"⚠️ [EREZCRAFT] Ваш аккаунт не привязан к Discord! Привяжите командой /link","color":"red"}]`;
            await executeRconCommand(tellraw).catch(() => {});
          } else {
            const profile = await db.economyProfile.findUnique({
              where: { guildId_userId: { guildId: account.guildId, userId: account.discordId } },
            });
            const wallet = profile?.wallet ?? 0;
            const tellraw = `tellraw ${targetUsername} ["",{"text":"₪ [EREZCRAFT] Баланс: ","color":"gold"},{"text":"${wallet} ₪","color":"green","bold":true},{"text":" (Шекелей). Магазин: /mc shop в Discord","color":"gray"}]`;
            await executeRconCommand(tellraw).catch(() => {});
          }
        } catch (err) {
          log.error('[ChatBridge] Error responding to REQUEST_BALANCE', err);
        }
        continue;
      }

      const channel = (await client.channels.fetch(config.chatChannelId!).catch(() => null)) as TextChannel | null;
      if (!channel || !channel.isTextBased()) continue;

      await channel
        .send({
          content: `🎮 **${username.slice(0, 64)}**: ${message.slice(0, 1_800)}`,
          allowedMentions: { parse: [] },
        })
        .catch(() => {});

      log.info(`[ChatBridge] MC → Discord: <${username}> ${message}`);
    }
    return 'success';
  } catch (error) {
    log.warn('[ChatBridge] Ошибка опроса Minecraft-чата', error);
    return 'failure';
  }
}
