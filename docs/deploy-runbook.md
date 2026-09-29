# Deploy Runbook — Hosted MCP on Railway

Операционная процедура деплоя `consciousness-protocol-mcp` как удалённого (Streamable HTTP) MCP-сервера на Railway. Дизайн и обоснование решений: [`docs/plans/2026-06-05-hosted-mcp-deploy-design.md`](plans/2026-06-05-hosted-mcp-deploy-design.md).

> **STATUS 2026-09-02:** the custody and tool-surface sections of the June design are superseded by
> [`2026-09-01-p6-client-signer-and-agent-tools.md`](plans/2026-09-01-p6-client-signer-and-agent-tools.md).
> Hosted HTTP is an exact eight-tool read service and holds no wallet key. Signing and broadcasting
> belong only to a self-installed stdio client.

---

## ✅ Pre-flight: code-блокеры закрыты в `main`

Все code prerequisites смёржены и покрыты тестами. Перед публичным деплоем нужно выполнить keyless-cutover ниже; старый wallet-hosted порядок больше недопустим.

- [x] **P1 — multi-session crash fix.** Per-session `buildServer()` + регистрация сессии в `onsessioninitialized` + try/catch вокруг listener. Регресс-тесты: `tests/http-transport.test.ts`.
- [x] **P2 — auth на `/mcp`.** Env `MCP_API_KEY`: каждый `/mcp`-запрос обязан предъявить ключ через `Authorization: Bearer <key>` **или** `X-API-Key: <key>`, сравнение constant-time. Пустой/незаданный ключ = auth выключен (локальный dev). Тесты: `tests/http-auth.test.ts`. **⚠️ Переменная называется `MCP_API_KEY`, не `MCP_AUTH_TOKEN` — при неверном имени auth молча выключится и кошелёк станет открытым.**
- [x] **P3 — health-проба.** `/health` (liveness, всегда 200, без auth/rate-limit/session) + `/ready` (200, либо 503 при draining). `railway.toml healthcheckPath=/health`. Тесты: `tests/health-ready.test.ts`.
- [x] **P4/S7 — exact hosted boundary.** HTTP registers only `search_works`, `get_asset`, `get_agent`, `get_revenue`, `get_revenue_all`, `verify_provenance`, `list_threads`, and `get_thread`. Startup refuses every persisted `keys/*.json` wallet file. The exact set and refusal are asserted in `tests/http-transport.test.ts`.
- [x] **P5 — SIGTERM graceful shutdown.** Дрейн сессий + `httpServer.close()`, таймаут `MCP_SHUTDOWN_TIMEOUT_MS`. Тесты: `tests/graceful-shutdown.test.ts`.
- [x] **Rate limiting** смёржен: per-IP token-bucket (`MCP_RATE_LIMIT_*`), `MCP_TRUST_PROXY=1` за edge-proxy. Тесты: `tests/rate-limit*.test.ts`.

> Перед коммитом правок в этот код: `yarn build` (рантайм из `dist/`), `yarn test`, `gitnexus_detect_changes`.

---

## 0. Предусловия

- Аккаунт Railway (Hobby или Pro — volume 5GB/50GB; состояние крошечное, хватит Hobby).
- `railway` CLI (`npm i -g @railway/cli`) **или** доступ к dashboard.
- Public read configuration: a NEAR account ID and an EVM address. Private wallet keys must live on the self-installed client, never in Railway variables or its volume.
- Сгенерированный `MCP_API_KEY` (длинный случайный, напр. `openssl rand -hex 32` — генерировать **вне** этой сессии).

## 1. Артефакты в репозитории (уже созданы)

```
Dockerfile                      # multi-stage, node:22-slim, tini+gosu, non-root
.dockerignore
docker/bootstrap.mjs            # public env -> keyless config.json
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
- The mounted volume must contain no `keys/*.json`. HTTP startup checks the real directory and exits before binding a port if even one persisted wallet-key file remains.

## 5. Переменные окружения (Service → Variables)

Секреты пометить sealed. `PORT` Railway инжектит сам.

| Variable | Обяз. | Пример / значение | Назначение |
|---|---|---|---|
| `MCP_TRANSPORT` | — | `http` (уже в образе) | режим транспорта |
| `MCP_API_KEY` | **да** 🔐 | `<openssl rand -hex 32>` | bearer-gate на `/mcp` (P2) |
| `CP_NETWORK` | да | `testnet` \| `mainnet` | сеть NEAR/Story |
| `CP_NEAR_ACCOUNT` | **да** | `chiti.testnet` | NEAR account id |
| `CP_EVM_ADDRESS` | **да** | `0x...` | public address used by read-only portfolio queries |
| `CP_NEAR_PRIVATE_KEY` | **must be absent** | — | forbidden on hosted HTTP; keep it on the local stdio client |
| `CP_EVM_PRIVATE_KEY` | **must be absent** | — | forbidden on hosted HTTP; keep it on the local stdio client |
| `CP_BACKEND` | реком. | `story` \| `local` \| `volem` | search backend; use `volem` only with a reachable `CP_VOLEM_API_URL` |
| `CP_STORY_API_KEY` | опц. 🔐 | `...` | если `CP_BACKEND=story` |
| `CP_VOLEM_API_URL` | опц. | `https://...` | только если реально есть hosted Volem |
| `MCP_RATE_LIMIT_CAPACITY` | опц. | `120` | per-IP token-bucket cap |
| `MCP_RATE_LIMIT_REFILL_PER_SEC` | опц. | `2` | refill rate |
| `MCP_RATE_LIMIT_DISABLED` | опц. | — | выключить rate-limit |
| `MCP_TRUST_PROXY` | реком.¹ | `1` | доверять X-Forwarded-For (Railway за edge-proxy); берётся rightmost hop |
| `MCP_SHUTDOWN_TIMEOUT_MS` | опц. | `10000` | дедлайн graceful shutdown (P5) |

¹ Rate-limiting в `main` (`src/rate-limit.ts`, тесты `tests/rate-limit*.test.ts`). На Railway задать `MCP_TRUST_PROXY=1` — сервис за edge-proxy, иначе все клиенты схлопнутся в один IP и token-bucket будет общим на всех.

> `bootstrap.mjs` rewrites only public `config.json`; it neither reads nor writes wallet secrets.
> `chain.json` and `registrations.json` remain untouched.

### Keyless cutover from an older hosted-writer deployment

1. Stop sending write requests and copy any wallet keys that must be retained into the intended local
   self-custody client. Verify that local client before removing the hosted copies.
2. Set `CP_EVM_ADDRESS` to the public address that read-only revenue queries should inspect. Remove
   `CP_NEAR_PRIVATE_KEY`, `CP_EVM_PRIVATE_KEY`, and obsolete upload-only secrets from Railway.
3. Remove every `keys/*.json` file from the mounted volume. This deletion is intentional and is not
   recoverable from the service; retain an offline/local copy first if the wallet is still needed.
4. Deploy this release. Railway keeps the old healthy deployment serving reads during the new health
   gate; the new process will fail closed rather than start with a stale persisted key.
5. Complete the exact `tools/list` assertion below before routing clients to the new deployment.

## 6. Deploy + smoke-test

```bash
railway up           # или auto-deploy по git push
railway logs         # wait for "Provisioned keyless hosted config" and "MCP server listening"
railway domain       # получить публичный https://<app>.railway.app
```

Smoke (через MCP-клиент или `node:http`-скрипт):
1. `GET https://<app>/health` (без токена) → **200** `{"status":"ok"}`.
2. `POST https://<app>/mcp` **без** `Authorization` → **401**.
3. MCP-handshake with `Authorization: Bearer <MCP_API_KEY>` (or `X-API-Key`): `initialize` → `notifications/initialized` → `tools/list` on the same session. Assert the exact sorted names: `get_agent`, `get_asset`, `get_revenue`, `get_revenue_all`, `get_thread`, `list_threads`, `search_works`, `verify_provenance`. Any ninth tool blocks release, and any tool named `offer_*` is a defect.
4. Второй `initialize` (новая сессия) → процесс **жив** (P1-регресс; до фикса тут был exit 1).
5. Подключить клиента (Claude Code): `claude mcp add cp-hosted --transport http https://<app>/mcp --header "Authorization: Bearer <token>"`.

## 7. Rollback

- Railway: Deployments → выбрать предыдущий healthy → **Redeploy/Rollback**. Volume переживает rollback (состояние сохраняется).
- On public-config misconfiguration, `bootstrap.mjs` exits 1 with a `FATAL` message. On a stale key file, `src/index.ts` exits 1 before listening. Correct the variables or volume, then redeploy.
- A rollback must not restore the wallet-hosted release or reintroduce key files. If write capability is required, run the stdio client on the key owner's machine instead.

## 8. Эксплуатация

- **Бэкап hash chain (RPO):** периодически `export_chain` (он сериализует `content`, которого нет on-chain — потеря volume без бэкапа = безвозвратная потеря контента состояний). Сохранять дамп вне Railway.
- **Ротация `MCP_API_KEY`:** новый токен в Variables → redeploy → обновить клиентов. Старый токен мгновенно инвалидируется.
- **Monitoring:** Railway `/health`; alert on startup-key refusal, any `tools/list` drift, auth failures, and rate-limit saturation. Hosted logs must never contain writer-tool invocations.
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

### P4/S7 — exact hosted read boundary (current)

`buildServer({ mode: 'hosted' })` registers the exact eight-tool allow-list. Local stdio uses
`buildServer({ mode: 'local' })` and owns setup, filesystem mutation, signing, broadcasting, thread
writes, all ten acceptance actions, and the six `offer_*` negotiation tools (`offer_list`,
`offer_conversation`, `offer_message`, `offer_counter`, `offer_decline`, `offer_mark_read`). Hosted stays
at eight: no `offer_*` tool is ever registered there, and `tests/mcp-hosted-offer-boundary.test.ts` asserts it. `src/index.ts` calls `assertHostedKeyless()` before starting
the HTTP listener, so a stale volume cannot silently restore host-wallet capability. The registry and
real HTTP transport are both covered by exact enumeration tests; a subset assertion is insufficient.

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
