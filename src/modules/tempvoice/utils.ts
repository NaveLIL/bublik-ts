// ═══════════════════════════════════════════════
//  TempVoice — утилиты
// ═══════════════════════════════════════════════

import {
  GuildMember,
  VoiceChannel,
  PermissionsBitField,
  OverwriteResolvable,
  ChannelType,
  Guild,
} from 'discord.js';
import type { TempVoiceGenerator, TempVoiceChannel } from '@prisma/client';
import { AccessLevel, ChannelState, RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_MS, CREATION_COOLDOWN_MS } from './constants';
import { getTrusted, getBlocked } from './database';

// ═══════════════════════════════════════════════
//  Rate Limiter (in-memory, per-user)
// ═══════════════════════════════════════════════

const rateLimits = new Map<string, number[]>();
const creationCooldowns = new Map<string, number>();

/** Периодическая очистка */
setInterval(() => {
  const now = Date.now();
  for (const [key, timestamps] of rateLimits) {
    const valid = timestamps.filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
    if (valid.length === 0) rateLimits.delete(key);
    else rateLimits.set(key, valid);
  }
  for (const [key, ts] of creationCooldowns) {
    if (now - ts > CREATION_COOLDOWN_MS) creationCooldowns.delete(key);
  }
}, 60_000);

/** Проверить rate-limit. Возвращает true если лимит превышен */
export function isRateLimited(userId: string): boolean {
  const now = Date.now();
  const timestamps = rateLimits.get(userId) ?? [];
  const valid = timestamps.filter((t) => now - t < RATE_LIMIT_WINDOW_MS);

  if (valid.length >= RATE_LIMIT_MAX) return true;

  valid.push(now);
  rateLimits.set(userId, valid);
  return false;
}

/** Проверить кулдаун создания канала */
export function isCreationCooldown(userId: string): boolean {
  const last = creationCooldowns.get(userId);
  if (last && Date.now() - last < CREATION_COOLDOWN_MS) return true;
  creationCooldowns.set(userId, Date.now());
  return false;
}

// ═══════════════════════════════════════════════
//  Блокировка создания (антирейс)
// ═══════════════════════════════════════════════

const creationLocks = new Set<string>();

export function acquireCreationLock(userId: string): boolean {
  if (creationLocks.has(userId)) return false;
  creationLocks.add(userId);
  // Автоматический сброс через 10с на случай ошибки
  setTimeout(() => creationLocks.delete(userId), 10_000);
  return true;
}

export function releaseCreationLock(userId: string): void {
  creationLocks.delete(userId);
}

// ═══════════════════════════════════════════════
//  Активные взаимодействия (антидубли select menu)
// ═══════════════════════════════════════════════

const activeInteractions = new Set<string>();

export function hasActiveInteraction(userId: string): boolean {
  return activeInteractions.has(userId);
}

export function setActiveInteraction(userId: string): void {
  activeInteractions.add(userId);
  setTimeout(() => activeInteractions.delete(userId), 35_000);
}

export function clearActiveInteraction(userId: string): void {
  activeInteractions.delete(userId);
}

// ═══════════════════════════════════════════════
//  Определение уровня доступа
// ═══════════════════════════════════════════════

export async function getAccessLevel(
  member: GuildMember,
  channelData: TempVoiceChannel,
  generator: TempVoiceGenerator,
): Promise<AccessLevel> {
  // Владелец канала
  if (member.id === channelData.ownerId) return AccessLevel.Owner;

  // Модератор (любая из immuneRoleIds)
  if (generator.immuneRoleIds.length > 0 && generator.immuneRoleIds.some((id) => member.roles.cache.has(id))) {
    return AccessLevel.Moderator;
  }

  // Проверка блокировки
  const blocked = await getBlocked(channelData.id);
  if (blocked.includes(member.id)) return AccessLevel.Blocked;

  // Доверенный
  const trusted = await getTrusted(channelData.id);
  if (trusted.includes(member.id)) return AccessLevel.Trusted;

  // Бустер
  if (generator.boosterPerks && member.premiumSince) return AccessLevel.Booster;

  return AccessLevel.Normal;
}

/** Проверить, может ли пользователь управлять каналом */
export function canManage(level: AccessLevel): boolean {
  return level === AccessLevel.Owner || level === AccessLevel.Moderator;
}

/** Проверить, расширенные ли права (бустер+) */
export function hasElevated(level: AccessLevel): boolean {
  return (
    level === AccessLevel.Owner ||
    level === AccessLevel.Moderator ||
    level === AccessLevel.Booster
  );
}

// ═══════════════════════════════════════════════
//  Шаблон имени канала
// ═══════════════════════════════════════════════

export function resolveChannelName(
  template: string,
  member: GuildMember,
  count: number,
): string {
  const game = member.presence?.activities?.find((a) => a.type === 0)?.name;

  let name = template
    .replace(/{username}/gi, member.user.username)
    .replace(/{nickname}/gi, member.displayName)
    .replace(/{game}/gi, game ?? member.displayName)
    .replace(/{count}/gi, String(count));

  // Ограничение Discord: 1–100 символов
  if (name.length > 100) name = name.slice(0, 100);
  if (name.length === 0) name = member.displayName;

  return name;
}

// ═══════════════════════════════════════════════
//  Permission Overwrites
// ═══════════════════════════════════════════════

/** Построить permission overwrites для канала по его состоянию */
export async function buildPermissionOverwrites(
  channelData: TempVoiceChannel,
  generator: TempVoiceGenerator,
  guild: Guild,
  botId: string,
): Promise<OverwriteResolvable[]> {
  const overwrites: OverwriteResolvable[] = [];
  const trusted = await getTrusted(channelData.id);
  const blocked = await getBlocked(channelData.id);

  const state = channelData.state as ChannelState;
  const guildId = guild.id;

  // Копировать права РОЛЕЙ с мастер-канала (генератора)
  const generatorChannel = guild.channels.cache.get(generator.channelId);
  if (generatorChannel && 'permissionOverwrites' in generatorChannel) {
    for (const [id, overwrite] of generatorChannel.permissionOverwrites.cache) {
      // Копируем только role-оверрайды, но не @everyone (его мы управляем отдельно)
      if (overwrite.type === 0 && id !== guildId) {
        overwrites.push({
          id,
          allow: overwrite.allow.toArray(),
          deny: overwrite.deny.toArray(),
        });
      }
    }
  }

  // @everyone: зависит от состояния
  switch (state) {
    case ChannelState.Locked:
      overwrites.push({
        id: guildId, // @everyone role ID = guild ID
        deny: [PermissionsBitField.Flags.Connect],
        allow: [PermissionsBitField.Flags.ViewChannel],
      });
      break;
    case ChannelState.Hidden:
      overwrites.push({
        id: guildId,
        deny: [
          PermissionsBitField.Flags.Connect,
          PermissionsBitField.Flags.ViewChannel,
        ],
      });
      break;
    default: // unlocked
      overwrites.push({
        id: guildId,
        allow: [
          PermissionsBitField.Flags.Connect,
          PermissionsBitField.Flags.ViewChannel,
        ],
      });
  }

  // Бот: полный доступ (нужен для панели управления и управления каналом)
  overwrites.push({
    id: botId,
    allow: [
      PermissionsBitField.Flags.ViewChannel,
      PermissionsBitField.Flags.Connect,
      PermissionsBitField.Flags.SendMessages,
      PermissionsBitField.Flags.ManageChannels,
      PermissionsBitField.Flags.MoveMembers,
      PermissionsBitField.Flags.MuteMembers,
      PermissionsBitField.Flags.DeafenMembers,
      PermissionsBitField.Flags.ReadMessageHistory,
      PermissionsBitField.Flags.EmbedLinks,
    ],
  });

  // Владелец: полное управление
  overwrites.push({
    id: channelData.ownerId,
    allow: [
      PermissionsBitField.Flags.Connect,
      PermissionsBitField.Flags.ViewChannel,
      PermissionsBitField.Flags.ManageChannels,
      PermissionsBitField.Flags.MuteMembers,
      PermissionsBitField.Flags.DeafenMembers,
      PermissionsBitField.Flags.MoveMembers,
      PermissionsBitField.Flags.Stream,
      PermissionsBitField.Flags.Speak,
    ],
  });

  // Immune Roles: обход всех ограничений
  for (const roleId of generator.immuneRoleIds) {
    overwrites.push({
      id: roleId,
      allow: [
        PermissionsBitField.Flags.Connect,
        PermissionsBitField.Flags.ViewChannel,
        PermissionsBitField.Flags.ManageChannels,
        PermissionsBitField.Flags.MuteMembers,
        PermissionsBitField.Flags.DeafenMembers,
        PermissionsBitField.Flags.MoveMembers,
      ],
    });
  }

  // Доверенные: могут подключаться даже когда заблокировано/скрыто
  for (const userId of trusted) {
    overwrites.push({
      id: userId,
      allow: [
        PermissionsBitField.Flags.Connect,
        PermissionsBitField.Flags.ViewChannel,
        PermissionsBitField.Flags.Speak,
        PermissionsBitField.Flags.Stream,
      ],
    });
  }

  // Заблокированные: полный запрет
  for (const userId of blocked) {
    overwrites.push({
      id: userId,
      deny: [
        PermissionsBitField.Flags.Connect,
        PermissionsBitField.Flags.ViewChannel,
        PermissionsBitField.Flags.Speak,
        PermissionsBitField.Flags.Stream,
        PermissionsBitField.Flags.SendMessages,
      ],
    });
  }

  return overwrites;
}

/** Найти голосовой канал участника (из tempvoice) */
export function getMemberVoiceChannel(member: GuildMember): VoiceChannel | null {
  const vc = member.voice.channel;
  if (!vc || vc.type !== ChannelType.GuildVoice) return null;
  return vc as VoiceChannel;
}
