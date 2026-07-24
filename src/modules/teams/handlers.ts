// ═══════════════════════════════════════════════
//  Teams — Interaction Router
// ═══════════════════════════════════════════════

import { Interaction } from 'discord.js';
import type { BublikClient } from '../../bot';
import type { ModuleExecutionGuard } from '../../types';
import { logger } from '../../core/Logger';
import { TM_PREFIX, TM_SEP } from './constants';
import { TEAM_NAME_MODAL_ID, REPORT_MODAL_ID, POLL_TIME_MODAL_ID, POLL_VOTE_MODAL_ID } from './embeds';

import {
  handleMemberSelect,
  handleNameModal,
  handleInviteResponse,
  handleApplicationReview,
} from './creation';

import {
  handleInviteNew,
  handleInviteNewSelect,
  handleKick,
  handleKickSelect,
  handleTransfer,
  handleTransferSelect,
  handleDisband,
} from './management';

import { handlePollClose, handlePollVote, handlePollTimeModal, handlePollVoteModal } from './polls';
import { handleReportButton, handleReportModal } from './reports';
import { handleSeasonSelect } from './statistics';

const log = logger.child('Teams:Handlers');

export async function handleTeamInteraction(
  interaction: Interaction,
  client: BublikClient,
  guard?: ModuleExecutionGuard,
): Promise<void> {
  guard?.assertCurrent();
  // ── Кнопки ──
  if (interaction.isButton()) {
    const parts = interaction.customId.split(TM_SEP);
    if (parts[0] !== TM_PREFIX) return;

    const action = parts[1];

    switch (action) {
      // Инвайты (ЛС)
      case 'invite': {
        const subAction = parts[2]; // accept | decline
        const teamId = parts[3];
        const userId = parts[4];
        if (subAction === 'accept' || subAction === 'decline') {
          await handleInviteResponse(interaction, subAction, teamId, userId, client);
        }
        return;
      }

      // Заявка (approve | reject)
      case 'app': {
        const subAction = parts[2]; // approve | reject
        const applicationId = parts[3];
        if (subAction === 'approve' || subAction === 'reject') {
          await handleApplicationReview(interaction, subAction, applicationId, client);
        }
        return;
      }

      // Управление командой
      case 'manage': {
        const subAction = parts[2];
        const teamId = parts[3];

        switch (subAction) {
          case 'invite':
            await handleInviteNew(interaction, teamId, client);
            return;
          case 'kick':
            await handleKick(interaction, teamId, client);
            return;
          case 'transfer':
            await handleTransfer(interaction, teamId, client);
            return;
          case 'poll':
            // Импорт из polls
            const { handlePollCreate } = await import('./polls');
            await handlePollCreate(interaction, teamId, client);
            return;
          case 'disband':
            await handleDisband(interaction, teamId, client);
            return;
          default:
            log.warn(`Неизвестное manage действие: ${subAction}`);
        }
        return;
      }

      // Опрос
      case 'poll': {
        const subAction = parts[2]; // yes | no | close
        const pollId = parts[3];
        if (subAction === 'close') {
          await handlePollClose(interaction, pollId, client);
          return;
        }
        if (subAction === 'yes' || subAction === 'no') {
          await handlePollVote(interaction, subAction, pollId, client);
        }
        return;
      }

      // Отчёт
      case 'report': {
        const subAction = parts[2]; // fill
        const sessionId = parts[3];
        if (subAction === 'fill') await handleReportButton(interaction, sessionId, client);
        return;
      }

      // Приглашение в войс
      case 'vinvite': {
        const subAction = parts[2]; // join
        const squadId = parts[3];
        const userId = parts[4];
        if (subAction === 'join') {
          const { handleVoiceInviteJoin } = await import('./voiceIntegration');
          guard?.assertCurrent();
          await handleVoiceInviteJoin(interaction, squadId, userId, client, guard);
        }
        return;
      }

      // Инвайт из панели отряда
      case 'squad': {
        const subAction = parts[2]; // invite
        const squadId = parts[3];
        if (subAction === 'invite') {
          const { handleSquadInvite } = await import('./voiceIntegration');
          guard?.assertCurrent();
          await handleSquadInvite(interaction, squadId, client);
        }
        return;
      }

      default:
        log.warn(`Неизвестное tm действие: ${action}`);
    }
    return;
  }

  // ── UserSelectMenu ──
  if (interaction.isUserSelectMenu()) {
    const parts = interaction.customId.split(TM_SEP);
    if (parts[0] !== TM_PREFIX || parts[1] !== 'sel') return;

    const selType = parts[2];
    const entityId = parts[3];

    switch (selType) {
      case 'members':
        await handleMemberSelect(interaction, client);
        return;
      case 'invite_new':
        await handleInviteNewSelect(interaction, entityId, client);
        return;
      case 'kick':
        await handleKickSelect(interaction, entityId, client);
        return;
      case 'transfer':
        await handleTransferSelect(interaction, entityId, client);
        return;
      case 'vinvite_target': {
        const { handleSquadInviteSelect } = await import('./voiceIntegration');
        guard?.assertCurrent();
        await handleSquadInviteSelect(interaction, entityId, client, guard);
        return;
      }
      default:
        log.warn(`Неизвестный tm select: ${selType}`);
    }
    return;
  }

  // ── StringSelectMenu ──
  if (interaction.isStringSelectMenu()) {
    const parts = interaction.customId.split(TM_SEP);
    if (parts[0] !== TM_PREFIX || parts[1] !== 'sel') return;

    const selType = parts[2];

    switch (selType) {
      case 'season':
        await handleSeasonSelect(interaction, client);
        return;
      default:
        log.warn(`Неизвестный tm string select: ${selType}`);
    }
    return;
  }

  // ── Modal ──
  if (interaction.isModalSubmit()) {
    const customId = interaction.customId;

    if (customId.startsWith(TEAM_NAME_MODAL_ID)) {
      await handleNameModal(interaction, client);
      return;
    }

    if (customId.startsWith(REPORT_MODAL_ID)) {
      await handleReportModal(interaction, client);
      return;
    }

    if (customId.startsWith(POLL_TIME_MODAL_ID)) {
      await handlePollTimeModal(interaction, client);
      return;
    }

    if (customId.startsWith(POLL_VOTE_MODAL_ID)) {
      await handlePollVoteModal(interaction, client);
      return;
    }
  }
}
