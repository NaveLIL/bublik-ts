// ═══════════════════════════════════════════════
//  Minecraft Module — Constants
// ═══════════════════════════════════════════════

export const MINECRAFT_PREFIX = 'mc';
export const DEFAULT_SERVER_ADDRESS = 'play.erez.pro:25565';
export const DEFAULT_SERVER_NAME = 'EREZCRAFT';

/** Interval for status auto-refresh (60 seconds) */
export const STATUS_REFRESH_INTERVAL_MS = 60_000;

/** TPS threshold below which server is marked as degraded */
export const ALERT_DEGRADED_TPS_THRESHOLD = 15.0;

/** Min interval between smart alerts to prevent spam (15 minutes) */
export const ALERT_COOLDOWN_MS = 15 * 60 * 1000;
