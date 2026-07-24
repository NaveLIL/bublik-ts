// ═══════════════════════════════════════════════
//  Minecraft Module — Cross-Chat Bridge Service
//  Discord ↔ Minecraft real-time chat relay
// ═══════════════════════════════════════════════

import type { Client, TextChannel, Message } from 'discord.js';
import { Events } from 'discord.js';
import { logger } from '../../../core/Logger';
import { getAllMinecraftConfigs } from '../database';
import { executeRconCommand } from './rcon-service';

const log = logger.child('Minecraft:ChatBridge');

// --- Polling: MC logs → Discord ---
// We poll RCON for chat output by using KubeJS-written file via a dedicated
// RCON command trick: KubeJS writes recent chat to a file on each message,
// and we read it via exec on game-host. For now, Discord → MC is implemented
// fully; MC → Discord requires the KubeJS chat hook file polling (see below).

let bridgeInterval: NodeJS.Timeout | null = null;
let discordMessageListener: ((...args: unknown[]) => void) | null = null;

export async function startChatBridge(client: Client): Promise<void> {
  stopChatBridge();

  // --- Discord → Minecraft ---
  discordMessageListener = async (...args: unknown[]) => {
    const msg = args[0] as Message;
    if (msg.author.bot) return;

    try {
      const configs = await getAllMinecraftConfigs();
      const config = configs.find((c) => c.chatChannelId === msg.channelId);
      if (!config) return;

      // Format: <DiscordNick> message
      const nick = msg.member?.displayName ?? msg.author.username;
      const text = msg.content
        .replace(/`/g, "'")
        .replace(/"/g, '\\"')
        .substring(0, 200);

      if (!text.trim()) return;

      // Send as a tellraw with Discord icon prefix
      const tellraw = `tellraw @a ["",{"text":"[💬] ","color":"blue"},{"text":"${nick}","color":"aqua","bold":true},{"text":" » ","color":"dark_gray"},{"text":"${text}","color":"white"}]`;
      const result = await executeRconCommand(tellraw);
      if (result.success) {
        log.info(`[ChatBridge] Discord → MC: <${nick}> ${text}`);
      }
    } catch (err) {
      log.error('[ChatBridge] Discord → MC error', err);
    }
  };

  client.on(Events.MessageCreate, discordMessageListener as Parameters<typeof client.on>[1]);

  // --- Minecraft → Discord: poll the RCON chat queue file ---
  bridgeInterval = setInterval(async () => {
    await pollMinecraftChat(client);
  }, 3000); // every 3 seconds

  log.info('Кросс-чат мост запущен (Discord ↔ Minecraft)');
}

export function stopChatBridge(): void {
  if (bridgeInterval) {
    clearInterval(bridgeInterval);
    bridgeInterval = null;
  }
  discordMessageListener = null;
  log.info('Кросс-чат мост остановлен');
}

// Read chat queue written by KubeJS to a tmp file via RCON exec trick
async function pollMinecraftChat(client: Client): Promise<void> {
  try {
    const configs = await getAllMinecraftConfigs();
    const activeConfigs = configs.filter((c) => c.chatChannelId);
    if (activeConfigs.length === 0) return;

    // Use RCON to read & flush the chat queue file
    const readResult = await executeRconCommand('erezcraft_chat_flush');
    if (!readResult.success || !readResult.response?.trim()) return;

    const lines = readResult.response
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0);

    for (const config of activeConfigs) {
      const channel = (await client.channels.fetch(config.chatChannelId!).catch(() => null)) as TextChannel | null;
      if (!channel || !channel.isTextBased()) continue;

      for (const line of lines) {
        // Expected format from KubeJS: "USERNAME|MESSAGE"
        const sep = line.indexOf('|');
        if (sep < 0) continue;
        const username = line.substring(0, sep);
        const message = line.substring(sep + 1);

        await channel
          .send({
            content: `🎮 **${username}**: ${message}`,
            allowedMentions: { parse: [] },
          })
          .catch(() => {});

        log.info(`[ChatBridge] MC → Discord: <${username}> ${message}`);
      }
    }
  } catch (err) {
    // Silently ignore polling errors (server may be offline)
  }
}
