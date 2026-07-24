import { getDatabase } from '../../core/Database';
import { DEFAULT_SERVER_ADDRESS, DEFAULT_SERVER_NAME } from './constants';

export interface MinecraftConfigData {
  id: string;
  guildId: string;
  statusChannelId: string | null;
  statusMessageId: string | null;
  serverAddress: string;
  serverName: string;
  lastStatus: string | null;
  lastAlertSentAt: Date | null;
}

export async function getMinecraftConfig(guildId: string): Promise<MinecraftConfigData | null> {
  const db = getDatabase();
  return db.minecraftConfig.findUnique({
    where: { guildId },
  });
}

export async function getOrCreateMinecraftConfig(guildId: string): Promise<MinecraftConfigData> {
  const db = getDatabase();
  return db.minecraftConfig.upsert({
    where: { guildId },
    create: {
      guildId,
      serverAddress: DEFAULT_SERVER_ADDRESS,
      serverName: DEFAULT_SERVER_NAME,
    },
    update: {},
  });
}

export async function updateMinecraftConfig(
  guildId: string,
  data: {
    statusChannelId?: string | null;
    statusMessageId?: string | null;
    serverAddress?: string;
    serverName?: string;
    lastStatus?: string | null;
    lastAlertSentAt?: Date | null;
  }
): Promise<MinecraftConfigData> {
  const db = getDatabase();
  return db.minecraftConfig.upsert({
    where: { guildId },
    create: {
      guildId,
      statusChannelId: data.statusChannelId ?? null,
      statusMessageId: data.statusMessageId ?? null,
      serverAddress: data.serverAddress ?? DEFAULT_SERVER_ADDRESS,
      serverName: data.serverName ?? DEFAULT_SERVER_NAME,
      lastStatus: data.lastStatus ?? null,
      lastAlertSentAt: data.lastAlertSentAt ?? null,
    },
    update: data,
  });
}

export async function getAllMinecraftConfigs(): Promise<MinecraftConfigData[]> {
  const db = getDatabase();
  return db.minecraftConfig.findMany();
}
