/**
 * Unit tests for src/logger.ts — structured stderr logger.
 *
 * All tests are offline and deterministic — no network calls, no file system.
 * Time is injected via the `now` option so output is stable across runs.
 * Sink is injected so we capture output without touching process.stderr.
 *
 * Covers: JSON shape, level filtering, base/fields merging, Error serialisation,
 * MCP_LOG_LEVEL env fallback, and graceful handling of circular-ref fields.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createLogger } from '../src/logger.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Inject a fixed timestamp so assertions are deterministic. */
const FIXED_ISO = '2020-01-01T00:00:00.000Z';
const fixedNow = () => FIXED_ISO;

/**
 * Build a logger that captures written lines in an array.
 * Returns both the logger and the lines array.
 */
function makeCapturingLogger(opts: Parameters<typeof createLogger>[0] = {}) {
  const lines: string[] = [];
  const sink = (line: string) => lines.push(line);
  const log = createLogger({ now: fixedNow, sink, ...opts });
  return { log, lines };
}

/** Parse the single line at `lines[0]` as JSON, assert the array has exactly one entry. */
function parseSingle(lines: string[]): Record<string, unknown> {
  assert.equal(lines.length, 1, `expected exactly 1 line, got ${lines.length}`);
  return JSON.parse(lines[0]) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// 1. JSON shape and format
// ---------------------------------------------------------------------------

describe('createLogger — JSON shape', () => {
  it('produces a valid JSON line ending with \\n', () => {
    const { log, lines } = makeCapturingLogger();
    log.info('hello');
    assert.equal(lines.length, 1, 'should write exactly one line');
    // Must end with newline
    assert.ok(lines[0].endsWith('\n'), 'line must end with \\n');
    // Must be valid JSON
    assert.doesNotThrow(() => JSON.parse(lines[0]), 'line must be valid JSON');
  });

  it('includes ts, level, msg in correct order (first three keys)', () => {
    const { log, lines } = makeCapturingLogger();
    log.info('test message');
    const entry = parseSingle(lines);
    assert.equal(entry.ts, FIXED_ISO, 'ts must equal the injected ISO timestamp');
    assert.equal(entry.level, 'info', 'level must be "info"');
    assert.equal(entry.msg, 'test message', 'msg must equal the argument');
  });

  it('each log level method writes the correct level string', () => {
    const { log, lines } = makeCapturingLogger({ level: 'debug' });
    log.debug('d');
    log.info('i');
    log.warn('w');
    log.error('e');
    assert.equal(lines.length, 4, 'all four methods should produce a line');
    const levels = lines.map((l) => (JSON.parse(l) as { level: string }).level);
    assert.deepEqual(levels, ['debug', 'info', 'warn', 'error']);
  });
});

// ---------------------------------------------------------------------------
// 2. Level filtering
// ---------------------------------------------------------------------------

describe('createLogger — level filtering', () => {
  it('at level "warn": debug and info are suppressed, warn and error pass through', () => {
    const { log, lines } = makeCapturingLogger({ level: 'warn' });
    log.debug('suppressed-debug');
    log.info('suppressed-info');
    log.warn('passes');
    log.error('also-passes');
    assert.equal(lines.length, 2, 'only warn and error should be written');
    const parsed = lines.map((l) => JSON.parse(l) as { level: string });
    assert.equal(parsed[0].level, 'warn');
    assert.equal(parsed[1].level, 'error');
  });

  it('at level "error": only error passes through', () => {
    const { log, lines } = makeCapturingLogger({ level: 'error' });
    log.debug('no');
    log.info('no');
    log.warn('no');
    log.error('yes');
    assert.equal(lines.length, 1);
    assert.equal((JSON.parse(lines[0]) as { level: string }).level, 'error');
  });

  it('at level "debug": all four levels pass through', () => {
    const { log, lines } = makeCapturingLogger({ level: 'debug' });
    log.debug('d');
    log.info('i');
    log.warn('w');
    log.error('e');
    assert.equal(lines.length, 4, 'all levels should pass when configured at debug');
  });

  it('at level "info" (default): debug is suppressed', () => {
    const { log, lines } = makeCapturingLogger({ level: 'info' });
    log.debug('hidden');
    log.info('visible');
    assert.equal(lines.length, 1, 'debug must be suppressed at info level');
    assert.equal((JSON.parse(lines[0]) as { level: string }).msg, 'visible');
  });
});

// ---------------------------------------------------------------------------
// 3. base and fields merging
// ---------------------------------------------------------------------------

describe('createLogger — base and fields merging', () => {
  it('base fields appear in every log line', () => {
    const { log, lines } = makeCapturingLogger({
      level: 'debug',
      base: { transport: 'http', pid: 1234 },
    });
    log.debug('first');
    log.info('second');
    assert.equal(lines.length, 2);
    for (const line of lines) {
      const entry = JSON.parse(line) as Record<string, unknown>;
      assert.equal(entry.transport, 'http', 'base.transport must be present in every line');
      assert.equal(entry.pid, 1234, 'base.pid must be present in every line');
    }
  });

  it('fields passed to the method are merged into the record', () => {
    const { log, lines } = makeCapturingLogger();
    log.info('with fields', { port: 3020, mode: 'streamable-http' });
    const entry = parseSingle(lines);
    assert.equal(entry.port, 3020);
    assert.equal(entry.mode, 'streamable-http');
  });

  it('per-call fields take precedence over base fields on key collision', () => {
    // When both base and fields share a key, the spread order {...base, ...fields}
    // means fields wins — document this behaviour explicitly.
    const { log, lines } = makeCapturingLogger({ base: { env: 'base-value' } });
    log.info('collision', { env: 'field-value' });
    const entry = parseSingle(lines);
    assert.equal(entry.env, 'field-value', 'per-call fields should override base fields');
  });

  it('no fields arg: line contains only ts, level, msg (plus base)', () => {
    const { log, lines } = makeCapturingLogger({ base: { x: 1 } });
    log.info('plain');
    const entry = parseSingle(lines);
    assert.deepEqual(Object.keys(entry), ['ts', 'level', 'msg', 'x']);
  });
});

// ---------------------------------------------------------------------------
// 4. Error serialisation
// ---------------------------------------------------------------------------

describe('createLogger — Error serialisation', () => {
  it('Error in fields is serialised to {message, stack} instead of {}', () => {
    const { log, lines } = makeCapturingLogger();
    const err = new Error('boom');
    log.error('request failed', { err });
    const entry = parseSingle(lines);
    const serialised = entry.err as Record<string, unknown>;
    assert.ok(
      typeof serialised === 'object' && serialised !== null,
      'err field must be an object, not {}',
    );
    assert.equal(serialised.message, 'boom', 'err.message must be present');
    assert.ok(typeof serialised.stack === 'string', 'err.stack must be a string');
  });

  it('Error.name is preserved in serialisation', () => {
    const { log, lines } = makeCapturingLogger();
    const err = new TypeError('type fail');
    log.error('type error', { err });
    const entry = parseSingle(lines);
    const serialised = entry.err as Record<string, unknown>;
    assert.equal(serialised.name, 'TypeError', 'err.name must be included');
  });

  it('own enumerable properties (e.g. code) are preserved on Error subclass', () => {
    const { log, lines } = makeCapturingLogger();
    const err = Object.assign(new Error('sys error'), { code: 'ENOENT' });
    log.error('file error', { err });
    const entry = parseSingle(lines);
    const serialised = entry.err as Record<string, unknown>;
    assert.equal(serialised.code, 'ENOENT', 'own enumerable props on Error must be preserved');
  });

  it('plain objects in fields pass through unchanged', () => {
    const { log, lines } = makeCapturingLogger();
    log.info('plain obj', { meta: { foo: 'bar', num: 42 } });
    const entry = parseSingle(lines);
    const meta = entry.meta as Record<string, unknown>;
    assert.equal(meta.foo, 'bar');
    assert.equal(meta.num, 42);
  });
});

// ---------------------------------------------------------------------------
// 5. MCP_LOG_LEVEL environment variable
// ---------------------------------------------------------------------------

describe('createLogger — MCP_LOG_LEVEL env fallback', () => {
  let savedEnv: string | undefined;

  before(() => {
    savedEnv = process.env.MCP_LOG_LEVEL;
    delete process.env.MCP_LOG_LEVEL;
  });

  after(() => {
    if (savedEnv === undefined) {
      delete process.env.MCP_LOG_LEVEL;
    } else {
      process.env.MCP_LOG_LEVEL = savedEnv;
    }
  });

  it('invalid MCP_LOG_LEVEL value falls back to "info" (debug suppressed, info passes)', () => {
    process.env.MCP_LOG_LEVEL = 'NONSENSE';
    const { log, lines } = makeCapturingLogger({}); // no opts.level — reads env
    log.debug('should be suppressed');
    log.info('should pass');
    assert.equal(lines.length, 1, 'with invalid env value, fallback level must be info (debug suppressed)');
    assert.equal((JSON.parse(lines[0]) as { msg: string }).msg, 'should pass');
    delete process.env.MCP_LOG_LEVEL;
  });

  it('empty MCP_LOG_LEVEL falls back to "info"', () => {
    process.env.MCP_LOG_LEVEL = '';
    const { log, lines } = makeCapturingLogger({});
    log.debug('no');
    log.info('yes');
    assert.equal(lines.length, 1, 'empty env value must fall back to info');
    delete process.env.MCP_LOG_LEVEL;
  });

  it('valid MCP_LOG_LEVEL="debug" enables debug output', () => {
    process.env.MCP_LOG_LEVEL = 'debug';
    const { log, lines } = makeCapturingLogger({});
    log.debug('debug line');
    assert.equal(lines.length, 1, 'MCP_LOG_LEVEL=debug should enable debug output');
    delete process.env.MCP_LOG_LEVEL;
  });

  it('valid MCP_LOG_LEVEL="warn" suppresses info', () => {
    process.env.MCP_LOG_LEVEL = 'warn';
    const { log, lines } = makeCapturingLogger({});
    log.info('suppressed');
    log.warn('visible');
    assert.equal(lines.length, 1, 'MCP_LOG_LEVEL=warn should suppress info');
    delete process.env.MCP_LOG_LEVEL;
  });

  it('opts.level takes precedence over MCP_LOG_LEVEL env', () => {
    process.env.MCP_LOG_LEVEL = 'error'; // would suppress warn
    const { log, lines } = makeCapturingLogger({ level: 'debug' }); // explicit opts overrides
    log.debug('visible because opts.level=debug wins');
    assert.equal(lines.length, 1, 'explicit opts.level must take precedence over env');
    delete process.env.MCP_LOG_LEVEL;
  });
});

// ---------------------------------------------------------------------------
// 6. Circular reference safety
// ---------------------------------------------------------------------------

describe('createLogger — circular reference safety', () => {
  it('does not throw when fields contain a circular reference', () => {
    const { log, lines } = makeCapturingLogger();
    const circular: Record<string, unknown> = { a: 1 };
    circular.self = circular; // circular reference
    assert.doesNotThrow(
      () => log.error('circular fields', { data: circular }),
      'logger must never throw on circular reference in fields',
    );
  });

  it('writes a fallback line (not silent) when fields cannot be serialised', () => {
    const { log, lines } = makeCapturingLogger();
    const circular: Record<string, unknown> = {};
    circular.ref = circular;
    log.error('circular', { bad: circular });
    assert.equal(lines.length, 1, 'must still write exactly one line');
    // The fallback line must be valid JSON
    assert.doesNotThrow(() => JSON.parse(lines[0]), 'fallback line must be valid JSON');
    const entry = JSON.parse(lines[0]) as Record<string, unknown>;
    // Must have msg preserved
    assert.equal(entry.msg, 'circular', 'fallback line must preserve the msg');
    // Must signal the serialisation failure
    assert.ok(
      entry._serializationError === true,
      'fallback line must include _serializationError: true',
    );
  });
});
