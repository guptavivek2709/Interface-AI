import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EvidenceStore } from "../../src/evidence/store.js";
import { Redactor } from "../../src/safety/redactor.js";

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe("EvidenceStore DOM privacy", () => {
  it("removes marked content, outputs, selected options, and live form values", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "evidence-store-privacy-"));
    cleanup.push(directory);
    const store = await EvidenceStore.create({
      rootDirectory: directory,
      runId: "privacy-canary",
      redactor: new Redactor(),
    });
    const reference = await store.saveDomSnapshot(
      "canary",
      `<main>
        <td data-sensitive="member-name">PII_CANARY_ELENA</td>
        <output aria-label="Nickname">PII_CANARY_RAINY</output>
        <input value="PII_CANARY_INPUT">
        <textarea>PII_CANARY_TEXTAREA</textarea>
        <select><option selected>PII_CANARY_SELECTED</option></select>
      </main>`,
    );
    const persisted = await readFile(store.resolve(reference), "utf8");
    expect(persisted).not.toContain("PII_CANARY_");
    expect(persisted).toContain("[REDACTED]");
  });
});
