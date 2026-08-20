import { readFile } from "node:fs/promises";
import path from "node:path";

export type InvocationInput = string | number | boolean;
export type InvocationInputs = Record<string, InvocationInput>;

const RESERVED_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const INPUT_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u;

function validateKey(key: string): void {
  if (!key) throw new Error("Input names cannot be empty");
  if (!INPUT_NAME_PATTERN.test(key)) {
    throw new Error(
      `Invalid input name ${JSON.stringify(key)}; use 1-160 letters, digits, dots, underscores, colons, or hyphens`,
    );
  }
  if (RESERVED_KEYS.has(key)) {
    throw new Error(`Reserved input name ${JSON.stringify(key)} is forbidden`);
  }
}

export function ensureInputObject(value: unknown, label = "inputs"): InvocationInputs {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`);
  }

  const result = Object.create(null) as InvocationInputs;
  const entries = Object.entries(value);
  if (entries.length === 0) throw new Error(`${label} must contain at least one input`);
  for (const [key, item] of entries) {
    validateKey(key);
    if (typeof item !== "string" && typeof item !== "number" && typeof item !== "boolean") {
      throw new Error(`${label}.${key} must be a string, number, or boolean`);
    }
    result[key] = item as InvocationInput;
  }
  return result;
}

export function parseInputAssignments(assignments: readonly string[]): InvocationInputs {
  const result = Object.create(null) as InvocationInputs;
  for (const assignment of assignments) {
    const separator = assignment.indexOf("=");
    if (separator < 1) {
      throw new Error(
        `Invalid --input ${JSON.stringify(assignment)}; expected name=value (the option may be repeated)`,
      );
    }
    const key = assignment.slice(0, separator).trim();
    validateKey(key);
    if (Object.hasOwn(result, key)) {
      throw new Error(`Input ${JSON.stringify(key)} was provided more than once`);
    }
    result[key] = assignment.slice(separator + 1);
  }
  return result;
}

export async function readInvocationInputs(options: {
  inputs?: string;
  input?: readonly string[];
}): Promise<InvocationInputs> {
  const assignments = options.input ?? [];
  if (options.inputs && assignments.length > 0) {
    throw new Error(
      "Choose either --inputs <json-or-path> or repeatable --input <name=value>, not both",
    );
  }
  if (!options.inputs && assignments.length === 0) {
    throw new Error("Inputs are required: use --inputs <json-or-path> or repeat --input <name=value>");
  }
  if (assignments.length > 0) return parseInputAssignments(assignments);

  const source = options.inputs!;
  const isInlineJson = source.trimStart().startsWith("{");
  let text: string;
  try {
    text = isInlineJson ? source : await readFile(path.resolve(source), "utf8");
  } catch (error) {
    const detail = error instanceof Error ? `: ${error.message}` : "";
    throw new Error(`Could not read input JSON file ${JSON.stringify(source)}${detail}`, {
      cause: error,
    });
  }

  try {
    return ensureInputObject(JSON.parse(text.replace(/^\uFEFF/u, "")) as unknown);
  } catch (error) {
    const detail = error instanceof Error ? `: ${error.message}` : "";
    throw new Error(
      `Invalid input data${isInlineJson ? "" : ` in ${JSON.stringify(source)}`}${detail}. ` +
        "On Windows, prefer a JSON file or repeat --input \"name=value\".",
      { cause: error },
    );
  }
}

export function collectInputAssignment(value: string, previous: string[]): string[] {
  return [...previous, value];
}
