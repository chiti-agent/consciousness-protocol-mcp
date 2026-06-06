---
date: 2026-06-05
type: research
slug: streamable-http-mcp-hosting
related_projects:
  - /Users/user/project/dev/consciousness-protocol-mcp
tags: [mcp, http, hosting, deployment, streaming, session-management]
status: draft
source_task: "Streamable HTTP MCP hosting best practices."
---

# Streamable HTTP MCP: Hosting Best Practices

## TL;DR

Streamable HTTP — официальный транспорт MCP с марта 2025. Stateful режим (одна per-session `McpServer`) требует sticky sessions или внешнего Redis для горизонтального масштабирования. Текущая реализация в проекте содержит 2 критических бага (shared singleton + sessionId до handleRequest) — последняя ночная сессия нашла фиксы, но они не попали в working tree.

---

## Факты: Spec и SDK

- ✓ Streamable HTTP введён в spec 2025-03-26, заменяет deprecated HTTP+SSE (2024-11-05). Один endpoint `/mcp` обрабатывает GET/POST/DELETE.
- ✓ `sessionIdGenerator: () => string` — включает stateful режим. `undefined` = stateless (новый transport на каждый запрос, SDK бросает при повторном использовании).
- ✓ `onsessioninitialized: (sessionId) => void` — единственное правильное место регистрации транспорта в session map. Вызывается после обработки InitializeRequest внутри `handleRequest`.
- ✓ `onsessionclosed: (sessionId) => void` — вызывается при DELETE до `close()`. Правильное место для удаления из session map.
- ✓ `McpServer.connect(transport)` бросает `"Already connected to a transport"` при вторичном вызове — shared singleton = crash на 2-й сессии.
- ✓ DELETE с `Mcp-Session-Id` → сервер вызывает `onsessionclosed` + `close()` → HTTP 200. Это официальный client-initiated termination.
- ✓ `enableJsonResponse: true` — возвращает plain JSON вместо SSE. Идеально для stateless/serverless.
- ✓ `eventStore: EventStore` — включает resumability. `InMemoryEventStore` в SDK только для примеров (не production).
- ✓ `EventStore` interface: `storeEvent()`, `replayEventsAfter()`, опционально `getStreamIdForEventId()`.
- ✓ Priming events (пустые SSE события с id) отправляются при `eventStore` + protocol version >= 2025-11-25. Дают клиенту начальный `Last-Event-ID` для reconnect.
- ✓ GET /mcp открывает standalone SSE для server-initiated сообщений. Только один GET stream на сессию (409 Conflict при втором).
- ✓ Client обязан слать `Accept: application/json, text/event-stream` на каждый POST. Без этого — 406.
- ✓ Все deprecated: `allowedHosts`, `allowedOrigins`, `enableDnsRebindingProtection`. SDK рекомендует внешний middleware.

**Канонический паттерн stateful multi-session сервера (SDK docs):**

```typescript
const transports = new Map<string, StreamableHTTPServerTransport>();

app.all('/mcp', async (req, res) => {
  const sessionId = req.headers['mcp-session-id'];
  if (sessionId && transports.has(sessionId)) {
    await transports.get(sessionId)!.handleRequest(req, res, req.body);
  } else if (!sessionId && isInitializeRequest(req.body)) {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => { transports.set(id, transport); },
      onsessionclosed:      (id) => { transports.delete(id); },
    });
    const server = buildServer(); // PER-SESSION factory
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } else {
    res.status(400).send('Bad Request');
  }
});
```

---

## Факты: Реверс-прокси

- ✓ nginx: `proxy_buffering off` — критично. Без него SSE тихо ломается (буферизация гасит стрим).
- ✓ nginx `proxy_read_timeout 3600`: дефолт 60s убивает долгоживущие SSE соединения.
- ✓ Caddy: `flush_interval -1` = эквивалент `proxy_buffering off`.
- ✓ `Mcp-Session-Id` должен проходить через прокси как есть (custom header). Cloudflare/CDN иногда его стрипают.
- ⚠ `Vary: Origin` нужен при динамической проверке Origin, чтобы CDN не кэшировал CORS responses.

**nginx минимальный конфиг для MCP:**
```nginx
location /mcp {
    proxy_pass http://localhost:3020;
    proxy_http_version 1.1;
    proxy_buffering off;
    proxy_cache off;
    proxy_set_header Connection '';
    proxy_set_header Host $host;
    proxy_read_timeout 3600;
    proxy_send_timeout 3600;
}
```

---

## Факты: Аутентификация

- ✓ Spec 2025-03-26 требует OAuth 2.1 + PKCE (S256) для remote MCP серверов.
- ✓ Без токена сервер должен вернуть `401` с заголовком `WWW-Authenticate: Bearer realm="mcp", resource_metadata="..."`.
- ✓ Protected Resource Metadata документ на `/.well-known/oauth-protected-resource` (RFC 9728).
- ✓ `aud` claim в JWT должен совпадать с URI сервера.
- ⚠ Для внутренних/локальных deployments упрощённый bearer token (env var `MCP_AUTH_TOKEN`) достаточен вместо полного OAuth flow.

---

## Факты: CORS

- ✓ Браузер не может читать custom response headers без `Access-Control-Expose-Headers: Mcp-Session-Id`.
- ✓ `DELETE` должен быть в `Access-Control-Allow-Methods` (сессионное завершение).
- ✓ `Last-Event-ID` должен быть в `Access-Control-Allow-Headers` (SSE resumption).

**Минимальный CORS для MCP:**
```typescript
res.setHeader('Access-Control-Allow-Origin', process.env.CORS_ORIGIN ?? '*');
res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
res.setHeader('Access-Control-Allow-Headers', 
  'Content-Type, Authorization, Mcp-Session-Id, Accept, Last-Event-ID');
res.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id');
```

---

## Факты: Горизонтальное масштабирование

- ✓ MCP stateful по дизайну: `Mcp-Session-Id` привязывает клиента к инстансу.
- ✓ TypeScript SDK не имеет нативного Redis session store (issue #843 открыт).
- ✓ Python SDK аналогично (issue #880, P1, открыт на июнь 2026).
- ✓ Sticky sessions (IP hash или cookie affinity в nginx/ALB) — простейший workaround.
- ⚠ Redis pattern: хранить `initialize` payload под `session:{sessionId}`, TTL со скользящим окном. Community pattern, не SDK-native.
- ⚠ MCP working group движется к stateless redesign (Q1 2026 SEP, июнь 2026 RC target). `Mcp-Method` + `Mcp-Name` headers для routing без инспекции body.

---

## Факты: Платформы

| Платформа | SSE поддержка | Ограничения | Рекомендация |
|---|---|---|---|
| **Cloudflare Workers** | ✓ | 30s CPU (не wall-clock), stateful → Durable Objects | Stateless MCP или Durable Objects |
| **Vercel Serverless** | ✓ | Hobby: 10s timeout; деньги за idle SSE | Stateless с `enableJsonResponse` |
| **AWS Lambda (std)** | ✗ | API GW буферизует response | Не подходит для SSE |
| **AWS Lambda Function URL** | ✓ | 15min max, 5min idle stream timeout | `RESPONSE_STREAM` + Lambda Web Adapter |
| **VPS/Docker** | ✓ | Нет специфических ограничений | Оптимально для stateful MCP |

---

## Ограничения

- **Stateful horizontal scaling** — нет официального решения. Redis workaround требует дополнительной инфраструктуры.
- **AWS Lambda idle timeout** — 5 минут без активности убивает SSE stream. Клиенты должны реализовывать reconnect.
- **Cloudflare Workers CPU** — 30s CPU лимит касается только computing, не wall-clock. Но сложные tool calls могут упереться.
- **InMemoryEventStore** — только для примеров и тестов. Production resumability требует внешнего хранилища (Redis/DB).
- **EventStore priming events** — только для protocol version `>= 2025-11-25`. Старые клиенты не получат начальный Last-Event-ID.

---

## VS Альтернативы

| Решение | Где лучше | Где хуже |
|---|---|---|
| **Stateful Streamable HTTP** | SSE streaming, server-initiated notifications, long conversations | Горизонтальное масштабирование, serverless |
| **Stateless Streamable HTTP** | Serverless, простые request/response tools, горизонтальное масштабирование | Нет server-initiated messages, нет resumability |
| **stdio** | Локальные инструменты (Claude Desktop), zero network overhead | Только один клиент, нельзя хостить |
| **Legacy HTTP+SSE** | — | Deprecated с 2025-03-26, не используй |

---

## Аудит текущей реализации (src/index.ts:314-392)

**Критичные баги (CRITICAL):**

1. **Shared singleton crash (line 371):** `server.connect(transport)` вызывается на модульном singleton. SDK бросает `"Already connected"` на 2-й сессии → процесс падает.
2. **sessionId читается до handleRequest (lines 373-375):** `transport.sessionId` = undefined до обработки InitializeRequest. Sessions map всегда пуст → каждый запрос создаёт новый транспорт → cascade crash.

**Средние баги (HIGH/MEDIUM):**

3. **Нет try/catch:** async handler без try/catch → UnhandledPromiseRejection → Node 18+ process exit.
4. **Нет CORS:** браузерные клиенты не смогут подключиться.
5. **Нет SIGTERM handler:** открытые SSE соединения обрываются без graceful close.
6. **Нет session count limit:** unbounded Map → OOM при нагрузке.

**Низкий приоритет (LOW):**

7. **Нет `/health` endpoint:** нужен для container orchestrators.
8. **Нет auth:** ОК для localhost, нужен для remote deployment.

**Важная заметка:**  
Вчерашняя ночная сессия нашла фиксы для багов #1, #2, #3 и реализовала `buildServer()` factory + `onsessioninitialized`. Но git status чистый, рабочее дерево не изменено — фикс не попал из worktree в основной working tree. Код **всё ещё содержит критические баги**.

---

## Per-project вердикт

**consciousness-protocol-mcp** использует Streamable HTTP как основной remote транспорт. Приоритеты:

1. **Немедленно:** применить вчерашний фикс — `buildServer()` factory + `onsessioninitialized` + try/catch.
2. **Перед production:** CORS + SIGTERM graceful shutdown + session count limit.
3. **При pubличном хостинге:** bearer token auth (простой env var достаточно).
4. **При масштабировании:** sticky sessions в nginx (простейшее решение).
5. **Опционально:** `eventStore` для resumability (нужно внешнее хранилище, не in-memory).

---

## Источники

- SDK source `@modelcontextprotocol/sdk@1.27.1` — `dist/cjs/server/webStandardStreamableHttp.d.ts/.js` ✓
- [MCP Transports Spec 2025-03-26](https://modelcontextprotocol.io/specification/2025-03-26/basic/transports) ✓
- [MCP Authorization Tutorial](https://modelcontextprotocol.io/docs/tutorials/security/authorization) ✓
- [nginx buffering for SSE](https://aisauce.dev/posts/mcp-nginx-buffering/) ✓
- [Redis session continuity pattern](https://www.huuhka.net/preserving-mcp-session-continuity-with-redis/) ⚠
- [Cloudflare MCP docs](https://developers.cloudflare.com/agents/model-context-protocol/) ✓
- [Vercel MCP blog](https://vercel.com/blog/building-efficient-mcp-servers) ✓
- [AWS Lambda streaming guide](https://hidekazu-konishi.com/entry/mcp_server_aws_lambda_complete_guide.html) ✓
- [TypeScript SDK horizontal scaling issue #843](https://github.com/modelcontextprotocol/typescript-sdk/issues/843) ✓
- [MCP transport future blog](https://blog.modelcontextprotocol.io/posts/2025-12-19-mcp-transport-future/) ⚠
- [CORS for MCP](https://mcpcat.io/guides/implementing-cors-policies-web-based-mcp-servers/) ✓
