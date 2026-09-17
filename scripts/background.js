#!/usr/bin/env node
import { runBackgroundCli } from "../src/background/cli.js";

runBackgroundCli().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
