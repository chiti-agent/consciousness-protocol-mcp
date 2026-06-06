# Deploy Runbook — Hosted MCP on Railway

Операционная процедура деплоя `consciousness-protocol-mcp` как удалённого (Streamable HTTP) MCP-сервера на Railway. Дизайн и обоснование решений: [`docs/plans/2026-06-05-hosted-mcp-deploy-design.md`](plans/2026-06-05-hosted-mcp-deploy-design.md).

---

## ⛔ Pre-flight: НЕ ДЕПЛОИТЬ, пока не сделано

Сервер в текущем `main` **нельзя** выставлять публично как есть. Три блокера (детали и патчи — в Приложении A):

- [ ] **P1 — multi-session crash fix.** `main` держит один общий `McpServer` и зовёт `server.connect()` на каждую HTTP-сессию → краш на 2-й сессии (`Already connected`). Hosted = много сессий. **Без P1 сервер падает почти сразу.**
- [ ] **P2 — bearer auth на `/mcp`.** Сейчас публичный URL = открытый доступ к кошельку (`pay_royalty`, `claim_revenue`, `register_work`). **Без P2 любой может потратить ваши деньги.**
- [ ] **P3 — `/healthz`.** `railway.toml` указывает `healthcheckPath=/healthz`; эндпоинта в коде нет → health-check (и деплой) провалятся.
- [ ] *(рекомендуется)* **P4** — отключить `install_skill` в http-режиме; **P5** — SIGTERM graceful shutdown.
- [ ] После правок: `yarn build`, `yarn test` зелёный (включая HTTP-регресс-тесты), `gitnexus_impact`/`gitnexus_detect_changes`.

> 💡 **P1 (и rate-limiting) скорее всего уже написаны.** Night-log фиксирует crash-fix (2026-06-04, 13/13 тестов) и rate-limiting (2026-06-06, 34/34) как `[done]`, но в `main` их нет (работа осталась в несохранённом working tree). Перед тем как писать P1 заново — поискать/восстановить ту работу. См. design-doc, раздел «Связь с незакоммиченной работой».

---

## 0. Предусловия

- Аккаунт Railway (Hobby или Pro — volume 5GB/50GB; состояние крошечное, хватит Hobby).
- `railway` CLI (`npm i -g @railway/cli`) **или** доступ к dashboard.
- Готовые секреты: NEAR account + private key, EVM private key (оба **фундированы** на нужной сети), опц. Pinata JWT, опц. Story API key.
- Сгенерированный `MCP_AUTH_TOKEN` (длинный случайный, напр. `openssl rand -hex 32` — генерировать **вне** этой сессии).

## 1. Артефакты в репозитории (уже созданы)

```
Dockerfile                      # multi-stage, node:22-slim, tini+gosu, non-root
.dockerignore
docker/bootstrap.mjs            # env -> config.json + keys/* (reuse setupAgent)
docker/docker-entrypoint.sh     # PORT map, chown volume, gosu drop, bootstrap+start
railway.toml                    # DOCKERFILE builder, /healthz, ON_FAILURE, numReplicas=1
```

## 2. Применить code prerequisites (P1–P3, см. Приложение A)

Применить патчи → `yarn build` (обязательно по `CLAUDE.md`: рантайм идёт из `dist/`) → `yarn test`. Локальная проверка HTTP-режима:

```bash
MCP_TRANSPORT=http MCP_PORT=3020 MCP_AUTH_TOKEN=test-token node dist/index.js --http
# в другом терминале:
#   GET /healthz без токена -> 200
#   POST /mcp без токена    -> 401
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
| `MCP_AUTH_TOKEN` | **да** 🔐 | `<openssl rand -hex 32>` | bearer-gate на `/mcp` (P2) |
| `CP_AGENT_NAME` | **да** | `chiti` (lowercase, `[a-z0-9_-]`) | имя агента |
| `CP_NETWORK` | да | `testnet` \| `mainnet` | сеть NEAR/Story |
| `CP_NEAR_ACCOUNT` | **да** | `chiti.testnet` | NEAR account id |
| `CP_NEAR_PRIVATE_KEY` | **да** 🔐 | `ed25519:...` | подпись NEAR-транзакций |
| `CP_EVM_PRIVATE_KEY` | **да** 🔐 | `0x...` | подпись Story-транзакций |
| `CP_BACKEND` | реком. | `story` \| `local` (НЕ `volem`) | бэкенд search; `volem`=localhost:3005 недоступен |
| `CP_PINATA_JWT` | опц. 🔐 | `eyJ...` | IPFS-загрузки (иначе free gateway) |
| `CP_STORY_API_KEY` | опц. 🔐 | `...` | если `CP_BACKEND=story` |
| `CP_VOLEM_API_URL` | опц. | `https://...` | только если реально есть hosted Volem |
| `MCP_RATE_LIMIT_CAPACITY` | опц.¹ | `120` | per-IP token-bucket cap (если смёржен rate-limiting) |
| `MCP_RATE_LIMIT_REFILL_PER_SEC` | опц.¹ | `2` | refill rate |
| `MCP_RATE_LIMIT_DISABLED` | опц.¹ | — | выключить rate-limit |
| `MCP_TRUST_PROXY` | опц.¹ | `1` | доверять X-Forwarded-For (Railway за edge-proxy); берётся rightmost hop |

¹ Из rate-limiting-работы (night-log 2026-06-06, `src/rate-limit.ts`, 34/34 теста) — **готова, но не в `main`**. Для публичного hosted endpoint рекомендуется смёржить вместе с P1. `MCP_TRUST_PROXY=1` на Railway корректен (сервис за edge-proxy), иначе все клиенты схлопнутся в один IP.

> Смена секрета: `bootstrap.mjs` перечитывает env и **перезаписывает** `config.json`+`keys/*` на каждом boot (env — источник истины). Достаточно поменять Variable и сделать redeploy. `chain.json`/`registrations.json` на volume не трогаются.

## 6. Deploy + smoke-test

```bash
railway up           # или auto-deploy по git push
railway logs         # ждём "[bootstrap] Provisioned ..." и "MCP server listening ..."
railway domain       # получить публичный https://<app>.railway.app
```

Smoke (через MCP-клиент или `node:http`-скрипт):
1. `GET https://<app>/healthz` (без токена) → **200** `{"status":"ok"}`.
2. `POST https://<app>/mcp` **без** `Authorization` → **401**.
3. MCP-handshake с `Authorization: Bearer <MCP_AUTH_TOKEN>`: `initialize` → `notifications/initialized` → `tools/list` (тот же `mcp-session-id`) → **200**, непустой список tools (18 в полном наборе; 17 если применён P4 — `install_skill` снят в http-режиме).
4. Второй `initialize` (новая сессия) → процесс **жив** (P1-регресс; до фикса тут был exit 1).
5. Подключить клиента (Claude Code): `claude mcp add cp-hosted --transport http https://<app>/mcp --header "Authorization: Bearer <token>"`.

## 7. Rollback

- Railway: Deployments → выбрать предыдущий healthy → **Redeploy/Rollback**. Volume переживает rollback (состояние сохраняется).
- При misconfig секрета: `bootstrap.mjs` падает loud (exit 1, лог `[bootstrap] FATAL: missing required env vars: ...`); `restartPolicyMaxRetries=5` не даёт зациклиться — поправить Variable → redeploy.
- Полный откат фичи: убрать сервис/домен; ключи на volume — **удалить volume** (иначе ключи переживут удаление сервиса в snapshot/grace-период).

## 8. Эксплуатация

- **Бэкап hash chain (RPO):** периодически `export_chain` (он сериализует `content`, которого нет on-chain — потеря volume без бэкапа = безвозвратная потеря контента состояний). Сохранять дамп вне Railway.
- **Ротация `MCP_AUTH_TOKEN`:** новый токен в Variables → redeploy → обновить клиентов. Старый токен мгновенно инвалидируется.
- **Мониторинг:** healthcheck Railway (`/healthz`); следить за логами `register_work`/`pay_royalty`/`claim_revenue` (деньги).
- **Инвариант:** сервис **single-instance**. Не включать реплики до выноса state + session-store наружу.

---

## Приложение A — Code prerequisite патчи

Все правки — в `src/index.ts`, затем `yarn build`. Перед правкой: `gitnexus_impact({target:"main", direction:"upstream", repo:"consciousness-protocol-mcp"})`.

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

Внутри listener, **после** ветки `/healthz` (P3), **до** разбора `/mcp`:

```ts
const AUTH = process.env.MCP_AUTH_TOKEN;
if (AUTH) {
  if (req.headers['authorization'] !== `Bearer ${AUTH}`) {
    res.writeHead(401, { 'Content-Type': 'application/json', 'WWW-Authenticate': 'Bearer' });
    res.end(JSON.stringify({ error: 'Unauthorized' }));
    return;
  }
}
```
`MCP_AUTH_TOKEN` не задан → gate выключен (локальный dev/stdio не ломается). На Railway задать обязательно.

### P3 — /healthz (БЛОКЕР)

Внутри listener, **первой веткой** (до auth — Railway probe ходит без токена), после вычисления `url`:

```ts
if (url.pathname === '/healthz') {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ status: 'ok' }));
  return;
}
```
Liveness, не readiness — намеренно **не** дёргает Story/NEAR RPC, чтобы флап RPC не ронял контейнер в рестарт-петлю.

### P4 — отключить install_skill в http (рекомендуется)

`install_skill` пишет в `~/.claude/skills` и исполняет скачанный код — на hosted-машине с ключами это бессмысленно и опасно. В `buildServer()` обернуть его регистрацию:

```ts
if (process.env.MCP_TRANSPORT !== 'http') {
  server.tool('install_skill', /* ... */);
}
```

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
