// Intentionally missing `ledger` — used to test ConfigError on invalid config.
// Do NOT annotate as PleachConfig (that would make tsc reject the fixture itself).
export default {
  runner: {
    spawnWorker: async () => {
      throw new Error('x');
    },
  },
};
