---
date: 2026-06-05
type: design
slug: hosted-mcp-deploy
related_projects: [consciousness-protocol-mcp]
tags: [deploy, docker, railway, mcp, streamable-http, security, infra]
status: draft
source_task: "Dockerfile + railway.toml + deploy-runbook для hosted MCP (#85)"
---

# Hosted MCP Deploy (Railway) — Design

## TL;DR

Сервер задеплоить на Railway реально: стек чистый (Node ESM → `dist/`, yarn, **ноль** native-зависимостей), HTTP-транспорт уже есть. Но «просто собрать Dockerfile» — это 20% задачи. Перед публичным деплоем обязательны **три кодовых правки-блокера**: (1) починка multi-session-краша (в `main` её нет — `src/index.ts` всё ещё держит один общий `McpServer` и зовёт `server.connect` на каждую сессию → краш на 2-й сессии, а hosted = много сессий по определению); (2) bearer-auth на `/mcp` (сейчас публичный URL = открытый доступ к кошельку: `pay_royalty`, `claim_revenue`, `register_work`); (3) отдельный `/healthz` для health-check. Артефакты деплоя (`Dockerfile`, `.dockerignore`, `docker/`, `railway.toml`, runbook) созданы и спроектированы вокруг single-instance + persistent volume + секреты-через-env. Multi-tenancy сознательно отложена (YAGNI), но точка её будущей вставки (per-session `buildServer`) совпадает с правкой-блокером №1 — поэтому фикс делается «правильно» бесплатно.

## Проблема и контекст

Нужно сделать `consciousness-protocol-mcp` доступным как **hosted** (удалённо вызываемый) MCP-сервер. Deliverables: `Dockerfile`, `railway.toml`, `deploy-runbook.md`.

**Что выяснено из кода (факты, не предположения):**

| Аспект | Факт | Источник |
|---|---|---|
| Сборка | Node ESM, TS→`dist/` через `tsc`. `yarn@1.22.22` жёстко (`packageManager`). Node ≥18. Entry `dist/index.js`. `dist/` в `.gitignore` → билдить в образе. | `package.json:30-55`, `.gitignore:2` |
| Транспорт | stdio (default) + Streamable HTTP (`--http` / `MCP_TRANSPORT=http`), порт `MCP_PORT` (def 3020), endpoint `/mcp`, не-`/mcp` → 404, логи в stderr. | `src/index.ts:314-387` |
| Состояние+секреты | Всё на локальной ФС `~/.consciousness-protocol/`: `config.json` (0600), `keys/` (0700: near.json, evm.json), `chain.json`+`chain.lock`, `registrations.json`. Путь от `homedir()`. | `src/config/store.ts:11-16,43-75` |
| Секреты | Приходят только через MCP-tool `setup` (пишет на диск). Нет env-bootstrap. NEAR pk / EVM pk / Pinata JWT управляют деньгами. | `src/tools/setup.ts` |
| **Auth** | **Нет.** `/mcp` открыт всему интернету. | `src/index.ts` (нет проверок заголовков) |
| **Multi-session** | **Краш.** Один module-level `McpServer` (стр. 24) + `server.connect(transport)` на каждую new-session (стр. 371). SDK бросает `Already connected` на 2-й сессии. `sessions.set` читает `transport.sessionId` до `handleRequest` → карта всегда пуста → каждый запрос = new-session. | `src/index.ts:24,352-377` |
| Native-деп | **Ноль.** `0` файлов `*.node`, `0` `binding.gyp`. Крипто на `@noble/*` (pure-JS). Alpine бы собрался. | `find node_modules` |
| Volem | `config.backend ?? 'volem'` → `http://localhost:3005`, которого в контейнере нет (10s timeout → fallback на local). | `src/tools/search.ts:212,234,82,242` |
| Chain lock | `openSync(..., 'wx')` (O_EXCL, атомарен на локальном ext4-volume). Busy-wait блокирует event loop. Stale-cleanup >30s. | `src/chain/hash-chain.ts:49-85` |

**Constraints (технические):**
- Railway: **volume несовместим с репликами** → `numReplicas=1`; **один volume на сервис**; volume монтируется **владельцем root**; **volume не конфигурируется в `railway.toml`** (только dashboard/CLI). *(Проверено по docs.railway.com/reference/volumes.)*
- Stateful-транспорт (сессии в памяти процесса) → горизонтальный скейл невозможен без внешнего session-store. Совпадает с volume-ограничением.
- Запрет ночной сессии: без коммитов/push, всё в working tree.

**Success criteria:**
1. `docker build` даёт небольшой безопасный образ, запускающий HTTP MCP.
2. `railway.toml`: build (Dockerfile), healthcheck, restart-policy, single-instance.
3. Runbook: пошаговый деплой, инъекция секретов, volume, smoke-test, rollback, security-caveats, **и явный pre-flight чеклист кодовых блокеров**.
4. Дан ответ на auth публичного endpoint.

## Голоса агентов

### Architect (long-term maintainability)
Главный вклад — поймал расхождение с условием задачи: в `main` **нет** `buildServer()`-фабрики, это module-level singleton (no isolation, не «single-tenant by design»). Отсюда вывод: деплой-артефакты — 20%, а 80% — два минимальных кодовых вмешательства (auth-gate + secrets-from-env), без которых hosted выкатывать нельзя. Рекомендация по секретам: **env→disk на старте** через переиспользование `setupAgent()` (а не ручной `setup`-tool на каждый redeploy и не сразу vault — это YAGNI, но точка должна быть pluggable). Auth — свойство **transport-слоя**, не tool-слоя: bearer-gate между HTTP-приёмом и `server.connect` — это ровно та точка, где завтра токен будет резолвиться в tenant-контекст; поэтому стоит сейчас обернуть регистрацию tools в `buildServer(config)` (механический перенос, низкий риск) — сегодня поведение не меняется, завтра подставляется per-tenant config без правки 15 хэндлеров. Огородить инвариантом `numReplicas=1`, бэкап `chain.json` через `export_chain` (content не хранится on-chain — потеря безвозвратна), graceful SIGTERM, отключить `install_skill` в http-режиме.

### Code Reviewer (pragmatism)
Минимальный путь — за вечер, **без рефактора singleton**. Снял главный страх: native-деп **нет** (проверено: `0` `*.node`, `0` `binding.gyp`, `@noble` pure-JS) → берём `node:22-slim` не из-за musl, а чтобы не играть в рулетку. Bootstrap секретов — shell-entrypoint, воспроизводящий форматы `saveConfig`/`saveKey` напрямую, идемпотентно (`[ ! -f ]`), без трогания `setup.ts`. Volem — не мокать, решать **конфигом** `backend: story|local` (fallback в `search.ts` и так есть). `chain.lock` на volume **работает** (ext4, не NFS) — не рефакторить. `homedir()` ↔ mount-point: `ENV HOME=/home/node` + volume на `/home/node/.consciousness-protocol`. Healthcheck: `/mcp` не годится (требует session) → +5 строк `/healthz`. Auth: +12 строк bearer в `main()`. Не трогать: `HASH_FIELDS` порядок, per-session connect-логику, config singleton, fallback в search. `tini` для PID1-сигналов.

> ⚠️ Прагматик исходил из того, что singleton **работает** для single-tenant. По факту (см. Architect + проверку) singleton в `main` — это **крашащаяся** версия. Поэтому его «не делай `buildServer`» неприменимо к HTTP-хостингу — см. «Точки расхождения».

### General Purpose (external perspective)
Web-research с источниками. Railway официально поддерживает remote MCP через `/mcp` (`type: "streamable-http"`), но stateful-сессии + volume → проектировать под **одну реплику** (не временно, а архитектурно). **Auth для денежного endpoint** (modelcontextprotocol.io/Authorization): формально OPTIONAL, но HTTP-транспорт SHOULD; индустриальный консенсус 2025-2026 — для personal/single-operator достаточно **статичного Bearer** (401 + `WWW-Authenticate`), полный OAuth 2.1 + RFC 9728 PRM + audience-валидация — для публичного multi-tenant. Не делать «полу-OAuth». `railway.toml`: `builder=DOCKERFILE`, `healthcheckPath`, `restartPolicyType`, `numReplicas`; **volumes в toml не выражаются** — только dashboard/CLI; Railway инжектит `PORT`, слушать `0.0.0.0`. Base image: **`node:22-slim`** (Snyk/iximiuz: alpine для Node — experimental, musl-риск для крипто); multi-stage, tini, non-root, `.dockerignore`. **Секреты — в env+память, не на volume** (snapshot/backup-утечка); не-секретное состояние — на volume; **volume монтируется root, non-root требует `RAILWAY_RUN_UID=0`**. Health: отдельный `/health` 200, не за auth.

## Точки согласия

Все три сошлись на:
1. **`node:22-slim`** (Debian), multi-stage (builder+runtime), `.dockerignore` обязателен, `tini` как PID1, процесс — non-root.
2. **Auth — блокер №1.** Статичный bearer-токен перед `/mcp`, 401 при несовпадении. OAuth 2.1 — будущее для multi-tenant.
3. **Отдельный `/healthz` (200, без auth)** как `healthcheckPath`. `/mcp` для health не годится.
4. **`numReplicas=1`** — навязано и in-memory сессиями, и volume-ограничением Railway.
5. **Volem `localhost:3005` обойти** — выставить `backend=story|local`, не `volem`.
6. **`yarn --frozen-lockfile`**, билд `dist` внутри образа, corepack/`yarn@1.22.22`.
7. **`PORT`→`MCP_PORT`** маппинг (Railway даёт `PORT`, код читает `MCP_PORT`), слушать `0.0.0.0` (уже так — `listen(PORT)` без хоста).
8. **Секреты — через env**, разложить на диск на старте; не передавать ключи через `setup`-tool по сети.

## Точки расхождения и их разрешение

**Р1. `buildServer()`-фабрика: делать или нет?**
Code Reviewer: нет, оставить singleton (простота single-tenant). Architect: да, как seam для multi-tenancy.
**Разрешено данными:** `main` `src/index.ts:24,371` — общий singleton + `server.connect` на каждую сессию = **живой multi-session-краш** (тот самый из ночи 2026-06-04, в `main` не смёржен; в leftover-worktree его тоже нет — проверено). HTTP-хостинг по определению порождает много сессий, а SDK **запрещает** повторный `connect` одного сервера. Значит per-session `buildServer()` — **не опция, а обязательное условие работоспособности HTTP**. Выбрали: **делать `buildServer()`** (правка-блокер P1). Бонусом это и есть та самая точка вставки multi-tenancy (Architect прав), но мотив — краш (домен Reviewer), а не будущее. Так конфликт снят: оба правы, решение одно.

**Р2. Ключи на volume или только в памяти из env?**
General Purpose: ключи в env+память, не на volume (риск snapshot-утечки). Architect/Reviewer: bootstrap env→disk (ключи ложатся на диск).
**Ограничение:** код читает ключи **с диска** (`loadKey`), держать их только в памяти = более крупный рефактор (`store.ts`, `near.ts`, `royalty.ts`...).
**Разрешено компромиссом по горизонту:** *сегодня* — bootstrap env→disk, ключи персистят на volume, это **осознанный долг** (задокументирован). *Hardening-follow-up* — вынести `keys/` на ephemeral-fs (перевыводятся из env каждый boot), а на volume оставить только `chain.json`/`registrations.json`. Выбрали прагматику Reviewer/Architect для запуска + явный долг по замечанию General Purpose.

**Р3. USER-стратегия при Railway volume.**
Reviewer: `USER node` + `HOME`. General Purpose: volume монтируется root → non-root требует `RAILWAY_RUN_UID=0` (т.е. фактически root).
**Разрешено третьим путём (gosu drop-privilege):** контейнер **стартует как root** (нет `USER` в финальном стейдже) → entrypoint под tini `chown`-ит примонтированный volume на `node` → `exec gosu node` для bootstrap и сервера. Итог: основной процесс **non-root** + volume **writable** + `RAILWAY_RUN_UID` **не нужен**. Лучше обоих исходных вариантов для money-сервера. Альтернатива (`RAILWAY_RUN_UID=0`) задокументирована как более простой, но менее безопасный путь.

**Р4. Релокация `CONFIG_DIR` (env-override) — править код или монтировать в homedir?**
General Purpose: вынести путь в env (не хардкодить `~`). Reviewer: монтировать в `/home/node/.consciousness-protocol`, без правок кода.
**Разрешено в пользу Reviewer (меньше обязательных правок):** `ENV HOME=/home/node` + `os.homedir()` (libuv `uv_os_homedir` берёт `$HOME` если задан) → и root-bootstrap, и node-сервер резолвят один путь; volume монтируется туда же. Кода не меняем. Env-override `CP_HOME` оставлен как **опциональная** hardening-правка (чистый `/data`-mount), не обязательная.

## Финальный дизайн

### Архитектура

```
                    Railway edge (TLS)
                          │  HTTPS, Authorization: Bearer <MCP_AUTH_TOKEN>
                          ▼
   ┌─────────────────────────────────────────────────────────┐
   │ Service (numReplicas=1)                                   │
   │                                                           │
   │  tini (PID1)                                              │
   │   └─ docker-entrypoint.sh  [root]                         │
   │        ├─ map PORT→MCP_PORT, MCP_TRANSPORT=http           │
   │        ├─ chown volume → node                             │
   │        ├─ gosu node  bootstrap.mjs  (env → config+keys)   │
   │        └─ exec gosu node  node dist/index.js --http       │
   │                                                           │
   │   HTTP server :$PORT                                      │
   │     GET  /healthz → 200 (no auth)      ← Railway probe    │
   │     */mcp → bearer gate → per-session buildServer()       │
   │                                                           │
   └───────────────┬───────────────────────────────────────────┘
                   │ mount: /home/node/.consciousness-protocol
                   ▼
            Persistent Volume (root-mounted, chowned→node)
              config.json · keys/ · chain.json · registrations.json
```

Внешние backing-services (runtime, HTTPS наружу): Story RPC, NEAR RPC, IPFS/Pinata, опц. Volem (выключен в контейнере по умолчанию).

### Компоненты (deliverables)

| Файл | Роль | Статус |
|---|---|---|
| `Dockerfile` | multi-stage (builder/deps/runtime), `node:22-bookworm-slim`, tini+gosu, non-root через gosu | **создан** |
| `.dockerignore` | защита от утечки host-`node_modules`/секретов в образ | **создан** |
| `docker/bootstrap.mjs` | env→`config.json`+`keys/*` через переиспользование `setupAgent()`; форсит `backend`; fail-loud | **создан** |
| `docker/docker-entrypoint.sh` | PORT-маппинг, chown volume, gosu drop, запуск bootstrap+server | **создан** |
| `railway.toml` | `builder=DOCKERFILE`, `healthcheckPath=/healthz`, `restartPolicyType=ON_FAILURE`, `numReplicas=1` | **создан** |
| `docs/deploy-runbook.md` | процедура деплоя + pre-flight блокеры + патчи + smoke/rollback | **создан** |

### Code prerequisites (НЕ применены — для утреннего ревью; точные патчи в runbook)

| # | Правка | Почему блокер | Размер |
|---|---|---|---|
| **P1** | `buildServer()` factory + per-session сервер + `onsessioninitialized` + try/catch вокруг listener | без неё HTTP крашится на 2-й сессии (Already connected) | средний (механический перенос) |
| **P2** | bearer-auth gate на `/mcp` (env `MCP_AUTH_TOKEN`, 401) | публичный кошелёк без auth | ~12 строк |
| **P3** | `GET /healthz` → 200 до auth | Railway healthcheck (`/mcp` требует session) | ~5 строк |
| P4 *(рекоменд.)* | не регистрировать `install_skill` при `MCP_TRANSPORT=http` | пишет в `~/.claude/skills`, исполняет скачанный код на машине с ключами | ~3 строки |
| P5 *(рекоменд.)* | `SIGTERM`-handler: закрыть httpServer + сессии | graceful shutdown при redeploy, не оставлять `chain.lock` | ~8 строк |
| P6 *(опц. hardening)* | `CP_HOME` env-override в `store.ts` | чистый `/data`-mount без homedir-гадания | 1 строка |

### Data flow (деплой)

1. `git push` / Railway build → Dockerfile: `yarn install --frozen-lockfile` → `yarn build` (`tsc`) → `dist/`; prod-deps отдельным стейджем.
2. Старт контейнера: tini→entrypoint(root): `MCP_PORT=$PORT`, `chown` volume→node, `gosu node bootstrap.mjs`.
3. `bootstrap.mjs`: если в env есть `CP_*_PRIVATE_KEY` → `setupAgent()` пишет `config.json`+`keys/*` (0600), затем форс `backend=story|local`. Иначе skip (volume-provisioned).
4. `exec gosu node node dist/index.js --http` → слушает `:$PORT`.
5. Railway probe `GET /healthz` → 200 → сервис healthy.
6. MCP-клиент: `https://<app>.railway.app/mcp`, `Authorization: Bearer <token>` → bearer-gate → per-session `buildServer()` → tools.

### Error handling

- **Bad/нет секрета:** `bootstrap.mjs` падает loud (exit 1) с перечнем недостающих env → контейнер не стартует, `restartPolicyMaxRetries=5` не зацикливает на misconfig (виден в логах).
- **Неавторизованный запрос:** 401 + `WWW-Authenticate: Bearer` (P2), кошелёк не тронут.
- **RPC флапает (Story/NEAR):** `/healthz` — **liveness**, не readiness (не дёргает RPC) → флап RPC не уронит контейнер в рестарт-петлю.
- **Volem недоступен:** `backend=local|story` → ветка `searchVolem` не вызывается; даже при `volem` — try/catch fallback на `listOwn`.
- **Redeploy (SIGTERM):** tini форвардит сигнал; с P5 — graceful close; без P5 — процесс завершается, `chain.lock` (если был) подберётся stale-cleanup ≤30s.
- **Потеря volume:** head-hash восстановим из NEAR-anchor, но `content` состояний — нет → RPO задаётся периодическим `export_chain` (runbook).

## План имплементации

1. **Этап 0 — артефакты (СДЕЛАНО):** `Dockerfile`, `.dockerignore`, `docker/bootstrap.mjs`, `docker/docker-entrypoint.sh`, `railway.toml`, runbook.
2. **Этап 1 — code prerequisites (утро, ревью Ивана):** применить P1–P3 (блокеры) + желательно P4–P5; `yarn build`; восстановить/написать `tests/http-transport.test.ts` (3 регресс-кейса из ночи 2026-06-04); `yarn test` зелёный; `gitnexus_impact` на `main` + HTTP-listener; `gitnexus_detect_changes`.
3. **Этап 2 — Railway provisioning:** проект/сервис из репо; создать Volume (dashboard/CLI), mount `/home/node/.consciousness-protocol`; задать env (секреты sealed): `MCP_AUTH_TOKEN`, `CP_AGENT_NAME`, `CP_NEAR_ACCOUNT`, `CP_NEAR_PRIVATE_KEY`, `CP_EVM_PRIVATE_KEY`, `CP_NETWORK`, `CP_BACKEND`, опц. `CP_PINATA_JWT`/`CP_STORY_API_KEY`/`CP_VOLEM_API_URL`.
4. **Этап 3 — deploy + smoke:** деплой; `GET /healthz`→200; MCP-handshake с bearer (init → notifications/initialized → tools/list, тот же `mcp-session-id`) → второй init → процесс жив (регресс на краш); неавторизованный → 401.
5. **Этап 4 — operate:** периодический `export_chain` бэкап; ротация `MCP_AUTH_TOKEN`; мониторинг логов.

## Review iterations

1 итерация (`feature-dev:code-reviewer`, opus, confidence-фильтр). Вердикт: артефакты технически добротны, **реальных блокеров build/deploy/runtime в самих файлах нет**. Reviewer подтвердил корректность по пунктам: multi-stage Dockerfile, corepack/yarn, tini+gosu + отсутствие `USER` (старт root для chown root-mounted volume), COPY-пути, билд `dist/` в стейдже (не с хоста), ESM `.js`-расширения; путь импорта `bootstrap.mjs` `../dist/...`; сигнатура `setupAgent`; backend-логика (обход `volem`→localhost); HOME-консистентность root↔node через gosu (libuv `uv_os_homedir` читает `$HOME`); `exec` для доставки SIGTERM; P1 реально чинит краш (`onsessioninitialized` подтверждён в SDK 1.27.1, `config` остаётся доступен tools как module-level closure); порядок `/healthz`→auth→`/mcp`; единый mount-path во всех файлах.

Принято и исправлено (2 правки):
- **I3** (факт, 100% по перепроверке): runbook smoke-критерий «список из 15 tools» неверен — фактически 18 (17 с P4). → заменено на «18 в полном наборе; 17 если применён P4».
- **C3** (defensive, costless): `$HOME` без default под `set -eu` в `docker-entrypoint.sh:14`. → `${HOME:-/home/node}`.

Отклонено/неприменимо: C1, C2, I2, I4 — сам reviewer снял как не-дефекты на текущем коде. I1 (`numReplicas` validity) — поле подтверждено как валидное в `[deploy]` config-as-code (web-research general-purpose); volume сам по себе навязывает single-instance, комментарий это отражает. Сходимость за 1 круг, лимит 3 не исчерпан.

## Связь с незакоммиченной работой прошлых ночей (ВАЖНО)

Сверка с `~/night-tasks.md` показала: **в `main` нет нескольких ночей готовой hardening-работы** — она была сделана «в working tree для утреннего ревью», но в `main` не попала (текущий `main` = коммит 22f9a4f, сырой). Проверено grep-ом по `main`:

| Готово (по night-log), но НЕ в `main` | Что это | Связь с деплоем |
|---|---|---|
| crash-fix (2026-06-04): `buildServer()` + `onsessioninitialized` + try/catch, **13/13 тестов** | P1 | **P1 уже написан** — задача ревью/merge, не «писать заново» |
| rate-limiting (2026-06-06): `src/rate-limit.ts` (`TokenBucketRateLimiter`), wiring в HTTP-ветке, env `MCP_RATE_LIMIT_{DISABLED,CAPACITY,REFILL_PER_SEC}`, `MCP_TRUST_PROXY`, **34/34 теста** | hosted hardening | прямо для публичного endpoint — включить в hosted-env |
| `drafts/2026-06-05-http-mode-env-reference.md` | env-ref для README | согласован с этим дизайном (per-session, MCP_*-конвенция) |
| research: streamable-http hosting, production MCP auth/ratelimit/multitenancy | контекст | основания этого дизайна |

**Вывод:** Этап 1 — это в первую очередь **восстановить и смёржить** накопленную работу (P1 + rate-limiting), а не реализовывать с нуля. Затем добавить недостающее (P2 auth, P3 healthz). Env-конвенция выровнена: `MCP_*` для server-knobs (`MCP_TRANSPORT/PORT/AUTH_TOKEN/RATE_LIMIT_*/TRUST_PROXY`), `VOLEM_API_URL` (bare) для backend; bootstrap-секреты — новый namespace `CP_*` (подтвердить именование).

## Open questions (для Ивана)

1. **Почему многократная ночная работа не доходит до `main`?** Crash-fix (2026-06-04, 13/13), rate-limiting (2026-06-06, 34/34), env-ref — всё помечено `[done]` в night-log, но отсутствует в `main` и в leftover-worktree (`.claude/worktrees/agent-a8027cc9b9d354d7c` — там тоже `src/index.ts:24` singleton). Это **системная проблема процесса**: «оставляю в working tree» → working tree сбрасывается между сессиями → работа теряется. Стоит решить (ветки/PR вместо working-tree), иначе деплой-prereqs придётся переписывать каждый раз.
2. **#85** не резолвится в `chiti-agent/consciousness-protocol-mcp` (нет такого issue). Внутренний трекер? Уточнить scope, если в issue были доп. требования.
3. **Single- vs multi-tenant сейчас?** Дизайн исходит из «один Railway-сервис = один агент/кошелёк». Если цель — публичный marketplace-хост с чужими кошельками, нужен отдельный трек (OAuth 2.1 + per-tenant config + реальная изоляция), это не «деплой».
4. **Mainnet или testnet** для первого hosted-инстанса? От этого зависит, насколько критичен auth и бэкап (mainnet = реальные деньги).
5. **Ключи на volume** — принять как стартовый долг или сразу делать P6 + ephemeral-keys hardening?
