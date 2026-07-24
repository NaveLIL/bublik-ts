export interface BrImportPolicyInput {
  sourceGuildId: string;
  targetGuildId: string;
  templateGuildId: string;
  actorId: string;
  ownerId: string | null;
  actorCanManageSourceGuild: boolean;
}

/**
 * The configured template is intentionally public. Every other cross-guild
 * read is tenant data and therefore requires authority in the source guild.
 */
export function canImportBrSource(input: BrImportPolicyInput): boolean {
  if (input.sourceGuildId === input.targetGuildId) return true;
  if (input.sourceGuildId === input.templateGuildId) return true;
  if (input.ownerId && input.actorId === input.ownerId) return true;
  return input.actorCanManageSourceGuild;
}
