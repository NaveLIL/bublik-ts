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
const RCON_CLOSE_TIMEOUT_MS = 2_000;
const MAX_RCON_COMMAND_LENGTH = 8_192;
const ALLOWED_RCON_COMMANDS = new Set([
  'erezcraft_chat_flush',
  'erezcraft_verify_code',
  'give',
  'tellraw',
  'tps',
]);
let missingConfigurationWasLogged = false;
let acceptingCommands = false;
let activeConnection: Rcon | null = null;
let activeConnectionFingerprint: string | null = null;
let connecting: Promise<Rcon> | null = null;
let commandQueue: Promise<void> = Promise.resolve();

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

export function isRconConfigured(
  environment: NodeJS.ProcessEnv = process.env
): boolean {
  try {
    resolveRconOptions({}, environment);
    return true;
  } catch {
    return false;
  }
}

function redactCredential(message: string, password: string): string {
  return password ? message.split(password).join('[REDACTED]') : message;
}

function commandLabel(command: string): string {
  return command.trim().split(/\s+/, 1)[0]?.slice(0, 64) || 'unknown';
}

export function validateRconCommand(command: string): {
  ok: true;
  command: string;
} | {
  ok: false;
  error: 'RCON_COMMAND_REJECTED';
} {
  const cleanCommand = command.startsWith('/') ? command.slice(1).trim() : command.trim();
  if (
    !cleanCommand
    || cleanCommand.length > MAX_RCON_COMMAND_LENGTH
    || /[\0\r\n]/.test(cleanCommand)
    || !ALLOWED_RCON_COMMANDS.has(commandLabel(cleanCommand).toLowerCase())
  ) {
    return { ok: false, error: 'RCON_COMMAND_REJECTED' };
  }

  return { ok: true, command: cleanCommand };
}

function connectionFingerprint(options: ResolvedRconOptions): string {
  return [
    options.host,
    options.port,
    options.timeoutMs,
    options.password,
  ].join('\0');
}

async function closeConnection(connection: Rcon | null): Promise<void> {
  if (!connection) return;

  const close = connection.end().catch(() => undefined);
  let closeTimer: NodeJS.Timeout | null = null;
  await Promise.race([
    close,
    new Promise<void>((resolve) => {
      closeTimer = setTimeout(resolve, RCON_CLOSE_TIMEOUT_MS);
      closeTimer.unref();
    }),
  ]);
  if (closeTimer) clearTimeout(closeTimer);

  // rcon-client cannot cancel a half-open connect/end operation itself.
  // Destroying the socket here prevents a stale RCON client thread from
  // surviving a bot reload or server restart.
  connection.socket?.destroy();
}

async function resetConnection(connection?: Rcon): Promise<void> {
  const current = connection ?? activeConnection;
  if (current && activeConnection === current) {
    activeConnection = null;
    activeConnectionFingerprint = null;
  }
  if (current) await closeConnection(current);
}

async function getConnection(options: ResolvedRconOptions): Promise<Rcon> {
  const fingerprint = connectionFingerprint(options);
  if (
    activeConnection
    && activeConnectionFingerprint === fingerprint
    && activeConnection.authenticated
    && activeConnection.socket
  ) {
    return activeConnection;
  }

  if (activeConnection && activeConnectionFingerprint !== fingerprint) {
    await resetConnection(activeConnection);
  }

  if (!connecting) {
    const candidate = new Rcon({
      host: options.host,
      port: options.port,
      password: options.password,
      timeout: options.timeoutMs,
      maxPending: 1,
    });
    const connectAttempt = candidate.connect();
    let connectTimer: NodeJS.Timeout | null = null;
    const connectTimeout = new Promise<never>((_resolve, reject) => {
      connectTimer = setTimeout(() => {
        candidate.socket?.destroy();
        reject(new Error('RCON_CONNECTION_TIMEOUT'));
      }, options.timeoutMs);
      connectTimer.unref();
    });

    connecting = Promise.race([connectAttempt, connectTimeout]).then((connection) => {
      activeConnection = connection;
      activeConnectionFingerprint = fingerprint;
      connection.on('end', () => {
        if (activeConnection === connection) {
          activeConnection = null;
          activeConnectionFingerprint = null;
        }
      });
      // The command path handles and logs operational failures. Registering an
      // error listener also prevents EventEmitter from treating socket errors
      // as unhandled exceptions.
      connection.on('error', () => undefined);
      return connection;
    }).finally(() => {
      if (connectTimer) clearTimeout(connectTimer);
      connecting = null;
    });
  }

  return connecting;
}

function serializeCommand<T>(operation: () => Promise<T>): Promise<T> {
  const result = commandQueue.then(operation, operation);
  commandQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

export function startRconService(): void {
  acceptingCommands = true;
  missingConfigurationWasLogged = false;
}

export async function stopRconService(): Promise<void> {
  acceptingCommands = false;
  await commandQueue;

  const pendingConnection = connecting;
  if (pendingConnection) {
    await pendingConnection.catch(() => undefined);
  }

  const connection = activeConnection;
  activeConnection = null;
  activeConnectionFingerprint = null;
  connecting = null;
  await closeConnection(connection);
}

export async function executeRconCommand(
  command: string,
  options: Partial<RconOptions> = {},
  environment: NodeJS.ProcessEnv = process.env
): Promise<{ success: boolean; response?: string; error?: string }> {
  const validation = validateRconCommand(command);
  if (!validation.ok) {
    log.warn('[RCON] Отклонена команда вне разрешённого набора', {
      command: commandLabel(command),
    });
    return { success: false, error: validation.error };
  }

  if (!acceptingCommands) {
    return { success: false, error: 'RCON_SERVICE_STOPPED' };
  }

  const cleanCmd = validation.command;
  let resolved: ResolvedRconOptions;

  try {
    resolved = resolveRconOptions(options, environment);
  } catch {
    if (!missingConfigurationWasLogged) {
      missingConfigurationWasLogged = true;
      log.error('[RCON] Конфигурация отсутствует или некорректна; команды отключены');
    }
    return { success: false, error: 'RCON_NOT_CONFIGURED' };
  }

  return serializeCommand(async () => {
    if (!acceptingCommands) {
      return { success: false, error: 'RCON_SERVICE_STOPPED' };
    }

    let connection: Rcon | null = null;
    try {
      connection = await getConnection(resolved);
      if (!acceptingCommands) {
        await resetConnection(connection);
        return { success: false, error: 'RCON_SERVICE_STOPPED' };
      }

      const response = await connection.send(cleanCmd);
      if (cleanCmd !== 'erezcraft_chat_flush') {
        log.info('[RCON] Команда успешно выполнена', { command: commandLabel(cleanCmd) });
      }
      return { success: true, response };
    } catch (error) {
      await resetConnection(connection ?? undefined);
      const rawMessage = error instanceof Error ? error.message : String(error);
      const msg = redactCredential(rawMessage, resolved.password);
      log.error('[RCON] Ошибка выполнения команды', {
        command: commandLabel(cleanCmd),
        error: msg,
      });
      return { success: false, error: msg };
    }
  });
}
