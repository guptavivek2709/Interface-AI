import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

/** Test-only MERIDIAN HTTP fixture. This module is never exported by production code. */

export type MeridianFixtureFault =
  | "validation"
  | "notfound"
  | "permission"
  | "timeout"
  | "maintenance"
  | "server";

export interface MeridianFixtureOptions {
  readonly host?: string;
  readonly port?: number;
  readonly fault?: MeridianFixtureFault;
}

export interface MeridianFixtureSnapshot {
  readonly members: ReadonlyArray<{
    number: string;
    name: string;
    email: string;
    phone: string;
    address: string;
    shares: ReadonlyArray<{ id: string; type: string; balanceMinor: number; status: "OPEN" | "HOLD" }>;
  }>;
  readonly commits: ReadonlyArray<{
    kind: "transfer" | "open_share" | "update_member" | "place_hold";
    confirmation: string;
    memberNumber: string;
  }>;
}

export interface MeridianFixtureServer {
  readonly baseUrl: string;
  setFault(fault?: MeridianFixtureFault): void;
  snapshot(): MeridianFixtureSnapshot;
  close(): Promise<void>;
}

interface Share {
  id: string;
  type: string;
  balanceMinor: number;
  status: "OPEN" | "HOLD";
}

interface Member {
  number: string;
  name: string;
  email: string;
  phone: string;
  address: string;
  shares: Share[];
}

interface Session {
  id: string;
  operator: string;
  role: "teller" | "supervisor";
  branch: string;
  tokens: Set<string>;
}

interface CommitRecord {
  kind: "transfer" | "open_share" | "update_member" | "place_hold";
  confirmation: string;
  memberNumber: string;
}

const SESSION_COOKIE = "meridian_fixture_session";
const BODY_LIMIT = 32 * 1024;

function escapeHtml(value: unknown): string {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function money(minor: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(minor / 100);
}

function parseMoney(value: string): number | undefined {
  if (!/^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,2})?$/u.test(value.trim())) return undefined;
  const parsed = Math.round(Number(value) * 100);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function fixtureMembers(): Map<string, Member> {
  return new Map([
    ["100234", {
      number: "100234",
      name: "Alex Smith",
      email: "alex.smith@example.test",
      phone: "+1 (206) 555-0142",
      address: "10 Main Street",
      shares: [
        { id: "100234-S0001", type: "Checking", balanceMinor: 25_000, status: "OPEN" },
        { id: "100234-S0070", type: "Savings", balanceMinor: 15_000, status: "OPEN" },
      ],
    }],
    ["100235", {
      number: "100235",
      name: "Jordan Smith",
      email: "jordan.smith@example.test",
      phone: "+1 (206) 555-0199",
      address: "20 Oak Avenue",
      shares: [{ id: "100235-S0001", type: "Checking", balanceMinor: 8_500, status: "OPEN" }],
    }],
    ["100987", {
      number: "100987",
      name: "Taylor Jones",
      email: "taylor.jones@example.test",
      phone: "+1 (425) 555-0100",
      address: "30 Pine Road",
      shares: [{ id: "100987-S0001", type: "Checking", balanceMinor: 5_000, status: "OPEN" }],
    }],
  ]);
}

function document(title: string, body: string, session?: Session): string {
  const nav = session
    ? `<nav><a href="/menu">Main Menu</a> | <a href="/members">Member Inquiry / Selection</a></nav>`
    : "";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
    <style>body{font-family:Arial,sans-serif;margin:18px;color:#111}table{border-collapse:collapse;margin:12px 0}th,td{border:1px solid #888;padding:6px 9px;text-align:left}form div{margin:8px 0}label{display:inline-block;min-width:150px}.error{border:2px solid #900;padding:10px}.notice{border:2px solid #886800;padding:10px}</style>
    </head><body>${nav}<h1>${escapeHtml(title.replace(/ - Meridian Core$/u, ""))}</h1>${body}
    ${session ? `<footer data-sensitive>Operator ${escapeHtml(session.operator)} · branch ${escapeHtml(session.branch)} · session ${escapeHtml(session.id)}</footer>` : ""}
    </body></html>`;
}

function sendHtml(response: ServerResponse, title: string, body: string, status = 200, session?: Session): void {
  sendRawHtml(response, status, document(title, body, session));
}

function redirect(response: ServerResponse, location: string, cookie?: string): void {
  response.writeHead(303, {
    location,
    "cache-control": "no-store",
    ...(cookie ? { "set-cookie": cookie } : {}),
  });
  response.end();
}

function cookies(request: IncomingMessage): Record<string, string> {
  const output: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const part of (request.headers.cookie ?? "").split(";")) {
    const separator = part.indexOf("=");
    if (separator < 1) continue;
    output[part.slice(0, separator).trim()] = decodeURIComponent(part.slice(separator + 1).trim());
  }
  return output;
}

async function formBody(request: IncomingMessage): Promise<URLSearchParams> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > BODY_LIMIT) throw new Error("REQUEST_TOO_LARGE");
    chunks.push(buffer);
  }
  return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
}

function exactValueTable(values: ReadonlyArray<readonly [string, unknown]>): string {
  return `<table><tbody>${values
    .map(([label, value]) => `<tr><th scope="row">${escapeHtml(label)}</th><td>${escapeHtml(value)}</td></tr>`)
    .join("")}</tbody></table>`;
}

function hidden(name: string, value: string): string {
  return `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`;
}

function select(name: string, options: readonly string[], selected = ""): string {
  return `<select name="${escapeHtml(name)}">${options
    .map((option) => `<option value="${escapeHtml(option)}"${option === selected ? " selected" : ""}>${escapeHtml(option)}</option>`)
    .join("")}</select>`;
}

function memberDetail(member: Member, session: Session): string {
  const shares = `<table><thead><tr><th>Share ID</th><th>Type</th><th>Balance</th><th>Status</th></tr></thead><tbody>${member.shares
    .map((share) => `<tr><td>${escapeHtml(share.id)}</td><td>${escapeHtml(share.type)}</td><td>${money(share.balanceMinor)}</td><td>${share.status}</td></tr>`)
    .join("")}</tbody></table>`;
  return document("Member Record - Meridian Core", `${exactValueTable([
    ["Member No.:", member.number],
    ["Name:", member.name],
    ["E-mail:", member.email],
    ["Phone:", member.phone],
    ["Address:", member.address],
  ])}${shares}<p><a href="/members/${member.number}/transfer">Funds Transfer</a> | <a href="/members/${member.number}/open-share">Open New Share</a> | <a href="/members/${member.number}/update">Update Member Information</a> | <a href="/members/${member.number}/hold">Place Account Hold</a></p>`, session);
}

function token(session: Session): string {
  const value = `opaque/${randomBytes(9).toString("base64url")}:${Date.now().toString(36)}`;
  session.tokens.add(value);
  return value;
}

function consumeToken(session: Session, value: string): boolean {
  if (!session.tokens.has(value)) return false;
  session.tokens.delete(value);
  return true;
}

function confirmation(prefix: string): string {
  return `${prefix}-${randomBytes(6).toString("hex").toUpperCase()}`;
}

function signOnPage(error?: string): string {
  return document("OPERATOR SIGN ON - Meridian Core", `${error ? `<p class="error">${escapeHtml(error)}</p>` : ""}
    <p>OPERATOR SIGN ON</p><form method="post" action="/signon">
      <div><label for="operator">Operator ID</label><input id="operator" name="operator" autocomplete="off"></div>
      <div><label for="password">Password</label><input id="password" name="password" type="password"></div>
      <div><label for="branch">Branch</label>${select("branch", ["MAIN-001", "WEST-014", "EAST-022"], "MAIN-001")}</div>
      <button type="submit">Sign On</button>
    </form>`);
}

function menuPage(session: Session): string {
  return document("Main Menu - Meridian Core", "<p>Authenticated training menu.</p>", session);
}

function searchPage(session: Session, url: URL, members: Map<string, Member>): string {
  const mode = url.searchParams.get("by") ?? "number";
  const query = url.searchParams.get("q") ?? "";
  let matches: Member[] = [];
  if (query) {
    if (mode === "number") {
      const member = members.get(query);
      if (member) matches = [member];
    } else {
      matches = [...members.values()].filter((member) => member.name.toLocaleLowerCase("en-US").includes(query.toLocaleLowerCase("en-US")));
    }
  }
  const result = !query
    ? ""
    : matches.length === 0
      ? "<p>No member records matched your search.</p>"
      : `<table><thead><tr><th>Member No.</th><th>Name</th><th>Shares</th><th>Action</th></tr></thead><tbody>${matches.map((member) => `<tr><td>${member.number}</td><td>${escapeHtml(member.name)}</td><td>${member.shares.length}</td><td><a href="/members/${member.number}">Select</a></td></tr>`).join("")}</tbody></table>`;
  return document("Member Inquiry - Meridian Core", `<form method="get" action="/members">
    <div><label for="by">Search by</label>${select("by", ["number", "name"], mode)}</div>
    <div><label for="q">Search value</label><input id="q" name="q" value="${escapeHtml(query)}"></div>
    <button type="submit">Search</button></form>${result}`, session);
}

function faultPage(fault: MeridianFixtureFault, session: Session): { status: number; html: string } {
  if (fault === "maintenance") {
    return {
      status: 503,
      html: document("Maintenance - Meridian Core", '<p class="notice">Maintenance is in progress.</p><a href="/menu">Continue</a>', session),
    };
  }
  const values: Record<Exclude<MeridianFixtureFault, "maintenance">, [number, string, string]> = {
    validation: [400, "Validation Rejected - Meridian Core", "MERIDIAN rejected the submitted values."],
    notfound: [404, "Record Not Found - Meridian Core", "The requested record was not found."],
    permission: [403, "Supervisor Required - Meridian Core", "Supervisor authorization is required."],
    timeout: [440, "Session Expired - Meridian Core", "The MERIDIAN session expired."],
    server: [500, "Application Error - Meridian Core", "MERIDIAN encountered an application error."],
  };
  const [status, title, message] = values[fault];
  return { status, html: document(title, `<p class="error">${escapeHtml(message)}</p>`, session) };
}

function sendRawHtml(response: ServerResponse, status: number, html: string): void {
  response.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "content-length": Buffer.byteLength(html),
    "cache-control": "no-store",
  });
  response.end(html);
}

function transactionForm(kind: "transfer" | "open-share" | "hold", member: Member, session: Session): string {
  const nonce = token(session);
  if (kind === "transfer") {
    const options = member.shares.map((share) => share.id);
    return document("Funds Transfer - Meridian Core", `<form method="post" action="/members/${member.number}/transfer/review">${hidden("_token", nonce)}
      <div><label>From share</label>${select("from", options, options[0])}</div>
      <div><label>To share</label>${select("to", options, options[1] ?? options[0])}</div>
      <div><label>Amount</label><input name="amount"></div><div><label>Memo</label><input name="memo" maxlength="60"></div>
      <button type="submit">Continue</button></form>`, session);
  }
  if (kind === "open-share") {
    return document("Open New Share - Meridian Core", `<form method="post" action="/members/${member.number}/open-share/review">${hidden("_token", nonce)}
      <div><label>Share type</label>${select("type", ["S0001", "S0070", "MMKT", "CERT"], "S0001")}</div>
      <div><label>Initial deposit</label><input name="deposit"></div><button type="submit">Continue</button></form>`, session);
  }
  return document("Place Account Hold - Meridian Core", `<form method="post" action="/members/${member.number}/hold/review">${hidden("_token", nonce)}
    <div><label>Share</label>${select("share", member.shares.map((share) => share.id), member.shares[0]?.id)}</div>
    <div><label>Reason</label>${select("reason", ["FRAUD", "LEGAL", "DECEASED"], "FRAUD")}</div>
    <div><label>Notes</label><input name="notes" maxlength="80"></div><button type="submit">Continue</button></form>`, session);
}

function reviewPage(
  kind: "transfer" | "open-share" | "hold",
  member: Member,
  session: Session,
  body: URLSearchParams,
): string | undefined {
  const nonce = body.get("_token") ?? "";
  if (!session.tokens.has(nonce)) return undefined;
  if (kind === "transfer") {
    return document("Confirm Transfer - Meridian Core", `${exactValueTable([
      ["Member:", member.number], ["From:", body.get("from") ?? ""], ["To:", body.get("to") ?? ""],
      ["Amount:", body.get("amount") ?? ""], ["Memo:", body.get("memo") ?? ""],
    ])}<form method="post" action="/members/${member.number}/transfer/post">${hidden("_token", nonce)}${hidden("from", body.get("from") ?? "")}${hidden("to", body.get("to") ?? "")}${hidden("amount", body.get("amount") ?? "")}${hidden("memo", body.get("memo") ?? "")}<button type="submit">Post Transfer</button></form>`, session);
  }
  if (kind === "open-share") {
    return document("Confirm New Share - Meridian Core", `${exactValueTable([
      ["Member:", member.number], ["Share Type:", body.get("type") ?? ""], ["Initial Deposit:", body.get("deposit") ?? ""],
    ])}<form method="post" action="/members/${member.number}/open-share/post">${hidden("_token", nonce)}${hidden("type", body.get("type") ?? "")}${hidden("deposit", body.get("deposit") ?? "")}<button type="submit">Open Share</button></form>`, session);
  }
  return document("Confirm Account Hold - Meridian Core", `${exactValueTable([
    ["Member:", member.number], ["Share:", body.get("share") ?? ""], ["Reason:", body.get("reason") ?? ""], ["Notes:", body.get("notes") ?? ""],
  ])}<form method="post" action="/members/${member.number}/hold/post">${hidden("_token", nonce)}${hidden("share", body.get("share") ?? "")}${hidden("reason", body.get("reason") ?? "")}${hidden("notes", body.get("notes") ?? "")}<button type="submit">Apply Hold</button></form>`, session);
}

function updateForm(member: Member, session: Session): string {
  const nonce = token(session);
  return document("Update Member Information - Meridian Core", `<form method="post" action="/members/${member.number}/update">${hidden("_token", nonce)}
    <div><label>E-mail</label><input name="email" value="${escapeHtml(member.email)}"></div>
    <div><label>Phone</label><input name="phone" value="${escapeHtml(member.phone)}"></div>
    <div><label>Address</label><input name="address" value="${escapeHtml(member.address)}"></div>
    <button type="submit">Save Changes</button></form>`, session);
}

function memberFromPath(pathname: string, members: Map<string, Member>): Member | undefined {
  const number = /^\/members\/([0-9]{6})(?:\/|$)/u.exec(pathname)?.[1];
  return number ? members.get(number) : undefined;
}

function copySnapshot(members: Map<string, Member>, commits: CommitRecord[]): MeridianFixtureSnapshot {
  return structuredClone({ members: [...members.values()], commits });
}

export async function startMeridianFixture(options: MeridianFixtureOptions = {}): Promise<MeridianFixtureServer> {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 0;
  const members = fixtureMembers();
  const sessions = new Map<string, Session>();
  const commits: CommitRecord[] = [];
  let pendingFault = options.fault;

  const server: Server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? "/", "http://fixture.invalid");
      const method = request.method?.toUpperCase() ?? "GET";
      if (method !== "GET" && method !== "POST" && method !== "HEAD") {
        response.writeHead(405, { allow: "GET, POST, HEAD" }).end();
        return;
      }

      if (url.pathname === "/signon" && method === "GET") {
        sendRawHtml(response, 200, signOnPage());
        return;
      }
      if (url.pathname === "/signon" && method === "POST") {
        const body = await formBody(request);
        const operator = body.get("operator") ?? "";
        const password = body.get("password") ?? "";
        const branch = body.get("branch") ?? "";
        const valid = (operator === "teller1" || operator === "super1") && password === "password" && ["MAIN-001", "WEST-014", "EAST-022"].includes(branch);
        if (!valid) {
          sendRawHtml(response, 200, signOnPage("Invalid operator ID or password."));
          return;
        }
        const id = randomBytes(18).toString("base64url");
        sessions.set(id, { id, operator, role: operator === "super1" ? "supervisor" : "teller", branch, tokens: new Set() });
        redirect(response, "/menu", `${SESSION_COOKIE}=${encodeURIComponent(id)}; HttpOnly; SameSite=Strict; Path=/`);
        return;
      }

      const sessionId = cookies(request)[SESSION_COOKIE];
      const session = sessionId ? sessions.get(sessionId) : undefined;
      if (!session) {
        sendRawHtml(response, 200, signOnPage());
        return;
      }
      if (url.pathname === "/signoff") {
        sessions.delete(session.id);
        redirect(response, "/signon", `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
        return;
      }
      if (url.pathname === "/menu") {
        sendRawHtml(response, 200, menuPage(session));
        return;
      }
      if (url.pathname === "/members" && method === "GET") {
        sendRawHtml(response, 200, searchPage(session, url, members));
        return;
      }

      const member = memberFromPath(url.pathname, members);
      if (!member) {
        sendHtml(response, "Record Not Found - Meridian Core", "<p>The requested record was not found.</p>", 404, session);
        return;
      }
      if (pendingFault) {
        const active = pendingFault;
        pendingFault = undefined;
        const page = faultPage(active, session);
        sendRawHtml(response, page.status, page.html);
        return;
      }
      if (url.pathname === `/members/${member.number}` && method === "GET") {
        sendRawHtml(response, 200, memberDetail(member, session));
        return;
      }
      for (const kind of ["transfer", "open-share", "hold"] as const) {
        if (url.pathname === `/members/${member.number}/${kind}` && method === "GET") {
          sendRawHtml(response, 200, transactionForm(kind, member, session));
          return;
        }
        if (url.pathname === `/members/${member.number}/${kind}/review` && method === "POST") {
          const body = await formBody(request);
          const html = reviewPage(kind, member, session, body);
          if (!html) {
            sendHtml(response, "Validation Rejected - Meridian Core", "<p>Invalid or expired transaction token.</p>", 400, session);
            return;
          }
          sendRawHtml(response, 200, html);
          return;
        }
        if (url.pathname === `/members/${member.number}/${kind}/post` && method === "POST") {
          const body = await formBody(request);
          if (!consumeToken(session, body.get("_token") ?? "")) {
            sendHtml(response, "Validation Rejected - Meridian Core", "<p>Invalid or expired transaction token.</p>", 400, session);
            return;
          }
          if (kind === "transfer") {
            const from = member.shares.find((share) => share.id === body.get("from"));
            const to = member.shares.find((share) => share.id === body.get("to"));
            const amountMinor = parseMoney(body.get("amount") ?? "");
            if (!from || !to || from === to || amountMinor === undefined || amountMinor < 1) {
              sendHtml(response, "Validation Rejected - Meridian Core", "<p>MERIDIAN rejected the submitted values.</p>", 400, session);
              return;
            }
            if (from.status === "HOLD") {
              sendHtml(response, "Transfer Rejected - Meridian Core", "<p>Source share is HOLD and cannot be debited.</p>", 200, session);
              return;
            }
            if (from.balanceMinor < amountMinor) {
              sendHtml(response, "Transfer Rejected - Meridian Core", "<p>Insufficient available balance in the source share.</p>", 200, session);
              return;
            }
            from.balanceMinor -= amountMinor;
            to.balanceMinor += amountMinor;
            const reference = confirmation("TR");
            commits.push({ kind: "transfer", confirmation: reference, memberNumber: member.number });
            sendHtml(response, "Transfer Posted - Meridian Core", `${exactValueTable([
              ["Confirmation:", reference], ["Posted:", new Date().toISOString()], ["Amount:", money(amountMinor)],
              [`${from.id}:`, `${money(from.balanceMinor)} (new balance)`],
              [`${to.id}:`, `${money(to.balanceMinor)} (new balance)`],
            ])}<a href="/members/${member.number}">Return to Member Record</a>`, 200, session);
            return;
          }
          if (kind === "open-share") {
            const type = body.get("type") ?? "";
            const depositMinor = parseMoney(body.get("deposit") ?? "");
            if (!["S0001", "S0070", "MMKT", "CERT"].includes(type) || depositMinor === undefined || depositMinor < 1) {
              sendHtml(response, "Validation Rejected - Meridian Core", "<p>MERIDIAN rejected the submitted values.</p>", 400, session);
              return;
            }
            if (type === "CERT" && depositMinor < 50_000) {
              sendHtml(response, "Share Rejected - Meridian Core", "<p>Certificate accounts require a minimum opening deposit of $500.00.</p>", 200, session);
              return;
            }
            const suffix = String(member.shares.length + 1).padStart(4, "0");
            const newShare: Share = { id: `${member.number}-${type}-${suffix}`, type, balanceMinor: depositMinor, status: "OPEN" };
            member.shares.push(newShare);
            const reference = confirmation("NS");
            commits.push({ kind: "open_share", confirmation: reference, memberNumber: member.number });
            const displayType = type === "S0001" ? "Regular Shares" : type;
            sendHtml(response, "Share Opened - Meridian Core", `${exactValueTable([
              ["Confirmation:", reference], ["New Share ID:", newShare.id], ["Type:", displayType], ["Opening Balance:", money(depositMinor)],
            ])}<a href="/members/${member.number}">Return to Member Record</a>`, 200, session);
            return;
          }
          const share = member.shares.find((candidate) => candidate.id === body.get("share"));
          if (session.role !== "supervisor") {
            sendHtml(response, "Supervisor Required - Meridian Core", "<p>Supervisor authorization is required.</p>", 403, session);
            return;
          }
          if (!share) {
            sendHtml(response, "Validation Rejected - Meridian Core", "<p>MERIDIAN rejected the submitted values.</p>", 400, session);
            return;
          }
          if (share.status === "HOLD") {
            sendHtml(response, "Hold Exists - Meridian Core", "<p>A hold already exists on this share.</p>", 200, session);
            return;
          }
          share.status = "HOLD";
          const reference = confirmation("HD");
          commits.push({ kind: "place_hold", confirmation: reference, memberNumber: member.number });
          sendHtml(response, "Hold Applied - Meridian Core", `${exactValueTable([
            ["Confirmation:", reference], ["Share:", `${share.id} is now HOLD`], ["Applied:", new Date().toISOString()],
          ])}<a href="/members/${member.number}">Return to Member Record</a>`, 200, session);
          return;
        }
      }

      if (url.pathname === `/members/${member.number}/update` && method === "GET") {
        sendRawHtml(response, 200, updateForm(member, session));
        return;
      }
      if (url.pathname === `/members/${member.number}/update` && method === "POST") {
        const body = await formBody(request);
        if (!consumeToken(session, body.get("_token") ?? "")) {
          sendHtml(response, "Validation Rejected - Meridian Core", "<p>Invalid or expired transaction token.</p>", 400, session);
          return;
        }
        const email = body.get("email") ?? "";
        const phone = body.get("phone") ?? "";
        const address = body.get("address") ?? "";
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/u.test(email)) {
          sendHtml(response, "Update Rejected - Meridian Core", "<p>E-mail address is not in a valid format.</p>", 200, session);
          return;
        }
        if (!/^[0-9()+ .-]{7,24}$/u.test(phone)) {
          sendHtml(response, "Update Rejected - Meridian Core", "<p>Phone number is not valid.</p>", 200, session);
          return;
        }
        if (address.trim().length < 5) {
          sendHtml(response, "Update Rejected - Meridian Core", "<p>Mailing address is too short.</p>", 200, session);
          return;
        }
        member.email = email;
        member.phone = phone;
        member.address = address;
        commits.push({ kind: "update_member", confirmation: confirmation("UP"), memberNumber: member.number });
        sendHtml(
          response,
          "Member Information Updated - Meridian Core",
          `<p>Member information was updated successfully.</p><a href="/members/${member.number}">Return to Member Record</a>`,
          200,
          session,
        );
        return;
      }

      sendHtml(response, "Page Not Found - Meridian Core", "<p>No fixture route matched.</p>", 404, session);
    })().catch((error) => {
      if (!response.headersSent) {
        const tooLarge = error instanceof Error && error.message === "REQUEST_TOO_LARGE";
        sendHtml(response, "Application Error - Meridian Core", `<p>${tooLarge ? "Request too large" : "Fixture application error"}</p>`, tooLarge ? 413 : 500);
      } else {
        response.destroy();
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once("error", onError);
    server.listen(port, host, () => {
      server.off("error", onError);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("MERIDIAN fixture did not bind a TCP address");
  const urlHost = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  let closePromise: Promise<void> | undefined;
  return {
    baseUrl: `http://${urlHost}:${address.port}`,
    setFault(fault) {
      pendingFault = fault;
    },
    snapshot() {
      return copySnapshot(members, commits);
    },
    close() {
      closePromise ??= new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
        server.closeIdleConnections();
      });
      return closePromise;
    },
  };
}
