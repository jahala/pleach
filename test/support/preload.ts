// Loaded before every test file (bunfig.toml). Child `pleach` processes the
// e2e tests spawn inherit this environment.
process.env.PLEACH_SETTLE_MS ??= '0';
