// ═══════════════════════════════════════════════
//  Minecraft Module — Constants
// ═══════════════════════════════════════════════

import { isRconConfigured } from './services/rcon-service';

export const MINECRAFT_PREFIX = 'mc';
export const DEFAULT_SERVER_ADDRESS = 'play.erez.pro:25565';
export const DEFAULT_SERVER_NAME = 'EREZCRAFT';

export function getMinecraftGuildId(
  environment: NodeJS.ProcessEnv = process.env
): string | null {
  const guildId = environment.MINECRAFT_GUILD_ID?.trim();
  return guildId || null;
}

export function isMinecraftModuleConfigured(
  environment: NodeJS.ProcessEnv = process.env
): boolean {
  return getMinecraftGuildId(environment) !== null && isRconConfigured(environment);
}

/**
 * One RCON endpoint cannot safely serve unrelated Discord guilds. Until RCON
 * credentials become per-guild database configuration, Minecraft operations
 * are restricted to one explicitly selected guild.
 */
export function isMinecraftGuildEnabled(
  guildId: string,
  environment: NodeJS.ProcessEnv = process.env
): boolean {
  return isMinecraftModuleConfigured(environment)
    && getMinecraftGuildId(environment) === guildId;
}

/** Interval for status auto-refresh (60 seconds) */
export const STATUS_REFRESH_INTERVAL_MS = 60_000;

/** TPS threshold below which server is marked as degraded */
export const ALERT_DEGRADED_TPS_THRESHOLD = 15.0;

/** Min interval between smart alerts to prevent spam (15 minutes) */
export const ALERT_COOLDOWN_MS = 15 * 60 * 1000;
