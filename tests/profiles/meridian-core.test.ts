import { describe, expect, it } from "vitest";
import { createMeridianSurfaceOptions } from "../../src/profiles/meridianCore.js";

describe("MERIDIAN evidence privacy profile", () => {
  it("masks the authenticated footer that echoes operator and session identifiers", () => {
    const options = createMeridianSurfaceOptions("observations");
    expect(options.sensitiveSelectors).toContain(
      'td[bgcolor="#e4e4e4"][style*="border-top"]',
    );
    expect(options.sensitiveSelectors).toContain('font[color="#555555"]');
  });
});
