import { once } from "node:events";
import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PlannerAction } from "../../src/model/planner.js";
import type { TargetV2 } from "../../src/domain/index.js";
import { PlaywrightSurface } from "../../src/surface/playwright/playwrightSurface.js";
import { PlaywrightReplayRuntimeV2 } from "../../src/surface/playwright/runtimeV2.js";

interface FixtureServer {
  baseUrl: string;
  close(): Promise<void>;
}

function action(
  kind: "click" | "select",
  targetRef: string,
  value: string | null = null,
): PlannerAction {
  return {
    kind,
    targetRef,
    value: value === null ? null : { kind: "literal", name: null, value },
    outputName: null,
    outputType: null,
    key: null,
  };
}

async function startFixtureServer(): Promise<FixtureServer> {
  const server: Server = createServer((request, response) => {
    const requestUrl = new URL(request.url ?? "/", "http://fixture.invalid");
    if (requestUrl.pathname === "/legacy") {
      response.writeHead(207, { "content-type": "text/html; charset=utf-8" });
      response.end(`<!doctype html>
        <html><head><title>Legacy controls</title></head><body>
          <table><tr><td><a href="/menu">Main Menu</a> <a href="/members">Member Inquiry</a></td></tr></table>
          <p><a href="/wrong-menu">Main Menu</a></p>
          <label for="operator-password">Operator password</label>
          <input id="operator-password" name="operatorPassword" type="password" value="PASSWORD_CANARY_8371">
          <label for="member-number">Member number</label>
          <input id="member-number" name="memberNumber" type="text" value="100234">
          <input name="plainAction" type="button" value="Plain Action">
          <input name="resetAction" type="reset" value="Reset Form">
          <input name="imageAction" type="image" value="Image Action" alt="" width="16" height="16"
            src="data:image/gif;base64,R0lGODlhAQABAAAAACw=">
          <form action="/redirect" method="get">
            <input name="searchAction" type="submit" value="Search Members">
          </form>
          <label for="branch">Branch</label>
           <select id="branch" name="branch">
            <option value="">Choose a branch</option>
            <option value="MAIN-001">Main Office</option>
             <option value="WEST-014">West Office</option>
           </select>
           <table>
             <tr><th>Share ID</th><th>Type</th><th>Balance</th><th>Status</th><th>Action</th></tr>
             <tr><td>100234-S0001</td><td>Checking</td><td>$1,234.56</td><td>OPEN</td><td><a href="/selected?share=100234-S0001">Select</a></td></tr>
             <tr><td>100234-S0070</td><td>Savings</td><td>USD 25.00</td><td>HOLD</td><td><a href="/selected?share=100234-S0070">Select</a></td></tr>
           </table>
           <table><tr><th scope="row">Member name</th><td>Alex Example</td></tr></table>
           <table>
             <tr><th>Duplicate</th><th>Duplicate</th></tr>
             <tr><td>first</td><td>second</td></tr>
           </table>
           <iframe title="Failure frame" src="/frame"></iframe>
          <img alt="failing asset" src="/asset">
        </body></html>`);
      return;
    }
    if (requestUrl.pathname === "/redirect") {
      response.writeHead(302, { location: "/result" });
      response.end();
      return;
    }
    if (requestUrl.pathname === "/menu") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end("<!doctype html><title>Main menu</title><h1>Main menu</h1>");
      return;
    }
    if (requestUrl.pathname === "/result") {
      response.writeHead(422, { "content-type": "text/html; charset=utf-8" });
      response.end("<!doctype html><title>Search rejected</title><h1>Search rejected</h1>");
      return;
    }
    if (requestUrl.pathname === "/slow-result") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.write("<!doctype html><html><head><title>Loading result</title></head><body>");
      setTimeout(() => response.end("<h1>Stable result</h1></body></html>"), 75);
      return;
    }
    if (requestUrl.pathname === "/frame") {
      response.writeHead(418, { "content-type": "text/html; charset=utf-8" });
      response.end("<!doctype html><title>Frame response</title><p>Frame response</p>");
      return;
    }
    if (requestUrl.pathname === "/selected") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(`<!doctype html><title>Selected share</title><h1>Selected ${requestUrl.searchParams.get("share") ?? ""}</h1>`);
      return;
    }
    if (requestUrl.pathname === "/asset") {
      response.writeHead(503, { "content-type": "image/png" });
      response.end();
      return;
    }
    response.writeHead(404).end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Fixture server did not bind a TCP port");
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

describe("PlaywrightSurface legacy HTML semantics", () => {
  let fixture: FixtureServer | undefined;
  let scratch: string | undefined;
  let surface: PlaywrightSurface | undefined;

  beforeEach(async () => {
    fixture = await startFixtureServer();
    scratch = await mkdtemp(path.join(tmpdir(), "playwright-surface-test-"));
    surface = new PlaywrightSurface({ observationDirectory: scratch });
    await surface.start(`${fixture.baseUrl}/legacy`);
  });

  afterEach(async () => {
    await surface?.close();
    await fixture?.close();
    if (scratch) await rm(scratch, { recursive: true, force: true });
  });

  it("observes native input buttons by their values without exposing password values", async () => {
    const observation = await surface!.observe();
    for (const name of ["Search Members", "Plain Action", "Reset Form", "Image Action"]) {
      expect(observation.controls).toContainEqual(
        expect.objectContaining({ role: "button", name, tag: "input" }),
      );
    }

    expect(observation.controls).toContainEqual(
      expect.objectContaining({
        role: "textbox",
        name: "Operator password",
        nameAttribute: "operatorPassword",
        value: null,
      }),
    );
    expect(observation.controls).toContainEqual(
      expect.objectContaining({ role: "textbox", name: "Member number", value: "100234" }),
    );
    expect(JSON.stringify(observation)).not.toContain("PASSWORD_CANARY_8371");
  });

  it("selects an option by an exact stable value as well as an exact label", async () => {
    const observation = await surface!.observe();
    const branch = observation.controls.find((control) => control.name === "Branch");
    expect(branch).toBeDefined();

    await surface!.actFromObservation(action("select", branch!.ref, "MAIN-001"), observation, {});
    await expect(surface!.page.getByLabel("Branch").inputValue()).resolves.toBe("MAIN-001");

    await surface!.actFromObservation(action("select", branch!.ref, "West Office"), observation, {});
    await expect(surface!.page.getByLabel("Branch").inputValue()).resolves.toBe("WEST-014");

    await expect(
      surface!.actFromObservation(action("select", branch!.ref, "main"), observation, {}),
    ).rejects.toThrow(/did not match exactly one option/u);
  });

  it("uses an exact reviewed fallback when an earlier locator strategy is ambiguous", async () => {
    const navigationTarget: TargetV2 = {
      id: "main-menu",
      description: "Persistent navigation link",
      framePath: [],
      strategies: [
        { kind: "role", role: "link", name: "Main Menu", exact: true },
        { kind: "navigation_link", name: "Main Menu", exact: true, companionText: "Member Inquiry" },
      ],
      cardinality: "exactly_one",
      sensitive: false,
    };
    const runtime = new PlaywrightReplayRuntimeV2(surface!, { targets: [navigationTarget] });
    const receipt = await runtime.act(
      { kind: "click", targetId: "main-menu" },
      { inputs: {}, bindings: {} },
    );
    expect(receipt.strategy).toBe("navigation_link");
    expect(receipt.attempts).toEqual([
      expect.objectContaining({ strategy: "role", count: 2 }),
      expect.objectContaining({ strategy: "navigation_link", count: 1 }),
    ]);
    expect(new URL(surface!.page.url()).pathname).toBe("/menu");
  });

  it("tracks the latest main-document status without accepting frame or asset statuses", async () => {
    const initial = await surface!.observe();
    expect(initial.httpStatus).toBe(207);
    expect(surface!.lastMainDocumentStatus).toBe(207);

    const search = initial.controls.find((control) => control.name === "Search Members");
    expect(search).toBeDefined();
    await surface!.actFromObservation(action("click", search!.ref), initial, {});

    const result = await surface!.observe();
    expect(result.url).toBe(`${fixture!.baseUrl}/result`);
    expect(result.httpStatus).toBe(422);
    expect(surface!.lastMainDocumentStatus).toBe(422);
  });

  it("extracts structured balances and rejects duplicate runtime table headers", async () => {
    const sharesTarget: TargetV2 = {
      id: "shares",
      description: "Structured share balances",
      framePath: [],
      strategies: [{ kind: "table", headers: ["Share ID", "Type", "Balance", "Status"] }],
      cardinality: "exactly_one",
      sensitive: true,
    };
    const duplicateTarget: TargetV2 = {
      id: "duplicates",
      description: "Ambiguous duplicate table headers",
      framePath: [],
      strategies: [{ kind: "table", headers: ["Duplicate"] }],
      cardinality: "exactly_one",
      sensitive: false,
    };
    const runtime = new PlaywrightReplayRuntimeV2(surface!, { targets: [sharesTarget, duplicateTarget] });
    const context = { inputs: {}, bindings: {} };
    const extracted = await runtime.act({
      kind: "extract_table",
      targetId: "shares",
      outputName: "shares",
      columns: [
        { header: "Share ID", key: "share_id", type: { kind: "string", format: "share_id" }, classification: "restricted" },
        { header: "Type", key: "type", type: { kind: "string" }, classification: "internal" },
        { header: "Balance", key: "balance", type: { kind: "money", currency: "USD" }, classification: "restricted" },
        { header: "Status", key: "status", type: { kind: "string" }, classification: "internal" },
      ],
    }, context);
    expect(extracted.value).toEqual([
      {
        share_id: "100234-S0001",
        type: "Checking",
        balance: { currency: "USD", amount: "1234.56", minorUnits: 123_456 },
        status: "OPEN",
      },
      {
        share_id: "100234-S0070",
        type: "Savings",
        balance: { currency: "USD", amount: "25.00", minorUnits: 2_500 },
        status: "HOLD",
      },
    ]);

    await expect(runtime.act({
      kind: "extract_table",
      targetId: "duplicates",
      outputName: "duplicates",
      columns: [{ header: "Duplicate", key: "value", type: { kind: "string" }, classification: "internal" }],
    }, context)).rejects.toThrow(/duplicate header/u);
  });

  it("observes and resolves label-value, table, and input-keyed row semantics", async () => {
    const observation = await surface!.observe({ share_id: "100234-S0070" });
    const labelValue = observation.semanticTargets?.find(
      (target) => target.kind === "label_value" && target.label === "Member name",
    );
    const table = observation.semanticTargets?.find(
      (target) => target.kind === "table" && target.headers.includes("Share ID"),
    );
    const rowControl = observation.semanticTargets?.find(
      (target) => target.kind === "table_row_control" && target.keyInputName === "share_id",
    );
    const rowValue = observation.semanticTargets?.find(
      (target) =>
        target.kind === "table_row_value" &&
        target.keyInputName === "share_id" &&
        target.valueColumn === "Status",
    );
    expect(labelValue).toEqual(expect.objectContaining({ valueCellOffset: 1 }));
    expect(table).toEqual(
      expect.objectContaining({ headers: ["Share ID", "Type", "Balance", "Status", "Action"] }),
    );
    expect(rowControl).toEqual(
      expect.objectContaining({
        keyColumn: "Share ID",
        controlRole: "link",
        controlName: "Select",
      }),
    );
    expect(rowValue).toEqual(
      expect.objectContaining({
        keyColumn: "Share ID",
        valueColumn: "Status",
      }),
    );
    expect(JSON.stringify(rowControl)).not.toContain("100234-S0070");
    expect(JSON.stringify(rowValue)).not.toContain("100234-S0070");

    const scalar = await surface!.actFromObservation(
      {
        kind: "extract",
        targetRef: labelValue!.ref,
        value: null,
        outputName: "member_name",
        outputType: "string",
        key: null,
      },
      observation,
      { share_id: "100234-S0070" },
    );
    expect(scalar.observedValue).toBe("Alex Example");

    const rows = await surface!.actFromObservation(
      {
        kind: "extract",
        targetRef: table!.ref,
        value: null,
        outputName: "shares",
        outputType: "table",
        key: null,
      },
      observation,
      { share_id: "100234-S0070" },
    );
    expect(JSON.parse(rows.observedValue ?? "[]")).toEqual([
      expect.objectContaining({ "Share ID": "100234-S0001", Status: "OPEN" }),
      expect.objectContaining({ "Share ID": "100234-S0070", Status: "HOLD" }),
    ]);

    const status = await surface!.actFromObservation(
      {
        kind: "extract",
        targetRef: rowValue!.ref,
        value: null,
        outputName: "share_status",
        outputType: "string",
        key: null,
      },
      observation,
      { share_id: "100234-S0070" },
    );
    expect(status.observedValue).toBe("HOLD");

    await surface!.actFromObservation(
      {
        kind: "click",
        targetRef: rowControl!.ref,
        value: null,
        outputName: null,
        outputType: null,
        key: null,
      },
      observation,
      { share_id: "100234-S0070" },
    );
    expect(new URL(surface!.page.url()).searchParams.get("share")).toBe("100234-S0070");
  });

  it("lets an adapter redact path and query identifiers from observations and DOM evidence", async () => {
    await surface!.close();
    surface = new PlaywrightSurface({
      observationDirectory: scratch!,
      redactObservedUrl: (url) => {
        url.pathname = "/legacy/[MEMBER]";
        if (url.searchParams.has("q")) url.searchParams.set("q", "[REDACTED]");
      },
    });
    await surface.start(`${fixture!.baseUrl}/legacy?q=PII_CANARY_100234#private-fragment`);

    const observation = await surface.observe();
    const dom = await surface.domSnapshot();
    expect(observation.url).toContain("/legacy/[MEMBER]");
    expect(JSON.stringify(observation)).not.toContain("PII_CANARY_100234");
    expect(dom).not.toContain("PII_CANARY_100234");
    expect(dom).not.toContain("private-fragment");
  });

  it("reacquires the main document when evidence capture begins during navigation", async () => {
    await surface!.page.goto(`${fixture!.baseUrl}/slow-result`, { waitUntil: "commit" });
    const dom = await surface!.domSnapshot();
    expect(dom).toContain("Stable result");
    expect(dom).not.toContain("detached frame");
  });
});
