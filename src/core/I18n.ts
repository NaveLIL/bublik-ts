import fs from 'fs';
import path from 'path';
import { Config } from '../config';
import { logger } from './Logger';

const log = logger.child('I18n');

type LocaleData = { [key: string]: string | LocaleData };

class I18nManager {
  private locales = new Map<string, LocaleData>();
  private readonly configuredDefaultLocale: string;
  private defaultLocale: string;

  constructor() {
    this.configuredDefaultLocale = Config.defaultLocale.trim().toLowerCase() || 'ru';
    this.defaultLocale = this.configuredDefaultLocale;
  }

  /** Загрузить все файлы локалей */
  load(): void {
    const dir = Config.localesDir;
    this.locales.clear();
    this.defaultLocale = this.configuredDefaultLocale;

    if (!fs.existsSync(dir)) {
      log.warn(`Папка локалей не найдена: ${dir}`);
      return;
    }

    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort();

    for (const file of files) {
      const locale = path.basename(file, '.json').toLowerCase();
      try {
        const raw = fs.readFileSync(path.join(dir, file), 'utf-8');
        const data = JSON.parse(raw) as LocaleData;
        this.locales.set(locale, data);
        log.info(`Локаль загружена: ${locale} (${Object.keys(data).length} ключей)`);
      } catch (err) {
        log.error(`Ошибка парсинга локали ${file}`, err);
      }
    }

    if (!this.locales.has(this.defaultLocale)) {
      const configured = this.defaultLocale;
      this.defaultLocale = this.locales.has('ru')
        ? 'ru'
        : (this.locales.keys().next().value ?? configured);
      log.warn(`Локаль по умолчанию "${configured}" не найдена; fallback: "${this.defaultLocale}"`);
    }
  }

  /** Перезагрузить все локали (hot-reload friendly) */
  reload(): void {
    this.locales.clear();
    this.load();
  }

  /**
   * Получить перевод по ключу.
   * Поддерживает вложенные ключи через точку: `module.info.title`
   * Плейсхолдеры: `{name}` заменяются на params.name
   */
  t(key: string, locale?: string, params?: Record<string, string | number>): string {
    const loc = locale?.trim().toLowerCase() || this.defaultLocale;
    const data = this.locales.get(loc) ?? this.locales.get(this.defaultLocale);

    if (!data) return key;

    // Поддержка вложенных ключей: "info.title" → data.info.title
    const parts = key.split('.');
    let value: any = data;
    for (const part of parts) {
      if (value && typeof value === 'object' && part in value) {
        value = value[part];
      } else {
        // Попробовать дефолтную локаль
        if (loc !== this.defaultLocale) {
          return this.t(key, this.defaultLocale, params);
        }
        return key; // ключ не найден — возвращаем как есть
      }
    }

    if (typeof value !== 'string') return key;

    // Подстановка плейсхолдеров
    if (params) {
      return value.replace(/\{(\w+)\}/g, (_, k) => String(params[k] ?? `{${k}}`));
    }

    return value;
  }

  /** Список доступных локалей */
  getAvailableLocales(): string[] {
    return Array.from(this.locales.keys());
  }

  /** Проверить, существует ли локаль */
  hasLocale(locale: string): boolean {
    return this.locales.has(locale.trim().toLowerCase());
  }

  getDefaultLocale(): string {
    return this.defaultLocale;
  }
}

// ── Синглтон ─────────────────────────────────
export const i18n = new I18nManager();
