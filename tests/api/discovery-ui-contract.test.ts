import { describe, expect, it } from "vitest";
import { PublishedDiscoveryHistory } from "../../src/api/discoveryRuns.js";
import { loadConfiguredCapabilityCatalog } from "../../src/catalog/configuredCatalog.js";
import { normalizeDiscoveryRun } from "../../web/api.js";

describe("published discovery history UI contract", () => {
  it("normalizes the real server projection without losing evidence references", async () => {
    const catalog = await loadConfiguredCapabilityCatalog();
    const projected = new PublishedDiscoveryHistory(catalog).list();
    expect(projected).toHaveLength(8);

    for (const wireRecord of projected) {
      const normalized = normalizeDiscoveryRun({ discoveryRun: wireRecord });
      expect(normalized).toMatchObject({
        kind: "discovery",
        id: wireRecord.discoveryRunId,
        discoveryRunId: wireRecord.discoveryRunId,
        status: "approved",
        provider: "anthropic-messages",
        inputs: wireRecord.inputs.map((input) => expect.objectContaining({
          name: input.name,
          valueStatus: "withheld",
        })),
        outputContract: wireRecord.outputContract.map((output) => expect.objectContaining({
          name: output.name,
          classification: output.classification,
          required: false,
        })),
        output: wireRecord.output,
        evidence: wireRecord.evidence.map((reference) => expect.objectContaining({
          kind: reference.kind,
          label: reference.referenceId,
          sha256: reference.sha256,
          href: reference.url,
        })),
      });
      expect(normalized?.outputContract).toHaveLength(wireRecord.outputContract.length);
      expect(normalized?.timeline).toHaveLength(4);
    }
  });
});
