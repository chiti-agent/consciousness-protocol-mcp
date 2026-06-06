/**
 * Structured stderr logger — pure, no I/O dependencies, no npm packages.
 *
 * WHY this file exists
 * --------------------
 * The MCP server runs in two transports:
 *   1. stdio — stdout is the JSON-RPC wire protocol. Anything written there is
 *      treated as an MCP message by the SDK and will corrupt the stream.
 *      Logs MUST go to stderr only, never stdout.
 *   2. HTTP — no stdout constraint, but structured JSON logs are needed for
 *      operator tooling (log aggregators, alerting, grep).
 *
 * Both concerns are served by emitting one JSON object per line to stderr
 * (JSON-Lines / NDJSON format). Consumers can `jq .` the output directly.
 *
 * Design constraints
 * ------------------
 * - Zero npm dependencies (mirrors src/rate-limit.ts philosophy).
 * - All I/O is routed through the injectable `sink` so the logger is
 *   fully testable without touching process.stderr.
 * - Injectable `now` so timestamps are deterministic in tests.
 * - NEVER throws — callers must not wrap log calls in try/catch.
 *
 * Level ordering: debug(0) < info(1) < warn(2) < error(3).
 * A record is written only when its level index >= the configured minimum index.
 */

/** The four supported log levels, ordered from least to most severe. */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** Maps each level to a numeric priority for threshold comparison. */
const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

/** Subset of valid level names used for env-value validation. */
const VALID_LEVELS = new Set<string>(['debug', 'info', 'warn', 'error']);

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

export interface LoggerOptions {
  /**
   * Minimum severity threshold. Records below this level are silently dropped.
   *
   * Resolution order:
   * 1. This option, if provided.
   * 2. process.env.MCP_LOG_LEVEL, if set to a valid level string.
   * 3. 'info' as the safe default.
   *
   * The env var is read once at logger creation time, not on every write,
   * so hot-reload of env after startup does NOT affect an existing logger.
   */
  level?: LogLevel;

  /**
   * Output sink. Receives the complete serialised line including the trailing
   * newline character. Default: (line) => process.stderr.write(line).
   *
   * Using a custom sink is the primary mechanism for testing — pass an array
   * push function to capture lines without touching the real stderr.
   *
   * WHY a string sink rather than a WriteStream: process.stderr.write() is
   * synchronous on most platforms (TTY / file), which avoids backpressure
   * complexity in a server-side logger used for diagnostics, not bulk I/O.
   */
  sink?: (line: string) => void;

  /**
   * Clock source that returns an ISO-8601 timestamp string.
   * Default: () => new Date().toISOString().
   * Injectable for deterministic test output.
   */
  now?: () => string;

  /**
   * Static key-value pairs that appear in every log record, after ts/level/msg
   * but before per-call fields. Useful for adding constant context such as
   * { transport: 'http' } so every line from the HTTP server carries that tag.
   */
  base?: Record<string, unknown>;
}

/**
 * Serialise a single value from a `fields` object.
 *
 * WHY special-case Error:
 * JSON.stringify(new Error('x')) produces "{}", losing the message and stack.
 * This is because Error properties (message, stack) are non-enumerable and
 * therefore invisible to the default JSON serialiser. We explicitly extract
 * them at the top level of fields — one level deep only (recursive Error
 * expansion is not needed for practical logging use cases and risks blowing
 * the output size on deeply nested causes).
 *
 * Own enumerable properties (e.g. `code` on Node's system errors) ARE
 * included via spread so that custom Error subclasses lose no information.
 */
function serializeValue(value: unknown): unknown {
  if (value instanceof Error) {
    // Spread own enumerable props first (e.g. { code: 'ENOENT' } on system
    // errors), then overwrite with the non-enumerable properties that
    // JSON.stringify would otherwise silently drop. Explicit keys come last
    // so they always win over any same-named enumerable prop on the instance,
    // and so that TypeScript strict mode does not flag duplicate keys (TS2783).
    return {
      ...value,
      message: value.message,
      stack: value.stack,
      name: value.name,
    };
  }
  return value;
}

/**
 * Apply serializeValue to each top-level value in a fields record.
 *
 * Only one level of Error serialisation is needed: the values of `fields`
 * can be Errors (the common case: `{ err }`) but we do not recurse into nested
 * objects. This keeps the implementation simple and predictable.
 */
function serializeFields(
  fields: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(fields)) {
    result[key] = serializeValue(val);
  }
  return result;
}

/**
 * Create a structured JSON-lines logger.
 *
 * The returned object is stateless from the caller's perspective — each
 * method call independently assembles and emits one JSON record. No internal
 * queue, no async I/O, no timers.
 *
 * @example
 * ```ts
 * const log = createLogger({ base: { transport: 'http' } });
 * log.info('MCP server listening on http://localhost:3020/mcp', { port: 3020 });
 * // stderr: {"ts":"2024-...","level":"info","msg":"MCP server ...","transport":"http","port":3020}
 * ```
 */
export function createLogger(opts: LoggerOptions = {}): Logger {
  // ── Resolve the minimum level threshold ──────────────────────────────────
  // Read at creation time so the env check does not penalise every log call
  // and so that callers get a consistent threshold for the logger's lifetime.
  let minLevel: LogLevel;
  if (opts.level !== undefined) {
    minLevel = opts.level;
  } else {
    const envVal = process.env.MCP_LOG_LEVEL ?? '';
    minLevel = VALID_LEVELS.has(envVal) ? (envVal as LogLevel) : 'info';
  }

  const minIndex = LEVEL_ORDER[minLevel];

  // ── Injectable dependencies ───────────────────────────────────────────────
  const sink = opts.sink ?? ((line: string) => process.stderr.write(line));
  const now = opts.now ?? (() => new Date().toISOString());
  const base = opts.base ?? {};

  // ── Core write function ───────────────────────────────────────────────────
  function write(level: LogLevel, msg: string, fields?: Record<string, unknown>): void {
    // Level filtering: skip entirely if below threshold. Sink is NOT called.
    if (LEVEL_ORDER[level] < minIndex) return;

    // Assemble the record. Field order: ts, level, msg, ...base, ...fields.
    // This ordering ensures the most-important identifiers come first, making
    // truncated log lines still useful in constrained terminals.
    const record: Record<string, unknown> = {
      ts: now(),
      level,
      msg,
      ...base,
      ...(fields !== undefined ? serializeFields(fields) : undefined),
    };

    // Safe serialisation: JSON.stringify can throw on circular references.
    // We must NEVER propagate exceptions to the caller — logging a message
    // should never break application control flow. Emit a fallback record
    // that still carries ts, level, msg but signals the failure explicitly.
    let line: string;
    try {
      line = JSON.stringify(record) + '\n';
    } catch {
      // Fallback: strip fields and mark the record as partially lost.
      const fallback: Record<string, unknown> = {
        ts: record.ts,
        level,
        msg,
        ...base,
        _serializationError: true,
      };
      // Fallback itself must not fail — base contains only plain values set
      // at construction time, which are developer-controlled and safe.
      line = JSON.stringify(fallback) + '\n';
    }

    sink(line);
  }

  return {
    debug: (msg, fields) => write('debug', msg, fields),
    info: (msg, fields) => write('info', msg, fields),
    warn: (msg, fields) => write('warn', msg, fields),
    error: (msg, fields) => write('error', msg, fields),
  };
}
