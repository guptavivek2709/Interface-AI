import type { CapabilityField, FieldType, JsonValue } from "./types";

const PROTECTED_KEY =
  /(?:^|[_\-.])(password|passcode|passwd|pwd|pin|otp|credential|secret|authorization|csrf|private[_-]?key|api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|cookie|session[_-]?token)(?:$|[_\-.])/iu;
const ASSIGNMENT_SECRET =
  /\b(password|passwd|passcode|pin|secret|api[ _-]?key|access[ _-]?token|refresh[ _-]?token|session[ _-]?token|authorization|cookie)\b\s*(?:is|=|:)\s*(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;]+)/iu;
const BEARER_SECRET = /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/u;
const PROVIDER_KEY = /\b(?:sk-ant|sk-proj|sk-live)-[A-Za-z0-9_-]{8,}/u;
const PRIVATE_KEY = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/iu;
const CREDENTIAL_URL = /https?:\/\/[^:/\s]+:[^@\s/]+@/iu;

export function isProtectedKey(name: string): boolean {
  const normalized = name.replace(/([a-z])([A-Z])/gu, "$1_$2").toLocaleLowerCase();
  return PROTECTED_KEY.test(`_${normalized}_`);
}

export function isProtectedField(field: CapabilityField): boolean {
  return (
    field.classification.toLocaleLowerCase() === "secret" ||
    ["password", "unsupported"].includes(field.type.format?.toLocaleLowerCase() ?? "") ||
    isProtectedKey(field.name)
  );
}

export function containsCredentialMaterial(message: string): boolean {
  return (
    ASSIGNMENT_SECRET.test(message) ||
    BEARER_SECRET.test(message) ||
    PROVIDER_KEY.test(message) ||
    PRIVATE_KEY.test(message) ||
    CREDENTIAL_URL.test(message)
  );
}

function stringLooksSecret(value: string): boolean {
  return containsCredentialMaterial(value);
}

export function containsProtectedMaterial(value: JsonValue, key = "", depth = 0): boolean {
  if (isProtectedKey(key) || depth > 32) return true;
  if (typeof value === "string") return containsCredentialMaterial(value);
  if (Array.isArray(value)) return value.some((item) => containsProtectedMaterial(item, "", depth + 1));
  if (value && typeof value === "object") {
    return Object.entries(value).some(([childKey, child]) =>
      containsProtectedMaterial(child, childKey, depth + 1),
    );
  }
  return false;
}

export function textForDisplay(value: string): string {
  return stringLooksSecret(value) ? "[Protected content withheld]" : value;
}

export function redactForDisplay(value: JsonValue, key = "", depth = 0): JsonValue {
  if (isProtectedKey(key)) return "[Protected]";
  if (depth > 8) return "[Nested value omitted]";
  if (typeof value === "string") return stringLooksSecret(value) ? "[Protected]" : value;
  if (Array.isArray(value)) {
    return value.slice(0, 250).map((item) => redactForDisplay(item, "", depth + 1));
  }
  if (value && typeof value === "object") {
    const result: Record<string, JsonValue> = {};
    for (const [childKey, child] of Object.entries(value).slice(0, 250)) {
      result[childKey] = redactForDisplay(child, childKey, depth + 1);
    }
    return result;
  }
  return value;
}

/** Projects a run value through its reviewed catalog fields; unknown keys fail closed. */
function projectContractValue(value: JsonValue, type: FieldType, key: string, depth = 0): JsonValue | undefined {
  if (depth > 32 || isProtectedKey(key)) return undefined;
  if (type.kind === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const projected: Record<string, JsonValue> = {};
    for (const [name, childType] of Object.entries(type.properties ?? {})) {
      if (!Object.hasOwn(value, name) || isProtectedKey(name)) continue;
      const child = projectContractValue(value[name]!, childType, name, depth + 1);
      if (child !== undefined) projected[name] = child;
    }
    return projected;
  }
  if (type.kind === "array") {
    if (!Array.isArray(value) || !type.items) return undefined;
    const projected: JsonValue[] = [];
    for (const item of value) {
      const child = projectContractValue(item, type.items, "item", depth + 1);
      if (child === undefined) return undefined;
      projected.push(child);
    }
    return projected;
  }
  if (type.kind === "money" && value && typeof value === "object" && !Array.isArray(value)) {
    const source = value as Record<string, JsonValue>;
    const projected: Record<string, JsonValue> = {};
    for (const name of ["currency", "amount", "minorUnits"] as const) {
      if (Object.hasOwn(source, name)) projected[name] = source[name]!;
    }
    return projected;
  }
  if (type.kind === "string" && typeof value !== "string") return undefined;
  if (type.kind === "number" && typeof value !== "number") return undefined;
  if (type.kind === "boolean" && typeof value !== "boolean") return undefined;
  return value;
}

export function contractValues(
  value: Record<string, JsonValue> | undefined,
  fields: readonly CapabilityField[] | undefined,
): Record<string, JsonValue> | undefined {
  if (!value || !fields) return undefined;
  const result: Record<string, JsonValue> = {};
  for (const field of fields) {
    if (!Object.hasOwn(value, field.name)) continue;
    if (isProtectedField(field)) {
      result[field.name] = "[Protected]";
      continue;
    }
    const projected = projectContractValue(value[field.name]!, field.type, field.name);
    if (projected !== undefined) result[field.name] = projected;
  }
  return Object.keys(result).length ? result : undefined;
}
