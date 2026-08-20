import { describe, expect, it } from "vitest";
import { meridianArtifacts } from "../../src/capabilities/index.js";
import { CapabilityCatalog } from "../../src/catalog/index.js";
import {
  catalogToChatTools,
  compileAnthropicTools,
  prepareChatTools,
} from "../../src/chat/index.js";

function containsSchemaKey(value: unknown, searchedKey: string): boolean {
  if (Array.isArray(value)) return value.some((item) => containsSchemaKey(item, searchedKey));
  if (value === null || typeof value !== "object") return false;
  return Object.entries(value).some(
    ([key, child]) => key === searchedKey || containsSchemaKey(child, searchedKey),
  );
}

describe("catalog chat projection", () => {
  it("excludes sign-on and exposes money as a decimal boundary value", () => {
    const catalog = CapabilityCatalog.fromArtifacts(meridianArtifacts);
    const entries = catalog
      .list()
      .map((metadata) => catalog.resolve(metadata.id, metadata.version))
      .filter((entry): entry is NonNullable<typeof entry> => entry !== undefined);
    const tools = catalogToChatTools(entries);

    expect(tools.some((tool) => tool.capabilityId === "session.sign_on")).toBe(false);
    const transfer = tools.find((tool) => tool.capabilityId === "funds.transfer")!;
    const common = {
      member_number: "100234",
      from_share: "100234-S0070",
      to_share: "100234-S0001-3",
      memo: "test",
    };
    expect(transfer.inputSchema.safeParse({ ...common, amount: "1.25" }).success).toBe(true);
    expect(
      transfer.inputSchema.safeParse({
        ...common,
        amount: { currency: "USD", amount: "1.25", minorUnits: 125 },
      }).success,
    ).toBe(false);
  });

  it("compiles the complete approved catalog to Anthropic's strict schema subset", () => {
    const catalog = CapabilityCatalog.fromArtifacts(meridianArtifacts);
    const entries = catalog
      .list()
      .map((metadata) => catalog.resolve(metadata.id, metadata.version))
      .filter((entry): entry is NonNullable<typeof entry> => entry !== undefined);
    const tools = catalogToChatTools(entries);
    const compiled = compileAnthropicTools(prepareChatTools(tools));

    expect(compiled).toHaveLength(tools.length);
    expect(compiled.length).toBeGreaterThan(0);
    for (const tool of compiled) {
      expect(tool.inputSchema).toMatchObject({
        type: "object",
        additionalProperties: false,
      });
      expect(containsSchemaKey(tool.inputSchema, "pattern")).toBe(false);
    }
  });
});
