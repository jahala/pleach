import type { PleachConfig } from '../../src/faces/config.ts';
import type { LedgerSeam, RunnerSeam } from '../../src/loop/deps.ts';

const SENTINEL_KEY = 'CUSTOM-SENTINEL';

const ledger: LedgerSeam = {
  readClosed(_source: string): Promise<Map<string, string | null>> {
    const m = new Map<string, string | null>();
    m.set(SENTINEL_KEY, null);
    return Promise.resolve(m);
  },
  emitVerdict(_v, _source): Promise<{ closed: boolean }> {
    return Promise.resolve({ closed: true });
  },
};

const runner: RunnerSeam = {
  spawnWorker(_spec): Promise<never> {
    throw new Error('custom runner: spawnWorker should not be called in this test');
  },
};

export default { runner, ledger } satisfies PleachConfig;
