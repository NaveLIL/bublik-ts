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
  whitelistEnabled: boolean;
  playerRoleId: string | null;
}

export interface MinecraftAccountData {
  id: string;
  guildId: string;
  discordId: string;
  minecraftUsername: string;
  minecraftUuid: string | null;
  linkCode: string | null;
  linkCodeExpiresAt: Date | null;
  isLinked: boolean;
  linkedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export async function getMinecraftConfig(guildId: string): Promise<MinecraftConfigData | null> {
  const db = getDatabase();
  return db.minecraftConfig.findUnique({
    where: { guildId },
  }) as Promise<MinecraftConfigData | null>;
}

export async function getOrCreateMinecraftConfig(guildId: string): Promise<MinecraftConfigData> {
  const db = getDatabase();
  return db.minecraftConfig.upsert({
    where: { guildId },
    create: {
      guildId,
      serverAddress: DEFAULT_SERVER_ADDRESS,
      serverName: DEFAULT_SERVER_NAME,
      whitelistEnabled: false,
    },
    update: {},
  }) as Promise<MinecraftConfigData>;
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
    whitelistEnabled?: boolean;
    playerRoleId?: string | null;
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
      whitelistEnabled: data.whitelistEnabled ?? false,
      playerRoleId: data.playerRoleId ?? null,
    },
    update: data,
  }) as Promise<MinecraftConfigData>;
}

export async function getAllMinecraftConfigs(): Promise<MinecraftConfigData[]> {
  const db = getDatabase();
  return db.minecraftConfig.findMany() as Promise<MinecraftConfigData[]>;
}

// ── Minecraft Accounts ──────────────────────────

export async function getMinecraftAccountByDiscordId(
  guildId: string,
  discordId: string
): Promise<MinecraftAccountData | null> {
  const db = getDatabase();
  return db.minecraftAccount.findUnique({
    where: { guildId_discordId: { guildId, discordId } },
  }) as Promise<MinecraftAccountData | null>;
}

export async function getMinecraftAccountByUsername(
  guildId: string,
  minecraftUsername: string
): Promise<MinecraftAccountData | null> {
  const db = getDatabase();
  return db.minecraftAccount.findUnique({
    where: { guildId_minecraftUsername: { guildId, minecraftUsername } },
  }) as Promise<MinecraftAccountData | null>;
}

export async function createLinkCode(
  guildId: string,
  discordId: string,
  minecraftUsername: string,
  linkCode: string,
  expiresAt: Date
): Promise<MinecraftAccountData> {
  const db = getDatabase();
  return db.minecraftAccount.upsert({
    where: { guildId_discordId: { guildId, discordId } },
    create: {
      guildId,
      discordId,
      minecraftUsername,
      linkCode,
      linkCodeExpiresAt: expiresAt,
      isLinked: false,
    },
    update: {
      minecraftUsername,
      linkCode,
      linkCodeExpiresAt: expiresAt,
      isLinked: false,
    },
  }) as Promise<MinecraftAccountData>;
}

export async function confirmAccountLink(
  guildId: string,
  discordId: string,
  code: string
): Promise<{ success: boolean; account?: MinecraftAccountData; reason?: string }> {
  const db = getDatabase();
  const account = await db.minecraftAccount.findUnique({
    where: { guildId_discordId: { guildId, discordId } },
  });

  if (!account) {
    return { success: false, reason: 'NOT_FOUND' };
  }

  if (account.isLinked) {
    return { success: false, reason: 'ALREADY_LINKED' };
  }

  if (account.linkCode !== code) {
    return { success: false, reason: 'INVALID_CODE' };
  }

  if (account.linkCodeExpiresAt && account.linkCodeExpiresAt < new Date()) {
    return { success: false, reason: 'CODE_EXPIRED' };
  }

  const updated = await db.minecraftAccount.update({
    where: { guildId_discordId: { guildId, discordId } },
    data: {
      isLinked: true,
      linkedAt: new Date(),
      linkCode: null,
      linkCodeExpiresAt: null,
    },
  });

  return { success: true, account: updated as MinecraftAccountData };
}

export async function unlinkMinecraftAccount(
  guildId: string,
  discordId: string
): Promise<boolean> {
  const db = getDatabase();
  try {
    await db.minecraftAccount.delete({
      where: { guildId_discordId: { guildId, discordId } },
    });
    return true;
  } catch {
    return false;
  }
}
