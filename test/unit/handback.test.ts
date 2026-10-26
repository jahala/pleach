// issue #125 — a phased node's handback carries every phase that ran, not just
// the last one's closing line. The assembly is pure (phase list in, text out)
// so it lives in core and is unit-tested here; the loop only collects the
// per-phase closing messages and the settle path calls this on them.
import { describe, expect, test } from 'bun:test';
import {
  assemblePhaseHandback,
  EMPTY_HANDBACK,
  type PhaseClosing,
  readFailedHandback,
} from '../../src/core/handback.ts';

const red: PhaseClosing = { name: 'red', index: 0, message: 'wrote the failing test\n' };
const impl: PhaseClosing = { name: 'impl', index: 1, message: 'made it pass\n' };
const green: PhaseClosing = { name: 'green', index: 2, message: 'suite green\n' };

describe('assemblePhaseHandback', () => {
  test('three phases in order, each message verbatim under its own heading', () => {
    expect(assemblePhaseHandback([red, impl, green])).toBe(
      '## red\nwrote the failing test\n\n## impl\nmade it pass\n\n## green\nsuite green\n',
    );
  });

  test('a phase whose read failed keeps the D42 note under its heading', () => {
    const failed = readFailedHandback({ exitCode: 1, outputTail: 'umbel: no transcript\n' });
    const out = assemblePhaseHandback([
      red,
      {
        name: 'impl',
        index: 1,
        readFailure: { exitCode: 1, outputTail: 'umbel: no transcript\n' },
      },
      green,
    ]);
    expect(out).toBe(
      `## red\nwrote the failing test\n\n## impl\n${failed}\n## green\nsuite green\n`,
    );
  });

  test('an empty phase message keeps the empty note under its heading', () => {
    const out = assemblePhaseHandback([red, { name: 'impl', index: 1, message: '' }, green]);
    expect(out).toBe(
      `## red\nwrote the failing test\n\n## impl\n${EMPTY_HANDBACK}\n## green\nsuite green\n`,
    );
  });

  test('a repeated phase name is disambiguated by its plan index', () => {
    const out = assemblePhaseHandback([
      { name: 'impl', index: 0, message: 'scaffold\n' },
      { name: 'red', index: 1, message: 'failing test\n' },
      { name: 'impl', index: 2, message: 'make it pass\n' },
      { name: 'green', index: 3, message: 'pass\n' },
    ]);
    expect(out).toBe(
      '## impl[0]\nscaffold\n\n## red\nfailing test\n\n## impl[2]\nmake it pass\n\n## green\npass\n',
    );
  });

  test('a single-phase list carries one heading and message', () => {
    expect(assemblePhaseHandback([{ name: 'green', index: 0, message: 'only green\n' }])).toBe(
      '## green\nonly green\n',
    );
  });
});
