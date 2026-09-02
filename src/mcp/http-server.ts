import { randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage } from 'node:http';

import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

import { createLogger } from '../logger.js';
import { clientKeyFromForwarded, TokenBucketRateLimiter } from '../rate-limit.js';
import { buildServer } from './server.js';

export const startHostedHttpServer = async (): Promise<void> => {
  const log = createLogger({ base: { transport: 'http' } });
  const port = Number.parseInt(process.env.MCP_PORT ?? '3020', 10);
  const rateLimitDisabled = ['1', 'true'].includes(process.env.MCP_RATE_LIMIT_DISABLED ?? '');
  const capacityValue = Number.parseInt(process.env.MCP_RATE_LIMIT_CAPACITY ?? '', 10);
  const refillValue = Number.parseFloat(process.env.MCP_RATE_LIMIT_REFILL_PER_SEC ?? '');
  const limiter = rateLimitDisabled
    ? null
    : new TokenBucketRateLimiter({
        capacity: Number.isNaN(capacityValue) ? 120 : capacityValue,
        refillPerSec: Number.isNaN(refillValue) ? 2 : refillValue,
      });

  const apiKey = process.env.MCP_API_KEY ?? '';
  const apiKeyBytes = Buffer.from(apiKey);
  const keyMatches = (presented: string | undefined): boolean => {
    if (!presented) return false;
    const bytes = Buffer.from(presented);
    return bytes.length === apiKeyBytes.length && timingSafeEqual(bytes, apiKeyBytes);
  };
  const requestKey = (request: IncomingMessage): string | undefined => {
    const authorization = request.headers.authorization;
    if (typeof authorization === 'string' && authorization.startsWith('Bearer ')) {
      return authorization.slice('Bearer '.length).trim();
    }
    const header = request.headers['x-api-key'];
    if (typeof header === 'string') return header.trim();
    return Array.isArray(header) ? header[0]?.trim() : undefined;
  };

  const sessions = new Map<string, StreamableHTTPServerTransport>();
  let shuttingDown = false;

  const httpServer = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', `http://localhost:${port}`);
      if (url.pathname === '/health' || url.pathname === '/ready') {
        if (request.method !== 'GET' && request.method !== 'HEAD') {
          response.writeHead(405, { 'Content-Type': 'application/json', Allow: 'GET, HEAD' });
          response.end(JSON.stringify({ error: 'Method not allowed' }));
          return;
        }
        const ready = url.pathname === '/health' || !shuttingDown;
        response.writeHead(ready ? 200 : 503, { 'Content-Type': 'application/json' });
        response.end(
          request.method === 'HEAD'
            ? undefined
            : JSON.stringify({ status: url.pathname === '/health' ? 'ok' : ready ? 'ready' : 'shutting_down' }),
        );
        return;
      }
      if (url.pathname !== '/mcp') {
        response.writeHead(404, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ error: 'Not found. Use /mcp endpoint.' }));
        return;
      }

      if (limiter) {
        const clientKey = clientKeyFromForwarded(
          request.headers['x-forwarded-for'],
          request.socket.remoteAddress,
          process.env.MCP_TRUST_PROXY === '1',
        );
        const limited = limiter.tryRemove(clientKey);
        if (!limited.allowed) {
          response.writeHead(429, {
            'Content-Type': 'application/json',
            'Retry-After': String(limited.retryAfterSec),
          });
          response.end(
            JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: 'Rate limit exceeded' }, id: null }),
          );
          return;
        }
      }

      if (apiKey && !keyMatches(requestKey(request))) {
        response.writeHead(401, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ error: 'Unauthorized' }));
        return;
      }

      if (request.method === 'DELETE') {
        const sessionId = request.headers['mcp-session-id'] as string | undefined;
        const transport = sessionId ? sessions.get(sessionId) : undefined;
        if (!sessionId || !transport) {
          response.writeHead(404);
          response.end();
          return;
        }
        await transport.close();
        sessions.delete(sessionId);
        response.writeHead(200);
        response.end();
        return;
      }

      const sessionId = request.headers['mcp-session-id'] as string | undefined;
      const existing = sessionId ? sessions.get(sessionId) : undefined;
      if (existing) {
        await existing.handleRequest(request, response);
        return;
      }

      let transport: StreamableHTTPServerTransport;
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (initializedId) => {
          sessions.set(initializedId, transport);
        },
      });
      transport.onclose = () => {
        if (transport.sessionId) sessions.delete(transport.sessionId);
      };
      await buildServer({ mode: 'hosted' }).connect(transport);
      await transport.handleRequest(request, response);
    } catch (error) {
      log.error('HTTP request handler error', { err: error });
      if (!response.headersSent) {
        response.writeHead(500, { 'Content-Type': 'application/json' });
        response.end(
          JSON.stringify({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null }),
        );
      } else if (!response.writableEnded) {
        response.end();
      }
    }
  });

  if (limiter) {
    const timer = setInterval(() => limiter.sweep(), 60_000);
    timer.unref();
    httpServer.on('close', () => clearInterval(timer));
  }

  const timeoutValue = Number.parseInt(process.env.MCP_SHUTDOWN_TIMEOUT_MS ?? '', 10);
  const shutdownTimeoutMs = Number.isNaN(timeoutValue) ? 10_000 : timeoutValue;
  const shutdown = (signal: string): void => {
    if (shuttingDown) {
      log.warn('Received signal again during shutdown — forcing exit', { signal });
      process.exit(1);
    }
    shuttingDown = true;
    log.info('Received signal, shutting down gracefully', { signal });
    const forceTimer = setTimeout(() => {
      log.error('Graceful shutdown timed out — forcing exit', { timeoutMs: shutdownTimeoutMs });
      process.exit(1);
    }, shutdownTimeoutMs);
    forceTimer.unref();
    for (const transport of sessions.values()) {
      transport.close().catch((error) => log.error('Error closing transport', { err: error }));
    }
    sessions.clear();
    httpServer.close((error) => {
      if (error) log.error('Error closing HTTP server', { err: error });
      clearTimeout(forceTimer);
      log.info('Shutdown complete');
      process.exit(0);
    });
    httpServer.closeAllConnections?.();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(port, () => {
      httpServer.off('error', reject);
      log.info(`MCP server listening on http://localhost:${port}/mcp`, {
        port,
        mode: 'streamable-http',
      });
      resolve();
    });
  });
};
