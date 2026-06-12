#!/usr/bin/env bun
import { runCli } from './faces/cli.ts';

process.exit(await runCli(process.argv.slice(2)));
