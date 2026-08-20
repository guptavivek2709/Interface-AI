import { isProtectedField, isProtectedKey } from "./security";
import type { Capability, CapabilityField, FieldType, JsonValue } from "./types";

export type FlatFormValues = Record<string, string | boolean>;
export type ArrayCounts = Record<string, number>;

export function fieldPath(parts: readonly string[]): string {
  return parts.map((part) => part.replaceAll("~", "~0").replaceAll("/", "~1")).join("/");
}

export function fieldDomId(path: string): string {
  return `field-${[...path].map((character) => character.codePointAt(0)!.toString(16)).join("-")}`;
}

export function humanize(value: string): string {
  return value
    .replace(/([a-z])([A-Z])/gu, "$1 $2")
    .replace(/[._-]+/gu, " ")
    .replace(/\b\w/gu, (letter) => letter.toLocaleUpperCase());
}

function derivedField(
  name: string,
  type: FieldType,
  required: boolean,
  parent: CapabilityField,
): CapabilityField {
  return {
    name,
    type,
    required,
    description: humanize(name),
    classification: parent.classification,
  };
}

function primitiveValue(
  field: CapabilityField,
  path: string,
  values: FlatFormValues,
  errors: Record<string, string>,
): JsonValue | undefined {
  const current = values[path];
  if (field.type.kind === "boolean") {
    if (field.required) return current === true;
    if (current === "true") return true;
    if (current === "false") return false;
    return undefined;
  }
  const raw = typeof current === "string" ? current : "";
  const trimmed = raw.trim();
  if (!trimmed) {
    if (field.required) errors[path] = `${humanize(field.name)} is required.`;
    return undefined;
  }
  if (field.type.enum?.length) {
    const match = field.type.enum.find((item) => String(item) === raw);
    if (match === undefined) {
      errors[path] = "Choose one of the approved values.";
      return undefined;
    }
    return match;
  }
  if (field.type.kind === "number") {
    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed) || (field.type.integer && !Number.isInteger(parsed))) {
      errors[path] = field.type.integer ? "Enter a whole number." : "Enter a valid number.";
      return undefined;
    }
    if (field.type.minimum !== undefined && parsed < field.type.minimum) {
      errors[path] = `Enter ${field.type.minimum} or more.`;
      return undefined;
    }
    if (field.type.maximum !== undefined && parsed > field.type.maximum) {
      errors[path] = `Enter ${field.type.maximum} or less.`;
      return undefined;
    }
    return parsed;
  }
  if (field.type.kind === "money") {
    if (!/^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/u.test(trimmed)) {
      errors[path] = "Enter a non-negative amount with no more than two decimals.";
      return undefined;
    }
    const [whole = "0", fraction = ""] = trimmed.split(".");
    const minorUnits = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0"));
    if (field.type.minimumMinorUnits !== undefined && minorUnits < BigInt(field.type.minimumMinorUnits)) {
      errors[path] = `Enter at least ${(field.type.minimumMinorUnits / 100).toFixed(2)}.`;
      return undefined;
    }
    if (field.type.maximumMinorUnits !== undefined && minorUnits > BigInt(field.type.maximumMinorUnits)) {
      errors[path] = `Enter no more than ${(field.type.maximumMinorUnits / 100).toFixed(2)}.`;
      return undefined;
    }
    return `${whole}.${fraction.padEnd(2, "0")}`;
  }
  if (field.type.format === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(trimmed)) {
    errors[path] = "Enter a valid email address.";
    return undefined;
  }
  if (field.type.minLength !== undefined && trimmed.length < field.type.minLength) {
    errors[path] = `Enter at least ${field.type.minLength} characters.`;
    return undefined;
  }
  if (field.type.maxLength !== undefined && raw.length > field.type.maxLength) {
    errors[path] = `Enter no more than ${field.type.maxLength} characters.`;
    return undefined;
  }
  if (field.type.pattern) {
    try {
      if (!new RegExp(field.type.pattern, "u").test(raw)) {
        errors[path] = "Use the format described for this field.";
        return undefined;
      }
    } catch {
      errors[path] = "This field has an invalid validation rule. Contact an administrator.";
      return undefined;
    }
  }
  return raw;
}

function buildValue(
  field: CapabilityField,
  parts: string[],
  values: FlatFormValues,
  counts: ArrayCounts,
  errors: Record<string, string>,
): JsonValue | undefined {
  const path = fieldPath(parts);
  if (isProtectedField(field) || isProtectedKey(path)) return undefined;
  if (field.type.kind === "object") {
    if (!field.required && values[path] !== true) return undefined;
    const result: Record<string, JsonValue> = {};
    for (const [name, type] of Object.entries(field.type.properties ?? {})) {
      const child = derivedField(name, type, field.type.required?.includes(name) ?? false, field);
      const value = buildValue(child, [...parts, name], values, counts, errors);
      if (value !== undefined) result[name] = value;
    }
    if (field.required && Object.keys(result).length === 0 && !Object.keys(errors).some((key) => key.startsWith(`${path}/`))) {
      errors[path] = `${humanize(field.name)} requires at least one value.`;
    }
    return Object.keys(result).length ? result : undefined;
  }
  if (field.type.kind === "array") {
    const count = counts[path] ?? (field.required ? 1 : 0);
    const result: JsonValue[] = [];
    const itemType = field.type.items ?? { kind: "string" };
    for (let index = 0; index < count; index += 1) {
      const item = derivedField(String(index), itemType, true, field);
      const value = buildValue(item, [...parts, String(index)], values, counts, errors);
      if (value !== undefined) result.push(value);
    }
    if (field.required && result.length === 0) errors[path] = `Add at least one ${humanize(field.name)} item.`;
    return result.length ? result : undefined;
  }
  return primitiveValue(field, path, values, errors);
}

export function serializeInputs(
  capability: Capability,
  values: FlatFormValues,
  counts: ArrayCounts,
): { inputs: Record<string, JsonValue>; errors: Record<string, string> } {
  const inputs: Record<string, JsonValue> = {};
  const errors: Record<string, string> = {};
  for (const field of capability.inputs) {
    const value = buildValue(field, [field.name], values, counts, errors);
    if (value !== undefined) inputs[field.name] = value;
  }
  return { inputs, errors };
}

function flatten(
  type: FieldType,
  value: JsonValue,
  parts: string[],
  values: FlatFormValues,
  counts: ArrayCounts,
  required: boolean,
): void {
  const path = fieldPath(parts);
  if (type.kind === "object" && value && typeof value === "object" && !Array.isArray(value)) {
    if (!required) values[path] = true;
    for (const [name, child] of Object.entries(value)) {
      if (!isProtectedKey(name)) {
        flatten(
          type.properties?.[name] ?? { kind: "string" },
          child,
          [...parts, name],
          values,
          counts,
          type.required?.includes(name) ?? false,
        );
      }
    }
  } else if (type.kind === "array" && Array.isArray(value)) {
    counts[path] = value.length;
    value.forEach((child, index) =>
      flatten(type.items ?? { kind: "string" }, child, [...parts, String(index)], values, counts, true),
    );
  } else if (typeof value === "boolean") {
    values[path] = required ? value : String(value);
  } else if (value !== null && typeof value !== "object") {
    values[path] = String(value);
  }
}

export function flattenProposal(
  capability: Capability,
  args: Record<string, JsonValue>,
): { values: FlatFormValues; counts: ArrayCounts } {
  const values: FlatFormValues = {};
  const counts: ArrayCounts = {};
  for (const field of capability.inputs) {
    if (isProtectedField(field) || !Object.hasOwn(args, field.name)) continue;
    flatten(field.type, args[field.name]!, [field.name], values, counts, field.required);
  }
  return { values, counts };
}

export function isRunnable(capability: Capability): boolean {
  return (
    capability.schemaVersion === "2.0" &&
    capability.approval === "approved" &&
    capability.contractValid &&
    /^\d+\.\d+\.\d+$/u.test(capability.version) &&
    /^[a-f0-9]{64}$/u.test(capability.digest) &&
    !/(?:^|[._-])(sign[._-]?(?:on|in)|login|auth|authenticate|authentication)(?:$|[._-])/iu.test(capability.id)
  );
}
