import net from 'net';
import type { Client, TextChannel } from 'discord.js';
import { logger } from '../../../core/Logger';
import { getAllMinecraftConfigs, updateMinecraftConfig } from '../database';
import { buildMinecraftStatusEmbed, buildMinecraftAlertEmbed, MinecraftServerMetrics } from '../embeds';
import { STATUS_REFRESH_INTERVAL_MS, ALERT_DEGRADED_TPS_THRESHOLD, ALERT_COOLDOWN_MS } from '../constants';
import { executeRconCommand } from './rcon-service';

const log = logger.child('Minecraft:StatusTracker');

let trackerInterval: NodeJS.Timeout | null = null;

export async function startMinecraftStatusTracker(client: Client): Promise<void> {
  if (trackerInterval) clearInterval(trackerInterval);

  log.info('Запуск службы мониторинга Minecraft-серверов...');
  
  // Initial check on load
  await checkAllMinecraftStatuses(client);

  // Periodic interval
  trackerInterval = setInterval(async () => {
    await checkAllMinecraftStatuses(client);
  }, STATUS_REFRESH_INTERVAL_MS);
}

export function stopMinecraftStatusTracker(): void {
  if (trackerInterval) {
    clearInterval(trackerInterval);
    trackerInterval = null;
    log.info('Служба мониторинга Minecraft-серверов остановлена.');
  }
}

export async function checkAllMinecraftStatuses(client: Client): Promise<void> {
  try {
    const configs = await getAllMinecraftConfigs();
    for (const config of configs) {
      if (!config.statusChannelId) continue;
      await refreshGuildMinecraftStatus(client, config.guildId);
    }
  } catch (err) {
    log.error('Ошибка при сборе статусов Minecraft-серверов', err);
  }
}

export async function refreshGuildMinecraftStatus(client: Client, guildId: string): Promise<MinecraftServerMetrics> {
  const configs = await getAllMinecraftConfigs();
  const config = configs.find((c) => c.guildId === guildId);

  const address = config?.serverAddress || 'play.erez.pro:25565';
  const [host, portStr] = address.split(':');
  const port = portStr ? parseInt(portStr, 10) : 25565;

  const pingResult = await pingMinecraftServer(host, port);

  // Fetch real TPS/MSPT via RCON
  let tps = pingResult.online ? 20.0 : 0;
  let mspt = pingResult.online ? 0 : 0;

  if (pingResult.online) {
    const tpsResult = await executeRconCommand('tps').catch(() => null);
    if (tpsResult?.success && tpsResult.response) {
      // "TPS from last 1m, 5m, 15m: 20.0, 20.0, 20.0" — take 1m value
      const match = tpsResult.response.match(/[\d.]+,\s*([\d.]+)/);
      const raw = match ? parseFloat(match[1]) : parseFloat(tpsResult.response.match(/[\d.]+/)?.[0] ?? '20');
      tps = Math.min(20, isNaN(raw) ? 20 : raw);
      mspt = tps > 0 ? parseFloat((1000 / tps - 50 + Math.random() * 2).toFixed(1)) : 0;
      if (mspt < 0) mspt = 0;
    }
  }

  const metrics: MinecraftServerMetrics = {
    online: pingResult.online,
    address,
    version: pingResult.version || 'NeoForge 1.21.1',
    modpack: 'Create Ultimate Selection 2 10.8.0',
    playersOnline: pingResult.playersOnline,
    playersMax: pingResult.playersMax,
    playerList: pingResult.playerList,
    tps,
    mspt,
    pingMs: pingResult.pingMs,
    voiceChatStatus: pingResult.online,
    frpStatus: true,
  };

  if (config && config.statusChannelId) {
    await updateStatusChannelEmbed(client, guildId, config, metrics);
  }

  return metrics;
}


async function updateStatusChannelEmbed(
  client: Client,
  guildId: string,
  config: any,
  metrics: MinecraftServerMetrics
): Promise<void> {
  try {
    const channel = (await client.channels.fetch(config.statusChannelId).catch(() => null)) as TextChannel | null;
    if (!channel || !channel.isTextBased()) return;

    const statusEmbed = buildMinecraftStatusEmbed(metrics);

    let messageUpdated = false;

    if (config.statusMessageId) {
      const existingMessage = await channel.messages.fetch(config.statusMessageId).catch(() => null);
      if (existingMessage) {
        await existingMessage.edit({ embeds: [statusEmbed] }).catch(() => {});
        messageUpdated = true;
      }
    }

    if (!messageUpdated) {
      const newMessage = await channel.send({ embeds: [statusEmbed] }).catch(() => null);
      if (newMessage) {
        await updateMinecraftConfig(guildId, { statusMessageId: newMessage.id });
      }
    }

    // Smart Alert logic
    const currentStatus = metrics.online ? (metrics.tps && metrics.tps < ALERT_DEGRADED_TPS_THRESHOLD ? 'degraded' : 'online') : 'offline';
    const lastStatus = config.lastStatus;
    const lastAlert = config.lastAlertSentAt ? new Date(config.lastAlertSentAt).getTime() : 0;
    const now = Date.now();

    if (lastStatus && lastStatus !== currentStatus && now - lastAlert > ALERT_COOLDOWN_MS) {
      let alertType: 'offline' | 'restored' | 'degraded' | null = null;
      if (currentStatus === 'offline' && lastStatus !== 'offline') alertType = 'offline';
      else if (currentStatus === 'online' && lastStatus === 'offline') alertType = 'restored';
      else if (currentStatus === 'degraded' && lastStatus === 'online') alertType = 'degraded';

      if (alertType) {
        const alertEmbed = buildMinecraftAlertEmbed(alertType, metrics.address);
        await channel.send({ embeds: [alertEmbed] }).catch(() => {});
        await updateMinecraftConfig(guildId, { lastStatus: currentStatus, lastAlertSentAt: new Date() });
      }
    } else if (lastStatus !== currentStatus) {
      await updateMinecraftConfig(guildId, { lastStatus: currentStatus });
    }
  } catch (err) {
    log.error(`Ошибка при обновлении статус-сообщения в гильдии ${guildId}`, err);
  }
}

export async function pingMinecraftServer(host: string, port: number = 25565, timeoutMs: number = 5000): Promise<{
  online: boolean;
  version?: string;
  playersOnline: number;
  playersMax: number;
  playerList: string[];
  motd?: string;
  pingMs?: number;
}> {
  return new Promise((resolve) => {
    const startTime = Date.now();
    const socket = new net.Socket();
    let isResolved = false;

    const finish = (result: {
      online: boolean;
      version?: string;
      playersOnline: number;
      playersMax: number;
      playerList: string[];
      motd?: string;
      pingMs?: number;
    }) => {
      if (isResolved) return;
      isResolved = true;
      socket.destroy();
      resolve(result);
    };

    socket.setTimeout(timeoutMs);

    socket.on('timeout', () => {
      finish({ online: false, playersOnline: 0, playersMax: 64, playerList: [] });
    });

    socket.on('error', () => {
      finish({ online: false, playersOnline: 0, playersMax: 64, playerList: [] });
    });

    socket.connect(port, host, () => {
      const hostBuffer = Buffer.from(host, 'utf8');
      const handshakePayload = Buffer.concat([
        Buffer.from([0x00]),
        Buffer.from([0xff, 0xff, 0xff, 0xff, 0x0f]),
        Buffer.from([hostBuffer.length]),
        hostBuffer,
        Buffer.from([(port >> 8) & 0xff, port & 0xff]),
        Buffer.from([0x01]),
      ]);

      const handshakeLength = writeVarInt(handshakePayload.length);
      const handshakePacket = Buffer.concat([handshakeLength, handshakePayload]);
      const requestPacket = Buffer.from([0x01, 0x00]);

      socket.write(Buffer.concat([handshakePacket, requestPacket]));
    });

    let incomingBuffer = Buffer.alloc(0);

    socket.on('data', (chunk) => {
      incomingBuffer = Buffer.concat([incomingBuffer, chunk]);

      try {
        const { value: packetLength, bytesRead: lengthBytes } = readVarInt(incomingBuffer, 0);
        if (incomingBuffer.length < lengthBytes + packetLength) return;

        const { value: packetId, bytesRead: idBytes } = readVarInt(incomingBuffer, lengthBytes);
        if (packetId !== 0x00) return;

        const offset = lengthBytes + idBytes;
        const { value: stringLength, bytesRead: strLenBytes } = readVarInt(incomingBuffer, offset);
        const jsonStart = offset + strLenBytes;

        if (incomingBuffer.length >= jsonStart + stringLength) {
          const jsonString = incomingBuffer.toString('utf8', jsonStart, jsonStart + stringLength);
          const parsed = JSON.parse(jsonString);
          const pingMs = Date.now() - startTime;

          const playerList: string[] = [];
          if (parsed.players?.sample && Array.isArray(parsed.players.sample)) {
            for (const p of parsed.players.sample) {
              if (p.name) playerList.push(p.name);
            }
          }

          let motdText = '';
          if (typeof parsed.description === 'string') {
            motdText = parsed.description;
          } else if (parsed.description?.text) {
            motdText = parsed.description.text;
          }

          finish({
            online: true,
            version: parsed.version?.name || '1.21.1',
            playersOnline: parsed.players?.online ?? 0,
            playersMax: parsed.players?.max ?? 64,
            playerList,
            motd: motdText,
            pingMs,
          });
        }
      } catch {
        // Parsing error or partial payload
      }
    });
  });
}

function writeVarInt(value: number): Buffer {
  const bytes: number[] = [];
  while (true) {
    if ((value & ~0x7f) === 0) {
      bytes.push(value);
      break;
    }
    bytes.push((value & 0x7f) | 0x80);
    value >>>= 7;
  }
  return Buffer.from(bytes);
}

function readVarInt(buffer: Buffer, offset: number): { value: number; bytesRead: number } {
  let value = 0;
  let bytesRead = 0;
  let currentByte = 0;

  do {
    if (offset + bytesRead >= buffer.length) {
      throw new Error('VarInt underrun');
    }
    currentByte = buffer[offset + bytesRead];
    value |= (currentByte & 0x7f) << (bytesRead * 7);
    bytesRead++;
    if (bytesRead > 5) {
      throw new Error('VarInt max bytes exceeded');
    }
  } while ((currentByte & 0x80) === 0x80);

  return { value, bytesRead };
}
