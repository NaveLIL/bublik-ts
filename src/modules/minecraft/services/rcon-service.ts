import { Rcon } from 'rcon-client';
import { logger } from '../../../core/Logger';

const log = logger.child('Minecraft:RCON');

export interface RconOptions {
  host: string;
  port: number;
  password?: string;
  timeoutMs?: number;
}

export async function executeRconCommand(
  command: string,
  options?: Partial<RconOptions>
): Promise<{ success: boolean; response?: string; error?: string }> {
  const host = options?.host ?? '100.74.108.43';
  const port = options?.port ?? 25575;
  const password = options?.password ?? process.env.RCON_PASSWORD ?? '43ee011b247d568a1a623769e2120f0fda70a1fd733a6650';

  const cleanCmd = command.startsWith('/') ? command.slice(1) : command;

  try {
    const rcon = await Rcon.connect({
      host,
      port,
      password,
      timeout: options?.timeoutMs ?? 5000,
    });

    const response = await rcon.send(cleanCmd);
    await rcon.end();

    if (cleanCmd !== 'erezcraft_chat_flush') {
      log.info(`[RCON] Успешно выполнено: "${cleanCmd}"`);
    }
    return { success: true, response };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    log.error(`[RCON] Ошибка выполнения "${cleanCmd}": ${msg}`);
    return { success: false, error: msg };
  }
}
