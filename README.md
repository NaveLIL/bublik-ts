# 🥯 Bublik Bot

> Модульный Discord-бот на TypeScript от **NaveL** для **EREZ**

## Архитектура

```
src/
├── index.ts              # Точка входа
├── bot.ts                # Класс BublikClient
├── config.ts             # Конфигурация (.env)
├── core/
│   ├── Logger.ts         # Winston логгер (файлы + консоль)
│   ├── Database.ts       # PostgreSQL через Prisma
│   ├── Redis.ts          # Redis + кэш-хелперы
│   ├── ModuleLoader.ts   # Hot-reload модулей
│   ├── CommandRegistry.ts# Реестр slash-команд
│   ├── EventHandler.ts   # Ядровые event'ы Discord
│   ├── EmbedBuilder.ts   # Единый стиль embed'ов
│   └── I18n.ts           # Мультиязычность
├── types/                # TypeScript интерфейсы
├── modules/              # Модули бота
│   ├── info/             # /info панель
│   └── general/          # /ping, /reload
├── utils/                # Утилиты
locales/
├── ru.json               # Русский
└── en.json               # English
```

## Быстрый старт

### 1. Настройка окружения

```bash
cp .env.example .env
# Заполните DISCORD_TOKEN и DISCORD_CLIENT_ID
```

### 2. Через Docker (рекомендуется)

```bash
docker compose up -d --build
```

### 3. Локальная разработка

```bash
npm install
npx prisma generate
npx prisma db push
npm run dev
```

## Hot-reload модулей

Бот поддерживает перезагрузку **отдельных модулей** без перезапуска:

- Команда `/reload <module>` — перезагрузить модуль (только для администраторов)
- При reload: команды перерегистрируются, event listener'ы обновляются
- Бот остаётся онлайн во время перезагрузки

## Создание нового модуля

```
src/modules/my-module/
├── index.ts              # Экспорт BublikModule
└── commands/
    └── my-command.ts     # Экспорт BublikCommand
```

```typescript
// src/modules/my-module/index.ts
import { BublikModule } from '../../types';
import myCommand from './commands/my-command';

const module: BublikModule = {
  name: 'my-module',
  descriptionKey: 'modules.my_module.description',
  version: '1.0.0',
  author: 'NaveL',
  commands: [myCommand],
};

export default module;
```

## Защита кода

```bash
npm run build              # Компиляция TS → JS
npm run build:protected    # Компиляция + обфускация
```

Результат обфускации — `dist-protected/`, используйте его для деплоя.

## Команды

| Команда   | Scope  | Описание                           |
|-----------|--------|------------------------------------|
| `/info`   | Global | Информационная панель бота         |
| `/ping`   | Guild  | Проверка задержки                  |
| `/reload` | Guild  | Перезагрузка модуля (admin only)   |

## Стек

- **Runtime:** Node.js 20+
- **Language:** TypeScript 5
- **Discord:** discord.js v14
- **Database:** PostgreSQL 16 (Prisma ORM)
- **Cache:** Redis 7
- **Logger:** Winston + DailyRotateFile
- **Deploy:** Docker Compose

---

**© NaveL for EREZ 2024–2026**
