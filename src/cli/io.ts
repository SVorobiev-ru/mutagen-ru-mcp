import type { Env } from "../config.js";
import type { FetchLike } from "../core/transport.js";
import { redactSecret } from "../core/transport.js";

export interface Writer {
  write(text: string): unknown;
}

export interface CliIo {
  stdin: NodeJS.ReadableStream;
  stdout: Writer;
  stderr: Writer;
  env: Env;
  stdinIsTTY: boolean;
  stdoutIsTTY: boolean;
  cwd?: string;
  fetch?: FetchLike;
  signal?: AbortSignal;
}

export function defaultIo(): CliIo {
  return {
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
    env: process.env,
    stdinIsTTY: process.stdin.isTTY === true,
    stdoutIsTTY: process.stdout.isTTY === true,
  };
}

export function redacting(writer: Writer, secret: string | undefined): Writer {
  if (!secret) return writer;
  return { write: (text: string) => writer.write(redactSecret(text, secret)) };
}

export async function readAll(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk, "utf8") : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}
