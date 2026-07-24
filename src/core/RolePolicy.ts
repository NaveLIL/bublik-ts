import {
  ChatInputCommandInteraction,
  Guild,
  PermissionsBitField,
  Role,
} from 'discord.js';

export const DANGEROUS_ASSIGNABLE_PERMISSIONS = [
  PermissionsBitField.Flags.Administrator,
  PermissionsBitField.Flags.ManageGuild,
  PermissionsBitField.Flags.ManageRoles,
  PermissionsBitField.Flags.ManageChannels,
  PermissionsBitField.Flags.BanMembers,
  PermissionsBitField.Flags.KickMembers,
  PermissionsBitField.Flags.ModerateMembers,
  PermissionsBitField.Flags.ManageWebhooks,
] as const;

type PermissionSource = bigint | Readonly<{ has(permission: bigint): boolean }>;

/** Roles automatically granted by the bot must never carry staff authority. */
export function hasDangerousAssignablePermissions(permissions: PermissionSource): boolean {
  if (typeof permissions === 'bigint') {
    return DANGEROUS_ASSIGNABLE_PERMISSIONS.some((permission) =>
      (permissions & permission) === permission);
  }
  return DANGEROUS_ASSIGNABLE_PERMISSIONS.some((permission) => permissions.has(permission));
}

export type RolePolicyFailureReason =
  | 'missing_manage_roles'
  | 'bot_missing_manage_roles'
  | 'role_missing'
  | 'wrong_guild'
  | 'everyone'
  | 'managed'
  | 'bot_hierarchy'
  | 'actor_hierarchy';

export type RolePolicyDecision =
  | { ok: true }
  | { ok: false; reason: RolePolicyFailureReason };

export interface RolePolicyContext {
  guildId: string;
  actorCanManageRoles: boolean;
  actorIsGuildOwner: boolean;
  actorHighestPosition: number;
  botCanManageRoles: boolean;
  botHighestPosition: number;
}

export type RolePolicySubject =
  | Pick<Role, 'id' | 'guild' | 'managed' | 'position'>
  | {
      id: string;
      guildId: string;
      managed: boolean;
      position: number;
    };

/**
 * Pure Discord role-authority decision. Equality is deliberately rejected:
 * neither Discord bots nor non-owner members can manage their highest role.
 */
export function evaluateRolePolicy(
  context: RolePolicyContext,
  role: RolePolicySubject | null,
): RolePolicyDecision {
  if (!context.actorCanManageRoles) return { ok: false, reason: 'missing_manage_roles' };
  if (!context.botCanManageRoles) return { ok: false, reason: 'bot_missing_manage_roles' };
  if (!role) return { ok: false, reason: 'role_missing' };
  const roleGuildId = 'guildId' in role ? role.guildId : role.guild.id;
  if (roleGuildId !== context.guildId) return { ok: false, reason: 'wrong_guild' };
  if (role.id === context.guildId) return { ok: false, reason: 'everyone' };
  if (role.managed) return { ok: false, reason: 'managed' };
  if (role.position >= context.botHighestPosition) return { ok: false, reason: 'bot_hierarchy' };
  if (!context.actorIsGuildOwner && role.position >= context.actorHighestPosition) {
    return { ok: false, reason: 'actor_hierarchy' };
  }
  return { ok: true };
}

/** Force-refresh both authority subjects before a security-sensitive decision. */
export async function loadInteractionRolePolicyContext(
  interaction: ChatInputCommandInteraction,
): Promise<RolePolicyContext | null> {
  const guild = interaction.guild;
  const botId = interaction.client.user?.id;
  if (!guild || !botId) return null;

  const [actor, bot] = await Promise.all([
    guild.members.fetch({ user: interaction.user.id, force: true }),
    guild.members.fetch({ user: botId, force: true }),
  ]);

  return {
    guildId: guild.id,
    actorCanManageRoles: actor.permissions.has(PermissionsBitField.Flags.ManageRoles),
    actorIsGuildOwner: actor.id === guild.ownerId,
    actorHighestPosition: actor.roles.highest.position,
    botCanManageRoles: bot.permissions.has(PermissionsBitField.Flags.ManageRoles),
    botHighestPosition: bot.roles.highest.position,
  };
}

/** Force-refresh the configured role so a stale interaction payload is not trusted. */
export async function fetchRolePolicySubject(guild: Guild, roleId: string): Promise<Role | null> {
  return guild.roles.fetch(roleId, { force: true });
}

export async function evaluateInteractionRole(
  interaction: ChatInputCommandInteraction,
  roleId: string,
  context?: RolePolicyContext | null,
): Promise<RolePolicyDecision> {
  const policyContext = context ?? await loadInteractionRolePolicyContext(interaction);
  if (!policyContext || !interaction.guild) return { ok: false, reason: 'wrong_guild' };
  const role = await fetchRolePolicySubject(interaction.guild, roleId);
  return evaluateRolePolicy(policyContext, role);
}

export function rolePolicyFailureMessage(reason: RolePolicyFailureReason): string {
  switch (reason) {
    case 'missing_manage_roles':
      return 'Для этой операции требуется право «Управлять ролями».';
    case 'bot_missing_manage_roles':
      return 'У бота нет права «Управлять ролями».';
    case 'role_missing':
      return 'Роль больше не существует на сервере.';
    case 'wrong_guild':
      return 'Роль должна принадлежать этому серверу.';
    case 'everyone':
      return 'Роль @everyone нельзя использовать в этой настройке.';
    case 'managed':
      return 'Интеграционной (managed) ролью нельзя управлять вручную.';
    case 'bot_hierarchy':
      return 'Эта роль находится не ниже высшей роли бота.';
    case 'actor_hierarchy':
      return 'Эта роль находится не ниже вашей высшей роли.';
  }
}

/**
 * A distinct error lets recovery code tell a permanent unsafe configuration
 * from a transient Discord lookup failure. Automatic grants must fail closed,
 * while callers may still remove an unsafe role during cleanup.
 */
export class UnsafeAutomaticRoleError extends Error {
  constructor(
    public readonly roleId: string,
    public readonly reason: RolePolicyFailureReason | 'dangerous_permissions',
  ) {
    super(`Automatic role ${roleId} is unsafe: ${reason}`);
    this.name = 'UnsafeAutomaticRoleError';
  }
}

/**
 * Force-read the bot member and role immediately before an automatic grant.
 * Setup-time validation is not sufficient because role hierarchy and
 * permissions can be edited later.
 */
export async function fetchSafeAutomaticRole(
  guild: Guild,
  roleId: string,
): Promise<Role> {
  const botId = guild.client.user?.id;
  if (!botId) throw new UnsafeAutomaticRoleError(roleId, 'bot_missing_manage_roles');

  const [bot, role] = await Promise.all([
    guild.members.fetch({ user: botId, force: true }),
    fetchRolePolicySubject(guild, roleId),
  ]);
  if (!bot.permissions.has(PermissionsBitField.Flags.ManageRoles)) {
    throw new UnsafeAutomaticRoleError(roleId, 'bot_missing_manage_roles');
  }
  if (!role) throw new UnsafeAutomaticRoleError(roleId, 'role_missing');
  if (role.guild.id !== guild.id) throw new UnsafeAutomaticRoleError(roleId, 'wrong_guild');
  if (role.id === guild.id) throw new UnsafeAutomaticRoleError(roleId, 'everyone');
  if (role.managed) throw new UnsafeAutomaticRoleError(roleId, 'managed');
  if (role.position >= bot.roles.highest.position) {
    throw new UnsafeAutomaticRoleError(roleId, 'bot_hierarchy');
  }
  if (hasDangerousAssignablePermissions(role.permissions)) {
    throw new UnsafeAutomaticRoleError(roleId, 'dangerous_permissions');
  }
  return role;
}
