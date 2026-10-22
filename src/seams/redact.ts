import { RedactError } from '../core/errors.ts';
import type { Redactor } from '../loop/deps.ts';

// The redaction seam: `plotplot redact`, the one shared implementation the
// plotplot stem ships. Reads the text on stdin and writes it with every secret
// replaced by `[REDACTED]` to stdout; pure from pleach's side — no network, no
// config — and it fails closed: a missing binary or a non-zero exit throws
// RedactError, never a best-effort pass of the input.
//
// The exec seam takes no stdin (ExecFn is argv + env only), so the redactor
// spawns its own process here: the text is written to stdin and stdout is the
// redacted text, byte-for-byte.

export function createRedactor(bin = 'plotplot'): Redactor {
  return {
    async redact(text: string): Promise<string> {
      let proc: Bun.Subprocess<'pipe', 'pipe', 'pipe'>;
      try {
        proc = Bun.spawn([bin, 'redact'], {
          stdin: 'pipe',
          stdout: 'pipe',
          stderr: 'pipe',
        });
      } catch (err) {
        // A missing or unspawnable binary: Bun.spawn throws before a process
        // exists. Same fail-closed answer as a non-zero exit.
        throw new RedactError(bin, err instanceof Error ? err.message : String(err));
      }

      // Feed the whole text and close stdin so the child sees EOF and answers.
      proc.stdin.write(text);
      proc.stdin.end();

      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);

      if (exitCode !== 0) {
        const detail = stderr.trim() !== '' ? stderr.trim() : `exited ${exitCode}`;
        throw new RedactError(bin, detail);
      }
      return stdout;
    },
  };
}
