import { PermissionsBitField } from 'discord.js';

type PermissionSource = bigint | Readonly<{ has(permission: bigint): boolean }>;

/**
 * Economy reward roles may carry ordinary member text/voice permissions, but
 * must never confer staff authority, mass-mention authority, or access to
 * administrative/audit surfaces. Keep this policy local to economy rewards:
 * other role features can have intentionally different trust models.
 */
export const FORBIDDEN_ECONOMY_REWARD_PERMISSIONS = [
  PermissionsBitField.Flags.Administrator,
  PermissionsBitField.Flags.KickMembers,
  PermissionsBitField.Flags.BanMembers,
  PermissionsBitField.Flags.ManageChannels,
  PermissionsBitField.Flags.ManageGuild,
  PermissionsBitField.Flags.ViewAuditLog,
  PermissionsBitField.Flags.ManageMessages,
  PermissionsBitField.Flags.MentionEveryone,
  PermissionsBitField.Flags.ViewGuildInsights,
  PermissionsBitField.Flags.MuteMembers,
  PermissionsBitField.Flags.DeafenMembers,
  PermissionsBitField.Flags.MoveMembers,
  PermissionsBitField.Flags.ManageNicknames,
  PermissionsBitField.Flags.ManageRoles,
  PermissionsBitField.Flags.ManageWebhooks,
  PermissionsBitField.Flags.ManageEmojisAndStickers,
  PermissionsBitField.Flags.ManageGuildExpressions,
  PermissionsBitField.Flags.ManageEvents,
  PermissionsBitField.Flags.ManageThreads,
  PermissionsBitField.Flags.ModerateMembers,
  PermissionsBitField.Flags.ViewCreatorMonetizationAnalytics,
  PermissionsBitField.Flags.CreateGuildExpressions,
  PermissionsBitField.Flags.CreateEvents,
  PermissionsBitField.Flags.SetVoiceChannelStatus,
  PermissionsBitField.Flags.PinMessages,
  PermissionsBitField.Flags.BypassSlowmode,
] as const;

export function hasForbiddenEconomyRewardPermissions(permissions: PermissionSource): boolean {
  if (typeof permissions === 'bigint') {
    return FORBIDDEN_ECONOMY_REWARD_PERMISSIONS.some((permission) =>
      (permissions & permission) === permission);
  }
  return FORBIDDEN_ECONOMY_REWARD_PERMISSIONS.some((permission) => permissions.has(permission));
}
