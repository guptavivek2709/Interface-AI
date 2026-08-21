import { afterEach, describe, expect, it, vi } from "vitest";
import { createChatRouter } from "../../src/chat/factory.js";

describe("createChatRouter", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("constructs Anthropic as the sole production provider", () => {
    expect(createChatRouter({ apiKey: "unit-test-key" }).name).toBe("anthropic-messages");
  });

  it("fails closed when the Anthropic key is missing", () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    expect(() => createChatRouter({ apiKey: "" })).toThrowError(
      expect.objectContaining({ code: "PROVIDER_CONFIGURATION_ERROR" }),
    );
  });
});
