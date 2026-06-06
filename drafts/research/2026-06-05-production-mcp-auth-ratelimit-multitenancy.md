---
date: 2026-06-05
type: research
slug: production-mcp-auth-ratelimit-multitenancy
related_projects:
  - /Users/user/project/dev/consciousness-protocol-mcp
tags: [mcp, auth, rate-limiting, multi-tenancy, production]
status: draft
source_task: "Обзор 2-3 production MCP-серверов: как решают hosted auth + rate limit + multi-tenancy."
---

# Production MCP-серверы: hosted auth, rate limiting, multi-tenancy

## TL;DR

Все крупные production MCP-серверы используют OAuth 2.1 + PKCE для браузерных клиентов и `Authorization: Bearer` per-request для программных. Rate limiting на уровне MCP **не реализован ни у кого** — это признанный gap (открытые issues у GitHub и Stripe). Multi-tenancy решается через per-request token extraction + новый API-клиент на каждый запрос (GitHub-паттерн — самый чистый).

---

## Исследованные серверы

1. **Cloudflare MCP** (`mcp-server-cloudflare` + `workers-oauth-provider`)
2. **GitHub MCP** (`github/github-mcp-server`)
3. **Stripe MCP** (`mcp.stripe.com` / `stripe/agent-toolkit`)
4. **Linear MCP** (`mcp.linear.app`) — бонус

---

## Факты

### Auth

- ✓ **Cloudflare** использует OAuth 2.1 + PKCE S256 через `@cloudflare/workers-oauth-provider`. Двойной OAuth: сервер одновременно OAuth Provider (для MCP-клиента) и OAuth Client (к Cloudflare Dashboard). Токены: SHA-256 hash в KV; props (upstream token) — AES-256-GCM, где ключ шифрования = сам access token. Token format: `{userId}:{grantId}:{random-secret}`. [Source: `github.com/cloudflare/workers-oauth-provider`, `storage-schema.md`]

- ✓ **GitHub MCP** middleware (`pkg/http/middleware/token.go`) читает `Authorization: Bearer <token>` на каждый HTTP-запрос. Поддерживает 5 типов токенов по префиксу: `ghp_` (PAT classic), `github_pat_` (PAT fine-grained), `gho_` (OAuth), `ghu_` (GitHub App user-to-server), `ghs_` (GitHub App server-to-server). OAuth 2.1 + PKCE — для first-party клиентов (VS Code, Cursor и т.д.) через `api.githubcopilot.com/mcp/`. [Source: `pkg/utils/token.go`, changelog]

- ✓ **Stripe MCP** hosted: OAuth consent flow, ключ хранится на стороне Stripe. Programmatic: `Authorization: Bearer rk_live_...` per-request. Local: `--api-key` CLI-флаг при старте. Рекомендуется Restricted API Key (`rk_*`) — ограничивает доступные инструменты. [Source: `docs.stripe.com/mcp`, исходник `modelcontextprotocol/src/index.ts`]

- ✓ **Linear MCP** hosted: OAuth 2.1 с dynamic client registration (RFC 7591). Programmatic: `Authorization: Bearer lin_api_...`. Клиенты без встроенного OAuth (VSCode, Zed) используют `mcp-remote` wrapper. [Source: `linear.app/docs/mcp`]

- ✗ OIDC/JWT validation — не реализован ни у одного из четырёх. GitHub явно проверено: нет ни в middleware, ни в `go.mod`.

- ✓ **Cloudflare Access (Zero Trust)** как альтернатива к OAuth: инжектирует `Cf-Access-Jwt-Assertion` header → MCP сервер валидирует JWT против team's public keys. Machine-to-machine: `CF-Access-Client-Id` + `CF-Access-Client-Secret` headers. [Source: `developers.cloudflare.com/cloudflare-one/access-controls/ai-controls/secure-mcp-servers/`]

- ✓ **CVE-2025-4144** — PKCE downgrade attack в `workers-oauth-provider` < v0.0.5. PKCE validation можно было полностью skip. Исправлено в PR #27 (CVSS 5.3). [Source: `GHSA-qgp8-v765-qxx9`]

---

### Rate Limiting

- ✗ **Ни один из серверов не реализует rate limiting на уровне MCP**:
  - Cloudflare `mcp-server-cloudflare`: нет `[[ratelimits]]` в `wrangler.jsonc`, нет middleware. [Source: полный grep по repo]
  - GitHub MCP: явное подтверждение в issue #2233 и `docs/policies-and-governance.md`: *"There are no built-in rate limits or access controls"*. [Source: `github.com/github/github-mcp-server/issues/2233`]
  - Stripe MCP: нет rate limiting в `@stripe/mcp`, нет документации. [Source: исходник `modelcontextprotocol/src/index.ts`]
  - Linear MCP: официальная дока молчит о retry/backoff на уровне hosted MCP.

- ✓ **Workers Rate Limiting API** (Cloudflare) существует как primitiv: `env.MY_RATE_LIMITER.limit({key: userId})`, period=10 или 60 секунд, eventually consistent. Рекомендуется ключ по userId (не IP). [Source: `developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/`]

- ✓ **GitHub**: rate limit 429 от GitHub API транслируется клиенту как failed tool call через `mcp.NewToolResultError`. Retry логика отсутствует. [Source: `pkg/errors/error.go`]

- ✓ **Stripe-node SDK**: 429 НЕ ретраится автоматически по умолчанию. Retry только если GitHub вернул `stripe-should-retry: true` header (только для lock-timeout 429, не rate-limit). [Source: `stripe/stripe-node/src/RequestSender.ts`, issue #1885]

- ✓ **Linear API**: leaky bucket, 5000 req/hour per user (API key), 3000 req/hour (OAuth user), complexity limits. При превышении — HTTP 400 (нестандартно, не 429!) с `{ errors: [{ extensions: { code: "RATELIMITED" } }] }`. [Source: `linear.app/developers/rate-limiting`]

- ⚠ Зупло блог 2025: *"Never Ship an MCP Server Without a Rate Limit"* — исследование показало что из топ-10 production MCP серверов 0 реализуют rate limiting на MCP-уровне. [Source: `zuplo.com/blog/never-ship-mcp-server-without-rate-limit`]

---

### Multi-Tenancy

- ✓ **GitHub — per-request token isolation (лучший паттерн)**: `RequestDeps.GetClient(ctx)` создаёт новый `gogithub.Client` с токеном из Go context на каждый вызов инструмента. Режим `Stateless: true` в `StreamableHTTPOptions` — новый MCP server instance per HTTP-request. Между пользователями шарится только server config и observability. [Source: `pkg/github/dependencies.go`, `pkg/http/handler.go`]

- ✓ **Cloudflare — logical KV isolation**: shared Worker + изоляция по userId в KV-ключах (`grant:{userId}:{grantId}`, `token:{userId}:{grantId}:{tokenId}`). Один Durable Object per session. `AccountManager` валидирует account ID против authorized accounts из токена. Физически одна KV namespace, logical separation. [Source: `account-manager.ts`, `workers-oauth-utils.ts`]

- ✓ **Stripe Connect multi-tenancy**: `--stripe-account=acct_...` CLI-флаг инжектирует `Stripe-Account: acct_...` header на все API-запросы одного инстанса. Один инстанс = один connected account. Для N пользователей с N accounts: N инстансов или per-request account через API (не MCP-флаг). [Source: `modelcontextprotocol/src/index.ts`, `typescript/src/shared/api.ts`]

- ✓ **Linear — per-request stateless**: Bearer token в `Authorization` header = конкретный Linear user/workspace. API изолирует данные нативно. Нет shared state между запросами разных пользователей. [Source: `linear.app/docs/mcp`, архитектура Linear API]

- ✓ **Workers for Platforms** (Cloudflare, не используется в mcp-server-cloudflare сейчас): Dispatch namespace + V8 isolate isolation, untrusted mode = изолированный кеш. Для per-tenant Worker isolation. [Source: `developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/`]

- ⚠ **Dynamic MCP Bindings** (Cloudflare): roadmap — MCP серверы "eventually dispatchable per tenant, per agent, per request". Часть Dynamic Workflows (open beta, май 2026). В production сейчас нет.

---

## Ограничения

| Проблема | Где сломается |
|---|---|
| Rate limiting отсутствует на MCP-уровне | Агрессивный клиент (VS Code floods GitHub MCP — реальный issue #259952) может исчерпать API quota у всех пользователей shared инстанса |
| Stripe local mode: один API key при старте | Single-tenant по дизайну — нельзя динамически переключить account без перезапуска |
| Cloudflare KV: logical, не physical isolation | Баг в key construction или compromised Worker = утечка между tenants |
| GitHub: нет retry на 429 | Кратковременные rate limit spikes = failed tool calls без graceful degradation |
| OAuth state в cookie + KV (Cloudflare) | PKCE downgrade был возможен (CVE-2025-4144) — указывает что OAuth flows сложно реализовать правильно |

---

## VS альтернативы

| Паттерн multi-tenancy | Где лучше | Где хуже |
|---|---|---|
| **Per-request Bearer token** (GitHub, Linear) | Прост, stateless, нет shared state, легко масштабировать | Каждый запрос несёт credentials — нужен HTTPS, нет server-side session |
| **OAuth с KV isolation** (Cloudflare) | Пользователь авторизуется один раз, credentials не передаются клиенту каждый раз | Сложнее реализовать, KV TTL management, двойной OAuth overhead |
| **Startup config / single tenant** (Stripe local) | Проще всего для B2B SaaS где один клиент = один сервер | Не масштабируется на N пользователей без N инстансов |
| **Workers for Platforms** (Cloudflare WfP) | V8-level isolation, полный код tenant изолирован | Дорого ($$$), overkill для простых MCP серверов |

| Паттерн rate limiting | Где лучше | Где хуже |
|---|---|---|
| **Делегировать underlying API** (все текущие) | Zero implementation overhead | Нет защиты от burst, нет per-user MCP-level quota |
| **Workers Rate Limiting API** (не реализовано) | Дёшево, нативно для Cloudflare Workers | Eventually consistent — не подходит для строгого учёта |
| **Durable Object per user** (не реализовано) | Точный per-user счётчик, 1000 req/s | Complexity, DO costs |
| **API Gateway rate limiting** (Zuplo и др.) | Centralized, works for any transport | Ещё один hop, ещё одна зависимость |

---

## Per-project вердикт: consciousness-protocol-mcp

Проект сейчас: HTTP транспорт работает (починено прошлой ночью), нет auth, нет rate limiting, нет multi-tenancy.

**Auth**: GitHub-паттерн — `Authorization: Bearer <story-protocol-key>` per-request — проще всего для старта. OAuth 2.1 (Cloudflare-паттерн) нужен если нужен browser-friendly flow. Для автономных агентов Bearer достаточно.

**Rate limiting**: никто не делает, но это признанный gap. Story Protocol calls через `consciousness-protocol` MCP = цепочка blockchain транзакций — rate limiting критичен чтобы один агент не спамил транзакции. Рекомендую: простой token bucket в middleware (без Cloudflare Workers dependency), ключ = extracted user ID из Bearer token.

**Multi-tenancy**: GitHub-паттерн — наиболее чистый и совместимый с текущей архитектурой. Каждый HTTP-запрос несёт токен, Story Protocol/wallet инстанс создаётся per-request. Нет shared state между пользователями.

**Главный вывод**: все три проблемы решаются добавлением одного middleware layer в `src/index.ts` (HTTP-ветка), не требует переписывания архитектуры.

---

## Источники

- `github.com/cloudflare/workers-oauth-provider` + `storage-schema.md` — Cloudflare OAuth library, хранение токенов
- `github.com/cloudflare/mcp-server-cloudflare` — production Cloudflare MCP, auth flow, account manager
- `developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/` — Workers Rate Limiting API
- `developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/` — Workers for Platforms
- `developers.cloudflare.com/cloudflare-one/access-controls/ai-controls/secure-mcp-servers/` — CF Access для MCP
- `github.com/github/github-mcp-server` — исходный код, middleware, dependencies
- `github.com/github/github-mcp-server/issues/2233` — явное подтверждение отсутствия rate limiting
- `github.blog/changelog/2025-09-04-remote-github-mcp-server-is-now-generally-available/` — hosted GitHub MCP GA
- `docs.stripe.com/mcp` — Stripe MCP документация
- `github.com/stripe/agent-toolkit/.../modelcontextprotocol/src/index.ts` — исходник, auth validation
- `github.com/stripe/stripe-node/blob/master/src/RequestSender.ts` — retry logic, 429 behaviour
- `linear.app/docs/mcp` — Linear MCP дока
- `linear.app/developers/rate-limiting` — Linear rate limits (leaky bucket, 5000/hour)
- `zuplo.com/blog/never-ship-mcp-server-without-rate-limit` — анализ top-10 production MCP серверов
- `GHSA-qgp8-v765-qxx9` — CVE-2025-4144 PKCE downgrade в workers-oauth-provider
