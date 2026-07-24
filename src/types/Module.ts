import { ClientEvents } from 'discord.js';
import { BublikCommand } from './Command';
import type { BublikClient } from '../bot';

/**
 * A generation-bound capability supplied by ModuleLoader. Long-running module
 * work must check it immediately before publishing state or mutating Discord.
 */
export interface ModuleExecutionGuard {
  readonly moduleName: string;
  readonly generation: number;
  /** Aborted as soon as unload starts; useful for cancellable I/O. */
  readonly signal: AbortSignal;
  /** True only while this generation is the active, event-accepting owner. */
  isCurrent(): boolean;
  /** True while the stable module name still belongs to this generation. */
  ownsGeneration(): boolean;
  /** Throws when isCurrent() is false. */
  assertCurrent(): void;
}

// ── Состояние модуля ─────────────────────────
export enum ModuleState {
  Loaded = 'loaded',
  /** Entry points are disabled, but unsafe legacy work still owns the name. */
  Quarantined = 'quarantined',
  Unloaded = 'unloaded',
  Error = 'error',
}

// ── Обработчик события модуля ────────────────
interface ModuleEventHandlerBase<K extends keyof ClientEvents> {
  event: K;
  once?: boolean;
}

type LegacyModuleEventHandler<K extends keyof ClientEvents> = ModuleEventHandlerBase<K> & {
  execute(...args: ClientEvents[K]): Promise<void> | void;
  executeGuarded?: never;
};

type GuardedModuleEventHandler<K extends keyof ClientEvents> = ModuleEventHandlerBase<K> & {
  execute?: never;
  /** Opt-in hook for checking generation after every awaited side effect. */
  executeGuarded(
    guard: ModuleExecutionGuard,
    ...args: ClientEvents[K]
  ): Promise<void> | void;
};

export type ModuleEventHandler<K extends keyof ClientEvents = keyof ClientEvents> =
  | LegacyModuleEventHandler<K>
  | GuardedModuleEventHandler<K>;

// ── Интерфейс модуля ─────────────────────────
export interface BublikModule {
  /** Уникальное имя модуля */
  name: string;

  /** Описание (i18n ключ) */
  descriptionKey: string;

  /** Версия */
  version: string;

  /** Автор */
  author: string;

  /** Команды модуля */
  commands: BublikCommand[];

  /** Обработчики событий */
  events?: ModuleEventHandler[];

  /** Вызывается при загрузке модуля */
  /** Legacy lifecycle hook. A timed-out call keeps the module quarantined. */
  onLoad?(client: BublikClient): Promise<void> | void;

  /**
   * Explicit generation-aware lifecycle contract. Implementations must check
   * the guard immediately before externally visible writes after an await.
   */
  onLoadGuarded?(client: BublikClient, guard: ModuleExecutionGuard): Promise<void> | void;

  /** Вызывается при выгрузке (очистка ресурсов) */
  /** Legacy lifecycle hook. A timed-out call keeps the module quarantined. */
  onUnload?(client: BublikClient): Promise<void> | void;

  /** Explicit generation-aware counterpart to onUnload. */
  onUnloadGuarded?(client: BublikClient, guard: ModuleExecutionGuard): Promise<void> | void;
}

// ── Мета-информация о загруженном модуле ─────
export interface LoadedModule {
  module: BublikModule;
  state: ModuleState;
  filePath: string;
  loadedAt: Date;
  /** Привязанные листенеры — для корректного удаления при reload */
  boundListeners: Array<{ event: string; listener: (...args: any[]) => void }>;
}
