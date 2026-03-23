import { ClientEvents } from 'discord.js';
import { BublikCommand } from './Command';
import type { BublikClient } from '../bot';

// ── Состояние модуля ─────────────────────────
export enum ModuleState {
  Loaded = 'loaded',
  Unloaded = 'unloaded',
  Error = 'error',
}

// ── Обработчик события модуля ────────────────
export interface ModuleEventHandler<K extends keyof ClientEvents = keyof ClientEvents> {
  event: K;
  once?: boolean;
  execute(...args: ClientEvents[K]): Promise<void> | void;
}

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
  onLoad?(client: BublikClient): Promise<void> | void;

  /** Вызывается при выгрузке (очистка ресурсов) */
  onUnload?(client: BublikClient): Promise<void> | void;
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
