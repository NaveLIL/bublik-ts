import { GuildMember, User } from 'discord.js';
import {
  createLinkCode,
  forceLinkMinecraftAccount,
  unlinkMinecraftAccount,
  getMinecraftAccountByDiscordId,
  getMinecraftConfig,
  MinecraftAccountData,
} from '../database';
import { logger } from '../../../core/Logger';

const log = logger.child('Minecraft:LinkService');
const MINECRAFT_JAVA_USERNAME_PATTERN = /^[A-Za-z0-9_]{3,16}$/;
const LINK_CODE_PATTERN = /^\d{6}$/;

export function isValidMinecraftJavaUsername(username: string): boolean {
  return MINECRAFT_JAVA_USERNAME_PATTERN.test(username);
}

export type MinecraftLinkVerificationDecision =
  | { verified: true }
  | { verified: false; reason: string };

export function interpretMinecraftLinkVerification(
  result: { success: boolean; response?: string } | null | undefined
): MinecraftLinkVerificationDecision {
  if (!result?.success) {
    return { verified: false, reason: 'RCON_UNAVAILABLE' };
  }

  const response = result.response?.trim();
  if (response === 'VERIFIED') {
    return { verified: true };
  }
  if (response === 'EXPIRED') {
    return { verified: false, reason: 'CODE_EXPIRED' };
  }
  if (response === 'INVALID_CODE') {
    return { verified: false, reason: 'INVALID_CODE' };
  }
  return { verified: false, reason: 'VERIFICATION_FAILED' };
}

export function generateRandom6DigitCode(): string {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

export async function requestAccountLink(
  guildId: string,
  discordId: string,
  minecraftUsername: string
): Promise<{ code: string; expiresAt: Date }> {
  if (!isValidMinecraftJavaUsername(minecraftUsername)) {
    throw new Error('INVALID_MINECRAFT_USERNAME');
  }

  const code = generateRandom6DigitCode();
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

  await createLinkCode(guildId, discordId, minecraftUsername, code, expiresAt);
  log.info(`Сгенерирован код привязки для ${minecraftUsername} (${discordId})`);

  return { code, expiresAt };
}

import { executeRconCommand } from './rcon-service';

export async function processConfirmLink(
  guildId: string,
  member: GuildMember,
  code: string,
  username: string
): Promise<{ success: boolean; account?: MinecraftAccountData; reason?: string }> {
  if (!isValidMinecraftJavaUsername(username)) {
    return { success: false, reason: 'INVALID_USERNAME' };
  }

  if (!LINK_CODE_PATTERN.test(code)) {
    return { success: false, reason: 'INVALID_CODE' };
  }

  // The database record identifies the Discord user and the exact pending
  // username, but it is never sufficient to confirm ownership by itself.
  const pending = await getMinecraftAccountByDiscordId(guildId, member.id);
  if (!pending) {
    return { success: false, reason: 'NOT_FOUND' };
  }
  if (pending.isLinked) {
    return { success: false, reason: 'ALREADY_LINKED' };
  }
  if (pending.minecraftUsername.toLowerCase() !== username.toLowerCase()) {
    return { success: false, reason: 'USERNAME_MISMATCH' };
  }
  if (pending.linkCode !== code) {
    return { success: false, reason: 'INVALID_CODE' };
  }
  if (pending.linkCodeExpiresAt && pending.linkCodeExpiresAt < new Date()) {
    return { success: false, reason: 'CODE_EXPIRED' };
  }

  const rconResult = await executeRconCommand(
    `erezcraft_verify_code ${pending.minecraftUsername} ${code}`
  ).catch(() => null);

  const verification = interpretMinecraftLinkVerification(rconResult);
  if (!verification.verified) {
    return { success: false, reason: verification.reason };
  }

  const account = await forceLinkMinecraftAccount(
    guildId,
    member.id,
    pending.minecraftUsername
  );
  log.info(
    `Аккаунт Minecraft ${pending.minecraftUsername} привязан к ${member.user.tag} (подтверждено в игре)`
  );

  // Assign player role if configured.
  const config = await getMinecraftConfig(guildId);
  if (config?.playerRoleId) {
    const role = member.guild.roles.cache.get(config.playerRoleId);
    if (role) {
      await member.roles.add(role).catch((err) => {
        log.warn(`Не удалось выдать роль игрока ${config.playerRoleId}`, err);
      });
    }
  }

  return { success: true, account };
}


export async function processUnlinkAccount(
  guildId: string,
  member: GuildMember
): Promise<boolean> {
  const account = await getMinecraftAccountByDiscordId(guildId, member.id);
  if (!account) return false;

  const success = await unlinkMinecraftAccount(guildId, member.id);
  if (success) {
    log.info(`Аккаунт ${account.minecraftUsername} отвязан от ${member.user.tag}`);

    const config = await getMinecraftConfig(guildId);
    if (config?.playerRoleId) {
      const role = member.guild.roles.cache.get(config.playerRoleId);
      if (role && member.roles.cache.has(role.id)) {
        await member.roles.remove(role).catch((err) => {
          log.warn(`Не удалось снять роль игрока ${config.playerRoleId}`, err);
        });
      }
    }
  }

  return success;
}

export async function getPlayerProfile(
  guildId: string,
  targetUser: User
): Promise<MinecraftAccountData | null> {
  return getMinecraftAccountByDiscordId(guildId, targetUser.id);
}
