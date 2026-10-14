#!/usr/bin/env node
import { main } from "./main.js";

const result = await main(process.argv.slice(2));
if (result.exitCode !== undefined) process.exitCode = result.exitCode;
const { close } = result;
if (close) {
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      void close().finally(() => process.exit(0));
    });
  }
}
