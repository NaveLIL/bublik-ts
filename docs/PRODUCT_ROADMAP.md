# Дорожная карта Bublik: onboarding, PB, экономика, AI и собственный dashboard

Статус: проект решения. Новые продуктовые функции из этого документа по умолчанию выключены и не входят в текущий hardening-релиз.

## 1. Цель

Собрать из существующих модулей единый путь игрока:

1. вход на сервер и короткий onboarding;
2. осознанный переход в тикеты ADIR там, где этот handoff включён;
3. выбор доступных дней, времени и типов уведомлений;
4. подтверждение участия в конкретном PB;
5. ручной или автоматический сбор состава;
6. подтверждённое участие в бою;
7. прозрачная награда в экономике;
8. понятный следующий шаг: новый бой, команда, наставник или прогресс.

Главная продуктовая метрика — не количество отправленных пингов, а доля подтверждённых игроков, которые действительно пришли и сыграли.

## 2. Неприкосновенные правила совместимости

- Существующие серверы продолжают работать в режиме `legacy`; новые возможности включаются отдельно для каждой гильдии.
- Ручное создание PB-войса и существующая кнопка уведомлений остаются рабочим fallback.
- Автоматический PB никогда не создаётся, если уже существует подходящий ручной войс или активный сбор.
- Отпуск остаётся глобальным запретом на подбор и уведомления до указанной даты. Доступность по дням его не заменяет.
- Для авто-событий уведомления по умолчанию тихие. Массовый ping, индивидуальные упоминания и DM — разные явно настраиваемые режимы.
- Onboarding не переносится и не переписывается одним релизом. Сначала фиксируется его текущее поведение и добавляется наблюдаемость.
- Dashboard не выполняет Discord-side effects напрямую. Он создаёт проверенную команду; бот/worker исполняет её идемпотентно и записывает результат.
- AI является опциональным интерфейсом общения и подготовки решений, но не источником истины и не владельцем Discord-side effects.
- AI не определяет eligibility, не выдаёт роли/деньги, не выбирает исход казино, не назначает взыскания и не принимает кандидата без детерминированной повторной проверки Bublik.
- PostgreSQL — источник истины. Redis используется как кеш/ускоритель, а не как единственное место хранения важного состояния.
- Любая выдача денег, ролей, создание войса, тикета или рассылки имеет стабильный idempotency key и восстанавливаемое состояние.

## 3. Карта существующих контуров

| Контур | Сейчас | Целевое развитие |
|---|---|---|
| `welcome` | правила, recruit-role, переход в ticket channel, welcome bonus | versioned journey, прогресс после рестарта, безопасный handoff в ADIR |
| `br` | расписание BR, справочник техники, панель и уведомления | источник BR для конкретного BattleEvent и фильтра техники |
| `regbattle` | PB-войсы, составы, пинги, роли участия | единая PB session/event policy и автоматический сбор |
| `teams` | команды, заявки, приглашения, team-voice | предпочтения состава, капитаны и приоритет подтверждённых игроков |
| `vacation` | отпуск, временное снятие/возврат ролей | глобальная недоступность, единая eligibility policy |
| `economy` | voice income, PB tiers, daily/weekly, RP-механики | ledger событий, антифарм, сезонная экономика и PB-награды по факту участия |
| `tempvoice` | временные голосовые каналы | инфраструктура, но не источник факта участия в PB |
| ADIR | модерация, lifecycle обычных тикетов, конфигурационный dashboard, API, Battle HQ | отдельный модерационный сервис и опциональный владелец ticket conversation lifecycle |

## 4. Целевая архитектура без большого переписывания

Новые доменные сущности добавляются рядом с текущими таблицами, без переименования и удаления старых полей в первом релизе:

- `GuildFeatureFlag`: независимые флаги и kill switch по гильдии;
- `OnboardingJourney`: версия сценария, текущий шаг, завершённые шаги, ошибки и handoff status;
- `RecruitmentProfile`: versioned ответы кандидата, часовой пояс, доступность, BR/техника, предпочтения состава и notification consent;
- `RecruitmentCase`: состояние набора, назначенные рекрутеры и ссылка на выбранный conversation provider;
- `RecruitmentDecision`: неизменяемое решение, разрешённый role bundle, автор, причина и saga-status выдачи ролей;
- `PlayerAvailability`: часовой пояс, повторяющиеся окна, предпочтительные BR/режимы и notification consent;
- `BattleWindow`: именованное редактируемое окно War Thunder (`EU_RU`/`NA`), timezone, локальные часы, дни, период действия и enabled;
- `BattleEvent`: гильдия, `battleWindowId`, BR period, время, порог, источник (`manual`/`auto`), состояние и связанный voice;
- `BattleCommitment`: `yes`/`maybe`/`no`, время ответа, источник и факт attendance;
- `BattleNotification`: тип, адресат, причина допуска/исключения, попытки и итог доставки;
- `DomainOutbox`: надёжные команды внутри Bublik web/API/worker; отдельный
  `IntegrationInbox` используется только для опциональных ticket-handoff событий ADIR;
- `EconomyLedgerEntry`: неизменяемая причина начисления с уникальным source key;
- `AdminAuditLog`: кто, где, что изменил, before/after и correlation id.
- `AiGuildPolicy`: включённые сценарии, разрешённые каналы/DM, модельные группы, дневной бюджет, cooldown, privacy policy и kill switch;
- `AiUsageLedger`: модель/провайдер, сценарий, токены, стоимость, latency, результат и correlation id без обязательного хранения текста переписки;
- `AiConversationSummary`: только opt-in краткая память с TTL и версией согласия вместо бессрочного хранения полной истории сообщений.

Рекомендуемая граница процессов:

```text
Discord UI -> Bublik domain policy -> PostgreSQL/outbox -> Discord worker
                         ^                    |
                         |                    v
Bublik dashboard -> Bublik API policy  optional handoff -> ADIR TicketManager
```

Ни dashboard, ни один бот не пишет напрямую в доменные таблицы другого бота.
Все PB/BR/availability/attendance/notification/economy-команды принадлежат Bublik;
недоступность ADIR не блокирует ни один PB-сценарий.

## 5. Безопасное внедрение

### 5.1 Feature flags

Минимальный набор флагов:

- `onboardingJourneyV2`
- `adirHandoff`
- `availabilityPanel`
- `dailyCheckIn`
- `autoRecruitShadow`
- `autoRecruitNotify`
- `autoVoiceCreate`
- `economyLedgerV2`
- `dashboardReadOnly`
- `dashboardMutations`
- `aiAssistant`
- `aiAvailabilityDraft`
- `aiPbCopilotShadow`
- `aiPbCopilotNotify`
- `aiOnboardingAssist`
- `aiRoleplay`

Для существующих гильдий все они создаются со значением `false`. Текущая notification policy сохраняется как `legacy_manual`. Новый автоматический сбор начинает с `silent`.

### 5.2 Лестница rollout

Каждая функция проходит одинаковые ступени:

1. `off` — старый код работает без изменений;
2. `observe` — собираются метрики старого поведения;
3. `shadow` — новая логика считает решение, но ничего не отправляет и не меняет;
4. `canary` — одна тестовая гильдия и ограниченный круг ролей;
5. `opt-in` — администратор включает функцию сам;
6. `default-on-new` — только для новых установок;
7. `general` — после подтверждённого периода без регрессий.

Откат — изменение одного флага без rollback миграции. Миграции используют expand/backfill/contract: сначала nullable/default поля и backfill, удаление старой схемы — только в отдельном позднем релизе.

### 5.3 Защита onboarding

До первого изменения UX нужны:

- контрактные тесты всех текущих `welcome:*` custom IDs;
- golden-сценарии: новый участник, повторный вход, двойной клик, рестарт между шагами, потеря Discord response, отключённая экономика, закрытый ticket channel;
- сохранение текущего результата: auto-role, recruit-role, welcome bonus и ссылка на тикеты;
- метрики по каждому шагу и отдельный kill switch;
- read-only страница диагностики до появления web-редактирования;
- версионирование journey: начатый сценарий завершается на той версии, на которой был создан.

## 6. Onboarding v2

Onboarding должен оставаться коротким. Не следует заставлять новичка заполнять полное расписание до обращения в полк.

### Шаг A — обязательный минимум

- цель прихода: вступление / вопрос / другое;
- правила сервера и полка;
- подтверждение;
- recruit-role и exact-once welcome bonus;
- кнопка перехода к настроенному conversation provider, если он включён; для
  `adir` это ссылка на нужную панель ADIR, а без provider базовый onboarding
  завершается без внешней зависимости.

### Шаг B — progressive profiling

После создания тикета или принятия кандидата:

- часовой пояс;
- обычные дни и интервалы доступности;
- предпочитаемые BR/техника/роль в составе;
- согласие на DM и интенсивность уведомлений;
- предложение наставника или команды.

### Шаг C — первая ценность

- показать ближайший подходящий PB;
- дать одно действие `Смогу` / `Возможно` / `Не смогу`;
- после первого подтверждённого боя показать вклад, награду и следующий достижимый этап.

## 7. Связь Bublik с ADIR

В `NaveLIL/Adir` уже есть отдельные `bot`, `api`, `dashboard`, TicketManager и
Battle HQ. Реализованный TicketManager ведёт обычный тикет в отдельном приватном
текстовом канале: permissions, claim/unclaim, participants, transcript, feedback и
auto-close. Его Discord-intake ограничен возможностями modal, а dashboard сейчас
покрывает главным образом конфигурацию, панели, blacklist и статистику. Операционной
очереди кандидатов, календаря доступности и продвинутого recruitment onboarding в
текущем коде нет — это новые продуктовые экраны, а не готовая часть ADIR.

Существующие ADIR `Case` и глобальный `Dossier` относятся к модерации, наказаниям
и risk score. Их нельзя переименовать или переиспользовать как `RecruitmentCase` и
анкету кандидата: рекрутинговые данные получают отдельную схему, RBAC и сроки
хранения. Поэтому ADIR может остаться опциональным conversation provider на уже
использующих его серверах, но не является UI-основой Bublik и не считается
готовым доверенным API без дополнительного hardening.

### Этап 0 — сохранить текущий handoff

После прочтения правил Bublik пингует пользователя в канале, где уже размещена
панель ADIR; пользователь сам выбирает тип тикета, а весь ticket lifecycle остаётся
в ADIR. Этот рабочий сценарий сохраняется без изменений и служит fallback за
feature flag. Повторный клик/рестарт не должен создавать второй пинг.

### Этап 1 — link handoff

Bublik хранит не только `ticketChannelId`, но и ID сообщения панели ADIR. После
проверки, что канал и сообщение существуют, он показывает прямую link-button на
конкретную panel. На первом canary эта кнопка добавляется рядом с нынешним пингом;
после измерения конверсии публичный пинг можно сделать настраиваемым. Никаких
общих секретов или межбазовых записей.

### Этап 2 — подписанный handoff

Добавить в ADIR узкий endpoint `POST /internal/integrations/bublik/onboarding-handoffs`:

- отдельный секрет/ключ только для этой интеграции, не общий `BOT_SECRET`;
- HMAC подпись body + timestamp + nonce либо mTLS;
- allowlist гильдий;
- уникальный `(source, eventId)`;
- проверка членства пользователя, ticket config, blacklist, cooldown и лимита открытых тикетов;
- durable inbox/outbox и повторная доставка;
- audit log каждого решения;
- ответ возвращает состояние handoff, а не обещание уже созданного канала.

Когда выбран provider `adir`, ADIR TicketManager остаётся единственным владельцем
создания ticket channel, permissions, welcome message, transcript и закрытия.
Bublik не получает права создавать или редактировать такой тикет напрямую.

### Recruitment case и сменяемый интерфейс общения

Анкета и решение о приёме принадлежат Bublik, а не конкретному тикетному UI.
`RecruitmentCase` использует ровно один настроенный provider на гильдию:

- `adir` — опциональный вариант для серверов, уже использующих ADIR: он управляет тикетом и transcript;
- `native_private_thread` — будущая приватная ветка Bublik для recruitment-сценария и canary;
- `disabled` — сохраняет текущий handoff к панели без автоматического создания case conversation.

Двойная запись в ADIR и private thread запрещена. Смена provider не переносит
активные заявки автоматически: начатый case завершается в исходном provider.
Рекрутинговый профиль, решение и role saga остаются одинаковыми для обоих
вариантов и не смешиваются с глобальным модерационным Dossier ADIR.

Для ADIR достаточно узкого контракта `ticket.created` и
`recruitment.action_requested`: второе событие передаёт намерение и actor, но не
является финальным решением. Bublik валидирует guild, case, actor и разрешённый
outcome, после чего сам создаёт идемпотентный `RecruitmentDecision`. Bublik
публикует versioned dossier card, но не получает управление произвольными
тикетами. Для private-thread provider учитывать
[модель доступа и архивирования Discord threads](https://docs.discord.com/developers/topics/threads):
кандидат добавляется явно, сотрудники с `Manage Threads` видят все приватные
ветки, а `View Channel`/`Send Messages in Threads` наследуются от родителя.

Кнопка `Принять` не выдаёт произвольные выбранные роли напрямую. Она создаёт
идемпотентный `RecruitmentDecision` для заранее разрешённого role bundle;
Bublik повторно проверяет guild, actor, bot hierarchy и dangerous permissions,
выполняет saga и пишет audit log.

### Этап 3 — подтверждённое создание

Автосоздание тикета допускается только после явного действия пользователя. Потеря HTTP/Discord response не создаёт второй тикет: ADIR возвращает существующий результат по `eventId`.

После этого ADIR может отправлять Bublik узкое событие `ticket.created` или
`recruitment.action_requested`. Bublik повторно проверяет полномочия actor и
состояние case, сам фиксирует решение и только затем продолжает onboarding либо
запускает role saga. Это не даёт Bublik права управлять тикетом и не делает
доступность ADIR условием завершения базовых правил.

### Security-gate ADIR

До любой глубокой интеграции с ADIR необходимо:

- применить guild authorization к каждому JWT route, а не ограничиваться authentication;
- разделить machine credentials по сервисам и scope;
- проверять, что связанные config/panel/ticket/channel ID принадлежат той же гильдии;
- запретить пустой `RolePack.allowedRoles` как разрешение на произвольные роли;
- сделать ticket creation saga идемпотентной и восстановимой;
- заменить `lastTicket + 1` на безопасную sequence/unique allocation и claim на CAS;
- считать `open` и `claimed` единым лимитом, а blacklist/open-ticket checks выполнять fail-closed;
- заменить критические Redis Pub/Sub команды на durable outbox/inbox;
- санитизировать HTML transcript, определить CSP, retention и guild-scoped доступ;
- обновить runtime/dependencies и прогнать security/contract tests;
- проверить CSRF/OAuth state, cookies, CORS, rate limits и server-side role revalidation.

## 8. Доступность и автоматический сбор PB

Расписание самих War Thunder PB хранится отдельно от доступности игроков в
`BattleWindow`. Начальные редактируемые значения:

- `EU_RU`: каждый день `17:00–01:00`, timezone `Europe/Moscow`, включено;
- `NA`: каждый день `01:00–07:00`, timezone `UTC` (`04:00–10:00 МСК`), включено.

Это стартовые значения на основе [опубликованных War Thunder окон](https://forum.warthunder.com/t/squadron-battles-technical-issues/43948)
`14:00–22:00 GMT` и `01:00–07:00 GMT`. Авторитетным источником актуального
расписания остаётся клиент War Thunder; перед изменением сезона администратор
сверяет окна в игре и обновляет конфигурацию. `BattleWindow` хранит
`validFrom`/`validUntil` и не является константой приложения. Администратор может
временно отключить окно или изменить его без релиза; изменение пишет audit log и
не передвигает уже подтверждённый BattleEvent молча. Существующие
`VacationConfig.primeTimeStart/End` не являются источником расписания PB и
используются только политикой отпуска.
Каждый BattleEvent хранит `windowBusinessDate` в timezone своего BattleWindow:
вечернее `EU_RU` остаётся одной сессией после полуночи, а утреннее `NA` не
смешивается с продолжением предыдущего вечернего окна.

Используется гибридная модель:

- `RecurringAvailability` задаёт обычные дни недели, локальные интервалы времени
  и опциональные `validFrom`/`validUntil`;
- `AvailabilityOverride` задаёт точную локальную дату `YYYY-MM-DD` с годом либо
  диапазон дат и одно или несколько окон, либо явное `unavailable`;
- утренний/дневной check-in подтверждает конкретный день;
- ответ на конкретный BattleEvent имеет наивысший приоритет;
- отпуск всегда исключает игрока;
- `played today` и уже находящиеся в PB исключаются из новых приглашений.

Каждый профиль хранит IANA timezone и дату последнего подтверждения. Время
BattleEvent сохраняется как UTC instant, а повторяющиеся окна — как локальное
время игрока с timezone; это не смешивает календарный день пользователя с
часовым поясом сервера. Пустой ответ означает `unknown`, а не `unavailable`.
Один день поддерживает несколько интервалов. Окно через полночь при сохранении
нормализуется в две части на соседних локальных датах; пересекающиеся интервалы
объединяются, а невозможные и нулевые интервалы отклоняются.

Приоритет eligibility:

1. активный/активирующийся отпуск;
2. явный запрет на точную дату;
3. явное окно на точную дату;
4. повторяющийся недельный шаблон;
5. неизвестно.

В Discord MVP используются timezone/preset, checkbox/select дней, интервалы и
постраничные недели. Полный month/year calendar, массовое выделение дат и
редактирование диапазонов относятся к будущему собственному Bublik dashboard.
В web-календаре игрок выбирает один день, набор дней или диапазон, применяет
`available`/`unavailable` и один или несколько временных preset; доступны
копирование недели/месяца и очистка только выбранных override без удаления
обычного недельного шаблона. Изменения сначала показываются в preview в часовом
поясе игрока и UTC-времени ближайших BattleEvent.
Основные presets — `EU/RU целиком`, `NA целиком`, `обе сессии` и `своё время`;
частичное окно автоматически пересекается с соответствующим BattleWindow. Поэтому
пользователю не нужно вручную вводить `04:00–10:00`, но такая точность остаётся
доступной.
По актуальному
[Discord Components reference](https://docs.discord.com/developers/components/reference)
нативного date-picker нет, поэтому имитировать год сотнями кнопок нельзя.
Основной оперативный горизонт — ближайшие 6–8 недель. Web UI позволяет планировать
до 12 месяцев вперёд, но перед использованием старого долгосрочного окна бот
просит коротко переподтвердить доступность; недельный шаблон переподтверждается
раз в 30 дней. Точные будущие даты не удаляются молча.

BattleEvent получает стабильный ключ, например `(guildId, brPeriodId, startsAt, mode)`. Это предотвращает двойной voice и двойную рассылку после рестарта или при нескольких процессах.

Автоматический алгоритм:

1. получает актуальный BR из `br`;
2. выбирает только доступных и не находящихся в отпуске игроков;
3. формирует кандидатов в shadow mode;
4. при достижении настраиваемого порога (первоначально 7) предлагает подтвердиться;
5. перед действием повторно проверяет состав и наличие ручного PB-войса;
6. создаёт voice только через durable saga;
7. приглашает только подтвердившихся пользователей выбранным ими способом;
8. при появлении ручного войса переводит авто-событие в `superseded_manual`.

Кнопка командира может переключить режим `silent` -> `recruit` -> `urgent`, но не обходит отпуск, opt-out и rate limits.

## 9. Экономика как продолжение PB, а не AFK-ферма

Текущие значения дают примерно 50 единиц/час в обычном voice и 200/час в PB; затем PB tier умножает разные доходы до 2.5x. Максимальный пассивный PB-доход поэтому может быть примерно в четыре раза выше обычного ещё до эффекта прогрессии, а сам PB-канал сейчас определяется в основном channel/category ID.

Перед новым контентом нужен Economy Ledger v2:

- каждая награда имеет `sourceType`, `sourceId`, `userId`, `ruleVersion` и unique key;
- PB reward требует активную подтверждённую PB session, а не только присутствие в канале;
- число подходящих участников считается после anti-AFK/eligibility фильтра;
- один временной bucket начисляется один раз даже при двух процессах и рестарте;
- вводятся дневной cap и diminishing returns для пассивного voice;
- PB-tier роли отделяются от eligibility/ping ролей;
- аномалии (пары аккаунтов, постоянные пустые каналы, 24/7 income) попадают в review, а не ведут к автоматическому наказанию.

После этого можно развивать RP:

- полковые контракты и совместные цели, которые требуют реального PB attendance;
- сезонные рейтинги и косметические награды;
- роли в составе и бонусы за дефицитные позиции;
- командные treasury/sinks, ремонт, логистика и подготовка к бою;
- цепочки заданий между onboarding, первым тикетом, первым PB и первой командой;
- market/raid/heist контент с контролируемой денежной массой;
- награды за надёжность: подтвердил и пришёл, а не за количество полученных уведомлений.

## 10. AI-помощник через OpenRouter

AI добавляется как отдельный provider-neutral модуль Bublik. Первой реализацией
может быть OpenRouter через совместимый chat API, но доменная логика не должна
зависеть от конкретной модели или провайдера. Недоступность AI переводит сценарий
на обычные embed/кнопки и никогда не блокирует onboarding, PB, отпуск или экономику.

### Полезные сценарии

1. **PB copilot** — объясняет статус сбора, отвечает на вопросы о BR, времени,
   командире и войсе, формулирует персональное приглашение и понимает ответы
   вроде «буду после 21:00» или «через полчаса».
2. **Availability assistant** — превращает свободный текст в черновик расписания,
   показывает timezone/date preview и сохраняет его только после явного
   подтверждения пользователя.
3. **Onboarding/recruitment assistant** — объясняет правила, замечает пропущенные
   ответы и готовит краткое досье для рекрутера; финальное решение и role bundle
   остаются за человеком и Bublik policy.
4. **Community/RP** — отдельный opt-in канал с персонажем Bublik, новости полка,
   викторины, описания предметов, задания, NPC и оформление событий экономики.
5. **Staff copilot** — сводки тикетов/логов и черновики ответов без автоматических
   наказаний, модерационных решений или публикации от имени сотрудника.

Для экономики AI создаёт текст, сюжет и оформление. Балансы, награды, случайность
казино, покупки и ledger entries рассчитываются только детерминированным кодом.

### PB copilot: строгая граница ответственности

Список адресатов всегда строит существующая PB policy с учётом ping-role,
отпуска, availability, `played today`, текущего войса, consent и cooldown. AI
получает уже отфильтрованный контекст и может только:

- сформулировать короткое персональное сообщение;
- вести диалог и предложить `Смогу` / `Позже` / `Сегодня нет`;
- создать подтверждаемый draft изменения availability;
- подготовить командиру сводку подтверждений и дефицита состава.

Ответ модели не является командой. Любое действие проходит JSON Schema,
allowlist tool calls, проверку guild/user/revision и повторную доменную
авторизацию. AI не обходит отпуск, opt-out, rate limits и ручное отключение
уведомлений. Цель — повысить релевантность приглашений, а не усложнить отказ.

### Интеграция и безопасность

- единый `AiProvider` adapter, чтобы OpenRouter можно было заменить без миграции
  доменных данных;
- разные модельные группы: дешёвая/быстрая для классификации и диалога,
  более сильная только для досье и творческих задач;
- model/provider fallback, жёсткие timeout и circuit breaker;
- structured outputs с `strict` JSON Schema и `require_parameters` для моделей,
  которые это поддерживают;
- инструменты делятся на read-only и confirm-required; прямого SQL, Discord API,
  токенов и произвольного выполнения команд у модели нет;
- очередь и per-user/per-guild rate limits в Redis, дневной денежный/token budget
  в PostgreSQL и немедленный kill switch;
- входящие Discord-сообщения считаются недоверенными данными: prompt injection
  не может изменить system policy или расширить tool permissions;
- для DM, анкет и досье запрещено включать обучение на данных; предпочтительны
  ZDR endpoints и `data_collection: deny`, а полное prompt logging по умолчанию
  выключено;
- в prompt передаётся минимальный контекст без секретов и лишних персональных
  данных; долговременная память только по opt-in и с TTL/удалением.

Опорные возможности OpenRouter:
[tool calling](https://openrouter.ai/docs/guides/features/tool-calling),
[structured outputs](https://openrouter.ai/docs/guides/features/structured-outputs),
[model fallbacks](https://openrouter.ai/docs/guides/routing/model-fallbacks) и
[Zero Data Retention](https://openrouter.ai/docs/guides/features/zdr).

### Минимальный AI MVP

- `/assistant` и один явно разрешённый канал, без чтения всего сервера;
- read-only ответы о ближайшем PB и объяснение текущего notification mode;
- availability draft из свободного текста с preview и кнопкой подтверждения;
- recruiter summary из уже собранной анкеты;
- shadow-режим персональных PB-сообщений без фактической отправки;
- наблюдаемость стоимости, latency, fallback, отказов схемы и жалоб пользователей.

Проактивные DM, запись действий через tools и RP-память включаются только после
canary. Развлекательный персонаж не отвечает на каждое сообщение автоматически:
только упоминание, команда либо специально выделенный канал.

## 11. Web dashboard и open-source основа

### Решение

Создать собственный Bublik dashboard как отдельный web/API deployment. Он владеет
PB, BR, availability, attendance, notification policy, onboarding и экономическими
представлениями Bublik. Dashboard пишет только проверенные команды в Bublik API;
Discord-side effects выполняет bot/worker через durable outbox. ADIR остаётся
отдельным модерационным продуктом: допускаются ссылка/переход к тикету и узкий
handoff-status, но не общая БД, не PB mutations и не зависимость доступности.

Из ADIR можно переиспользовать только отдельно проверенные open-source библиотеки,
дизайн-токены и UX-паттерны (Radix UI, Headless UI, Tremor/Recharts, React Hook
Form, Zod), а не копировать его authorization/API автоматически. Для новых
resource-heavy admin screens провести короткий spike [Refine](https://refine.dev/)
— у него есть access-control и audit-log providers, но не добавлять ещё один
framework без измеримого выигрыша.

Кандидаты инфраструктуры:

- Discord OAuth2 — только по [официальному flow](https://docs.discord.com/developers/platform/oauth2-and-permissions), с `state`, минимальными scopes и серверной проверкой guild membership;
- auth library — spike Auth.js vs [Better Auth Discord provider](https://better-auth.com/docs/authentication/discord), затем ADR и миграционный тест сессий;
- [OpenTelemetry JS](https://opentelemetry.io/docs/languages/js/) для traces/metrics;
- [Grafana OSS](https://grafana.com/oss/grafana/) только для внутренней наблюдаемости, не как player/admin product UI;
- [pg-boss](https://github.com/timgit/pg-boss) как кандидат durable jobs после совместимого обновления Node/Prisma; до spike текущий PostgreSQL outbox остаётся безопаснее;
- OpenFGA не вводить на старте: текущего server-side RBAC достаточно. Рассматривать его только при реальной сложности межсерверных отношений.

### Правила допуска open-source зависимости

- активные releases и security policy;
- понятная лицензия и сохранённые notices;
- pinned lockfile, Dependabot и `npm audit`;
- минимальная поверхность зависимостей;
- server-side authorization независимо от скрытых кнопок UI;
- threat model и contract tests до production;
- SBOM/список лицензий для production image;
- возможность удалить компонент без потери доменных данных.

### Первые страницы

1. read-only здоровье модулей, failed recoveries и feature flags;
2. PB calendar: BR, commitments, доступность, отпуск и ручной/авто источник;
3. notification policy и preview реальных адресатов;
4. economy ledger, источники/стоки и anti-farm anomalies;
5. onboarding funnel и ADIR handoff status;
6. audit log и кнопка безопасного rollback конфигурации.

## 12. Этапы и критерии выхода

### R0 — Reliability baseline

- закрыты подтверждённые race/recovery/whitelist проблемы;
- миграции, CI, Docker smoke и fault-injection tests проходят;
- никаких новых UX-функций.

### R1 — Наблюдаемость и контракты

- correlation ID проходит через bot, DB и ADIR handoff;
- метрики onboarding/PB/economy определены;
- golden onboarding tests и event ledger schema готовы;
- dashboard только read-only.

### R2 — Availability MVP в Discord

- повторяющиеся окна + timezone;
- daily check-in;
- отпуск и consent применяются одной policy;
- текущие ручные PB-сценарии не меняются.

### R3 — Auto-recruit shadow

- четыре недели shadow-решений без отправки;
- расхождения с ручным составом объяснимы;
- нет ложных vacation/played targets;
- администратор видит preview и причины исключения.

### R4 — Canary auto voice

- одна гильдия, заданные часы и kill switch;
- минимум 7 подтверждений по конфигу;
- manual voice всегда выигрывает CAS;
- ни одного duplicate voice/DM после restart tests.

### R5 — Economy Ledger v2

- exact-once bucket rewards;
- reward зависит от подтверждённой session;
- caps/diminishing returns и anomaly report;
- старые балансы не пересчитываются молча.

### R6 — Собственный Bublik dashboard

- отдельный deployment и Bublik API без общей БД с ADIR;
- сначала read-only Bublik data, затем canary mutations;
- каждая мутация авторизована сервером и попадает в audit log;
- Discord панели остаются основным быстрым интерфейсом игрока.

### R7 — Onboarding v2 + опциональный conversation handoff

- versioned durable journey;
- provider-neutral link handoff, затем signed handoff для включённого provider;
- duplicate ticket rate = 0 в fault tests;
- старый welcome flow доступен одним feature flag.

### Параллельный AI-track

- `A0` после R1 — `AiProvider`, privacy/budget policy, usage ledger, schema/tool
  validators и fake provider для тестов;
- `A1` после R2 — `/assistant`, read-only PB tools и подтверждаемый availability
  draft на одной canary-гильдии;
- `A2` вместе с R3/R4 — PB copilot сначала сравнивает тексты/ответы в shadow,
  затем отправляет ограниченные opt-in приглашения без изменения candidate policy;
- `A3` вместе с R7 — объяснение onboarding и recruiter summary без права принимать
  кандидата или выбирать роли;
- `A4` после стабильного A2/A3 — RP-персонаж, новости, викторины и narrative
  economy content в отдельных каналах.

AI-track откатывается собственными feature flags и не меняет порядок основных
R-релизов. Для перехода A1/A2 из shadow в canary обязательны тесты prompt
injection, malformed tool calls, timeout/fallback, budget exhaustion и provider
outage.

## 13. Метрики и guardrails

Основные:

- onboarding completion rate и median time;
- переход к настроенному conversation provider и создание валидного conversation;
  отдельно — конверсия ADIR handoff там, где он включён;
- first response/resolution time тикета;
- доля игроков с заполненной доступностью;
- check-in -> attendance conversion;
- PB fill time и доля событий, стартовавших составом;
- confirmed-no-show rate;
- retention после первого и третьего PB;
- economy emission/sinks и распределение богатства.
- AI-assisted PB invite -> commitment и commitment -> attendance conversion;
- стоимость AI на одного подтвердившегося и реально пришедшего игрока;
- доля availability drafts, подтверждённых без исправлений;
- AI response latency, fallback/error rate и schema rejection rate;
- жалобы, отключения AI и доля диалогов, переданных человеку.

Обязательные guardrails:

- vacation ping rate = 0;
- duplicate role/ticket/voice/reward = 0;
- onboarding technical failure rate не растёт;
- opt-out violation = 0;
- ручные PB-сценарии не деградируют;
- подозрительный пассивный voice income имеет измеримый тренд вниз;
- любой auto-action имеет actor/reason/correlation id и восстанавливаемый статус.
- AI unauthorized side effect = 0, hallucinated role/money/action execution = 0;
- AI opt-out/DM consent violation = 0;
- provider outage не ухудшает доступность обычных команд Bublik;
- дневной AI-бюджет нельзя превысить конкурентными запросами.

## 14. Ближайший практический порядок

1. завершить текущий hardening и развернуть его отдельно;
2. добавить метрики и durable onboarding journey без изменения экранов;
3. независимо провести security audit ADIR API/dashboard до любой глубокой интеграции;
4. сохранить текущий ADIR handoff и отдельно реализовать безопасную link-button;
5. выпустить availability + daily check-in сначала в Discord Bublik;
6. параллельно добавить AI foundation и `/assistant` в read-only canary;
7. включить availability draft и PB copilot только в shadow, измеряя полезность и стоимость;
8. поднять read-only Bublik dashboard и собрать 2–4 недели shadow-данных;
9. после этого принимать решение об AI PB DM, auto voice и web mutations;
10. Economy Ledger v2 развивать параллельно, но включать PB-награды только после надёжной session policy;
11. RP-персонажа и narrative economy включать после стабильности AI PB/onboarding сценариев.
