// ═══════════════════════════════════════════════
//  RegBattle — Утилиты
// ═══════════════════════════════════════════════

import { Guild, GuildMember, VoiceChannel, ChannelType } from 'discord.js';
import { SQUAD_NAME_TEMPLATE, AIR_NAME_TEMPLATE } from './constants';

// ═══════════════════════════════════════════════
//  Имена каналов
// ═══════════════════════════════════════════════

/** Сгенерировать имя отряда: ⟪ ・ОТРЯД 1・⟫ */
export function squadName(num: number): string {
  return SQUAD_NAME_TEMPLATE.replace('{n}', String(num));
}

/** Сгенерировать имя авиа-канала: ・AIR 1・ */
export function airName(num: number): string {
  return AIR_NAME_TEMPLATE.replace('{n}', String(num));
}

// ═══════════════════════════════════════════════
//  Подсчёт участников отряда
// ═══════════════════════════════════════════════

/** Посчитать не-ботов в основном и авиа-канале отряда. */
export function getSquadMemberCount(
  guild: Guild,
  voiceChannelId: string,
  airChannelId?: string | null,
): number {
  let count = 0;
  const mainVc = guild.channels.cache.get(voiceChannelId);
  if (mainVc?.type === ChannelType.GuildVoice) {
    count += (mainVc as VoiceChannel).members.filter((member) => !member.user.bot).size;
  }

  if (airChannelId) {
    const airVc = guild.channels.cache.get(airChannelId);
    if (airVc?.type === ChannelType.GuildVoice) {
      count += (airVc as VoiceChannel).members.filter((member) => !member.user.bot).size;
    }
  }
  return count;
}

/** Получить всех не-ботов из основного и авиа-канала отряда. */
export function getSquadMembers(
  guild: Guild,
  voiceChannelId: string,
  airChannelId?: string | null,
): GuildMember[] {
  const members: GuildMember[] = [];
  const mainVc = guild.channels.cache.get(voiceChannelId);
  if (mainVc?.type === ChannelType.GuildVoice) {
    (mainVc as VoiceChannel).members.forEach((member) => {
      if (!member.user.bot) members.push(member);
    });
  }

  if (airChannelId) {
    const airVc = guild.channels.cache.get(airChannelId);
    if (airVc?.type === ChannelType.GuildVoice) {
      (airVc as VoiceChannel).members.forEach((member) => {
        if (!member.user.bot) members.push(member);
      });
    }
  }
  return members;
}

// ═══════════════════════════════════════════════
//  Антирейс: блокировка создания канала
// ═══════════════════════════════════════════════

const creationLocks = new Set<string>();
const creationCooldowns = new Map<string, number>();

export function acquireCreationLock(userId: string): boolean {
  if (creationLocks.has(userId)) return false;
  creationLocks.add(userId);
  return true;
}

export function releaseCreationLock(userId: string): void {
  creationLocks.delete(userId);
}

export function isCreationCooldown(userId: string): boolean {
  const last = creationCooldowns.get(userId);
  if (!last) return false;
  if (Date.now() - last < 10_000) return true;
  creationCooldowns.delete(userId);
  return false;
}

export function setCreationCooldown(userId: string): void {
  creationCooldowns.set(userId, Date.now());
  if (creationCooldowns.size > 100) {
    const now = Date.now();
    for (const [uid, timestamp] of creationCooldowns) {
      if (now - timestamp > 60_000) creationCooldowns.delete(uid);
    }
  }
}
