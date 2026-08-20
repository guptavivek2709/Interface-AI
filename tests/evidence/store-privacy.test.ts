import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
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
        <script>globalThis.PII_CANARY_SCRIPT = true</script>
        <a href="https://example.test/PII_CANARY_LINK" onclick="PII_CANARY_CLICK()">safe label</a>
        <output aria-label="Nickname">PII_CANARY_RAINY</output>
        <input value="PII_CANARY_INPUT">
        <textarea>PII_CANARY_TEXTAREA</textarea>
        <select><option selected>PII_CANARY_SELECTED</option></select>
      </main>`,
    );
    const persisted = await readFile(store.resolve(reference), "utf8");
    expect(persisted).not.toContain("PII_CANARY_");
    expect(persisted).not.toContain("<script");
    expect(persisted).not.toContain("onclick");
    expect(persisted).toContain('href="#"');
    expect(persisted).toContain("[REDACTED]");
  });

  it("removes temporary files when an atomic rename fails", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "evidence-store-atomic-"));
    cleanup.push(directory);
    const store = await EvidenceStore.create({
      rootDirectory: directory,
      runId: "atomic-failure",
      renameFile: async () => {
        throw new Error("simulated rename failure");
      },
    });
    await expect(store.saveText("diagnostic", "safe")).rejects.toThrow("simulated rename failure");
    const entries = await readdir(path.join(store.runDirectory, "text"));
    expect(entries).toEqual([]);
  });

  it("hashes a flushed event log before writing the final manifest marker", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "evidence-store-finalized-"));
    cleanup.push(directory);
    const store = await EvidenceStore.create({ rootDirectory: directory, runId: "finalized-log" });
    await writeFile(path.join(store.runDirectory, "events.jsonl"), '{"type":"run.started"}\n', "utf8");
    const events = await store.registerFinalizedFile(
      "events.jsonl",
      "json",
      "application/x-ndjson; charset=utf-8",
      { redacted: true },
    );
    await store.writeManifest({ status: "success" });
    const manifest = JSON.parse(await readFile(path.join(store.runDirectory, "manifest.json"), "utf8")) as {
      evidence: Array<{ path: string; sha256: string }>;
    };
    expect(manifest.evidence).toContainEqual(expect.objectContaining({
      path: "events.jsonl",
      sha256: events.sha256,
    }));
  });
});
