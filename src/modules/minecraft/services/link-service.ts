import { GuildMember, User } from 'discord.js';
import {
  createLinkCode,
  confirmAccountLink,
  forceLinkMinecraftAccount,
  unlinkMinecraftAccount,
  getMinecraftAccountByDiscordId,
  getMinecraftAccountByUsername,
  getMinecraftConfig,
  MinecraftAccountData,
} from '../database';
import { logger } from '../../../core/Logger';

const log = logger.child('Minecraft:LinkService');

export function generateRandom6DigitCode(): string {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

export async function requestAccountLink(
  guildId: string,
  discordId: string,
  minecraftUsername: string
): Promise<{ code: string; expiresAt: Date }> {
  const code = generateRandom6DigitCode();
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

  await createLinkCode(guildId, discordId, minecraftUsername, code, expiresAt);
  log.info(`Сгенерирован код привязки ${code} для ${minecraftUsername} (${discordId})`);

  return { code, expiresAt };
}

import { executeRconCommand } from './rcon-service';

export async function processConfirmLink(
  guildId: string,
  member: GuildMember,
  code: string,
  username?: string
): Promise<{ success: boolean; account?: MinecraftAccountData; reason?: string }> {
  // If username is provided, try in-game RCON verification first
  if (username) {
    const rconResult = await executeRconCommand(`erezcraft_verify_code ${username} ${code}`).catch(() => null);
    if (rconResult?.success && rconResult.response) {
      const resp = rconResult.response.trim();
      if (resp === 'VERIFIED') {
        const account = await forceLinkMinecraftAccount(guildId, member.id, username);
        log.info(`Аккаунт Minecraft ${username} привязан к ${member.user.tag} (подтверждено в игре)`);

        // Assign player role if configured
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
      } else if (resp === 'EXPIRED') {
        return { success: false, reason: 'CODE_EXPIRED' };
      } else if (resp === 'INVALID_CODE') {
        return { success: false, reason: 'INVALID_CODE' };
      }
    }
  }

  // Fallback to database link code verification
  const result = await confirmAccountLink(guildId, member.id, code);

  if (result.success && result.account) {
    log.info(`Аккаунт Minecraft ${result.account.minecraftUsername} привязан к ${member.user.tag}`);

    // Assign player role if configured
    const config = await getMinecraftConfig(guildId);
    if (config?.playerRoleId) {
      const role = member.guild.roles.cache.get(config.playerRoleId);
      if (role) {
        await member.roles.add(role).catch((err) => {
          log.warn(`Не удалось выдать роль игрока ${config.playerRoleId}`, err);
        });
      }
    }
  }

  return result;
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
