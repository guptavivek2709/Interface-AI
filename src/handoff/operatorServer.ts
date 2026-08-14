import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { HandoffSurface } from "../surface/types.js";
import { ControlCoordinator, type ControlLease } from "./controlCoordinator.js";

interface JsonBody {
  operatorId?: string;
  accessibleName?: string;
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(value));
}

async function readJson(request: IncomingMessage): Promise<JsonBody> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  if (chunks.length === 0) return {};
  const value = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected JSON object");
  return value as JsonBody;
}

export class OperatorServer {
  readonly #coordinator: ControlCoordinator;
  readonly #surface: HandoffSurface;
  readonly #host: string;
  readonly #port: number;
  #lease: ControlLease | null = null;
  #server: ReturnType<typeof createServer> | null = null;
  #baseUrl: string | null = null;

  constructor(options: {
    coordinator: ControlCoordinator;
    surface: HandoffSurface;
    host?: string;
    port?: number;
  }) {
    this.#coordinator = options.coordinator;
    this.#surface = options.surface;
    this.#host = options.host ?? "127.0.0.1";
    this.#port = options.port ?? 0;
  }

  get baseUrl(): string {
    if (!this.#baseUrl) throw new Error("Operator server has not started");
    return this.#baseUrl;
  }

  async start(): Promise<string> {
    if (this.#server) return this.baseUrl;
    this.#server = createServer((request, response) => {
      void this.#handle(request, response).catch((error: unknown) => {
        sendJson(response, 400, { error: error instanceof Error ? error.message : String(error) });
      });
    });
    await new Promise<void>((resolve, reject) => {
      this.#server!.once("error", reject);
      this.#server!.listen(this.#port, this.#host, () => resolve());
    });
    const address = this.#server.address() as AddressInfo;
    this.#baseUrl = `http://${this.#host}:${address.port}`;
    return this.#baseUrl;
  }

  async close(): Promise<void> {
    if (!this.#server) return;
    await new Promise<void>((resolve, reject) =>
      this.#server!.close((error) => (error ? reject(error) : resolve())),
    );
    this.#server = null;
    this.#baseUrl = null;
    this.#lease = null;
  }

  async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", this.#baseUrl ?? "http://localhost");
    if (request.method === "GET" && url.pathname === "/") {
      const intervention = this.#coordinator.intervention;
      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      });
      response.end(this.#html(intervention?.reason ?? "No active intervention"));
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/intervention") {
      sendJson(response, 200, {
        phase: this.#coordinator.phase,
        intervention: this.#coordinator.intervention,
        sameSessionRef: this.#surface.sessionRef,
      });
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/take") {
      const body = await readJson(request);
      this.#lease = await this.#coordinator.takeHumanControl(body.operatorId ?? "operator");
      sendJson(response, 200, { ok: true, leaseEpoch: this.#lease.epoch });
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/click") {
      const body = await readJson(request);
      if (!this.#lease) throw new Error("Take control before acting");
      const accessibleName = body.accessibleName?.trim();
      if (!accessibleName) throw new Error("accessibleName is required");
      await this.#coordinator.recordHumanAction(
        this.#lease,
        `click button named ${JSON.stringify(accessibleName)}`,
        async () => this.#surface.humanClick(accessibleName),
      );
      sendJson(response, 200, { ok: true, sessionRef: this.#surface.sessionRef });
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/resume") {
      if (!this.#lease) throw new Error("Take control before resuming");
      const automationLease = await this.#coordinator.resumeAutomation(this.#lease);
      this.#lease = null;
      sendJson(response, 200, { ok: true, automationLeaseEpoch: automationLease.epoch });
      return;
    }
    sendJson(response, 404, { error: "Not found" });
  }

  #html(reason: string): string {
    const escaped = reason
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
    return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>Live session handoff</title><style>
body{font:16px system-ui;max-width:760px;margin:48px auto;padding:0 24px;background:#f6f8fb;color:#172033}
.card{background:white;border:1px solid #dbe2ec;border-radius:14px;padding:28px;box-shadow:0 8px 30px #21324d14}
button{display:block;width:100%;margin:12px 0;padding:13px;border:0;border-radius:8px;background:#1647b8;color:white;font-weight:700;cursor:pointer}
#log{white-space:pre-wrap;background:#eef2f8;padding:12px;border-radius:8px;min-height:56px}
</style></head><body><div class="card"><h1>Human intervention</h1><p>${escaped}</p>
<button id="take">1. Take exclusive control</button>
<button id="repair">2. Restore training session in the live browser</button>
<button id="resume">3. Hand control back</button><div id="log" aria-live="polite"></div></div>
<script>
const log=document.querySelector('#log');
async function post(path,body={}){const r=await fetch(path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});const j=await r.json();if(!r.ok)throw new Error(j.error);log.textContent=JSON.stringify(j,null,2);}
document.querySelector('#take').onclick=()=>post('/api/take',{operatorId:'browser-operator'});
document.querySelector('#repair').onclick=()=>post('/api/click',{accessibleName:'Restore training session'});
document.querySelector('#resume').onclick=()=>post('/api/resume');
</script></body></html>`;
  }
}

export async function performDemoOperatorHandoff(baseUrl: string): Promise<void> {
  const post = async (path: string, body: Record<string, string> = {}) => {
    const response = await fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`Operator request ${path} failed: ${await response.text()}`);
  };
  await post("/api/take", { operatorId: "reproducible-demo-operator" });
  await post("/api/click", { accessibleName: "Restore training session" });
  await post("/api/resume");
}
