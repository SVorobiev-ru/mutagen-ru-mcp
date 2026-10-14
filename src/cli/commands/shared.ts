import type { Command } from "commander";
import type { CliContext } from "../context.js";

export type Register = (program: Command, context: (cmd: Command) => CliContext) => void;
