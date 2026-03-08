import { EmbedBuilder, ColorResolvable, User } from 'discord.js';
import { Config } from '../config';
import { i18n } from './I18n';

/**
 * Стандартный Embed-билдер Bublik.
 * Все embed бота проходят через этот класс для единообразного стиля.
 */
export class BublikEmbed extends EmbedBuilder {
  constructor() {
    super();

    // Стандартный цвет
    this.setColor(Config.botColor as ColorResolvable);

    // Стандартный футер
    this.setFooter({ text: Config.footer });

    // Таймстемп
    this.setTimestamp();
  }

  /** Установить заголовок через i18n ключ */
  setLocalizedTitle(key: string, locale?: string, params?: Record<string, string | number>): this {
    return this.setTitle(i18n.t(key, locale, params));
  }

  /** Установить описание через i18n ключ */
  setLocalizedDescription(key: string, locale?: string, params?: Record<string, string | number>): this {
    return this.setDescription(i18n.t(key, locale, params));
  }

  /** Добавить поле через i18n */
  addLocalizedField(
    nameKey: string,
    valueKey: string,
    inline = false,
    locale?: string,
    params?: Record<string, string | number>,
  ): this {
    return this.addFields({
      name: i18n.t(nameKey, locale, params),
      value: i18n.t(valueKey, locale, params),
      inline,
    });
  }

  /** Успешный embed (зелёный) */
  success(): this {
    return this.setColor(0x57f287);
  }

  /** Ошибочный embed (красный) */
  error(): this {
    return this.setColor(0xed4245);
  }

  /** Предупреждение (жёлтый) */
  warning(): this {
    return this.setColor(0xfee75c);
  }

  /** Информационный (синий, дефолт) */
  info(): this {
    return this.setColor(0x5865f2);
  }

  /** Установить автора из User */
  setUserAuthor(user: User): this {
    return this.setAuthor({
      name: user.displayName,
      iconURL: user.displayAvatarURL({ size: 64 }),
    });
  }
}

/**
 * Быстрые фабрики для частых случаев
 */
export function successEmbed(description: string): BublikEmbed {
  return new BublikEmbed().success().setDescription(description);
}

export function errorEmbed(description: string): BublikEmbed {
  return new BublikEmbed().error().setDescription(description);
}

export function warnEmbed(description: string): BublikEmbed {
  return new BublikEmbed().warning().setDescription(description);
}
