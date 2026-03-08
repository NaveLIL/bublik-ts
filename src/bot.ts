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

  constructor() {
    super({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.GuildMessageReactions,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.MessageContent,
      ],
      partials: [
        Partials.Channel,
        Partials.Message,
        Partials.Reaction,
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
  }

  /**
   * Инициализация и запуск бота.
   * Порядок: DB → Redis → i18n → Events → Modules → Login
   */
  async start(): Promise<void> {
    logger.banner();

    logger.info(`Режим: ${Config.isDev ? 'DEVELOPMENT' : 'PRODUCTION'}`);
    logger.info(`Локаль: ${Config.defaultLocale}`);

    // 1. Подключаем базы данных
    await connectDatabase();
    await connectRedis();

    // 2. Загружаем локали
    i18n.load();

    // 3. Регистрируем ядровые события
    registerCoreEvents(this);

    // 4. Загружаем все модули
    await this.moduleLoader.loadAll();

    // 5. Логинимся в Discord
    logger.info('Подключение к Discord…');
    await this.login(Config.token);

    // 6. Инициализируем ErrorReporter (нужен клиент после login)
    errorReporter.init(this, Config.errorChannelId);
  }

  /**
   * Корректное завершение работы.
   */
  async shutdown(): Promise<void> {
    logger.info('Завершение работы бота…');

    // Отправляем оставшиеся ошибки перед выключением
    await errorReporter.shutdown();

    // Выгружаем модули
    const modules = this.moduleLoader.getLoadedModuleNames();
    for (const name of modules) {
      await this.moduleLoader.unload(name);
    }

    // Отключаемся от Discord
    this.destroy();

    // Закрываем соединения с БД
    await disconnectDatabase();
    await disconnectRedis();

    logger.info('Бот остановлен. До встречи! 🥯');
  }
}
