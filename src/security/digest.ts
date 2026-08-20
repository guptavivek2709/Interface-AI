import { createHash } from "node:crypto";

type CanonicalJson = null | boolean | number | string | CanonicalJson[] | { [key: string]: CanonicalJson };

function canonicalize(value: unknown, seen: WeakSet<object>): CanonicalJson {
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Canonical JSON does not support non-finite numbers");
    return value;
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new TypeError("Canonical JSON does not support cyclic values");
    seen.add(value);
    const result = value.map((item) => canonicalize(item, seen));
    seen.delete(value);
    return result;
  }
  if (typeof value === "object") {
    if (seen.has(value)) throw new TypeError("Canonical JSON does not support cyclic values");
    seen.add(value);
    const result = Object.create(null) as { [key: string]: CanonicalJson };
    for (const key of Object.keys(value as object).sort()) {
      const item = (value as Record<string, unknown>)[key];
      if (item === undefined) throw new TypeError(`Canonical JSON does not support undefined at ${key}`);
      result[key] = canonicalize(item, seen);
    }
    seen.delete(value);
    return result;
  }
  throw new TypeError(`Canonical JSON does not support ${typeof value}`);
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value, new WeakSet<object>()));
}

export function sha256Digest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}
