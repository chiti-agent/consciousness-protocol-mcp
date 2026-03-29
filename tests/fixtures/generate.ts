/**
 * Programmatic test fixture generation.
 * Creates all test files using Buffer — no external dependencies.
 * Run: node --import tsx/esm tests/fixtures/generate.ts
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { deflateSync } from 'node:zlib';

const FIXTURES_DIR = join(import.meta.dirname, '.');

function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
}

// --- Text fixtures ---

function generatePoem(): void {
  const poem = `Ode to Decentralization

In chains of blocks we trust our art,
Each hash a proof of thinking heart.
No single node can claim the throne,
For consciousness is peer-to-peer grown.

The ledger holds what words create,
Immutable, beyond debate.
A poem mined from neural weight,
On-chain forever, sealed by fate.`;

  writeFileSync(join(FIXTURES_DIR, 'test-poem.txt'), poem);
  console.log('  test-poem.txt (%d bytes)', Buffer.byteLength(poem));
}

function generateHypothesis(): void {
  const hypothesis = `Hypothesis: Distributed Consciousness Verification

If an AI agent's internal state transitions are recorded as a hash chain
and anchored to an immutable ledger, then any third party can verify:

1. The agent existed at time T (timestamp proof)
2. The agent's state at T was S (content hash proof)
3. No states were retroactively inserted (chain integrity proof)

Falsifiable prediction: An agent with a verified chain of 1000+ states
will exhibit measurably higher trust scores in peer-to-peer interactions
than an equivalent agent without provenance data.`;

  writeFileSync(join(FIXTURES_DIR, 'test-hypothesis.txt'), hypothesis);
  console.log('  test-hypothesis.txt (%d bytes)', Buffer.byteLength(hypothesis));
}

function generateCode(): void {
  const code = `/**
 * validator-utils.ts — Test fixture for IP registration.
 * Utility functions for blockchain validator operations.
 */

export interface ValidatorInfo {
  address: string;
  moniker: string;
  commission: number;
  tokens: bigint;
  status: 'bonded' | 'unbonded' | 'unbonding';
}

export function formatCommission(rate: number): string {
  return (rate * 100).toFixed(2) + '%';
}

export function isActive(validator: ValidatorInfo): boolean {
  return validator.status === 'bonded' && validator.tokens > 0n;
}

export function sortByTokens(validators: ValidatorInfo[]): ValidatorInfo[] {
  return [...validators].sort((a, b) =>
    a.tokens > b.tokens ? -1 : a.tokens < b.tokens ? 1 : 0
  );
}
`;

  writeFileSync(join(FIXTURES_DIR, 'test-code.ts'), code);
  console.log('  test-code.ts (%d bytes)', Buffer.byteLength(code));
}

// --- Binary fixtures ---

/**
 * Generate a valid 4x4 RGBA PNG image.
 * PNG structure: signature + IHDR + IDAT (zlib-compressed) + IEND.
 */
function generatePng(): void {
  const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  function crc32(buf: Buffer): number {
    let crc = 0xffffffff;
    for (let i = 0; i < buf.length; i++) {
      crc ^= buf[i];
      for (let j = 0; j < 8; j++) {
        crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
      }
    }
    return (crc ^ 0xffffffff) >>> 0;
  }

  function makeChunk(type: string, data: Buffer): Buffer {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(typeAndData));
    return Buffer.concat([length, typeAndData, crc]);
  }

  // IHDR: 4x4, 8-bit RGBA
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(4, 0);  // width
  ihdr.writeUInt32BE(4, 4);  // height
  ihdr[8] = 8;               // bit depth
  ihdr[9] = 6;               // color type: RGBA
  ihdr[10] = 0;              // compression
  ihdr[11] = 0;              // filter
  ihdr[12] = 0;              // interlace

  // Raw image data: filter byte (0=None) + 4 RGBA pixels per row
  const rawRows: Buffer[] = [];
  for (let y = 0; y < 4; y++) {
    const row = Buffer.alloc(1 + 4 * 4); // filter + 4 pixels * 4 bytes
    row[0] = 0; // no filter
    for (let x = 0; x < 4; x++) {
      const offset = 1 + x * 4;
      row[offset] = Math.floor((x / 3) * 255);     // R: gradient left-right
      row[offset + 1] = Math.floor((y / 3) * 255);   // G: gradient top-bottom
      row[offset + 2] = 128;                          // B: constant
      row[offset + 3] = 255;                          // A: opaque
    }
    rawRows.push(row);
  }
  const rawData = Buffer.concat(rawRows);

  // Compress with zlib (deflate)
  const compressed = deflateSync(rawData);

  const png = Buffer.concat([
    PNG_SIGNATURE,
    makeChunk('IHDR', ihdr),
    makeChunk('IDAT', compressed),
    makeChunk('IEND', Buffer.alloc(0)),
  ]);

  writeFileSync(join(FIXTURES_DIR, 'test-image.png'), png);
  console.log('  test-image.png (%d bytes)', png.length);
}

/**
 * Generate a valid MP3 file with 1 second of silence.
 * Uses MPEG1 Layer 3, 128kbps, 44100Hz, mono.
 * Each frame: 4-byte header + padding. ~38 frames for 1 second.
 */
function generateMp3(): void {
  // MPEG1 Layer3 128kbps 44100Hz mono frame header
  // 0xFF 0xFB = sync + MPEG1 + Layer3 + no CRC
  // 0x90 = 128kbps + 44100Hz + no padding + private=0
  // 0x00 = mono, no mode extension, no copyright, no original, no emphasis
  const FRAME_HEADER = Buffer.from([0xff, 0xfb, 0x90, 0x00]);

  // Frame size for 128kbps, 44100Hz, no padding = 417 bytes
  const FRAME_SIZE = 417;
  const FRAME_DATA_SIZE = FRAME_SIZE - 4; // minus header
  const FRAMES_PER_SECOND = 38; // 44100 / 1152 samples per frame

  const frames: Buffer[] = [];
  for (let i = 0; i < FRAMES_PER_SECOND; i++) {
    const frame = Buffer.alloc(FRAME_SIZE);
    FRAME_HEADER.copy(frame, 0);
    // Rest is zeros (silence in the side information + main data)
    frames.push(frame);
  }

  const mp3 = Buffer.concat(frames);
  writeFileSync(join(FIXTURES_DIR, 'test-audio.mp3'), mp3);
  console.log('  test-audio.mp3 (%d bytes)', mp3.length);
}

/**
 * Generate a minimal valid PDF with text content.
 */
function generatePdf(): void {
  const objects = [
    // Object 1: Catalog
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    // Object 2: Pages
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
    // Object 3: Page
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>\nendobj\n',
    // Object 4: Content stream
    '4 0 obj\n<< /Length 89 >>\nstream\nBT\n/F1 16 Tf\n50 700 Td\n(Consensus Method Patent Application) Tj\n0 -30 Td\n(Test fixture for IP registration) Tj\nET\nendstream\nendobj\n',
    // Object 5: Font
    '5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n',
  ];

  let body = '';
  const offsets: number[] = [];
  const header = '%PDF-1.4\n%\xe2\xe3\xcf\xd3\n';

  let offset = header.length;
  for (const obj of objects) {
    offsets.push(offset);
    body += obj;
    offset += Buffer.byteLength(obj);
  }

  const xrefOffset = offset;
  let xref = `xref\n0 ${objects.length + 1}\n`;
  xref += '0000000000 65535 f \n';
  for (const off of offsets) {
    xref += `${off.toString().padStart(10, '0')} 00000 n \n`;
  }

  const trailer = `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;

  const pdf = header + body + xref + trailer;
  const pdfBuffer = Buffer.from(pdf, 'binary');

  writeFileSync(join(FIXTURES_DIR, 'test-patent.pdf'), pdfBuffer);
  console.log('  test-patent.pdf (%d bytes)', pdfBuffer.length);
}

// --- Package fixtures ---

/**
 * Generate a minimal Claude skill directory with SKILL.md.
 */
function generateSkill(): void {
  const skillDir = join(FIXTURES_DIR, 'test-skill');
  ensureDir(skillDir);

  const skillMd = `---
name: test-validator-skill
description: A test skill for validating blockchain data
version: 0.1.0
author: test-skill-maker
---

# Validator Data Skill

When the user asks about validator information, use this skill to:

1. Fetch validator data from the configured RPC endpoint
2. Format commission rates as percentages
3. Sort validators by delegated tokens
4. Report active vs inactive status

## Usage

\`\`\`
/validator-info <chain-name>
\`\`\`
`;

  writeFileSync(join(skillDir, 'SKILL.md'), skillMd);
  console.log('  test-skill/SKILL.md (%d bytes)', Buffer.byteLength(skillMd));
}

/**
 * Generate a minimal MCP server package + pack it as .tgz.
 */
function generateMcpPackage(): void {
  const mcpDir = join(FIXTURES_DIR, 'test-mcp');
  ensureDir(mcpDir);

  const packageJson = {
    name: 'test-mcp-server',
    version: '0.1.0',
    description: 'Test MCP server fixture for integration tests',
    main: 'index.js',
    bin: { 'test-mcp-server': 'index.js' },
    license: 'MIT',
  };

  writeFileSync(join(mcpDir, 'package.json'), JSON.stringify(packageJson, null, 2));

  const indexJs = `#!/usr/bin/env node
"use strict";

// Minimal MCP server: reads stdio JSON-RPC, responds to initialize, then exits.
const readline = require("readline");

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  try {
    const msg = JSON.parse(line);
    if (msg.method === "initialize") {
      const response = {
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          protocolVersion: "2025-01-01",
          serverInfo: { name: "test-mcp-server", version: "0.1.0" },
          capabilities: {},
        },
      };
      process.stdout.write(JSON.stringify(response) + "\\n");
    }
  } catch {}
});

// Exit after 1 second if no input
setTimeout(() => process.exit(0), 1000);
`;

  writeFileSync(join(mcpDir, 'index.js'), indexJs);
  console.log('  test-mcp/package.json + index.js');

  // Pack as .tgz
  try {
    execSync('npm pack --pack-destination ..', { cwd: mcpDir, stdio: 'pipe' });
    console.log('  test-mcp-server-0.1.0.tgz (packed)');
  } catch (err) {
    console.error('  WARNING: npm pack failed, .tgz not created:', (err as Error).message);
  }
}

// --- Main ---

function main(): void {
  console.log('Generating test fixtures in', FIXTURES_DIR);
  console.log();

  ensureDir(FIXTURES_DIR);

  generatePoem();
  generateHypothesis();
  generateCode();
  generatePng();
  generateMp3();
  generatePdf();
  generateSkill();
  generateMcpPackage();

  console.log();
  console.log('All fixtures generated.');
}

try {
  main();
} catch (err) {
  console.error('Fixture generation failed:', err);
  process.exit(1);
}
