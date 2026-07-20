import type { MessageCreateOptions } from 'discord.js';
import type { PbMassRoleMentionPlan } from './pingEligibility';

const DENY_ALL_ALLOWED_MENTIONS = {
  parse: [] as [],
  roles: [] as [],
  users: [] as [],
  repliedUser: false as const,
};

type MessageEmbed = NonNullable<MessageCreateOptions['embeds']>[number];

/**
 * Build the one-shot pinger message with an explicit mention allow-list.
 * Embeds never notify Discord roles by themselves, while an unsafe or missing
 * mass-mention plan must remain completely silent.
 */
export function buildPbPingerMessage(
  embed: MessageEmbed,
  mention: PbMassRoleMentionPlan | null,
): MessageCreateOptions {
  return {
    ...(mention ?? {}),
    embeds: [embed],
    allowedMentions: mention?.allowedMentions ?? DENY_ALL_ALLOWED_MENTIONS,
  };
}
