#!/usr/bin/env node
import { defaultIo } from "./io.js";
import { run } from "./program.js";

const controller = new AbortController();
process.once("SIGINT", () => controller.abort());
process.exitCode = await run(process.argv.slice(2), { ...defaultIo(), signal: controller.signal });
