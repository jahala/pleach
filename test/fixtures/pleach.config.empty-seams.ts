// Intentionally has runner/ledger as empty objects — used to test that
// loadConfig duck-types required methods and rejects with ConfigError.
// Do NOT annotate as PleachConfig (tsc would reject the fixture itself).
export default {
  runner: {},
  ledger: {},
};
