import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { z } from "zod";

export interface StoredArtifact<T> {
  artifact: T;
  sha256: string;
  path: string;
}

export class JsonArtifactStore<T> {
  readonly #schema: z.ZodType<T>;

  constructor(schema: z.ZodType<T>) {
    this.#schema = schema;
  }

  async save(filePath: string, value: unknown): Promise<StoredArtifact<T>> {
    const artifact = this.#schema.parse(value);
    const serialized = `${JSON.stringify(artifact, null, 2)}\n`;
    const absolute = path.resolve(filePath);
    await mkdir(path.dirname(absolute), { recursive: true });
    const temporary = path.join(
      path.dirname(absolute),
      `.${path.basename(absolute)}.${randomBytes(6).toString("hex")}.tmp`,
    );
    await writeFile(temporary, serialized, { encoding: "utf8", flag: "wx", mode: 0o600 });
    await rename(temporary, absolute);
    return {
      artifact,
      sha256: createHash("sha256").update(serialized).digest("hex"),
      path: absolute,
    };
  }

  async load(filePath: string): Promise<StoredArtifact<T>> {
    const absolute = path.resolve(filePath);
    const serialized = await readFile(absolute, "utf8");
    const raw = JSON.parse(serialized) as unknown;
    const artifact = this.#schema.parse(raw);
    return {
      artifact,
      sha256: createHash("sha256").update(serialized).digest("hex"),
      path: absolute,
    };
  }
}
