import net from 'net';
import type { Client, TextChannel } from 'discord.js';
import { logger } from '../../../core/Logger';
import { getAllMinecraftConfigs, updateMinecraftConfig } from '../database';
import { buildMinecraftStatusEmbed, buildMinecraftAlertEmbed, MinecraftServerMetrics } from '../embeds';
import {
  STATUS_REFRESH_INTERVAL_MS,
  ALERT_DEGRADED_TPS_THRESHOLD,
  ALERT_COOLDOWN_MS,
  isMinecraftGuildEnabled,
  isMinecraftModuleConfigured,
} from '../constants';
import { executeRconCommand } from './rcon-service';

const log = logger.child('Minecraft:StatusTracker');

interface StatusTrackerRuntime {
  client: Client;
  environment: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  abortListener?: () => void;
  timer: NodeJS.Timeout | null;
  currentCheck: Promise<void> | null;
  stopped: boolean;
}

let trackerRuntime: StatusTrackerRuntime | null = null;

export async function startMinecraftStatusTracker(
  client: Client,
  environment: NodeJS.ProcessEnv = process.env,
  signal?: AbortSignal,
): Promise<boolean> {
  await stopMinecraftStatusTracker();

  if (!isMinecraftModuleConfigured(environment) || signal?.aborted) {
    log.warn('Мониторинг Minecraft отключён: Minecraft/RCON не настроен');
    return false;
  }

  const runtime: StatusTrackerRuntime = {
    client,
    environment,
    signal,
    timer: null,
    currentCheck: null,
    stopped: false,
  };
  trackerRuntime = runtime;
  if (signal) {
    runtime.abortListener = () => {
      void stopStatusRuntime(runtime);
    };
    signal.addEventListener('abort', runtime.abortListener, { once: true });
  }

  log.info('Запуск службы мониторинга Minecraft-серверов...');

  await runStatusCheck(runtime);
  return !runtime.stopped && trackerRuntime === runtime;
}

async function stopStatusRuntime(runtime: StatusTrackerRuntime): Promise<void> {
  if (runtime.stopped) {
    await runtime.currentCheck?.catch(() => undefined);
    return;
  }

  runtime.stopped = true;
  if (trackerRuntime === runtime) trackerRuntime = null;
  if (runtime.timer) {
    clearTimeout(runtime.timer);
    runtime.timer = null;
  }
  if (runtime.signal && runtime.abortListener) {
    runtime.signal.removeEventListener('abort', runtime.abortListener);
  }
  await runtime.currentCheck?.catch(() => undefined);
  log.info('Служба мониторинга Minecraft-серверов остановлена.');
}

export async function stopMinecraftStatusTracker(): Promise<void> {
  const runtime = trackerRuntime;
  if (runtime) await stopStatusRuntime(runtime);
}

function scheduleStatusCheck(runtime: StatusTrackerRuntime): void {
  if (runtime.stopped || trackerRuntime !== runtime || runtime.signal?.aborted) return;
  runtime.timer = setTimeout(() => {
    runtime.timer = null;
    void runStatusCheck(runtime);
  }, STATUS_REFRESH_INTERVAL_MS);
}

async function runStatusCheck(runtime: StatusTrackerRuntime): Promise<void> {
  if (
    runtime.stopped
    || trackerRuntime !== runtime
    || runtime.signal?.aborted
    || runtime.currentCheck
  ) return;

  const check = checkAllMinecraftStatuses(
    runtime.client,
    runtime.environment,
    runtime.signal,
  );
  runtime.currentCheck = check;
  try {
    await check;
  } finally {
    if (runtime.currentCheck === check) runtime.currentCheck = null;
  }

  scheduleStatusCheck(runtime);
}

export async function checkAllMinecraftStatuses(
  client: Client,
  environment: NodeJS.ProcessEnv = process.env,
  signal?: AbortSignal,
): Promise<void> {
  try {
    const configs = await getAllMinecraftConfigs();
    for (const config of configs) {
      if (signal?.aborted) return;
      if (!isMinecraftGuildEnabled(config.guildId, environment)) continue;
      if (!config.statusChannelId) continue;
      await refreshGuildMinecraftStatus(client, config.guildId, environment, signal);
    }
  } catch (err) {
    if (signal?.aborted) return;
    log.error('Ошибка при сборе статусов Minecraft-серверов', err);
  }
}

export async function refreshGuildMinecraftStatus(
  client: Client,
  guildId: string,
  environment: NodeJS.ProcessEnv = process.env,
  signal?: AbortSignal,
): Promise<MinecraftServerMetrics> {
  const configs = await getAllMinecraftConfigs();
  const config = configs.find((c) => c.guildId === guildId);

  const address = config?.serverAddress || 'play.erez.pro:25565';
  const [host, portStr] = address.split(':');
  const port = portStr ? parseInt(portStr, 10) : 25565;

  const pingResult = await pingMinecraftServer(host, port, 5000, signal);

  // Fetch real TPS via RCON. Unknown metrics remain unknown; never fabricate
  // an "excellent" value from TCP reachability alone.
  let tps: number | undefined;

  if (pingResult.online && !signal?.aborted) {
    const tpsResult = await executeRconCommand('tps', {}, environment).catch(() => null);
    if (tpsResult?.success && tpsResult.response) {
      tps = parseTpsResponse(tpsResult.response);
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
    pingMs: pingResult.pingMs,
  };

  if (config && config.statusChannelId && !signal?.aborted) {
    await updateStatusChannelEmbed(client, guildId, config, metrics, signal);
  }

  return metrics;
}


async function updateStatusChannelEmbed(
  client: Client,
  guildId: string,
  config: any,
  metrics: MinecraftServerMetrics,
  signal?: AbortSignal,
): Promise<void> {
  try {
    if (signal?.aborted) return;
    const channel = (await client.channels.fetch(config.statusChannelId).catch(() => null)) as TextChannel | null;
    if (signal?.aborted || !channel || !channel.isTextBased()) return;

    const statusEmbed = buildMinecraftStatusEmbed(metrics);

    let messageUpdated = false;

    if (config.statusMessageId) {
      const existingMessage = await channel.messages.fetch(config.statusMessageId).catch(() => null);
      if (signal?.aborted) return;
      if (existingMessage) {
        await existingMessage.edit({ embeds: [statusEmbed] }).catch(() => {});
        messageUpdated = true;
      }
    }

    if (!messageUpdated && !signal?.aborted) {
      const newMessage = await channel.send({ embeds: [statusEmbed] }).catch(() => null);
      if (newMessage && !signal?.aborted) {
        await updateMinecraftConfig(guildId, { statusMessageId: newMessage.id });
      }
    }

    if (signal?.aborted) return;
    // Smart Alert logic
    const currentStatus = metrics.online
      ? (metrics.tps !== undefined && metrics.tps < ALERT_DEGRADED_TPS_THRESHOLD
        ? 'degraded'
        : 'online')
      : 'offline';
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
        if (signal?.aborted) return;
        await channel.send({ embeds: [alertEmbed] }).catch(() => {});
        if (signal?.aborted) return;
        await updateMinecraftConfig(guildId, { lastStatus: currentStatus, lastAlertSentAt: new Date() });
      }
    } else if (lastStatus !== currentStatus && !signal?.aborted) {
      await updateMinecraftConfig(guildId, { lastStatus: currentStatus });
    }
  } catch (err) {
    if (signal?.aborted) return;
    log.error(`Ошибка при обновлении статус-сообщения в гильдии ${guildId}`, err);
  }
}

export function parseTpsResponse(response: string): number | undefined {
  const payload = response.includes(':')
    ? response.slice(response.indexOf(':') + 1)
    : response;
  const match = payload.match(/(-?\d+(?:\.\d+)?)/);
  if (!match) return undefined;
  const parsed = Number(match[1]);
  if (!Number.isFinite(parsed) || parsed < 0) return undefined;
  return Math.min(20, parsed);
}

export async function pingMinecraftServer(
  host: string,
  port: number = 25565,
  timeoutMs: number = 5000,
  signal?: AbortSignal,
): Promise<{
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
    let abortListener: (() => void) | null = null;

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
      if (signal && abortListener) signal.removeEventListener('abort', abortListener);
      socket.destroy();
      resolve(result);
    };

    abortListener = () => {
      finish({ online: false, playersOnline: 0, playersMax: 64, playerList: [] });
    };
    if (signal?.aborted) {
      abortListener();
      return;
    }
    if (signal) signal.addEventListener('abort', abortListener, { once: true });

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
