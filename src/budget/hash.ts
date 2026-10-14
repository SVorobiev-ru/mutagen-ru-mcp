import { createHash } from "node:crypto";

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .filter((key) => record[key] !== undefined)
        .sort()
        .map((key) => [key, canonical(record[key])]),
    );
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonical(value)) ?? "null";
}

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function requestHash(method: string, params: Record<string, unknown> = {}): string {
  return sha256(canonicalJson({ method, params }));
}
