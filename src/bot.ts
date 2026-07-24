import { Client, GatewayIntentBits, Partials } from 'discord.js';
import { Config } from './config';
import {
  logger,
  Logger,
  CommandRegistry,
  ModuleLoader,
  i18n,
  registerCoreEvents,
  connectDatabase,
  disconnectDatabase,
  connectRedis,
  disconnectRedis,
  errorReporter,
  unscheduleAll,
  initWhitelist,
  initLegacyWelcomeConfig,
  getDatabase,
  getRedis,
  HealthHeartbeat,
} from './core';

/**
 * Главный класс бота Bublik.
 * Расширяет discord.js Client, добавляя ядровые системы.
 */
export class BublikClient extends Client {
  public readonly commandRegistry: CommandRegistry;
  public readonly moduleLoader: ModuleLoader;
  public readonly logger: Logger;
  public readonly isDev: boolean;
  private readonly healthHeartbeat: HealthHeartbeat | null;

  constructor() {
    super({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildPresences,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.GuildMessages,    // Required for MessageCreate events
        GatewayIntentBits.MessageContent,   // Privileged: required to read message text
      ],
      partials: [
        Partials.GuildMember,
        Partials.User,
      ],
      // Увеличиваем sweepers для стабильности
      sweepers: {
        messages: {
          interval: 300,   // каждые 5 минут
          lifetime: 1800,  // хранить 30 мин
        },
      },
    });

    this.isDev = Config.isDev;
    this.logger = logger;
    this.commandRegistry = new CommandRegistry(this);
    this.moduleLoader = new ModuleLoader(this);
    this.healthHeartbeat = Config.nodeEnv === 'production'
      ? new HealthHeartbeat({
          markerPath: process.env.BUBLIK_HEALTH_FILE,
          isDiscordReady: () => this.isReady(),
          probeDatabase: async () => {
            await getDatabase().$queryRawUnsafe('SELECT 1');
          },
          pingRedis: async () => getRedis().ping(),
          logger: logger.child('Health'),
        })
      : null;
  }

  /**
   * Инициализация и запуск бота.
   * Порядок: DB → Redis → i18n → Events → Modules → Login
   */
  async start(): Promise<void> {
    // A container restart keeps its writable layer, so invalidate a marker
    // left by a previously crashed process before any slow startup work.
    await this.healthHeartbeat?.clearMarkerBeforeStartup();
    logger.banner();

    logger.info(`Режим: ${Config.isDev ? 'DEVELOPMENT' : 'PRODUCTION'}`);
    logger.info(`Локаль: ${Config.defaultLocale}`);

    // 1. Подключаем базы данных
    await connectDatabase();
    const maxRedisAttempts = 10;
    let redisConnected = false;
    for (let attempt = 1; attempt <= maxRedisAttempts; attempt++) {
      try {
        await connectRedis();
        redisConnected = true;
        break;
      } catch (err) {
        if (attempt === maxRedisAttempts) break;
        const delayMs = Math.min(3_000 * attempt, 15_000);
        logger.warn(`Redis недоступен (попытка ${attempt}/${maxRedisAttempts}), повтор через ${delayMs}мс`, err as Error);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }

    if (!redisConnected) {
      throw new Error('Не удалось подключиться к Redis после повторных попыток');
    }

    // Whitelist must be ready before module listeners/timers can observe guild
    // state. A DB failure aborts startup instead of briefly running fail-open.
    await initWhitelist();

    // Import the old environment-based welcome settings once and only when the
    // destination guild is unambiguous. Existing database values always win.
    await initLegacyWelcomeConfig();

    // 2. Загружаем локали
    i18n.load();

    // 3. Регистрируем ядровые события
    registerCoreEvents(this);

    // 4. Загружаем все модули
    await this.moduleLoader.loadAll();

    // 5. Логинимся в Discord
    logger.info('Подключение к Discord…');
    await this.login(Config.token);

    // 6. Инициализируем ErrorReporter (после login, когда client готов)
    errorReporter.init(this, Config.errorChannelId);
    await this.healthHeartbeat?.start();
  }

  /**
   * Корректное завершение работы.
   */
  async shutdown(): Promise<void> {
    // Invalidate readiness before potentially slow module drains and before
    // disconnecting Discord/PostgreSQL/Redis.
    try { await this.healthHeartbeat?.stop(); } catch (e) { logger.warn('Health heartbeat shutdown failed', e); }

    logger.info('Завершение работы бота…');

    // Выгружаем модули (каждый в try-catch — один сломанный не блокирует остальные)
    const modules = this.moduleLoader.getLoadedModuleNames();
    for (const name of modules) {
      try { await this.moduleLoader.unload(name); } catch (e) { logger.warn(`Ошибка выгрузки модуля ${name}`, e as Error); }
    }

    // Модуль мог уже удалить timer из реестра, но его запущенный handler
    // всё ещё учтён глобально и дожидается здесь.
    try { await unscheduleAll(10_000); } catch (e) { logger.warn('Scheduler shutdown failed', e); }

    // Отчёты об ошибках unload/task тоже должны успеть уйти до destroy().
    try { await errorReporter.shutdown(); } catch (e) { logger.warn('ErrorReporter shutdown failed', e); }

    // Отключаемся от Discord
    try { await this.destroy(); } catch (e) { logger.warn('Discord disconnect failed', e as Error); }

    // Закрываем соединения с БД
    try { await disconnectDatabase(); } catch (e) { logger.warn('DB disconnect failed', e as Error); }
    try { await disconnectRedis(); } catch (e) { logger.warn('Redis disconnect failed', e as Error); }

    logger.info('Бот остановлен. До встречи! 🥯');
  }
}
