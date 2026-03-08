import fs from 'fs';
import path from 'path';
import { Config } from '../config';
import { logger } from './Logger';
import { BublikModule, LoadedModule, ModuleState } from '../types';
import { errorReporter } from './ErrorReporter';
import type { BublikClient } from '../bot';

const log = logger.child('ModuleLoader');

/**
 * Менеджер модулей с поддержкой hot-reload.
 *
 * Модуль — это папка в src/modules/<name>/index.ts,
 * экспортирующая `module` типа BublikModule.
 *
 * API:
 *  - loadAll()          — загрузить все модули из папки
 *  - load(name)         — загрузить один модуль
 *  - unload(name)       — выгрузить модуль (очистить listeners, cache)
 *  - reload(name)       — unload + load
 *  - reloadAll()        — полная перезагрузка всех модулей
 *  - getModule(name)    — получить мета-информацию
 *  - getAllModules()     — список всех загруженных
 */
export class ModuleLoader {
  private modules = new Map<string, LoadedModule>();
  private client: BublikClient;

  constructor(client: BublikClient) {
    this.client = client;
  }

  // ── Загрузить все модули ────────────────────
  async loadAll(): Promise<void> {
    const modulesDir = Config.modulesDir;

    if (!fs.existsSync(modulesDir)) {
      log.warn(`Папка модулей не найдена: ${modulesDir}`);
      return;
    }

    const entries = fs.readdirSync(modulesDir, { withFileTypes: true });
    const dirs = entries.filter((e) => e.isDirectory());

    log.info(`Найдено ${dirs.length} модулей для загрузки`);

    for (const dir of dirs) {
      try {
        await this.load(dir.name);
      } catch (err) {
        log.error(`Не удалось загрузить модуль "${dir.name}"`, err);
      }
    }

    log.info(`Загружено модулей: ${this.modules.size}/${dirs.length}`);
  }

  // ── Валидация имени модуля (защита от path traversal) ──
  private static readonly MODULE_NAME_REGEX = /^[a-z0-9][a-z0-9_-]*$/i;

  private isValidModuleName(name: string): boolean {
    return (
      ModuleLoader.MODULE_NAME_REGEX.test(name) &&
      !name.includes('..') &&
      name.length <= 64
    );
  }

  // ── Загрузить один модуль ──────────────────
  async load(name: string): Promise<boolean> {
    // Защита от path traversal — имя модуля должно быть простым идентификатором
    if (!this.isValidModuleName(name)) {
      log.error(`Некорректное имя модуля: "${name}" — загрузка отклонена (security)`);
      return false;
    }

    if (this.modules.has(name)) {
      log.warn(`Модуль "${name}" уже загружен. Используйте reload().`);
      return false;
    }

    const modulePath = this.resolveModulePath(name);

    if (!modulePath) {
      log.error(`Модуль "${name}" не найден`);
      return false;
    }

    try {
      // Очищаем require cache для hot-reload
      this.clearRequireCache(modulePath);

      const imported = require(modulePath);
      const mod: BublikModule = imported.default ?? imported.module ?? imported;

      if (!mod.name || !mod.commands) {
        log.error(`Модуль "${name}" имеет некорректный формат (нужны name, commands)`);
        return false;
      }

      // Создаём запись
      const loaded: LoadedModule = {
        module: mod,
        state: ModuleState.Loaded,
        filePath: modulePath,
        loadedAt: new Date(),
        boundListeners: [],
      };

      // Регистрируем обработчики событий
      if (mod.events) {
        for (const handler of mod.events) {
          const listener = async (...args: any[]) => {
            try {
              await (handler.execute as any)(...args);
            } catch (err) {
              log.error(`Ошибка в обработчике ${handler.event} модуля "${name}"`, err);
              errorReporter.eventError(err, handler.event as string, name);
            }
          };

          if (handler.once) {
            this.client.once(handler.event, listener);
          } else {
            this.client.on(handler.event, listener);
          }

          loaded.boundListeners.push({ event: handler.event, listener });
        }
      }

      // Регистрируем команды в реестре бота
      for (const cmd of mod.commands) {
        this.client.commandRegistry.register(cmd, name);
      }

      // Вызываем onLoad
      if (mod.onLoad) {
        await mod.onLoad(this.client);
      }

      this.modules.set(name, loaded);
      log.info(`✓ Модуль "${name}" v${mod.version} загружен (${mod.commands.length} команд)`);

      return true;
    } catch (err) {
      log.error(`Критическая ошибка загрузки модуля "${name}"`, err);
      errorReporter.moduleError(err, name, 'load');

      this.modules.set(name, {
        module: { name, descriptionKey: '', version: '0.0.0', author: '', commands: [] },
        state: ModuleState.Error,
        filePath: modulePath,
        loadedAt: new Date(),
        boundListeners: [],
      });

      return false;
    }
  }

  // ── Выгрузить модуль ───────────────────────
  async unload(name: string): Promise<boolean> {
    if (!this.isValidModuleName(name)) {
      log.error(`Некорректное имя модуля: "${name}" — выгрузка отклонена (security)`);
      return false;
    }

    const loaded = this.modules.get(name);

    if (!loaded) {
      log.warn(`Модуль "${name}" не загружен`);
      return false;
    }

    try {
      // Вызываем onUnload для очистки ресурсов
      if (loaded.module.onUnload) {
        await loaded.module.onUnload(this.client);
      }

      // Снимаем все event listeners
      for (const { event, listener } of loaded.boundListeners) {
        this.client.removeListener(event, listener);
      }

      // Удаляем команды из реестра
      for (const cmd of loaded.module.commands) {
        this.client.commandRegistry.unregister(cmd.data.name);
      }

      // Очищаем require cache
      this.clearRequireCache(loaded.filePath);

      this.modules.delete(name);
      log.info(`✓ Модуль "${name}" выгружен`);

      return true;
    } catch (err) {
      log.error(`Ошибка выгрузки модуля "${name}"`, err);
      return false;
    }
  }

  // ── Hot-reload модуля ──────────────────────
  async reload(name: string): Promise<boolean> {
    log.info(`♻ Перезагрузка модуля "${name}"…`);

    const wasLoaded = this.modules.has(name);

    if (wasLoaded) {
      const unloaded = await this.unload(name);
      if (!unloaded) {
        log.error(`Не удалось выгрузить "${name}" перед reload`);
        return false;
      }
    }

    const loaded = await this.load(name);

    if (loaded) {
      // Перерегистрируем slash-команды для гильдий
      await this.client.commandRegistry.syncGuildCommands();
      log.info(`♻ Модуль "${name}" успешно перезагружен`);
    }

    return loaded;
  }

  // ── Перезагрузить все ──────────────────────
  async reloadAll(): Promise<void> {
    log.info('♻ Полная перезагрузка всех модулей…');

    const names = Array.from(this.modules.keys());

    for (const name of names) {
      await this.unload(name);
    }

    await this.loadAll();
    await this.client.commandRegistry.syncGuildCommands();
  }

  // ── Геттеры ────────────────────────────────
  getModule(name: string): LoadedModule | undefined {
    return this.modules.get(name);
  }

  getAllModules(): LoadedModule[] {
    return Array.from(this.modules.values());
  }

  /** Только успешно загруженные модули */
  getHealthyModules(): LoadedModule[] {
    return Array.from(this.modules.values()).filter((m) => m.state === ModuleState.Loaded);
  }

  getLoadedModuleNames(): string[] {
    return Array.from(this.modules.keys());
  }

  // ── Внутренние утилиты ─────────────────────

  private resolveModulePath(name: string): string | null {
    // Ищем dist/modules/<name>/index.js (compiled) или src/modules/<name>/index.ts (dev)
    const distPath = path.join(Config.modulesDir, name, 'index.js');
    const srcPath = path.join(Config.modulesDir, name, 'index.ts');

    // Дополнительная проверка: resolved path должен оставаться внутри modulesDir
    const resolvedDist = path.resolve(distPath);
    const resolvedSrc = path.resolve(srcPath);
    const modulesBase = path.resolve(Config.modulesDir);

    if (resolvedDist.startsWith(modulesBase + path.sep) && fs.existsSync(resolvedDist)) return resolvedDist;
    if (resolvedSrc.startsWith(modulesBase + path.sep) && fs.existsSync(resolvedSrc)) return resolvedSrc;

    return null;
  }

  /**
   * Полная очистка require-кэша для модуля и его зависимостей.
   * Это критически важно для hot-reload.
   */
  private clearRequireCache(modulePath: string): void {
    const resolvedPath = require.resolve(modulePath);
    const moduleDir = path.dirname(resolvedPath);

    // Удаляем все закэшированные файлы из директории модуля
    for (const key of Object.keys(require.cache)) {
      if (key.startsWith(moduleDir)) {
        delete require.cache[key];
      }
    }
  }
}
