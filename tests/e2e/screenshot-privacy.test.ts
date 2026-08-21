import { once } from "node:events";
import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PNG } from "pngjs";
import { afterEach, describe, expect, it } from "vitest";
import { PlaywrightSurface } from "../../src/surface/playwright/playwrightSurface.js";

interface FixtureServer {
  readonly baseUrl: string;
  close(): Promise<void>;
}

async function startFixtureServer(): Promise<FixtureServer> {
  const server: Server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(`<!doctype html>
      <html><head><title>Privacy fixture</title></head><body>
        <label for="account-type">Account type</label>
        <select id="account-type" name="accountType">
          <option value="checking">Checking</option>
          <option value="savings">Savings</option>
        </select>
        <p>Request denied for <strong data-sensitive>DENIED-1001</strong>.</p>
      </body></html>`);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Privacy fixture did not bind a TCP port");
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

function maskedPixel(png: PNG, box: { x: number; y: number; width: number; height: number }): number[] {
  const sampleX = Math.round(box.x + box.width / 2);
  const sampleY = Math.round(box.y + box.height / 2);
  const offset = (sampleY * png.width + sampleX) * 4;
  return [...png.data.subarray(offset, offset + 4)];
}

describe("masked screenshot privacy", () => {
  let fixture: FixtureServer | undefined;
  let surface: PlaywrightSurface | undefined;
  let scratch: string | undefined;

  afterEach(async () => {
    await surface?.close();
    await fixture?.close();
    if (scratch) await rm(scratch, { recursive: true, force: true });
  });

  async function startSurface(): Promise<void> {
    fixture = await startFixtureServer();
    scratch = await mkdtemp(path.join(tmpdir(), "screenshot-mask-test-"));
    surface = new PlaywrightSurface({ observationDirectory: scratch });
    await surface.start(fixture.baseUrl);
  }

  it("covers a selected value with the configured opaque mask color", async () => {
    await startSurface();
    const select = surface!.page.getByLabel("Account type", { exact: true });
    await select.selectOption({ label: "Savings" });
    const box = await select.boundingBox();
    expect(box).not.toBeNull();

    const png = PNG.sync.read(await surface!.captureMaskedScreenshot());
    expect(maskedPixel(png, box!)).toEqual([17, 17, 17, 255]);
  });

  it("covers a dynamic member identifier inside failure prose", async () => {
    await startSurface();
    const memberIdentifier = surface!.page.locator("[data-sensitive]");
    await memberIdentifier.waitFor({ state: "visible" });
    const box = await memberIdentifier.boundingBox();
    expect(box).not.toBeNull();

    const png = PNG.sync.read(await surface!.captureMaskedScreenshot());
    expect(maskedPixel(png, box!)).toEqual([17, 17, 17, 255]);
  });
});
