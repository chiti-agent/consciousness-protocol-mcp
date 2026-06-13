# Deploy Runbook — Hosted MCP on Railway

Операционная процедура деплоя `consciousness-protocol-mcp` как удалённого (Streamable HTTP) MCP-сервера на Railway. Дизайн и обоснование решений: [`docs/plans/2026-06-05-hosted-mcp-deploy-design.md`](plans/2026-06-05-hosted-mcp-deploy-design.md).

---

## ✅ Pre-flight: code-блокеры закрыты в `main`

Все code prerequisites смёржены и покрыты тестами (`yarn test` → 102/102). Перед публичным деплоем осталось только подготовить секреты и сам Railway-сервис (разделы ниже). Детали реализации — в Приложении A.

- [x] **P1 — multi-session crash fix.** Per-session `buildServer()` + регистрация сессии в `onsessioninitialized` + try/catch вокруг listener. Регресс-тесты: `tests/http-transport.test.ts`.
- [x] **P2 — auth на `/mcp`.** Env `MCP_API_KEY`: каждый `/mcp`-запрос обязан предъявить ключ через `Authorization: Bearer <key>` **или** `X-API-Key: <key>`, сравнение constant-time. Пустой/незаданный ключ = auth выключен (локальный dev). Тесты: `tests/http-auth.test.ts`. **⚠️ Переменная называется `MCP_API_KEY`, не `MCP_AUTH_TOKEN` — при неверном имени auth молча выключится и кошелёк станет открытым.**
- [x] **P3 — health-проба.** `/health` (liveness, всегда 200, без auth/rate-limit/session) + `/ready` (200, либо 503 при draining). `railway.toml healthcheckPath=/health`. Тесты: `tests/health-ready.test.ts`.
- [x] **P4 — `install_skill` снят в http-режиме.** `buildServer({ allowInstallSkill:false })` на HTTP-пути (запись в host-ФС + трата host-кошелька недопустимы для remote-вызывателя). Тест: `tests/http-transport.test.ts` («install_skill is gated off»).
- [x] **P5 — SIGTERM graceful shutdown.** Дрейн сессий + `httpServer.close()`, таймаут `MCP_SHUTDOWN_TIMEOUT_MS`. Тесты: `tests/graceful-shutdown.test.ts`.
- [x] **Rate limiting** смёржен: per-IP token-bucket (`MCP_RATE_LIMIT_*`), `MCP_TRUST_PROXY=1` за edge-proxy. Тесты: `tests/rate-limit*.test.ts`.

> Перед коммитом правок в этот код: `yarn build` (рантайм из `dist/`), `yarn test`, `gitnexus_detect_changes`.

---

## 0. Предусловия

- Аккаунт Railway (Hobby или Pro — volume 5GB/50GB; состояние крошечное, хватит Hobby).
- `railway` CLI (`npm i -g @railway/cli`) **или** доступ к dashboard.
- Готовые секреты: NEAR account + private key, EVM private key (оба **фундированы** на нужной сети), опц. Pinata JWT, опц. Story API key.
- Сгенерированный `MCP_API_KEY` (длинный случайный, напр. `openssl rand -hex 32` — генерировать **вне** этой сессии).

## 1. Артефакты в репозитории (уже созданы)

```
Dockerfile                      # multi-stage, node:22-slim, tini+gosu, non-root
.dockerignore
docker/bootstrap.mjs            # env -> config.json + keys/* (reuse setupAgent)
docker/docker-entrypoint.sh     # PORT map, chown volume, gosu drop, bootstrap+start
railway.toml                    # DOCKERFILE builder, /health, ON_FAILURE, numReplicas=1
```

## 2. Локальная проверка образа-режима (prerequisites уже в `main`)

`yarn build` (рантайм идёт из `dist/`) → `yarn test` (102/102). Дымовая проверка HTTP-режима локально:

```bash
MCP_TRANSPORT=http MCP_PORT=3020 MCP_API_KEY=test-token node dist/index.js --http
# в другом терминале:
#   GET /health без ключа              -> 200 {"status":"ok"}
#   POST /mcp без ключа                -> 401
#   POST /mcp с Bearer test-token, два init подряд -> процесс жив (регресс P1)
```
*(Проверки слать `node`-скриптом через `node:http`, не curl/python — см. `tests/http-transport.test.ts`.)*

## 3. Railway: проект и сервис

```bash
railway login
railway init                      # или link к существующему проекту
railway up                        # сборка по Dockerfile (builder=DOCKERFILE из railway.toml)
```
Либо через dashboard: New Project → Deploy from GitHub repo `chiti-agent/consciousness-protocol-mcp`.

## 4. Persistent state (Volume)

Volume **нельзя** задать в `railway.toml` (схема config-as-code этого не поддерживает). Создать через CLI/dashboard:

- Dashboard: Service → Settings → Volumes → New Volume.
- **Mount path: `/home/node/.consciousness-protocol`** — должен точно совпасть с `os.homedir()/.consciousness-protocol` в контейнере (`HOME=/home/node` задан в образе). Несовпадение = состояние не персистит.
- Ограничения Railway: **1 volume на сервис**, **volume несовместим с репликами** (поэтому `numReplicas=1`). Volume монтируется владельцем root — entrypoint сам `chown`-ит его на `node` через gosu, `RAILWAY_RUN_UID` задавать **не нужно**.

## 5. Переменные окружения (Service → Variables)

Секреты пометить sealed. `PORT` Railway инжектит сам.

| Variable | Обяз. | Пример / значение | Назначение |
|---|---|---|---|
| `MCP_TRANSPORT` | — | `http` (уже в образе) | режим транспорта |
| `MCP_API_KEY` | **да** 🔐 | `<openssl rand -hex 32>` | bearer-gate на `/mcp` (P2) |
| `CP_AGENT_NAME` | **да** | `chiti` (lowercase, `[a-z0-9_-]`) | имя агента |
| `CP_NETWORK` | да | `testnet` \| `mainnet` | сеть NEAR/Story |
| `CP_NEAR_ACCOUNT` | **да** | `chiti.testnet` | NEAR account id |
| `CP_NEAR_PRIVATE_KEY` | **да** 🔐 | `ed25519:...` | подпись NEAR-транзакций |
| `CP_EVM_PRIVATE_KEY` | **да** 🔐 | `0x...` | подпись Story-транзакций |
| `CP_BACKEND` | реком. | `story` \| `local` (НЕ `volem`) | бэкенд search; `volem`=localhost:3005 недоступен |
| `CP_PINATA_JWT` | опц. 🔐 | `eyJ...` | IPFS-загрузки (иначе free gateway) |
| `CP_STORY_API_KEY` | опц. 🔐 | `...` | если `CP_BACKEND=story` |
| `CP_VOLEM_API_URL` | опц. | `https://...` | только если реально есть hosted Volem |
| `MCP_RATE_LIMIT_CAPACITY` | опц. | `120` | per-IP token-bucket cap |
| `MCP_RATE_LIMIT_REFILL_PER_SEC` | опц. | `2` | refill rate |
| `MCP_RATE_LIMIT_DISABLED` | опц. | — | выключить rate-limit |
| `MCP_TRUST_PROXY` | реком.¹ | `1` | доверять X-Forwarded-For (Railway за edge-proxy); берётся rightmost hop |
| `MCP_SHUTDOWN_TIMEOUT_MS` | опц. | `10000` | дедлайн graceful shutdown (P5) |

¹ Rate-limiting в `main` (`src/rate-limit.ts`, тесты `tests/rate-limit*.test.ts`). На Railway задать `MCP_TRUST_PROXY=1` — сервис за edge-proxy, иначе все клиенты схлопнутся в один IP и token-bucket будет общим на всех.

> Смена секрета: `bootstrap.mjs` перечитывает env и **перезаписывает** `config.json`+`keys/*` на каждом boot (env — источник истины). Достаточно поменять Variable и сделать redeploy. `chain.json`/`registrations.json` на volume не трогаются.

## 6. Deploy + smoke-test

```bash
railway up           # или auto-deploy по git push
railway logs         # ждём "[bootstrap] Provisioned ..." и "MCP server listening ..."
railway domain       # получить публичный https://<app>.railway.app
```

Smoke (через MCP-клиент или `node:http`-скрипт):
1. `GET https://<app>/health` (без токена) → **200** `{"status":"ok"}`.
2. `POST https://<app>/mcp` **без** `Authorization` → **401**.
3. MCP-handshake с `Authorization: Bearer <MCP_API_KEY>` (или `X-API-Key: <MCP_API_KEY>`): `initialize` → `notifications/initialized` → `tools/list` (тот же `mcp-session-id`) → **200**, **17 tools** в http-режиме (`install_skill` снят по P4; локально в stdio их 18).
4. Второй `initialize` (новая сессия) → процесс **жив** (P1-регресс; до фикса тут был exit 1).
5. Подключить клиента (Claude Code): `claude mcp add cp-hosted --transport http https://<app>/mcp --header "Authorization: Bearer <token>"`.

## 7. Rollback

- Railway: Deployments → выбрать предыдущий healthy → **Redeploy/Rollback**. Volume переживает rollback (состояние сохраняется).
- При misconfig секрета: `bootstrap.mjs` падает loud (exit 1, лог `[bootstrap] FATAL: missing required env vars: ...`); `restartPolicyMaxRetries=5` не даёт зациклиться — поправить Variable → redeploy.
- Полный откат фичи: убрать сервис/домен; ключи на volume — **удалить volume** (иначе ключи переживут удаление сервиса в snapshot/grace-период).

## 8. Эксплуатация

- **Бэкап hash chain (RPO):** периодически `export_chain` (он сериализует `content`, которого нет on-chain — потеря volume без бэкапа = безвозвратная потеря контента состояний). Сохранять дамп вне Railway.
- **Ротация `MCP_API_KEY`:** новый токен в Variables → redeploy → обновить клиентов. Старый токен мгновенно инвалидируется.
- **Мониторинг:** healthcheck Railway (`/health`); следить за логами `register_work`/`pay_royalty`/`claim_revenue` (деньги).
- **Инвариант:** сервис **single-instance**. Не включать реплики до выноса state + session-store наружу.

---

## Приложение A — Code prerequisites (✅ реализовано в `main`, справка)

Историческая справка по тому, как устроены P1–P5 в коде. Все правки — в `src/index.ts` (рантайм из `dist/`, поэтому после любой правки `yarn build`). Фактическая реализация местами отличается от первоначальных набросков ниже — расхождения отмечены **РЕАЛИЗАЦИЯ:**.

### P1 — multi-session crash fix (БЛОКЕР)

**Проблема:** `src/index.ts:24` создаёт один `McpServer`; `src/index.ts:371` зовёт `server.connect(transport)` на каждую new-session → SDK бросает `Already connected to a transport` на 2-й сессии. Плюс `sessions.set` читает `transport.sessionId` до `handleRequest` (он ещё `undefined`) → карта всегда пуста → каждый запрос идёт в new-session ветку.

**Фикс** (соответствует дизайну ночного отчёта 2026-06-04, который не попал в `main`):

1. Обернуть создание сервера и **все** `server.tool(...)` (стр. 24–310) в фабрику. `config` оставить module-level `let` (общий, переприсваивается в `setup`):

```ts
function buildServer(): McpServer {
  const server = new McpServer({ name: 'consciousness-protocol', version: '0.1.0' });
  // ... ВСЕ существующие server.tool(...) переносятся сюда без изменений ...
  return server;
}
```

2. stdio-ветка — строить и подключать один раз:

```ts
const transport = new StdioServerTransport();
await buildServer().connect(transport);
```

3. http new-session ветка (заменить стр. ~360–377) — per-session сервер + регистрация сессии в SDK-колбэке `onsessioninitialized` (срабатывает ровно когда `sessionId` присвоен):

```ts
const transport = new StreamableHTTPServerTransport({
  sessionIdGenerator: () => randomUUID(),
  onsessioninitialized: (sid) => { sessions.set(sid, transport); },
});
transport.onclose = () => {
  if (transport.sessionId) sessions.delete(transport.sessionId);
};
const server = buildServer();          // <-- свежий сервер на сессию (НЕ общий singleton)
await server.connect(transport);
await transport.handleRequest(req, res);
// удалить старый блок `if (transport.sessionId) sessions.set(...)`
```

4. Обернуть тело listener в try/catch (defense-in-depth — любой будущий throw → 500, не падение процесса):

```ts
const httpServer = createServer(async (req, res) => {
  try {
    /* ... весь существующий код обработчика ... */
  } catch (err) {
    console.error('request error:', err);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null }));
    } else if (!res.writableEnded) {
      res.end();
    }
  }
});
```

**Тест:** восстановить/написать `tests/http-transport.test.ts` (3 кейса: два init подряд → процесс жив; malformed JSON → 4xx, жив; reuse `mcp-session-id` → 200). Проверить fail-before/pass-after через `git stash`.

### P2 — bearer auth (БЛОКЕР)

Внутри listener, **после** ветки `/health` (P3), **до** разбора `/mcp`:

```ts
const AUTH = process.env.MCP_API_KEY;
if (AUTH) {
  if (req.headers['authorization'] !== `Bearer ${AUTH}`) {
    res.writeHead(401, { 'Content-Type': 'application/json', 'WWW-Authenticate': 'Bearer' });
    res.end(JSON.stringify({ error: 'Unauthorized' }));
    return;
  }
}
```
`MCP_API_KEY` не задан → gate выключен (локальный dev/stdio не ломается). На Railway задать обязательно.

**РЕАЛИЗАЦИЯ:** env `MCP_API_KEY`. Ключ принимается в двух формах — `Authorization: Bearer <key>` **и** `X-API-Key: <key>` (`extractKey`). Сравнение **constant-time** (`crypto.timingSafeEqual` с предварительной сверкой длины), не наивное `!==`. Проверка идёт **после** rate-limit и **после** health-проб, **до** разбора `/mcp`.

### P3 — /health (БЛОКЕР)

Внутри listener, **первой веткой** (до auth — Railway probe ходит без токена), после вычисления `url`:

```ts
if (url.pathname === '/health') {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ status: 'ok' }));
  return;
}
```
Liveness, не readiness — намеренно **не** дёргает Story/NEAR RPC, чтобы флап RPC не ронял контейнер в рестарт-петлю.

**РЕАЛИЗАЦИЯ:** две пробы в одной ветке. `/health` — liveness, всегда `200 {"status":"ok"}`. `/ready` — readiness, `200 {"status":"ready"}` нормально и `503 {"status":"shutting_down"}` во время graceful-дрейна (P5). Обе только `GET`/`HEAD` (иначе `405` с `Allow: GET, HEAD`), без auth/rate-limit/session. Railway `healthcheckPath=/health`.

### P4 — отключить install_skill в http

`install_skill` пишет в `~/.claude/skills` и может авто-минтить лицензию с host-кошелька — на hosted-машине это бессмысленно (ставит на сервер, не клиенту) и опасно. В `buildServer()` обернуть его регистрацию:

```ts
if (process.env.MCP_TRANSPORT !== 'http') {
  server.tool('install_skill', /* ... */);
}
```

**РЕАЛИЗАЦИЯ:** через параметр `buildServer({ allowInstallSkill })`, не через чтение env внутри. HTTP-путь зовёт `buildServer({ allowInstallSkill: false })`, stdio — `{ allowInstallSkill: true }`. Так гейт работает и для флага `--http` (не только `MCP_TRANSPORT=http`), и call-site явно декларирует решение. Регресс-тест: `tests/http-transport.test.ts` → «install_skill is gated off».

### P5 — SIGTERM graceful shutdown (рекомендуется)

Railway шлёт SIGTERM при redeploy. Добавить после `httpServer.listen(...)` в http-ветке:

```ts
process.on('SIGTERM', () => {
  for (const t of sessions.values()) { t.close().catch(() => {}); }
  httpServer.close(() => process.exit(0));
});
```

### P6 — CP_HOME override (опц. hardening)

Чтобы монтировать volume в чистый `/data` вместо homedir, в `src/config/store.ts:11`:

```ts
export const CONFIG_DIR = process.env.CP_HOME ?? join(homedir(), '.consciousness-protocol');
```
Тогда env `CP_HOME=/data`, volume mount `/data`. Все производные пути (`CONFIG_FILE`, `KEYS_DIR`, ...) уже выводятся из `CONFIG_DIR` — править больше ничего не нужно.
