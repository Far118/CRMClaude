# CRMNadya — CRM предпродажного этапа

CRM для управления **предпродажным (presales) этапом** в логистических / коммерческих продажах. Система покрывает путь от момента «компания заведена в CRM» до «запрос передан в договоры» — то есть всё, что происходит **до** подписания договора.

> Полный жизненный цикл клиента (договоры, исполнение рейса, взаиморасчёты) — вне зоны ответственности этой системы. CRMNadya отвечает за этап работы с запросами: расчёт ставки, отправка КП, согласование, передача в договоры.

---

## Содержание

1. [Что делает система](#что-делает-система)
2. [Архитектура](#архитектура)
3. [Логика работы](#логика-работы)
4. [Структура проекта](#структура-проекта)
5. [Установка](#установка)
6. [Переменные окружения](#переменные-окружения)
7. [Тесты](#тесты)
8. [API](#api)
9. [Учётные записи демо](#учётные-записи-демо)
10. [Обслуживание](#обслуживание)

---

## Что делает система

- **Не теряет запросы.** У каждого запроса есть ответственный, статус и история изменений.
- **Управляет конверсией.** Видно, на какой стадии запросы «застревают» и сколько уходит в потери.
- **Автоматически считает статус компании** из статусов её запросов — никакого ручного рассинхрона.
- **Даёт руководителю прозрачность.** План/факт по командам и менеджерам в реальном времени.
- **Анализирует Excel через AI** — загрузка таблицы → автоматический разбор и текстовые инсайты.

---

## Архитектура

```
┌─────────────────────────────────────────────────────────────┐
│                  Frontend (SPA, статика)                     │
│      Vanilla JS + Alpine.js + Vite,  fetch → /api/*          │
└────────────────────────────┬────────────────────────────────┘
                             │ HTTP (nginx reverse proxy)
                             ▼
┌─────────────────────────────────────────────────────────────┐
│              Backend API (Node.js + Express)                 │
│   Cluster mode · Stateless (JWT в HttpOnly cookie)           │
│   Knex → PostgreSQL · Zod-валидация · helmet · rate-limit    │
└──────┬───────────────────────────┬──────────────────┬────────┘
       │                           │                  │
       ▼                           ▼                  ▼
┌──────────────┐         ┌──────────────────┐  ┌──────────────┐
│ PostgreSQL   │         │ Worker (процесс) │  │ Файлы (FS)   │
│  + outbox    │◄────────│ outbox + cron    │  │ uploads/     │
└──────────────┘         └──────────────────┘  └──────────────┘
                                  │
                                  ▼
                         ┌──────────────────┐
                         │ AI Provider API  │
                         │ OpenAI/Anthropic │
                         │ /DeepSeek        │
                         └──────────────────┘
```

| Слой | Технологии |
|------|-----------|
| Backend | Node.js 20+, Express, Knex, PostgreSQL 16, Zod, JWT, bcryptjs, helmet, express-rate-limit, multer, xlsx, web-push |
| Frontend | Vanilla JS, Alpine.js, Vite, собственный CSS с дизайн-токенами |
| Инфраструктура | Docker, docker-compose, nginx |
| Тесты | Встроенный `node --test` (без внешних зависимостей) |

**Два процесса backend:**
- `server.js` — API (отвечает на HTTP-запросы).
- `services/worker.js` — фоновый процесс: разбирает outbox-события и пересчитывает статусы компаний, плюс ночной cron.

---

## Логика работы

### Сущности

| Сущность | Назначение |
|----------|-----------|
| `departments` | Отделы (верхний уровень орг-структуры) |
| `teams` | Команды: один head + N менеджеров, привязка к отделу |
| `users` | Пользователи: admin / head / manager / ops |
| `companies` | Компании-лиды. Статус **вычисляется**, не редактируется вручную |
| `contacts` | Контактные лица компании |
| `requests` | Запросы на просчёт. Имеют жизненный цикл со статусами |
| `request_status_history` | История смен статуса запроса |
| `company_status_history` | История смен вычисленного статуса компании |
| `close_reasons` | Справочник причин закрытия (с флагом `is_loss`) |
| `activities` | Звонки, письма, встречи, заметки (лента активности) |
| `tasks` | Задачи и напоминания с дедлайнами и исполнителем |
| `plans` / `plan_history` | Месячные планы по метрикам + история изменений |
| `comments` | Комментарии к компаниям и запросам |
| `attachments` | Вложения к запросам (КП, документы) |
| `notifications` / `push_subscriptions` | In-app и web-push уведомления |
| `audit_logs` | Журнал действий пользователей |
| `ai_reports` / `ai_report_analysis` / `ai_report_charts` | Загруженные Excel + результаты AI-анализа |
| `outbox` | Очередь событий для transactional outbox |

### Статусы запроса

Запрос проходит строго ограниченный жизненный цикл:

| Статус | Что значит | Допустимые переходы |
|--------|-----------|---------------------|
| `new` | Новый — только получен | → `in_progress`, `closed` |
| `in_progress` | В работе — менеджер считает ставку | → `kp_sent`, `closed`, `new` |
| `kp_sent` | Отправлено КП | → `negotiation`, `handover`, `closed` |
| `negotiation` | Согласование ставки/условий | → `handover`, `closed`, `kp_sent` |
| `handover` | Передан в договоры | → `closed` (только admin) |
| `closed` | Закрыт | → `in_progress` (reopen, только head/admin) |

**Правила переходов** заданы в `constants/index.js` (`ALLOWED_TRANSITIONS`) и проверяются на бэкенде. Недопустимый переход → `409 Conflict`. Admin может переходить в любой статус.

**Чек-лист перед `handover`** (передача в договоры):
- заполнены `route_from`, `route_to`;
- `our_rate > 0`;
- прикреплён хотя бы один файл КП.

Если что-то не выполнено — переход блокируется с понятным сообщением.

**Закрытие (`closed`):**
- причина закрытия **обязательна**;
- если у причины флаг `requires_comment = true` — комментарий обязателен;
- причины с `is_loss = false` (дубль, нецелевой, тестовый) **не** делают компанию «потерянной».

**Read-only:** после `handover` запрос можно дополнять только примечанием; после `closed` — менять только причину/комментарий (head/admin).

**Optimistic locking:** при смене статуса клиент передаёт `updated_at`; если запись изменил кто-то другой — `409 Conflict` (защита от гонки при одновременном редактировании).

### Статусы компании (вычисляемые)

Статус компании **никогда не редактируется вручную** — он всегда выводится из статусов её запросов. Это ключевое архитектурное решение, устраняющее класс багов «статус компании рассинхронизирован с запросами».

| Статус | Когда |
|--------|-------|
| `cold_lead` | Холодный лид — нет активных запросов |
| `warm_lead` | Тёплый лид — есть запрос в `new` / `in_progress` |
| `hot_lead` | Горячий лид — есть запрос в `kp_sent` / `negotiation` |
| `client` | Клиент — был `handover` за последние N месяцев (по умолчанию 6) |
| `lost` | Потерян — все запросы закрыты, последний по дате закрыт с `is_loss = true` |

### Алгоритм пересчёта статуса компании

Реализован в `services/statusEngine.js` (функция `computeStatus`) по приоритету:

```
1. CLIENT      ← есть handover за последние N месяцев
2. HOT_LEAD    ← есть активный запрос в kp_sent / negotiation
3. WARM_LEAD   ← есть активный запрос в new / in_progress
4. LOST        ← все запросы закрыты И последний по дате — closed с is_loss=true
5. COLD_LEAD   ← всё остальное (в т.ч. последний закрыт «дублём»)
```

Особенности:
- **Компания не может быть «потеряна», пока есть активный запрос** — приоритет warm/hot выше.
- **«Клиент» — состояние с окном.** Если за N месяцев не было нового `handover`, компания возвращается в `warm`/`hot`/`cold` по активным запросам. Окно `CLIENT_WINDOW_MONTHS` настраивается.
- **Технические закрытия** (`is_loss=false`) ведут в `cold_lead`, а не в `lost`.

Функция `computeStatus` — **чистая** (без обращения к БД), что делает её полностью покрытой unit-тестами.

### Transactional outbox и worker

Чтобы статус компании никогда не «отстал» от запросов, используется паттерн **transactional outbox**:

1. При создании/смене статуса/удалении запроса в **одной транзакции** записывается:
   - изменение в `requests`,
   - запись в `request_status_history`,
   - событие в `outbox`.
2. Сразу же выполняется **синхронный** пересчёт компании (быстрый отклик в UI).
3. Фоновый `worker.js` дополнительно вычитывает `outbox` и пересчитывает статусы — **подстраховка** на случай сбоя синхронного пути. Идемпотентно, с `retry_count`.
4. **Ночной cron** (03:00 UTC) пересчитывает компании, у которых истекло «окно клиента».

Worker также делает health-check: предупреждает, если есть необработанные события старше 1 минуты.

### Роли и права (RBAC)

| Роль | Видит | Может менять |
|------|-------|-------------|
| `manager` | Только свои компании/запросы | Только свои записи |
| `head` | Свои + всю свою команду | Свои и команды; переназначение внутри команды |
| `admin` | Всё | Всё; справочники, пользователи, команды, отделы |
| `ops` | Только свои записи | Создание запросов (операционист на приёме) |

Реализация — `middleware/auth.js`:
- `getVisibleUserIds(user)` — список доступных `owner_id` (для admin — `null`, без ограничения).
- `canModify(user, ownerId)` — может ли пользователь менять запись.
- Чистые функции `computeVisibleUserIds` и `computeCanModify` покрыты тестами.

**Anti-IDOR:** при обращении к чужой записи возвращается `404`, а не `403` — чтобы не раскрывать сам факт её существования.

**Защита плана от понижения задним числом:** уменьшить план в текущем/прошлом месяце может только admin; любое изменение пишется в `plan_history`.

### Планы и факт

- План ставится на пользователя на месяц (`year` + `month`).
- Метрики: выручка, выигранные сделки (`handover`), новые запросы, отправленные КП, активности, звонки, встречи, новые компании.
- **Факт считается в реальном времени** из реальных данных:
  - выручка/выигрыши — по `requests` со статусом `handover`;
  - отправленные КП — по `request_status_history` (переходы в `kp_sent`);
  - активности — по `activities`.
- На дашборде показывается прогресс план/факт с цветовой индикацией относительно % прошедшего месяца.

### AI-отчёты

1. Пользователь загружает `.xlsx` / `.xls` / `.csv` (через `multer`, лимит размера настраивается).
2. Файл парсится (`xlsx`), данные отправляются выбранному AI-провайдеру.
3. AI возвращает структурированный JSON: резюме, тенденции, аномалии, рекомендации, конфигурации графиков.
4. Результат сохраняется с версионированием (`ai_report_analysis`), графики — в `ai_report_charts`.
5. Провайдер (OpenAI / Anthropic / DeepSeek) настраивается админом в разделе «Настройки».

---

## Структура проекта

```
crm_final/
├── docker-compose.yml          # db + backend + worker + frontend
├── .env.example                # шаблон переменных окружения
├── backend/
│   ├── server.js               # точка входа API (cluster mode)
│   ├── config.js               # конфиг из env с валидацией
│   ├── constants/index.js      # единый источник всех enum
│   ├── db/
│   │   ├── schema.sql          # полная схема БД (idempotent)
│   │   ├── knex.js             # подключение к БД
│   │   ├── migrate.js          # накат схемы + сид admin/справочников
│   │   └── seed.js             # демо-данные
│   ├── middleware/
│   │   ├── auth.js             # JWT, RBAC, scope, canModify
│   │   └── validate.js         # Zod-валидация
│   ├── routes/                 # auth, companies, contacts, requests, activities,
│   │   │                       # tasks, plans, dashboard, reports, comments,
│   │   │                       # closeReasons, notifications, aiReports, attachments,
│   │   │                       # audit, settings, users, lookup
│   ├── services/
│   │   ├── statusEngine.js     # пересчёт статуса компании + outbox
│   │   ├── worker.js           # обработчик outbox + ночной cron
│   │   ├── aiService.js        # вызовы AI-провайдеров
│   │   └── auditLog.js         # запись в audit_logs
│   ├── scripts/normalize_db.js # нормализация «грязных» данных
│   ├── tests/                  # statusEngine / rbac / transitions (node --test)
│   └── Dockerfile
└── frontend/
    ├── *.html                  # login, index (дашборд), companies, company,
    │                           # requests, request, activities, plans, reports,
    │                           # ai-reports, team, admin/users, settings
    ├── js/
    │   ├── api.js              # обёртка fetch
    │   ├── const.js            # загрузка справочников из /api/lookup
    │   ├── ui.js               # сайдбар, навигация, форматтеры
    │   └── pages/*.js          # Alpine-компоненты страниц
    ├── css/main.css            # дизайн-токены + компоненты
    ├── nginx.conf              # reverse proxy на backend
    ├── vite.config.js
    └── Dockerfile
```

---

## Установка

### Вариант A: Docker (рекомендуется)

Требуется Docker и Docker Compose.

```bash
# 1. Распаковать архив и перейти в каталог
unzip crm_nadya.zip && cd crm_final

# 2. Создать .env из шаблона и заполнить
cp .env.example .env
nano .env        # обязательно задать DB_PASSWORD, JWT_SECRET, ADMIN_PASSWORD

# 3. Поднять весь стек (db + backend + worker + frontend)
docker compose up -d --build
```

`docker compose` автоматически:
- поднимает PostgreSQL,
- накатывает схему и создаёт администратора (`node db/migrate.js` в контейнере backend),
- запускает API, worker и nginx с фронтендом.

Откройте **http://localhost** и войдите под учёткой администратора (`ADMIN_EMAIL` / `ADMIN_PASSWORD` из `.env`).

Полезные команды:
```bash
docker compose ps                  # статус контейнеров
docker compose logs -f backend     # логи API
docker compose logs -f worker      # логи фонового процесса
docker compose down                # остановить
docker compose down -v             # остановить и удалить данные БД
```

### Вариант B: локальная разработка

Требуется Node.js 20+ и установленный PostgreSQL 16.

```bash
# 1. Создать базу данных
createdb crmnadya

# 2. Backend
cd backend
cp ../.env.example .env
nano .env                # задать DB_*, JWT_SECRET, ADMIN_PASSWORD
npm install
npm run migrate          # схема + admin + справочник причин закрытия
npm run seed             # (опционально) демо-данные
npm run dev              # API на http://localhost:3000

# 3. Worker (отдельный терминал)
cd backend
npm run worker           # фоновый процесс пересчёта статусов

# 4. Frontend (отдельный терминал)
cd frontend
npm install
npm run dev              # Vite на http://localhost:5173 (проксирует /api → :3000)
```

Фронтенд в dev-режиме доступен на **http://localhost:5173**.

Сборка фронтенда для продакшена:
```bash
cd frontend
npm run build            # результат в frontend/dist/
```

---

## Переменные окружения

Полный список — в `.env.example`. Ключевые:

| Переменная | Назначение | Обязательна |
|-----------|-----------|:-----------:|
| `NODE_ENV` | `development` / `production` | — |
| `PORT` | Порт API (по умолчанию 3000) | — |
| `CORS_ORIGIN` | URL фронтенда для CORS | в prod |
| `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER` | Параметры PostgreSQL | — |
| `DB_PASSWORD` | Пароль БД | **да** |
| `JWT_SECRET` | Секрет для подписи JWT (64+ случайных символа) | **да** |
| `JWT_EXPIRES_IN` | Срок сессии (по умолчанию 8h) | — |
| `BCRYPT_ROUNDS` | Раунды bcrypt (12 для prod) | — |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD` | Первый администратор (создаётся при миграции) | **да** |
| `AI_PROVIDER`, `AI_API_KEY`, `AI_MODEL` | Настройки AI-провайдера (можно задать и в UI) | — |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` | Web-push уведомления | — |
| `UPLOAD_DIR`, `UPLOAD_MAX_SIZE_MB` | Каталог и лимит загрузки файлов | — |
| `CLIENT_WINDOW_MONTHS` | Окно «клиента» в месяцах (по умолчанию 6) | — |

Сгенерировать надёжный `JWT_SECRET`:
```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

---

## Тесты

```bash
cd backend
npm test
```

Запускает встроенный `node --test` (без внешних зависимостей). Покрытие:
- `tests/statusEngine.test.js` — алгоритм статусов компании + edge cases (несколько запросов разных статусов, client-окно, технические закрытия и т.д.);
- `tests/rbac.test.js` — права видимости и редактирования по ролям (manager/head/admin/ops), anti-IDOR;
- `tests/transitions.test.js` — таблица допустимых переходов статусов запроса.

Все 38 тестов должны проходить.

---

## API

База: `/api`. Аутентификация — JWT в HttpOnly cookie. Ошибки в формате `{ "error": "..." }`.

| Группа | Эндпоинты (основные) |
|--------|---------------------|
| Auth | `POST /auth/login`, `POST /auth/logout`, `GET /auth/me`, `POST /auth/change-password` |
| Справочники | `GET /lookup` (все enum для фронта), `GET/POST/PUT/DELETE /close-reasons` |
| Компании | `GET/POST /companies`, `GET/PUT /companies/:id`, `POST /companies/:id/reassign`, `GET /companies/:id/history` |
| Контакты | `GET/POST /contacts`, `PUT/DELETE /contacts/:id` |
| Запросы | `GET/POST /requests`, `GET/PUT /requests/:id`, `PATCH /requests/:id/status`, `POST /requests/:id/reopen`, `GET /requests/:id/history` |
| Вложения | `GET/POST /requests/:requestId/attachments`, `DELETE .../:attId` |
| Активности | `GET/POST /activities`, `PUT/PATCH/DELETE /activities/:id` |
| Задачи | `GET/POST /tasks`, `PUT/PATCH/DELETE /tasks/:id` |
| Планы | `GET /plans/my`, `GET /plans`, `GET /plans/progress`, `POST /plans`, `POST /plans/copy-month` |
| Дашборд | `GET /dashboard/funnel`, `GET /dashboard/staff` |
| Отчёты | `GET /reports/{summary,funnel,outcomes,team,activity,timeline,aging}` |
| AI-отчёты | `POST /ai-reports`, `POST /ai-reports/:id/analyze`, `GET /ai-reports/:id/status` |
| Уведомления | `GET /notifications`, `PATCH /notifications/:id/read`, push-подписка |
| Пользователи | `GET/POST/PUT /users`, `POST /users/:id/deactivate`, `GET/POST/PUT /teams`, `GET/POST/PUT/DELETE /departments` |
| Аудит | `GET /audit` |
| Настройки | `GET/POST /settings/ai`, `POST /settings/ai/test` |

Полное описание поведения каждого эндпоинта — в дизайн-документе (`crm_presales_design.md`, §18).

---

## Учётные записи демо

После `npm run seed` создаются (пароль у всех — `password123`):

| Email | Роль |
|-------|------|
| значение `ADMIN_EMAIL` из `.env` | Администратор |
| head@crmnadya.local | Руководитель |
| ivan@crmnadya.local | Менеджер |
| anna@crmnadya.local | Менеджер |

Плюс отдел «Коммерческий отдел», команда «Север», демо-компании с запросами в разных статусах и планы на текущий месяц.

---

## Обслуживание

**Нормализация «грязных» данных** (например, после импорта со старыми статусами):
```bash
cd backend
npm run normalize:db:dry     # показать что будет изменено
npm run normalize:db         # применить + пересчитать все статусы компаний
```

**Создание нового администратора** — через `db/migrate.js` (создаёт админа из `.env`, если его ещё нет) или через API `POST /api/users` под существующим админом.

**Бэкап БД:**
```bash
docker compose exec db pg_dump -U crmnadya crmnadya > backup_$(date +%F).sql
```

**Здоровье системы:** `GET /api/health` возвращает `{ ok: true }` при работающей БД.

---

## Лицензия и поддержка

Внутренний проект. Вопросы по архитектуре и бизнес-логике — см. сопроводительный дизайн-документ `crm_presales_design.md` (23 раздела, включая edge cases, матрицу прав и финальную ревизию).
