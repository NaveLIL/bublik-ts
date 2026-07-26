import { Rcon } from 'rcon-client';
import { logger } from '../../../core/Logger';

const log = logger.child('Minecraft:RCON');

export interface RconOptions {
  host: string;
  port: number;
  password: string;
  timeoutMs?: number;
}

export interface ResolvedRconOptions {
  host: string;
  port: number;
  password: string;
  timeoutMs: number;
}

const DEFAULT_TIMEOUT_MS = 5000;
const MAX_TIMEOUT_MS = 60_000;
let missingConfigurationWasLogged = false;

function optionalNonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function parseInteger(value: string | undefined): number | undefined {
  if (value === undefined || !/^\d+$/.test(value.trim())) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

/**
 * Resolve RCON credentials exclusively from an explicit call-site override or
 * environment variables. There are deliberately no production host/password
 * fallbacks: a missing or malformed configuration must fail closed.
 */
export function resolveRconOptions(
  options: Partial<RconOptions> = {},
  environment: NodeJS.ProcessEnv = process.env
): ResolvedRconOptions {
  const host = optionalNonEmpty(options.host) ?? optionalNonEmpty(environment.RCON_HOST);
  const password = optionalNonEmpty(options.password) ?? optionalNonEmpty(environment.RCON_PASSWORD);
  const port = options.port ?? parseInteger(environment.RCON_PORT);
  const timeoutMs = options.timeoutMs
    ?? parseInteger(environment.RCON_TIMEOUT_MS)
    ?? DEFAULT_TIMEOUT_MS;

  if (
    !host
    || !password
    || !Number.isInteger(port)
    || port === undefined
    || port < 1
    || port > 65_535
    || !Number.isInteger(timeoutMs)
    || timeoutMs < 1
    || timeoutMs > MAX_TIMEOUT_MS
  ) {
    throw new Error('RCON_NOT_CONFIGURED');
  }

  return { host, port, password, timeoutMs };
}

function redactCredential(message: string, password: string): string {
  return password ? message.split(password).join('[REDACTED]') : message;
}

function commandLabel(command: string): string {
  return command.trim().split(/\s+/, 1)[0]?.slice(0, 64) || 'unknown';
}

export async function executeRconCommand(
  command: string,
  options?: Partial<RconOptions>
): Promise<{ success: boolean; response?: string; error?: string }> {
  const cleanCmd = command.startsWith('/') ? command.slice(1) : command;
  let resolved: ResolvedRconOptions;

  try {
    resolved = resolveRconOptions(options);
  } catch {
    if (!missingConfigurationWasLogged) {
      missingConfigurationWasLogged = true;
      log.error('[RCON] Конфигурация отсутствует или некорректна; команды отключены');
    }
    return { success: false, error: 'RCON_NOT_CONFIGURED' };
  }

  let rcon: Rcon | undefined;

  try {
    rcon = await Rcon.connect({
      host: resolved.host,
      port: resolved.port,
      password: resolved.password,
      timeout: resolved.timeoutMs,
    });

    const response = await rcon.send(cleanCmd);

    if (cleanCmd !== 'erezcraft_chat_flush') {
      log.info('[RCON] Команда успешно выполнена', { command: commandLabel(cleanCmd) });
    }
    return { success: true, response };
  } catch (error) {
    const rawMessage = error instanceof Error ? error.message : String(error);
    const msg = redactCredential(rawMessage, resolved.password);
    log.error('[RCON] Ошибка выполнения команды', {
      command: commandLabel(cleanCmd),
      error: msg,
    });
    return { success: false, error: msg };
  } finally {
    await rcon?.end().catch(() => undefined);
  }
}
