import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PNG } from "pngjs";
import { afterEach, describe, expect, it } from "vitest";
import { startDemoServer, type DemoServer } from "../../src/demo/index.js";
import { createLegacyBankProfile } from "../../src/profiles/index.js";
import { PolicyEngine } from "../../src/safety/policy.js";
import { PlaywrightSurface } from "../../src/surface/playwright/playwrightSurface.js";

describe("masked screenshot privacy", () => {
  let demo: DemoServer | undefined;
  let surface: PlaywrightSurface | undefined;
  let scratch: string | undefined;

  afterEach(async () => {
    await surface?.close();
    await demo?.close();
    if (scratch) await rm(scratch, { recursive: true, force: true });
  });

  it("covers a selected value with the configured opaque mask color", async () => {
    demo = await startDemoServer();
    scratch = await mkdtemp(path.join(tmpdir(), "screenshot-mask-test-"));
    const profile = createLegacyBankProfile(demo.baseUrl);
    const policy = new PolicyEngine(profile.policy);
    surface = new PlaywrightSurface({
      observationDirectory: scratch,
      assertNavigationAllowed: (url, kind) => policy.assertNavigationAllowed({ url, kind }),
      assertResourceAllowed: (url) => policy.assertResourceAllowed(url),
    });
    await surface.start(`${demo.baseUrl}/?tenant=summit`);

    const workspace = surface.page.frameLocator('iframe[title="Core banking workspace"]');
    await workspace.getByLabel("Member number", { exact: true }).fill("MBR-1001");
    await workspace.getByRole("button", { name: "Search", exact: true }).click();
    await workspace.getByRole("button", { name: "Open sub-account", exact: true }).click();
    const select = workspace.getByLabel("Account type", { exact: true });
    await select.selectOption({ label: "Savings" });
    const box = await select.boundingBox();
    expect(box).not.toBeNull();

    const png = PNG.sync.read(await surface.captureMaskedScreenshot());
    const sampleX = Math.round(box!.x + box!.width / 2);
    const sampleY = Math.round(box!.y + box!.height / 2);
    const offset = (sampleY * png.width + sampleX) * 4;
    expect([...png.data.subarray(offset, offset + 4)]).toEqual([17, 17, 17, 255]);
  });

  it("covers a dynamic member identifier inside failure prose", async () => {
    demo = await startDemoServer();
    scratch = await mkdtemp(path.join(tmpdir(), "screenshot-mask-test-"));
    const profile = createLegacyBankProfile(demo.baseUrl);
    const policy = new PolicyEngine(profile.policy);
    surface = new PlaywrightSurface({
      observationDirectory: scratch,
      assertNavigationAllowed: (url, kind) => policy.assertNavigationAllowed({ url, kind }),
      assertResourceAllowed: (url) => policy.assertResourceAllowed(url),
    });
    await surface.start(`${demo.baseUrl}/?tenant=summit`);

    const workspace = surface.page.frameLocator('iframe[title="Core banking workspace"]');
    await workspace.getByLabel("Member number", { exact: true }).fill("DENIED-1001");
    await workspace.getByRole("button", { name: "Search", exact: true }).click();
    const memberIdentifier = workspace.locator('[data-sensitive="member-number"]');
    await memberIdentifier.waitFor({ state: "visible" });
    expect(await memberIdentifier.count()).toBe(1);
    const box = await memberIdentifier.boundingBox();
    expect(box).not.toBeNull();

    const png = PNG.sync.read(await surface.captureMaskedScreenshot());
    const sampleX = Math.round(box!.x + box!.width / 2);
    const sampleY = Math.round(box!.y + box!.height / 2);
    const offset = (sampleY * png.width + sampleX) * 4;
    expect([...png.data.subarray(offset, offset + 4)]).toEqual([17, 17, 17, 255]);
  });
});
