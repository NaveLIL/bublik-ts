import {
  Client,
  TextChannel,
  EmbedBuilder,
  ChatInputCommandInteraction,
  ButtonInteraction,
  StringSelectMenuInteraction,
  codeBlock,
} from 'discord.js';
import { Config } from '../config';
import { logger } from './Logger';

const log = logger.child('ErrorReporter');

// ── Типы ошибок ──────────────────────────────
export enum ErrorSeverity {
  /** Информационное — что-то необычное, но не поломка */
  Low = 'low',
  /** Средняя — команда упала, но бот работает */
  Medium = 'medium',
  /** Высокая — системная ошибка, потеря соединения */
  High = 'high',
  /** Критическая — бот не может функционировать */
  Critical = 'critical',
}

export enum ErrorCategory {
  Command = 'command',
  Event = 'event',
  Module = 'module',
  Database = 'database',
  Redis = 'redis',
  Discord = 'discord',
  System = 'system',
  Unknown = 'unknown',
}

interface ErrorReport {
  error: Error | unknown;
  severity: ErrorSeverity;
  category: ErrorCategory;
  context?: string;
  /** Имя команды, модуля или события */
  source?: string;
  /** Пользователь, вызвавший ошибку */
  userId?: string;
  /** Гильдия, в которой произошла ошибка */
  guildId?: string;
  /** Канал, где произошла ошибка */
  channelId?: string;
}

// ── Цвета по severity ────────────────────────
const SEVERITY_COLORS: Record<ErrorSeverity, number> = {
  [ErrorSeverity.Low]: 0xfee75c,      // жёлтый
  [ErrorSeverity.Medium]: 0xe67e22,    // оранжевый
  [ErrorSeverity.High]: 0xed4245,      // красный
  [ErrorSeverity.Critical]: 0x992d22,  // тёмно-красный
};

const SEVERITY_EMOJI: Record<ErrorSeverity, string> = {
  [ErrorSeverity.Low]: '⚠️',
  [ErrorSeverity.Medium]: '🟠',
  [ErrorSeverity.High]: '🔴',
  [ErrorSeverity.Critical]: '💀',
};

const CATEGORY_EMOJI: Record<ErrorCategory, string> = {
  [ErrorCategory.Command]: '⚡',
  [ErrorCategory.Event]: '📡',
  [ErrorCategory.Module]: '📦',
  [ErrorCategory.Database]: '🗄️',
  [ErrorCategory.Redis]: '🔴',
  [ErrorCategory.Discord]: '🤖',
  [ErrorCategory.System]: '💻',
  [ErrorCategory.Unknown]: '❓',
};

// ── Антифлуд ─────────────────────────────────
const ERROR_COOLDOWN_MS = 10_000; // не чаще раза в 10с для одинаковых ошибок
const MAX_QUEUE_SIZE = 50;        // макс. размер очереди ошибок
const FLUSH_INTERVAL_MS = 5_000;  // отправка батча каждые 5с

/**
 * Центральный обработчик ошибок Bublik.
 *
 * - Все ошибки проходят через report()
 * - Ошибки отправляются embed'ами в выделенный Discord-канал
 * - Антифлуд: дедупликация одинаковых ошибок, очередь с батчевой отправкой
 * - Всегда логирует в Winston параллельно
 * - Работает даже если канал ошибок не настроен (только лог)
 */
class ErrorReporterManager {
  private client: Client | null = null;
  private errorChannelId: string | null = null;
  private channel: TextChannel | null = null;
  private channelResolved = false;

  // Антифлуд: ключ = fingerprint ошибки, значение = timestamp
  private recentErrors = new Map<string, number>();
  private suppressedCount = new Map<string, number>();

  // Очередь ошибок для батчевой отправки
  private queue: ErrorReport[] = [];
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  // Счётчики для статистики
  private stats = {
    total: 0,
    suppressed: 0,
    sent: 0,
    failed: 0,
  };

  /**
   * Инициализация — вызывается после client.login()
   */
  init(client: Client, errorChannelId?: string | null): void {
    this.client = client;
    this.errorChannelId = errorChannelId ?? null;
    this.channelResolved = false;
    this.channel = null;

    // Запускаем таймер батчевой отправки
    if (this.flushTimer) clearInterval(this.flushTimer);
    this.flushTimer = setInterval(() => this.flush(), FLUSH_INTERVAL_MS);

    // Очистка устаревших fingerprints каждые 30с
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    this.cleanupTimer = setInterval(() => {
      const now = Date.now();
      for (const [key, ts] of this.recentErrors) {
        if (now - ts > ERROR_COOLDOWN_MS * 3) {
          // Если были suppressed — логируем сколько пропустили
          const count = this.suppressedCount.get(key);
          if (count && count > 0) {
            log.warn(`Подавлено ${count} повторов ошибки: ${key}`);
          }
          this.recentErrors.delete(key);
          this.suppressedCount.delete(key);
        }
      }
    }, 30_000);

    log.info(`ErrorReporter инициализирован${errorChannelId ? ` → канал ${errorChannelId}` : ' (без Discord-канала)'}`);
  }

  /**
   * Завершение работы — отправляем остаток очереди
   */
  async shutdown(): Promise<void> {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    // Финальный flush
    await this.flush();
  }

  // ═══════════════════════════════════════════
  //  Главный метод — report()
  // ═══════════════════════════════════════════

  /**
   * Зарегистрировать ошибку.
   * Логирует в Winston + отправляет в Discord-канал (если настроен).
   */
  report(report: ErrorReport): void {
    this.stats.total++;

    const error = report.error;
    const errorObj = error instanceof Error ? error : new Error(String(error ?? 'Unknown error'));
    const fingerprint = this.getFingerprint(errorObj, report.source);

    // ── Всегда логируем в Winston ────────────
    const logMessage = [
      `[${report.severity.toUpperCase()}]`,
      `[${report.category}]`,
      report.source ? `[${report.source}]` : '',
      errorObj.message,
      report.context ? `| ${report.context}` : '',
    ]
      .filter(Boolean)
      .join(' ');

    if (report.severity === ErrorSeverity.Critical || report.severity === ErrorSeverity.High) {
      log.error(logMessage, errorObj);
    } else if (report.severity === ErrorSeverity.Medium) {
      log.error(logMessage, errorObj);
    } else {
      log.warn(logMessage);
    }

    // ── Антифлуд ─────────────────────────────
    const now = Date.now();
    const lastSeen = this.recentErrors.get(fingerprint);

    if (lastSeen && now - lastSeen < ERROR_COOLDOWN_MS) {
      this.stats.suppressed++;
      const count = this.suppressedCount.get(fingerprint) ?? 0;
      this.suppressedCount.set(fingerprint, count + 1);
      return; // Подавляем дубликат
    }

    this.recentErrors.set(fingerprint, now);
    this.suppressedCount.set(fingerprint, 0);

    // ── В очередь ────────────────────────────
    if (this.queue.length < MAX_QUEUE_SIZE) {
      this.queue.push(report);
    }

    // Critical — отправляем немедленно
    if (report.severity === ErrorSeverity.Critical) {
      this.flush().catch(() => {});
    }
  }

  // ═══════════════════════════════════════════
  //  Удобные методы для частых случаев
  // ═══════════════════════════════════════════

  /** Ошибка выполнения команды */
  commandError(
    error: Error | unknown,
    interaction: ChatInputCommandInteraction,
    commandName?: string,
  ): void {
    this.report({
      error,
      severity: ErrorSeverity.Medium,
      category: ErrorCategory.Command,
      source: `/${commandName ?? interaction.commandName}`,
      userId: interaction.user.id,
      guildId: interaction.guildId ?? undefined,
      channelId: interaction.channelId,
      context: `User: ${interaction.user.tag}`,
    });
  }

  /** Ошибка в event listener */
  eventError(error: Error | unknown, eventName: string, moduleName?: string): void {
    this.report({
      error,
      severity: ErrorSeverity.Medium,
      category: ErrorCategory.Event,
      source: moduleName ? `${moduleName}:${eventName}` : eventName,
    });
  }

  /** Ошибка модуля (загрузка/выгрузка) */
  moduleError(error: Error | unknown, moduleName: string, action: string): void {
    this.report({
      error,
      severity: ErrorSeverity.High,
      category: ErrorCategory.Module,
      source: moduleName,
      context: `Action: ${action}`,
    });
  }

  /** Ошибка базы данных */
  databaseError(error: Error | unknown, context?: string): void {
    this.report({
      error,
      severity: ErrorSeverity.High,
      category: ErrorCategory.Database,
      source: 'PostgreSQL',
      context,
    });
  }

  /** Ошибка Redis */
  redisError(error: Error | unknown, context?: string): void {
    this.report({
      error,
      severity: ErrorSeverity.High,
      category: ErrorCategory.Redis,
      source: 'Redis',
      context,
    });
  }

  /** Ошибка Discord.js */
  discordError(error: Error | unknown, context?: string): void {
    this.report({
      error,
      severity: ErrorSeverity.High,
      category: ErrorCategory.Discord,
      source: 'discord.js',
      context,
    });
  }

  /** Критическая системная ошибка (unhandled rejection, uncaught exception) */
  systemError(error: Error | unknown, context: string): void {
    this.report({
      error,
      severity: ErrorSeverity.Critical,
      category: ErrorCategory.System,
      source: 'process',
      context,
    });
  }

  /** Ошибка кнопки/компонента */
  componentError(
    error: Error | unknown,
    interaction: ButtonInteraction | StringSelectMenuInteraction,
    componentId?: string,
  ): void {
    this.report({
      error,
      severity: ErrorSeverity.Medium,
      category: ErrorCategory.Event,
      source: `component:${componentId ?? interaction.customId}`,
      userId: interaction.user.id,
      guildId: interaction.guildId ?? undefined,
      channelId: interaction.channelId,
      context: `User: ${interaction.user.tag}`,
    });
  }

  /** Получить статистику */
  getStats() {
    return { ...this.stats };
  }

  // ═══════════════════════════════════════════
  //  Отправка в Discord
  // ═══════════════════════════════════════════

  private async flush(): Promise<void> {
    if (this.queue.length === 0) return;

    const channel = await this.resolveChannel();
    if (!channel) {
      // Нет канала — очищаем очередь, ошибки уже залогированы в Winston
      this.queue.length = 0;
      return;
    }

    // Берём до 5 ошибок за раз (лимит embed'ов Discord)
    const batch = this.queue.splice(0, 5);

    const embeds = batch.map((report) => this.buildEmbed(report));

    try {
      await channel.send({ embeds });
      this.stats.sent += batch.length;
    } catch (err) {
      this.stats.failed += batch.length;
      // Не рекурсируем report() — только лог
      log.error('Не удалось отправить ошибки в Discord-канал', err as Error);
    }
  }

  private async resolveChannel(): Promise<TextChannel | null> {
    if (this.channel) return this.channel;
    if (this.channelResolved) return null; // Уже пробовали, не нашли
    if (!this.errorChannelId || !this.client) {
      this.channelResolved = true;
      return null;
    }

    try {
      const ch = await this.client.channels.fetch(this.errorChannelId);
      if (ch?.isTextBased() && 'send' in ch) {
        this.channel = ch as TextChannel;
        this.channelResolved = true;
        log.info(`Error-канал найден: #${(ch as TextChannel).name}`);
        return this.channel;
      }
    } catch {
      log.warn(`Error-канал ${this.errorChannelId} не найден или недоступен`);
    }

    this.channelResolved = true;
    return null;
  }

  private buildEmbed(report: ErrorReport): EmbedBuilder {
    const error =
      report.error instanceof Error ? report.error : new Error(String(report.error ?? 'Unknown'));
    const sevEmoji = SEVERITY_EMOJI[report.severity];
    const catEmoji = CATEGORY_EMOJI[report.category];

    // Обрезаем stack trace до разумного размера для embed
    const stack = error.stack
      ? error.stack
          .split('\n')
          .slice(0, 8)
          .join('\n')
      : 'No stack trace';

    const truncatedStack = stack.length > 1000 ? stack.slice(0, 997) + '…' : stack;

    const embed = new EmbedBuilder()
      .setColor(SEVERITY_COLORS[report.severity])
      .setTitle(
        `${sevEmoji} ${catEmoji} ${report.category.toUpperCase()} Error`,
      )
      .setDescription(codeBlock(error.message.slice(0, 500)))
      .addFields(
        {
          name: '🏷️ Severity',
          value: `\`${report.severity.toUpperCase()}\``,
          inline: true,
        },
        {
          name: '📂 Source',
          value: `\`${report.source ?? 'unknown'}\``,
          inline: true,
        },
        {
          name: '📋 Category',
          value: `\`${report.category}\``,
          inline: true,
        },
      )
      .setTimestamp()
      .setFooter({ text: `Bublik Error Reporter • Total: ${this.stats.total}` });

    // Stack trace
    if (truncatedStack !== 'No stack trace') {
      embed.addFields({
        name: '🔍 Stack Trace',
        value: codeBlock('js', truncatedStack),
        inline: false,
      });
    }

    // Контекст
    if (report.context) {
      embed.addFields({
        name: '📝 Context',
        value: report.context.slice(0, 256),
        inline: false,
      });
    }

    // Мета
    const metaParts: string[] = [];
    if (report.userId) metaParts.push(`👤 <@${report.userId}>`);
    if (report.guildId) metaParts.push(`🏠 Guild: \`${report.guildId}\``);
    if (report.channelId) metaParts.push(`💬 <#${report.channelId}>`);

    if (metaParts.length > 0) {
      embed.addFields({
        name: '🔗 Details',
        value: metaParts.join(' • '),
        inline: false,
      });
    }

    return embed;
  }

  /**
   * Уникальный отпечаток ошибки для дедупликации.
   * Комбинация: message + source (без стека, т.к. номера строк могут отличаться)
   */
  private getFingerprint(error: Error, source?: string): string {
    const msg = error.message.slice(0, 100);
    return `${source ?? ''}::${msg}`;
  }
}

// ── Синглтон ─────────────────────────────────
export const errorReporter = new ErrorReporterManager();
