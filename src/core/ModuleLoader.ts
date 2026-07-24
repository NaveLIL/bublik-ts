import fs from 'fs';
import path from 'path';
import { Config } from '../config';
import { logger } from './Logger';
import {
  BublikCommand,
  BublikModule,
  LoadedModule,
  ModuleEventHandler,
  ModuleExecutionGuard,
  ModuleState,
} from '../types';
import type { BublikClient } from '../bot';
import { isModuleEventAllowed } from './Whitelist';
import { isPathWithin, isValidModuleName, normalizeError } from './Safety';
import { waitForPromiseWithin } from './SchedulerManager';

const log = logger.child('ModuleLoader');

export const DEFAULT_MODULE_LIFECYCLE_TIMEOUT_MS = 15_000;
export const DEFAULT_MODULE_EVENT_DRAIN_TIMEOUT_MS = 15_000;

export interface ModuleLoaderOptions {
  lifecycleTimeoutMs?: number;
  eventDrainTimeoutMs?: number;
}

export class ModuleGenerationFencedError extends Error {
  constructor(moduleName: string, generation: number) {
    super(`Module generation is no longer current: ${moduleName}@${generation}`);
    this.name = 'ModuleGenerationFencedError';
  }
}

export class ModuleLifecycleTimeoutError extends Error {
  constructor(moduleName: string, phase: 'onLoad' | 'onUnload' | 'event drain', timeoutMs: number) {
    super(`Module ${moduleName} ${phase} exceeded ${timeoutMs}ms`);
    this.name = 'ModuleLifecycleTimeoutError';
  }
}

type ModuleLoadOutcome =
  | { ok: true }
  | { ok: false; error: unknown };

interface PendingModuleLoad {
  loaded: LoadedModule;
  completion: Promise<ModuleLoadOutcome>;
}

interface ReloadStart {
  previousWasLoaded: boolean;
  aborted: boolean;
  pendingLoad: PendingModuleLoad | null;
}

interface TrackedLifecycleWork {
  guarded: boolean;
  promise: Promise<void>;
  settled: boolean;
  outcome?: ModuleLoadOutcome;
}

interface ModuleCleanupRuntime {
  started: boolean;
  callOnUnload: boolean;
  pendingCommandNames: Set<string> | null;
  onUnloadStarted: boolean;
  onUnloadWork?: TrackedLifecycleWork;
  autoFinalizeScheduled: boolean;
  finalized: boolean;
}

interface ModuleRuntime {
  generation: number;
  acceptingEvents: boolean;
  abortController: AbortController;
  inFlightEvents: Set<Promise<void>>;
  inFlightLegacyEvents: Set<Promise<void>>;
  onLoadWork?: TrackedLifecycleWork;
  cleanup: ModuleCleanupRuntime;
  guard: ModuleExecutionGuard;
}

interface ModuleCleanupResult {
  complete: boolean;
  errors: Error[];
}

function positiveTimeout(value: number | undefined, fallback: number, option: string): number {
  const resolved = value ?? fallback;
  if (!Number.isFinite(resolved) || resolved <= 0) {
    throw new Error(`${option} must be a positive finite number`);
  }
  return resolved;
}

async function settleLifecycleWithin(
  pending: Promise<void>,
  moduleName: string,
  phase: 'onLoad' | 'onUnload',
  timeoutMs: number,
): Promise<ModuleLoadOutcome> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const outcome = await Promise.race<ModuleLoadOutcome>([
    pending.then(
      () => ({ ok: true as const }),
      (error: unknown) => ({ ok: false as const, error }),
    ),
    new Promise<ModuleLoadOutcome>((resolve) => {
      timer = setTimeout(() => resolve({
        ok: false,
        error: new ModuleLifecycleTimeoutError(moduleName, phase, timeoutMs),
      }), timeoutMs);
    }),
  ]);
  if (timer) clearTimeout(timer);
  return outcome;
}

function trackLifecycleWork(
  guarded: boolean,
  start: () => Promise<void> | void,
): TrackedLifecycleWork {
  const work: TrackedLifecycleWork = {
    guarded,
    promise: Promise.resolve(),
    settled: false,
  };
  work.promise = Promise.resolve().then(start);
  void work.promise.then(
    () => {
      work.settled = true;
      work.outcome = { ok: true };
    },
    (error: unknown) => {
      work.settled = true;
      work.outcome = { ok: false, error };
    },
  );
  return work;
}

/** Loads modules and owns every listener/command registered on their behalf. */
export class ModuleLoader {
  private modules = new Map<string, LoadedModule>();
  private operationTails = new Map<string, Promise<void>>();
  private cleanedModules = new WeakSet<LoadedModule>();
  private moduleGenerations = new Map<string, number>();
  private moduleRuntimes = new WeakMap<LoadedModule, ModuleRuntime>();
  private readonly lifecycleTimeoutMs: number;
  private readonly eventDrainTimeoutMs: number;

  constructor(
    private readonly client: BublikClient,
    options: ModuleLoaderOptions = {},
  ) {
    this.lifecycleTimeoutMs = positiveTimeout(
      options.lifecycleTimeoutMs,
      DEFAULT_MODULE_LIFECYCLE_TIMEOUT_MS,
      'lifecycleTimeoutMs',
    );
    this.eventDrainTimeoutMs = positiveTimeout(
      options.eventDrainTimeoutMs,
      DEFAULT_MODULE_EVENT_DRAIN_TIMEOUT_MS,
      'eventDrainTimeoutMs',
    );
  }

  async loadAll(): Promise<void> {
    const modulesDir = Config.modulesDir;
    if (!fs.existsSync(modulesDir)) {
      throw new Error(`Папка модулей не найдена: ${modulesDir}`);
    }

    const dirs = fs.readdirSync(modulesDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && isValidModuleName(entry.name))
      .sort((a, b) => a.name.localeCompare(b.name));
    log.info(`Найдено ${dirs.length} модулей для загрузки`);

    let successful = 0;
    for (const dir of dirs) {
      if (await this.load(dir.name)) successful++;
    }
    log.info(`Загружено модулей: ${successful}/${dirs.length}`);
  }

  async load(name: string): Promise<boolean> {
    if (!isValidModuleName(name)) {
      log.error(`Недопустимое имя модуля: "${name}"`);
      return false;
    }

    const pending = await this.runModuleOperation(name, () => this.loadUnlocked(name));
    return pending ? this.finishLoad(name, pending) : false;
  }

  private async loadUnlocked(name: string): Promise<PendingModuleLoad | null> {
    const existing = this.modules.get(name);
    if (existing?.state === ModuleState.Loaded) {
      log.warn(`Модуль "${name}" уже загружен. Используйте reload().`);
      return null;
    }
    if (existing?.state === ModuleState.Quarantined && !this.cleanedModules.has(existing)) {
      log.warn(`Module "${name}" still owns its name while cleanup is quarantined`);
      return null;
    }
    if (existing) this.modules.delete(name);

    let modulePath: string | null = null;
    let loaded: LoadedModule | null = null;
    let published = false;

    try {
      modulePath = this.resolveModulePath(name);
      if (!modulePath) throw new Error(`Модуль "${name}" не найден`);

      this.clearRequireCache(modulePath);
      const imported = require(modulePath);
      const mod: BublikModule = imported.default ?? imported.module ?? imported;
      this.validateModule(mod, name);

      loaded = {
        module: mod,
        state: ModuleState.Loaded,
        filePath: modulePath,
        loadedAt: new Date(),
        boundListeners: [],
      };
      const runtime = this.createModuleRuntime(name, loaded);

      for (const handler of mod.events ?? []) {
        const listener = (...args: any[]) => {
          this.dispatchModuleEvent(loaded!, name, handler, args);
        };

        if (handler.once) this.client.once(handler.event, listener);
        else this.client.on(handler.event, listener);
        loaded.boundListeners.push({ event: handler.event, listener });
      }

      for (const command of mod.commands) {
        this.client.commandRegistry.register(
          this.bindCommandToRuntime(command, loaded, runtime),
          name,
          () => runtime.guard.isCurrent(),
        );
      }

      // Publish ownership before invoking arbitrary module code. This makes a
      // partially booting module reachable by unload/reload if onLoad stalls.
      this.modules.set(name, loaded);
      published = true;

      let completion: Promise<ModuleLoadOutcome>;
      if (mod.onLoadGuarded) {
        runtime.onLoadWork = trackLifecycleWork(
          true,
          () => mod.onLoadGuarded!(this.client, runtime.guard),
        );
        completion = settleLifecycleWithin(
          runtime.onLoadWork.promise,
          name,
          'onLoad',
          this.lifecycleTimeoutMs,
        );
      } else if (mod.onLoad) {
        runtime.onLoadWork = trackLifecycleWork(
          false,
          () => mod.onLoad!(this.client),
        );
        completion = settleLifecycleWithin(
          runtime.onLoadWork.promise,
          name,
          'onLoad',
          this.lifecycleTimeoutMs,
        );
      } else {
        completion = Promise.resolve({ ok: true });
      }

      // Do not keep the per-module operation queue locked while arbitrary
      // onLoad code is pending. unload/reload can quiesce a stalled boot; the
      // completion path re-enters the queue and finalizes by object identity.
      return { loaded, completion };
    } catch (err) {
      log.error(`Критическая ошибка загрузки модуля "${name}"`, err);

      let stillOwned = published
        ? this.modules.get(name) === loaded
        : !this.modules.has(name);
      if (loaded && stillOwned) {
        const cleanup = await this.cleanupModule(
          loaded,
          name,
          false,
          () => published ? this.modules.get(name) === loaded : !this.modules.has(name),
        );
        for (const cleanupError of cleanup.errors) {
          log.error(`Ошибка rollback модуля "${name}"`, cleanupError);
        }
        stillOwned = published
          ? this.modules.get(name) === loaded
          : !this.modules.has(name);
      } else if (modulePath && stillOwned) {
        try { this.clearRequireCache(modulePath); } catch { /* not loaded */ }
      }

      if (stillOwned) {
        if (loaded) {
          loaded.state = this.cleanedModules.has(loaded)
            ? ModuleState.Error
            : ModuleState.Quarantined;
          if (published) {
            if (this.modules.get(name) === loaded) this.modules.set(name, loaded);
          } else if (!this.modules.has(name)) {
            this.modules.set(name, loaded);
          }
        } else if (!this.modules.has(name)) {
          this.modules.set(name, {
            module: { name, descriptionKey: '', version: '0.0.0', author: '', commands: [] },
            state: ModuleState.Error,
            filePath: modulePath ?? '',
            loadedAt: new Date(),
            boundListeners: [],
          });
        }
      }
      return null;
    }
  }

  private async finishLoad(name: string, pending: PendingModuleLoad): Promise<boolean> {
    const outcome = await pending.completion;
    return this.runModuleOperation(
      name,
      () => this.finishLoadUnlocked(name, pending.loaded, outcome),
    );
  }

  private async finishLoadUnlocked(
    name: string,
    loaded: LoadedModule,
    outcome: ModuleLoadOutcome,
  ): Promise<boolean> {
    if (this.modules.get(name) !== loaded) return false;

    const runtime = this.moduleRuntimes.get(loaded);
    if (outcome.ok && loaded.state === ModuleState.Loaded && runtime?.guard.isCurrent()) {
      log.info(`✓ Модуль "${name}" v${loaded.module.version} загружен (${loaded.module.commands.length} команд)`);
      return true;
    }

    if (outcome.ok) return false;

    log.error(`Критическая ошибка загрузки модуля "${name}"`, outcome.error);
    const cleanup = await this.cleanupModule(
      loaded,
      name,
      true,
      () => this.modules.get(name) === loaded,
    );
    for (const cleanupError of cleanup.errors) {
      log.error(`Ошибка rollback модуля "${name}"`, cleanupError);
    }

    if (this.modules.get(name) === loaded) {
      loaded.state = cleanup.complete ? ModuleState.Error : ModuleState.Quarantined;
    }
    return false;
  }

  async unload(name: string): Promise<boolean> {
    if (!isValidModuleName(name)) {
      log.error(`Недопустимое имя модуля: "${name}"`);
      return false;
    }

    return this.runModuleOperation(name, () => this.unloadUnlocked(name));
  }

  private async unloadUnlocked(name: string): Promise<boolean> {
    const loaded = this.modules.get(name);
    if (!loaded) {
      log.warn(`Модуль "${name}" не загружен`);
      return false;
    }

    const cleanup = await this.cleanupModule(
      loaded,
      name,
      loaded.state === ModuleState.Loaded,
      () => this.modules.get(name) === loaded,
    );
    const errors = cleanup.errors;
    const stillOwned = this.modules.get(name) === loaded;

    if (!stillOwned) {
      log.warn(`Владение модулем "${name}" изменилось во время выгрузки`);
      return false;
    }

    if (!cleanup.complete) {
      for (const err of cleanup.errors) log.error(`Module "${name}" remains quarantined`, err);
      return false;
    }

    this.modules.delete(name);
    if (cleanup.errors.length === 0) {
      log.info(`✓ Модуль "${name}" выгружен`);
      return true;
    }

    for (const err of errors) log.error(`Ошибка выгрузки модуля "${name}"`, err);
    return false;
  }

  async reload(name: string): Promise<boolean> {
    if (!isValidModuleName(name)) {
      log.error(`Недопустимое имя модуля: "${name}"`);
      return false;
    }

    log.info(`♻ Перезагрузка модуля "${name}"…`);
    const started = await this.runModuleOperation(name, () => this.reloadUnlocked(name));
    if (started.aborted) {
      if (started.previousWasLoaded) await this.client.commandRegistry.syncAllCommands();
      return false;
    }

    const didLoad = started.pendingLoad
      ? await this.finishLoad(name, started.pendingLoad)
      : false;
    // A removed or reloaded module can own either guild or global commands;
    // synchronize even when loading the replacement failed to clear stale API state.
    if (started.previousWasLoaded || didLoad) {
      await this.client.commandRegistry.syncAllCommands();
    }
    if (!didLoad) return false;

    log.info(`♻ Модуль "${name}" успешно перезагружен`);
    return true;
  }

  private async reloadUnlocked(name: string): Promise<ReloadStart> {
    const current = this.modules.get(name);
    const previousWasLoaded = current?.state === ModuleState.Loaded;
    if (current && !await this.unloadUnlocked(name)) {
      // A failed or timed-out module hook is reported by unload(), but once the
      // old owner is quiesced and removed it must not block a replacement.
      if (this.modules.has(name)) {
        log.error(`Не удалось корректно выгрузить "${name}" перед reload`);
        return { previousWasLoaded, aborted: true, pendingLoad: null };
      }
    }

    const pendingLoad = await this.loadUnlocked(name);
    return { previousWasLoaded, aborted: false, pendingLoad };
  }

  async reloadAll(): Promise<void> {
    log.info('♻ Полная перезагрузка всех модулей…');
    for (const name of this.getLoadedModuleNames()) await this.unload(name);
    await this.loadAll();
    await this.client.commandRegistry.syncAllCommands();
  }

  getModule(name: string): LoadedModule | undefined {
    return isValidModuleName(name) ? this.modules.get(name) : undefined;
  }

  getAllModules(): LoadedModule[] {
    return Array.from(this.modules.values());
  }

  getHealthyModules(): LoadedModule[] {
    return Array.from(this.modules.values()).filter((entry) => entry.state === ModuleState.Loaded);
  }

  getLoadedModuleNames(): string[] {
    return Array.from(this.modules.entries())
      .filter(([, entry]) => entry.state === ModuleState.Loaded)
      .map(([name]) => name);
  }

  /** Capture the current generation for commands, timers, and other async work. */
  captureExecutionGuard(name: string): ModuleExecutionGuard | null {
    if (!isValidModuleName(name)) return null;
    const loaded = this.modules.get(name);
    if (!loaded) return null;
    const runtime = this.moduleRuntimes.get(loaded);
    return runtime?.guard.isCurrent() ? runtime.guard : null;
  }

  /**
   * Run a cross-module legacy operation under the target module's ownership.
   * If unload starts, cleanup waits (and quarantines on timeout) until this
   * exact operation settles, so callers cannot resurrect an unloaded module.
   */
  runLegacyModuleWork<T>(
    name: string,
    execute: () => Promise<T> | T,
  ): Promise<T | null> {
    if (!isValidModuleName(name)) return Promise.resolve(null);
    const loaded = this.modules.get(name);
    if (!loaded) return Promise.resolve(null);
    const runtime = this.moduleRuntimes.get(loaded);
    if (!runtime?.guard.isCurrent()) return Promise.resolve(null);
    return this.trackLegacyRuntimeWork(runtime, execute);
  }

  private createModuleRuntime(name: string, loaded: LoadedModule): ModuleRuntime {
    const generation = (this.moduleGenerations.get(name) ?? 0) + 1;
    this.moduleGenerations.set(name, generation);
    const runtime: ModuleRuntime = {
      generation,
      acceptingEvents: true,
      abortController: new AbortController(),
      inFlightEvents: new Set<Promise<void>>(),
      inFlightLegacyEvents: new Set<Promise<void>>(),
      cleanup: {
        started: false,
        callOnUnload: false,
        pendingCommandNames: null,
        onUnloadStarted: false,
        autoFinalizeScheduled: false,
        finalized: false,
      },
      guard: undefined as unknown as ModuleExecutionGuard,
    };
    runtime.guard = {
      moduleName: name,
      generation,
      signal: runtime.abortController.signal,
      isCurrent: () => runtime.acceptingEvents &&
        this.moduleGenerations.get(name) === generation &&
        this.modules.get(name) === loaded,
      ownsGeneration: () => this.moduleGenerations.get(name) === generation &&
        this.modules.get(name) === loaded,
      assertCurrent: () => {
        if (!runtime.guard.isCurrent()) throw new ModuleGenerationFencedError(name, generation);
      },
    };
    this.moduleRuntimes.set(loaded, runtime);
    return runtime;
  }

  private dispatchModuleEvent(
    loaded: LoadedModule,
    name: string,
    handler: ModuleEventHandler,
    args: any[],
  ): void {
    const runtime = this.moduleRuntimes.get(loaded);
    if (!runtime?.guard.isCurrent()) return;

    // Start through a microtask so the run is registered before module code is
    // invoked. cleanupModule can then take a complete, stable drain snapshot.
    const pending = Promise.resolve().then(async () => {
      if (!runtime.guard.isCurrent()) return;
      // EventEmitter invokes module listeners independently from core
      // listeners, so every guild-scoped event needs its own fail-closed gate.
      if (!isModuleEventAllowed(handler.event, args)) return;

      if (handler.executeGuarded) {
        await (handler.executeGuarded as any)(runtime.guard, ...args);
      } else if (handler.execute) {
        await (handler.execute as any)(...args);
      }
    }).catch((err: unknown) => {
      if (err instanceof ModuleGenerationFencedError) return;
      log.error(`Ошибка в обработчике ${handler.event} модуля "${name}"`, err);
    });

    runtime.inFlightEvents.add(pending);
    const legacy = typeof handler.execute === 'function';
    if (legacy) runtime.inFlightLegacyEvents.add(pending);
    void pending.then(
      () => {
        runtime.inFlightEvents.delete(pending);
        runtime.inFlightLegacyEvents.delete(pending);
      },
      () => {
        runtime.inFlightEvents.delete(pending);
        runtime.inFlightLegacyEvents.delete(pending);
      },
    );
  }

  /** Commands are legacy entry points until their public contract accepts a
   * ModuleExecutionGuard. Track the exact captured generation so a reload
   * quarantines instead of running a replacement over unfinished command I/O. */
  private bindCommandToRuntime(
    command: BublikCommand,
    loaded: LoadedModule,
    runtime: ModuleRuntime,
  ): BublikCommand {
    return {
      ...command,
      execute: (interaction, client) => this.dispatchModuleCommand(
        loaded,
        runtime,
        () => command.execute(interaction, client),
      ),
      autocomplete: command.autocomplete
        ? (interaction, client) => this.dispatchModuleCommand(
          loaded,
          runtime,
          () => command.autocomplete!(interaction, client),
        )
        : undefined,
    };
  }

  private dispatchModuleCommand(
    loaded: LoadedModule,
    runtime: ModuleRuntime,
    execute: () => Promise<void>,
  ): Promise<void> {
    if (this.moduleRuntimes.get(loaded) !== runtime || !runtime.guard.isCurrent()) {
      return Promise.resolve();
    }
    return this.trackLegacyRuntimeWork(runtime, execute);
  }

  private trackLegacyRuntimeWork<T>(
    runtime: ModuleRuntime,
    execute: () => Promise<T> | T,
  ): Promise<T> {
    // Register a settlement-only promise before invoking module code. The
    // result still propagates to its caller while cleanup gets an always-safe
    // promise that cannot create an unhandled rejection.
    const result = Promise.resolve().then(execute);
    const pending = result.then(
      () => undefined,
      () => undefined,
    );
    runtime.inFlightEvents.add(pending);
    runtime.inFlightLegacyEvents.add(pending);
    void pending.then(() => {
      runtime.inFlightEvents.delete(pending);
      runtime.inFlightLegacyEvents.delete(pending);
    });
    return result;
  }

  private runModuleOperation<T>(name: string, operation: () => Promise<T> | T): Promise<T> {
    const previous = this.operationTails.get(name) ?? Promise.resolve();
    const result = previous.then(operation, operation);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );

    this.operationTails.set(name, tail);
    void tail.then(() => {
      if (this.operationTails.get(name) === tail) this.operationTails.delete(name);
    });
    return result;
  }

  private validateModule(mod: BublikModule, requestedName: string): void {
    if (!mod || mod.name !== requestedName || !Array.isArray(mod.commands)) {
      throw new Error(`Модуль должен иметь name="${requestedName}" и массив commands`);
    }
    if (mod.events !== undefined && !Array.isArray(mod.events)) {
      throw new Error(`Поле events модуля "${requestedName}" должно быть массивом`);
    }

    for (const handler of mod.events ?? []) {
      const legacy = typeof handler.execute === 'function';
      const guarded = typeof handler.executeGuarded === 'function';
      if (typeof handler.event !== 'string' || legacy === guarded) {
        throw new Error(
          `Обработчик события модуля "${requestedName}" должен иметь ровно один execute/executeGuarded`,
        );
      }
    }

    this.validateLifecyclePair(mod, requestedName, 'onLoad', 'onLoadGuarded');
    this.validateLifecyclePair(mod, requestedName, 'onUnload', 'onUnloadGuarded');

    const names = new Set<string>();
    for (const command of mod.commands) {
      const name = command?.data?.name;
      if (!name || names.has(name)) {
        throw new Error(`Дублирующаяся или некорректная команда в модуле "${requestedName}"`);
      }
      const existing = this.client.commandRegistry.getCommand(name);
      if (existing) {
        throw new Error(`Команда /${name} уже принадлежит модулю "${existing.moduleName}"`);
      }
      names.add(name);
    }
  }

  private validateLifecyclePair(
    mod: BublikModule,
    requestedName: string,
    legacyName: 'onLoad' | 'onUnload',
    guardedName: 'onLoadGuarded' | 'onUnloadGuarded',
  ): void {
    const legacyValue = mod[legacyName];
    const guardedValue = mod[guardedName];
    const legacy = typeof legacyValue === 'function';
    const guarded = typeof guardedValue === 'function';
    if ((legacyValue !== undefined && !legacy) ||
        (guardedValue !== undefined && !guarded) ||
        (legacy && guarded)) {
      throw new Error(
        `Module "${requestedName}" must define at most one valid ${legacyName}/${guardedName} hook`,
      );
    }
  }

  private resolveModulePath(name: string): string | null {
    if (!isValidModuleName(name) || !fs.existsSync(Config.modulesDir)) return null;
    const modulesRoot = fs.realpathSync(Config.modulesDir);

    for (const filename of ['index.js', 'index.ts']) {
      const candidate = path.resolve(modulesRoot, name, filename);
      if (!fs.existsSync(candidate)) continue;
      const realCandidate = fs.realpathSync(candidate);
      if (isPathWithin(modulesRoot, realCandidate)) return realCandidate;
      log.error(`Путь модуля "${name}" выходит за пределы modulesDir`);
      return null;
    }
    return null;
  }

  private clearRequireCache(modulePath: string): void {
    if (!modulePath) return;
    const resolvedPath = require.resolve(modulePath);
    const moduleDir = path.dirname(resolvedPath);
    for (const key of Object.keys(require.cache)) {
      if (isPathWithin(moduleDir, key)) delete require.cache[key];
    }
  }

  private async cleanupModule(
    loaded: LoadedModule,
    name: string,
    callOnUnload: boolean,
    ownsModule: () => boolean,
  ): Promise<ModuleCleanupResult> {
    // An old completion/cleanup must never unregister commands or clear the
    // require cache of a replacement that now owns the same module name.
    if (!ownsModule()) return { complete: false, errors: [] };
    if (this.cleanedModules.has(loaded)) return { complete: true, errors: [] };
    const errors: Error[] = [];
    const runtime = this.moduleRuntimes.get(loaded);
    if (!runtime) {
      loaded.state = ModuleState.Unloaded;
      this.cleanedModules.add(loaded);
      if (ownsModule() && loaded.filePath) {
        try {
          this.clearRequireCache(loaded.filePath);
        } catch (err) {
          errors.push(normalizeError(err));
        }
      }
      return { complete: true, errors };
    }

    const cleanup = runtime.cleanup;
    cleanup.callOnUnload ||= callOnUnload;
    loaded.state = ModuleState.Quarantined;

    if (!cleanup.started) {
      cleanup.started = true;
      runtime.acceptingEvents = false;
      runtime.abortController.abort();
      cleanup.pendingCommandNames = new Set(
        loaded.module.commands.map((command) => command.data.name),
      );
    }

    // Quiesce external entry points before awaiting user cleanup. Otherwise a
    // slow onUnload/boot drain can still accept fresh events and commands.
    const listenersStillBound: typeof loaded.boundListeners = [];
    for (const bound of loaded.boundListeners) {
      try {
        this.client.removeListener(bound.event, bound.listener);
      } catch (err) {
        errors.push(normalizeError(err));
        listenersStillBound.push(bound);
      }
    }
    loaded.boundListeners.length = 0;
    loaded.boundListeners.push(...listenersStillBound);

    for (const commandName of [...(cleanup.pendingCommandNames ?? [])]) {
      try {
        this.client.commandRegistry.unregister(commandName, name);
        cleanup.pendingCommandNames?.delete(commandName);
      } catch (err) {
        errors.push(normalizeError(err));
      }
    }

    if (loaded.boundListeners.length > 0 || (cleanup.pendingCommandNames?.size ?? 0) > 0) {
      return { complete: false, errors };
    }

    if (runtime.inFlightEvents.size > 0) {
      const drained = await waitForPromiseWithin(
        Promise.allSettled([...runtime.inFlightEvents]),
        this.eventDrainTimeoutMs,
      );
      if (!drained) {
        errors.push(new ModuleLifecycleTimeoutError(
          name,
          'event drain',
          this.eventDrainTimeoutMs,
        ));
        if (runtime.inFlightLegacyEvents.size > 0) {
          this.scheduleQuarantineFinalization(
            loaded,
            name,
            runtime,
            [...runtime.inFlightLegacyEvents],
          );
          return { complete: false, errors };
        }
      }
    }

    const onLoadWork = runtime.onLoadWork;
    if (onLoadWork && !onLoadWork.guarded && !onLoadWork.settled) {
      const outcome = await settleLifecycleWithin(
        onLoadWork.promise,
        name,
        'onLoad',
        this.lifecycleTimeoutMs,
      );
      if (!onLoadWork.settled) {
        errors.push(normalizeError(outcome.ok
          ? new ModuleLifecycleTimeoutError(name, 'onLoad', this.lifecycleTimeoutMs)
          : outcome.error));
        this.scheduleQuarantineFinalization(loaded, name, runtime, [onLoadWork.promise]);
        return { complete: false, errors };
      }
    }

    const hasOnUnload = Boolean(loaded.module.onUnload || loaded.module.onUnloadGuarded);
    if (cleanup.callOnUnload && hasOnUnload && !cleanup.onUnloadStarted) {
      cleanup.onUnloadStarted = true;
      if (loaded.module.onUnloadGuarded) {
        cleanup.onUnloadWork = trackLifecycleWork(
          true,
          () => loaded.module.onUnloadGuarded!(this.client, runtime.guard),
        );
      } else {
        cleanup.onUnloadWork = trackLifecycleWork(
          false,
          () => loaded.module.onUnload!(this.client),
        );
      }
    }

    const onUnloadWork = cleanup.onUnloadWork;
    if (onUnloadWork) {
      const outcome = onUnloadWork.settled
        ? onUnloadWork.outcome!
        : await settleLifecycleWithin(
          onUnloadWork.promise,
          name,
          'onUnload',
          this.lifecycleTimeoutMs,
        );

      if (!onUnloadWork.settled) {
        errors.push(normalizeError(outcome.ok
          ? new ModuleLifecycleTimeoutError(name, 'onUnload', this.lifecycleTimeoutMs)
          : outcome.error));
        if (!onUnloadWork.guarded) {
          this.scheduleQuarantineFinalization(loaded, name, runtime, [onUnloadWork.promise]);
          return { complete: false, errors };
        }
      } else if (!onUnloadWork.outcome?.ok) {
        errors.push(normalizeError(onUnloadWork.outcome?.error));
      }
    }

    if (!ownsModule()) return { complete: false, errors };

    if (!cleanup.finalized) {
      try {
        this.clearRequireCache(loaded.filePath);
      } catch (err) {
        errors.push(normalizeError(err));
      }
      cleanup.finalized = true;
      loaded.state = ModuleState.Unloaded;
      this.cleanedModules.add(loaded);
    }
    return { complete: true, errors };
  }

  private scheduleQuarantineFinalization(
    loaded: LoadedModule,
    name: string,
    runtime: ModuleRuntime,
    pendingLegacyWork: Promise<unknown>[],
  ): void {
    if (runtime.cleanup.autoFinalizeScheduled || pendingLegacyWork.length === 0) return;
    runtime.cleanup.autoFinalizeScheduled = true;

    void Promise.allSettled(pendingLegacyWork).then(() => this.runModuleOperation(
      name,
      async () => {
        runtime.cleanup.autoFinalizeScheduled = false;
        if (this.modules.get(name) !== loaded) return;
        await this.unloadUnlocked(name);
      },
    )).catch((error: unknown) => {
      runtime.cleanup.autoFinalizeScheduled = false;
      log.error(`Automatic quarantine cleanup failed for module "${name}"`, error);
    });
  }
}
