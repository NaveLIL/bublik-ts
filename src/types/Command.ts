import {
  ChatInputCommandInteraction,
  SlashCommandBuilder,
  SlashCommandSubcommandsOnlyBuilder,
  SlashCommandOptionsOnlyBuilder,
  AutocompleteInteraction,
} from 'discord.js';
import type { BublikClient } from '../bot';

// ── Scope команды ────────────────────────────
export enum CommandScope {
  /** Глобальная — доступна везде, регистрируется через REST один раз */
  Global = 'global',
  /** Гильдийная — регистрируется для каждой гильдии */
  Guild = 'guild',
}

// ── Категория (для /info панели) ─────────────
export type CommandCategory =
  | 'general'
  | 'moderation'
  | 'utility'
  | 'fun'
  | 'admin'
  | 'info'
  | 'music'
  | 'economy'
  | string;

// ── Интерфейс команды ────────────────────────
export interface BublikCommand {
  /** Билдер slash-команды */
  data:
    | SlashCommandBuilder
    | SlashCommandSubcommandsOnlyBuilder
    | SlashCommandOptionsOnlyBuilder
    | Omit<SlashCommandBuilder, 'addSubcommand' | 'addSubcommandGroup'>;

  /** Где регистрируется: global / guild */
  scope: CommandScope;

  /** Категория для /info */
  category: CommandCategory;

  /** i18n ключ описания для /info панели */
  descriptionKey: string;

  /** Кулдаун в секундах (0 = нет) */
  cooldown?: number;

  /** Только для владельца бота (OWNER_ID) */
  ownerOnly?: boolean;

  /** Обработчик */
  execute(interaction: ChatInputCommandInteraction, client: BublikClient): Promise<void>;

  /** Autocomplete (опционально) */
  autocomplete?(interaction: AutocompleteInteraction, client: BublikClient): Promise<void>;
}
