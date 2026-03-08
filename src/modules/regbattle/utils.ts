// ═══════════════════════════════════════════════
//  RegBattle — Утилиты
// ═══════════════════════════════════════════════

import { Guild, GuildMember, VoiceChannel, ChannelType, Role } from 'discord.js';
import { SQUAD_NAME_TEMPLATE, AIR_NAME_TEMPLATE } from './constants';
import { logger } from '../../core/Logger';

const log = logger.child('RegBattle:Roles');

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

/**
 * Посчитать участников в основном + авиа каналах.
 * Учитывает только не-ботов.
 */
export function getSquadMemberCount(guild: Guild, voiceChannelId: string, airChannelId?: string | null): number {
  let count = 0;

  const mainVc = guild.channels.cache.get(voiceChannelId);
  if (mainVc && mainVc.type === ChannelType.GuildVoice) {
    count += (mainVc as VoiceChannel).members.filter((m) => !m.user.bot).size;
  }

  if (airChannelId) {
    const airVc = guild.channels.cache.get(airChannelId);
    if (airVc && airVc.type === ChannelType.GuildVoice) {
      count += (airVc as VoiceChannel).members.filter((m) => !m.user.bot).size;
    }
  }

  return count;
}

/**
 * Получить всех участников (не ботов) из основного + авиа канала.
 */
export function getSquadMembers(guild: Guild, voiceChannelId: string, airChannelId?: string | null): GuildMember[] {
  const members: GuildMember[] = [];

  const mainVc = guild.channels.cache.get(voiceChannelId);
  if (mainVc && mainVc.type === ChannelType.GuildVoice) {
    (mainVc as VoiceChannel).members.forEach((m) => {
      if (!m.user.bot) members.push(m);
    });
  }

  if (airChannelId) {
    const airVc = guild.channels.cache.get(airChannelId);
    if (airVc && airVc.type === ChannelType.GuildVoice) {
      (airVc as VoiceChannel).members.forEach((m) => {
        if (!m.user.bot) members.push(m);
      });
    }
  }

  return members;
}

// ═══════════════════════════════════════════════
//  Роли — swap при входе/выходе
// ═══════════════════════════════════════════════

/**
 * Проверить иерархию: может ли бот управлять целевой ролью
 */
function canManageRole(guild: Guild, role: Role | undefined): boolean {
  if (!role) return false;
  const botMember = guild.members.me;
  if (!botMember) return false;
  if (botMember.roles.highest.position <= role.position) {
    log.warn(
      `Иерархия ролей: бот (${botMember.roles.highest.name}:${botMember.roles.highest.position}) ` +
      `не может управлять ролью ${role.name}:${role.position}. ` +
      `Переместите роль бота ВЫШЕ этой роли в настройках сервера.`,
    );
    return false;
  }
  return true;
}

/**
 * Выдать inSquadRole, снять pingRole (вход в отряд)
 */
export async function applySquadRoles(
  member: GuildMember,
  pingRoleId: string | null,
  inSquadRoleId: string | null,
): Promise<void> {
  const guild = member.guild;
  const tag = member.user.tag;

  // Снять пинг-роль
  if (pingRoleId) {
    const role = guild.roles.cache.get(pingRoleId);
    if (!role) {
      log.warn(`pingRole ${pingRoleId} не найдена в кэше гильдии`);
    } else if (!canManageRole(guild, role)) {
      // предупреждение уже залогировано
    } else if (member.roles.cache.has(pingRoleId)) {
      try {
        await member.roles.remove(pingRoleId, 'RegBattle: вход в отряд');
        log.info(`✔ Снята pingRole ${role.name} у ${tag}`);
      } catch (err) {
        log.error(`✗ Не удалось снять pingRole ${role.name} у ${tag}`, { error: String(err) });
      }
    }
  }

  // Выдать роль «в отряде»
  if (inSquadRoleId) {
    const role = guild.roles.cache.get(inSquadRoleId);
    if (!role) {
      log.warn(`inSquadRole ${inSquadRoleId} не найдена в кэше гильдии`);
    } else if (!canManageRole(guild, role)) {
      // предупреждение уже залогировано
    } else if (!member.roles.cache.has(inSquadRoleId)) {
      try {
        await member.roles.add(inSquadRoleId, 'RegBattle: вход в отряд');
        log.info(`✔ Выдана inSquadRole ${role.name} для ${tag}`);
      } catch (err) {
        log.error(`✗ Не удалось выдать inSquadRole ${role.name} для ${tag}`, { error: String(err) });
      }
    }
  }
}

/**
 * Снять inSquadRole, вернуть pingRole (выход из отряда)
 */
export async function restoreSquadRoles(
  member: GuildMember,
  pingRoleId: string | null,
  inSquadRoleId: string | null,
): Promise<void> {
  const guild = member.guild;
  const tag = member.user.tag;

  // Снять роль «в отряде»
  if (inSquadRoleId) {
    const role = guild.roles.cache.get(inSquadRoleId);
    if (!role) {
      log.warn(`inSquadRole ${inSquadRoleId} не найдена в кэше гильдии`);
    } else if (!canManageRole(guild, role)) {
      // предупреждение уже залогировано
    } else if (member.roles.cache.has(inSquadRoleId)) {
      try {
        await member.roles.remove(inSquadRoleId, 'RegBattle: выход из отряда');
        log.info(`✔ Снята inSquadRole ${role.name} у ${tag}`);
      } catch (err) {
        log.error(`✗ Не удалось снять inSquadRole ${role.name} у ${tag}`, { error: String(err) });
      }
    }
  }

  // Вернуть пинг-роль
  if (pingRoleId) {
    const role = guild.roles.cache.get(pingRoleId);
    if (!role) {
      log.warn(`pingRole ${pingRoleId} не найдена в кэше гильдии`);
    } else if (!canManageRole(guild, role)) {
      // предупреждение уже залогировано
    } else if (!member.roles.cache.has(pingRoleId)) {
      try {
        await member.roles.add(pingRoleId, 'RegBattle: выход из отряда');
        log.info(`✔ Возвращена pingRole ${role.name} для ${tag}`);
      } catch (err) {
        log.error(`✗ Не удалось вернуть pingRole ${role.name} для ${tag}`, { error: String(err) });
      }
    }
  }
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
  return Date.now() - last < 10_000;
}

export function setCreationCooldown(userId: string): void {
  creationCooldowns.set(userId, Date.now());
}
