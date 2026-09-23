import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, normalize, relative } from 'node:path';

// ledger: D26 — ENGINEERING.md's layer rules and "no bare `new Error` outside
// core/errors.ts", read from the source tree itself so a new file is covered
// the day it lands. It reads files, like plan.drift and journal-doc beside it,
// and runs nothing.

const SRC_DIR = new URL('../../src/', import.meta.url).pathname;

type Layer = 'core' | 'seams' | 'adapters' | 'loop' | 'faces';

function srcFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return srcFiles(path);
    return entry.isFile() && path.endsWith('.ts') ? [path] : [];
  });
}

// src/index.ts (the package root) and src/main.ts (the bin) only wire the
// other layers, which is what faces/ does.
function classifyLayer(absPath: string): Layer {
  const rel = relative(SRC_DIR, absPath);
  const top = rel.split('/')[0];
  if (
    top === 'core' ||
    top === 'seams' ||
    top === 'adapters' ||
    top === 'loop' ||
    top === 'faces'
  ) {
    return top;
  }
  if (rel === 'index.ts' || rel === 'main.ts') return 'faces';
  throw new Error(`architecture test: cannot classify layer for ${absPath}`);
}

interface ImportEdge {
  line: number;
  specifier: string;
  isTypeOnly: boolean;
}

function lineOf(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

// Static imports and re-exports, brace lists spanning lines included (biome
// ends every statement with a semicolon).
const STATIC_RE = /\b(?:import|export)\s+(type\s+)?[^;]*?\bfrom\s+(['"])([^'"]+)\2\s*;/g;

// Dynamic `import('...')`. Followed by `.Member` it is a type query, which
// is type-only; otherwise it loads the module at run time.
const DYNAMIC_RE = /import\(\s*(['"])([^'"]+)\1\s*\)(\.)?/g;

function extractEdges(text: string): ImportEdge[] {
  const edges: ImportEdge[] = [];
  for (const m of text.matchAll(STATIC_RE)) {
    edges.push({ line: lineOf(text, m.index), specifier: m[3], isTypeOnly: m[1] !== undefined });
  }
  for (const m of text.matchAll(DYNAMIC_RE)) {
    edges.push({ line: lineOf(text, m.index), specifier: m[2], isTypeOnly: m[3] === '.' });
  }
  return edges;
}

// The direction rules. seams/ and adapters/ may import loop/deps.ts for
// types only: the ports loop/ defines and they implement. loop/ gets no such
// exception.
function violation(fromLayer: Layer, toLayer: Layer, isTypeOnly: boolean): string | null {
  if (fromLayer === toLayer) return null;
  if (toLayer === 'core') return null; // every layer may import core/
  if (fromLayer === 'faces') return null; // faces/ wires everything
  if (fromLayer === 'core') return `core/ imports nothing from the ${toLayer}/ layer`;
  if (fromLayer === 'loop') {
    return `loop/ imports only core/ — never ${toLayer}/, not even type-only`;
  }
  if (fromLayer === 'seams') {
    if (toLayer === 'loop' && isTypeOnly) return null; // interface contract (Seam types)
    if (toLayer === 'loop') return 'seams/ may only import loop/ types, not runtime bindings';
    return `seams/ may only import core/ (and loop/ types) — not ${toLayer}/`;
  }
  if (fromLayer === 'adapters') {
    if (toLayer === 'seams') return null; // "an adapters/ bridge may also use a seam"
    if (toLayer === 'loop' && isTypeOnly) return null; // interface contract (Seam/Runner types)
    if (toLayer === 'loop') return 'adapters/ may only import loop/ types, not runtime bindings';
    return `adapters/ may only import core/ or seams/ (and loop/ types) — not ${toLayer}/`;
  }
  return `unhandled layer pair ${fromLayer} -> ${toLayer}`;
}

function resolveSpecifier(fromFile: string, specifier: string): string | null {
  if (!specifier.startsWith('.')) return null; // package import (zod, node:*) — not a layer edge
  return normalize(join(dirname(fromFile), specifier));
}

describe('architecture — strict downward dependencies (ENGINEERING.md)', () => {
  test('every src/**/*.ts import respects its layer’s direction rule', () => {
    const files = srcFiles(SRC_DIR);
    const violations: string[] = [];

    for (const file of files) {
      const fromLayer = classifyLayer(file);
      const text = readFileSync(file, 'utf8');
      for (const edge of extractEdges(text)) {
        const resolved = resolveSpecifier(file, edge.specifier);
        if (resolved === null) continue;
        const toLayer = classifyLayer(resolved);
        const problem = violation(fromLayer, toLayer, edge.isTypeOnly);
        if (problem !== null) {
          const relFile = relative(SRC_DIR, file);
          violations.push(`src/${relFile}:${edge.line} imports '${edge.specifier}' — ${problem}`);
        }
      }
    }

    expect(violations).toEqual([]);
  });

  test('no bare `new Error(` outside src/core/errors.ts', () => {
    const files = srcFiles(SRC_DIR);
    const violations: string[] = [];
    const NEW_ERROR_RE = /\bnew\s+Error\s*\(/g;

    for (const file of files) {
      if (file.endsWith('core/errors.ts')) continue;
      const text = readFileSync(file, 'utf8');
      for (const m of text.matchAll(NEW_ERROR_RE)) {
        const relFile = relative(SRC_DIR, file);
        violations.push(
          `src/${relFile}:${lineOf(text, m.index)} throws a bare 'new Error(' — ` +
            'ENGINEERING.md: "no bare new Error outside core/errors.ts"; add a typed class there instead',
        );
      }
    }

    expect(violations).toEqual([]);
  });
});
