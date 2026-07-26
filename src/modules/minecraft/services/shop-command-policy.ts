const MAX_TEMPLATE_LENGTH = 8_192;
const MAX_COMMAND_LENGTH = 2_048;
const MAX_COMMANDS = 16;
const MAX_GIVE_COUNT = 2_147_483_647;

export type ShopCommandPolicyResult =
  | { ok: true; commands: string[] }
  | { ok: false; reason: string };

/**
 * Shop delivery is intentionally limited to Minecraft's `give` command.
 * Administrators can configure the item and count, but cannot turn a shop item
 * into a generic RCON console.
 */
export function validateShopCommandTemplate(template: string): ShopCommandPolicyResult {
  if (!template.trim()) return { ok: false, reason: 'Команда доставки не указана.' };
  if (template.length > MAX_TEMPLATE_LENGTH || template.includes('\0')) {
    return { ok: false, reason: 'Команда доставки слишком длинная или содержит запрещённые символы.' };
  }

  const rawCommands = template.split(/&&|;|\r?\n/);
  if (
    rawCommands.length > MAX_COMMANDS
    || rawCommands.some((command) => command.trim().length === 0)
  ) {
    return { ok: false, reason: `Допустимо от 1 до ${MAX_COMMANDS} непустых команд доставки.` };
  }

  const commands: string[] = [];
  for (const rawCommand of rawCommands) {
    const command = rawCommand.trim();
    if (command.length > MAX_COMMAND_LENGTH) {
      return { ok: false, reason: 'Одна из команд доставки слишком длинная.' };
    }

    const usernamePlaceholders = command.match(/\{username\}/g)?.length ?? 0;
    if (usernamePlaceholders !== 1) {
      return {
        ok: false,
        reason: 'Каждая команда должна содержать ровно один плейсхолдер {username}.',
      };
    }

    const match = /^give\s+\{username\}\s+([a-z0-9_.-]+:[a-z0-9_./-]+(?:\[[^\r\n;\s]*\])?)(?:\s+([1-9]\d*))?$/.exec(
      command
    );
    if (!match) {
      return {
        ok: false,
        reason: 'Разрешён только шаблон: give {username} namespace:item [количество].',
      };
    }

    if (match[2] && Number(match[2]) > MAX_GIVE_COUNT) {
      return { ok: false, reason: 'Количество выдаваемых предметов слишком велико.' };
    }
    commands.push(command);
  }

  return { ok: true, commands };
}
