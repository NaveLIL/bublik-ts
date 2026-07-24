import type { NsVacation, VacationConfig, VacationRequest } from '@prisma/client';
import type { GuildMember } from 'discord.js';
import { VacationStatus } from './constants';
import { type MemberRoleLock, withMemberRoleLock } from '../../core/MemberRoleLock';
import { getDatabase } from '../../core/Database';
import {
  appendLiveVacationSavedRole,
  appendLiveNsVacationSavedRole,
  getNsVacation,
  getRequest,
  transitionNsVacation,
  transitionRequest,
} from './database';
import { applyVacationRoles, restoreRoles } from './utils';
import {
  getVoiceSession,
  saveVoiceSession,
  suppressSessionForVacation,
} from '../regbattle/voiceSessions';
import { isNsInformationalVacation } from './state';

type VacationWithConfig = VacationRequest & { config: VacationConfig };

async function refreshMember(member: GuildMember): Promise<GuildMember> {
  return member.guild.members.fetch({ user: member.id, force: true });
}

async function persistCurrentPbPingRole(
  request: VacationWithConfig,
  member: GuildMember,
): Promise<VacationWithConfig> {
  const config = await getDatabase().regbattleConfig.findUnique({
    where: { guildId: request.guildId },
    select: { pingRoleId: true },
  });
  const pingRoleId = config?.pingRoleId ?? null;
  const pbSession = pingRoleId ? await getVoiceSession(request.guildId, request.userId) : null;
  const hasDurablePingProvenance = Boolean(
    pingRoleId &&
    pbSession?.version === 2 &&
    (pbSession.hadPingRole || pbSession.playedResetRoleIds.includes(pingRoleId)),
  );
  if (
    !pingRoleId ||
    (!member.roles.cache.has(pingRoleId) && !hasDurablePingProvenance) ||
    request.savedRoleIds.includes(pingRoleId)
  ) {
    return request;
  }
  const updated = await appendLiveVacationSavedRole(request.id, pingRoleId);
  if (!updated || !updated.savedRoleIds.includes(pingRoleId)) {
    throw new Error(`Vacation ${request.id} could not persist PB ping-role provenance`);
  }
  return updated;
}

async function persistNsPbPingRole(record: NsVacation): Promise<NsVacation> {
  const config = await getDatabase().regbattleConfig.findUnique({
    where: { guildId: record.guildId },
    select: { pingRoleId: true },
  });
  const pingRoleId = config?.pingRoleId ?? null;
  const session = pingRoleId ? await getVoiceSession(record.guildId, record.userId) : null;
  const hasProvenance = Boolean(
    pingRoleId &&
    session?.version === 2 &&
    (session.hadPingRole || session.playedResetRoleIds.includes(pingRoleId)),
  );
  if (!pingRoleId || !hasProvenance || record.savedRoleIds.includes(pingRoleId)) return record;
  const updated = await appendLiveNsVacationSavedRole(record.id, pingRoleId);
  if (!updated || !updated.savedRoleIds.includes(pingRoleId)) {
    throw new Error(`NS vacation ${record.id} could not persist PB ping-role provenance`);
  }
  return updated;
}

/**
 * Vacation becomes authoritative at its durable start time, not when a later
 * voice event happens to arrive. Persist the frozen PB clock first, then remove
 * only its transient in-squad capability under the shared member role lock.
 */
async function freezePbSessionForVacation(
  member: GuildMember,
  freezeAt: number,
  lock: MemberRoleLock,
): Promise<void> {
  const session = await getVoiceSession(member.guild.id, member.id);
  if (!session) return;
  const suppressed = suppressSessionForVacation(session, freezeAt);
  await saveVoiceSession(suppressed, lock);
  if (suppressed.inSquadRoleId && member.roles.cache.has(suppressed.inSquadRoleId)) {
    await lock.assertOwned();
    await member.roles.remove(suppressed.inSquadRoleId, 'Vacation: freeze active PB session');
    await lock.assertOwned();
  }
}

async function activateVacationLocked(
  request: VacationWithConfig,
  member: GuildMember,
  lock: MemberRoleLock,
): Promise<VacationWithConfig> {
  const current = await getRequest(request.id);
  if (current?.status === VacationStatus.Active) return current;
  if (!current || current.status !== VacationStatus.Activating) {
    throw new Error(`Vacation ${request.id} is no longer activating`);
  }

  const freshMember = await refreshMember(member);
  const durable = await persistCurrentPbPingRole(current, freshMember);
  await freezePbSessionForVacation(
    freshMember,
    durable.startDate?.getTime() ?? Date.now(),
    lock,
  );
  await applyVacationRoles(freshMember, durable.savedRoleIds, durable.config.vacationRoleId, lock);
  const activated = await transitionRequest(durable.id, VacationStatus.Activating, {
    status: VacationStatus.Active,
  });
  if (activated) return activated;
  const latest = await getRequest(durable.id);
  if (latest?.status === VacationStatus.Active) return latest;
  throw new Error(`Vacation ${durable.id} activation CAS lost`);
}

export async function activateVacation(
  request: VacationWithConfig,
  member: GuildMember,
): Promise<VacationWithConfig> {
  return withMemberRoleLock(request.guildId, request.userId, async (lock) => {
    await lock.assertOwned();
    // Discord errors are outcome-ambiguous. Keep `activating`; the periodic
    // worker force-fetches the member and idempotently converges to ACTIVE.
    return activateVacationLocked(request, member, lock);
  });
}

/** Repair role drift and backfill live pre-hardening vacation snapshots. */
export async function reconcileActiveVacationRoles(
  request: VacationWithConfig,
  member: GuildMember,
): Promise<VacationWithConfig> {
  return withMemberRoleLock(request.guildId, request.userId, async (lock) => {
    await lock.assertOwned();
    const current = await getRequest(request.id);
    if (!current) throw new Error(`Vacation ${request.id} no longer exists`);
    if (current.status === VacationStatus.Activating) {
      return activateVacationLocked(current, member, lock);
    }
    if (current.status !== VacationStatus.Active) return current;
    const freshMember = await refreshMember(member);
    const durable = await persistCurrentPbPingRole(current, freshMember);
    await freezePbSessionForVacation(
      freshMember,
      durable.startDate?.getTime() ?? Date.now(),
      lock,
    );
    await applyVacationRoles(freshMember, durable.savedRoleIds, durable.config.vacationRoleId, lock);
    return durable;
  });
}

export async function restoreVacation(
  request: VacationWithConfig,
  member: GuildMember,
): Promise<VacationWithConfig> {
  return withMemberRoleLock(request.guildId, request.userId, async (lock) => {
    const current = await getRequest(request.id);
    if (current?.status === VacationStatus.Completed) return current;
    if (!current || current.status !== VacationStatus.Restoring) {
      throw new Error(`Vacation ${request.id} is no longer restoring`);
    }
    const freshMember = await refreshMember(member);
    await lock.assertOwned();
    await restoreRoles(freshMember, current.savedRoleIds, current.config.vacationRoleId, lock);
    const completed = await transitionRequest(current.id, VacationStatus.Restoring, {
      status: VacationStatus.Completed,
    });
    if (completed) return completed;
    const latest = await getRequest(current.id);
    if (latest?.status === VacationStatus.Completed) return latest;
    // Never roll back to ACTIVE after an outcome-ambiguous Discord response.
    // REST recovery can safely retry the desired restoring end state.
    throw new Error(`Vacation ${current.id} completion CAS lost`);
  });
}

export async function activateNsRoleVacation(
  record: NsVacation,
  member: GuildMember,
): Promise<NsVacation> {
  return withMemberRoleLock(record.guildId, record.userId, async (lock) => {
    const current = await getNsVacation(record.id);
    if (current?.status === 'active') return current;
    if (!current || current.status !== 'activating') {
      throw new Error(`NS vacation ${record.id} is no longer activating`);
    }
    const freshMember = await refreshMember(member);
    const durable = await persistNsPbPingRole(current);
    await freezePbSessionForVacation(freshMember, durable.startDate.getTime(), lock);
    await applyVacationRoles(freshMember, durable.savedRoleIds, null, lock);
    const activated = await transitionNsVacation(durable.id, 'activating', { status: 'active' });
    if (activated) return activated;
    const latest = await getNsVacation(current.id);
    if (latest?.status === 'active') return latest;
    throw new Error(`NS vacation ${current.id} activation CAS lost`);
  });
}

/**
 * Activate the informational NS vacation through the same durable saga and
 * member lock as role-mutating leave. It changes no vacation-managed roles;
 * the only Discord mutation is removal of PB's transient in-squad capability.
 */
export async function activateNsInformationalVacation(
  record: NsVacation,
  member: GuildMember | null,
): Promise<NsVacation> {
  return withMemberRoleLock(record.guildId, record.userId, async (lock) => {
    const current = await getNsVacation(record.id);
    if (current?.status === 'active') return current;
    if (!current || current.status !== 'activating' || !isNsInformationalVacation(current.type)) {
      throw new Error(`NS informational vacation ${record.id} is no longer activating`);
    }
    if (member) {
      const freshMember = await refreshMember(member);
      await freezePbSessionForVacation(freshMember, current.startDate.getTime(), lock);
    } else {
      // A departed member can still have a durable PB session from a missed
      // voice event. Freeze its accounting now; no Discord role can be touched.
      const session = await getVoiceSession(current.guildId, current.userId);
      if (session) {
        await lock.assertOwned();
        await saveVoiceSession(
          suppressSessionForVacation(session, current.startDate.getTime()),
          lock,
        );
      }
    }
    const activated = await transitionNsVacation(current.id, 'activating', { status: 'active' });
    if (activated) return activated;
    const latest = await getNsVacation(current.id);
    if (latest?.status === 'active') return latest;
    throw new Error(`NS informational vacation ${current.id} activation CAS lost`);
  });
}

export async function restoreNsRoleVacation(
  record: NsVacation,
  member: GuildMember,
): Promise<NsVacation> {
  return withMemberRoleLock(record.guildId, record.userId, async (lock) => {
    const current = await getNsVacation(record.id);
    if (current?.status === 'completed') return current;
    if (!current || current.status !== 'restoring') {
      throw new Error(`NS vacation ${record.id} is no longer restoring`);
    }
    const freshMember = await refreshMember(member);
    await lock.assertOwned();
    await restoreRoles(freshMember, current.savedRoleIds, null, lock);
    const completed = await transitionNsVacation(current.id, 'restoring', { status: 'completed' });
    if (completed) return completed;
    const latest = await getNsVacation(current.id);
    if (latest?.status === 'completed') return latest;
    throw new Error(`NS vacation ${current.id} completion CAS lost`);
  });
}

/** Terminal transition for informational NS leave, serialized with PB roles. */
export async function completeNsVacationWithoutRoles(record: NsVacation): Promise<NsVacation> {
  return withMemberRoleLock(record.guildId, record.userId, async (lock) => {
    await lock.assertOwned();
    const current = await getNsVacation(record.id);
    if (current?.status === 'completed') return current;
    if (!current || !['active', 'restoring'].includes(current.status)) {
      throw new Error(`NS vacation ${record.id} cannot be completed from ${current?.status ?? 'missing'}`);
    }
    const completed = await transitionNsVacation(current.id, current.status, { status: 'completed' });
    if (completed) return completed;
    const latest = await getNsVacation(current.id);
    if (latest?.status === 'completed') return latest;
    throw new Error(`NS vacation ${current.id} completion CAS lost`);
  });
}
