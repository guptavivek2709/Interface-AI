import { randomBytes } from "node:crypto";
import { createServer, type Server, type ServerResponse } from "node:http";

export interface DemoServerOptions {
  readonly port?: number;
  readonly host?: string;
}

export interface DemoServer {
  readonly baseUrl: string;
  close(): Promise<void>;
}

interface Member {
  readonly number: string;
  readonly name: string;
  readonly relationship: string;
  readonly primaryAccount: string;
}

const MEMBERS: Readonly<Record<string, Member>> = Object.freeze({
  "MBR-1001": {
    number: "MBR-1001",
    name: "Elena Torres",
    relationship: "Personal",
    primaryAccount: "Everyday checking •••• 4821",
  },
  "MBR-1002": {
    number: "MBR-1002",
    name: "Malcolm Reed",
    relationship: "Personal",
    primaryAccount: "Essential checking •••• 1904",
  },
});

const RECOVERABLE_MEMBERS: Readonly<Record<string, Member>> = Object.freeze({
  "HANDOFF-1001": {
    number: "HANDOFF-1001",
    name: "Avery Shah",
    relationship: "Training recovery",
    primaryAccount: "Everyday checking •••• 7712",
  },
  "NOTICE-1001": {
    number: "NOTICE-1001",
    name: "Nora Okafor",
    relationship: "Training notice",
    primaryAccount: "Essential checking •••• 3350",
  },
  "SLOW-1001": {
    number: "SLOW-1001",
    name: "Santiago Alvarez",
    relationship: "Training latency",
    primaryAccount: "Everyday checking •••• 6088",
  },
});

const SPECIAL_MEMBER_IDS = Object.freeze({
  missing: "MISSING-0000",
  denied: "DENIED-1001",
  handoff: "HANDOFF-1001",
  notice: "NOTICE-1001",
  slow: "SLOW-1001",
});

const DEFAULT_TENANT = "summit";
const ACCOUNT_TYPES = new Set(["Savings", "Money market"]);

function generatedId(prefix: string): string {
  return `${prefix}-${randomBytes(8).toString("hex")}`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function tenantFrom(url: URL): string {
  const tenant = url.searchParams.get("tenant")?.trim();
  return tenant ? tenant.slice(0, 80) : DEFAULT_TENANT;
}

function queryString(values: Readonly<Record<string, string | undefined>>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) params.set(key, value);
  }
  return params.toString();
}

function workspaceUrl(
  path: string,
  tenant: string,
  values: Readonly<Record<string, string | undefined>> = {},
): string {
  return `${path}?${queryString({ tenant, ...values })}`;
}

function hiddenInput(name: string, value: string): string {
  return `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`;
}

function sendHtml(response: ServerResponse, html: string, status = 200): void {
  response.writeHead(status, {
    "cache-control": "no-store, max-age=0",
    "content-type": "text/html; charset=utf-8",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
  });
  response.end(html);
}

function shellPage(tenant: string): string {
  const harbor = tenant.toLowerCase() === "harbor";
  const frameId = generatedId("workspace-frame");
  const frameSource = workspaceUrl("/workspace/search", tenant);
  const bankName = harbor ? "Harbor Mutual Bank" : "Juniper Community Bank";
  const bankMark = harbor ? "HMB" : "JCB";

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(bankName)} — Branch Operations</title>
  <style>
    :root { color-scheme: light; --ink: ${harbor ? "#17304f" : "#18392b"}; --brand: ${harbor ? "#0c6580" : "#176947"}; --paper: #f6f4ee; --line: #c9c6ba; }
    * { box-sizing: border-box; }
    html, body { height: 100%; }
    body { margin: 0; background: var(--paper); color: var(--ink); font: 15px/1.4 Georgia, "Times New Roman", serif; }
    .masthead { min-height: 72px; padding: 12px 24px; color: white; background: var(--ink); border-bottom: 5px solid ${harbor ? "#e2a62b" : "#d6b255"}; }
    .brand-table { width: 100%; border-collapse: collapse; }
    .brand-table td { vertical-align: middle; }
    .mark { display: inline-grid; place-items: center; width: 43px; height: 43px; margin-right: 11px; border: 2px solid white; border-radius: ${harbor ? "50%" : "4px"}; font: 700 12px Arial, sans-serif; letter-spacing: .06em; }
    .bank-name { font-size: 20px; font-weight: 700; }
    .subbrand { opacity: .82; font: 11px Arial, sans-serif; text-transform: uppercase; letter-spacing: .13em; }
    .operator { text-align: right; font: 12px Arial, sans-serif; }
    .environment { display: inline-block; padding: 4px 9px; color: #222; background: #ffd966; border-radius: 2px; font-weight: 700; }
    main { height: calc(100% - 72px); padding: ${harbor ? "18px 26px 24px" : "14px 18px 20px"}; }
    .crumb { height: 25px; color: #68655d; font: 12px Arial, sans-serif; }
    iframe { display: block; width: 100%; height: calc(100% - 25px); min-height: 560px; background: white; border: 1px solid #8d8a80; box-shadow: 0 6px 22px rgb(30 41 35 / 14%); }
  </style>
</head>
<body>
  <header class="masthead">
    <table class="brand-table" role="presentation"><tr>
      <td><span class="mark" aria-hidden="true">${bankMark}</span><span class="bank-name">${escapeHtml(bankName)}</span><br><span class="subbrand">Core banking services</span></td>
      <td class="operator"><span class="environment">SYNTHETIC TRAINING</span>&nbsp;&nbsp; Branch 014 · Operator VTURNER</td>
    </tr></table>
  </header>
  <main>
    <div class="crumb">Branch Operations / Member Servicing / Sub-accounts</div>
    <iframe id="${frameId}" title="Core banking workspace" src="${escapeHtml(frameSource)}"></iframe>
  </main>
</body>
</html>`;
}

function workspaceDocument(
  tenant: string,
  title: string,
  body: string,
  options: { readonly script?: string; readonly bodyClass?: string } = {},
): string {
  const harbor = tenant.toLowerCase() === "harbor";
  const navId = generatedId("legacy-menu");
  const mainId = generatedId("legacy-main");
  const navigation = `<nav id="${navId}" aria-label="Core banking sections">
    <div class="menu-head">SERVICING MENU</div>
    <a href="${escapeHtml(workspaceUrl("/workspace/search", tenant))}" aria-current="page">Member lookup</a>
    <span>Account maintenance</span>
    <span>Statements</span>
    <span>Service requests</span>
  </nav>`;
  const main = `<main id="${mainId}" tabindex="-1">${body}</main>`;
  const cells = harbor
    ? `<td class="content-cell">${main}</td><td class="nav-cell">${navigation}</td>`
    : `<td class="nav-cell">${navigation}</td><td class="content-cell">${main}</td>`;

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)} — Core Banking Workspace</title>
  <style>
    :root { color-scheme: light; --nav: ${harbor ? "#243d61" : "#315344"}; --accent: ${harbor ? "#0b6e89" : "#246b4c"}; --pale: ${harbor ? "#edf5f8" : "#eef5f0"}; --border: #b8b8ae; --text: #20241f; }
    * { box-sizing: border-box; }
    body { margin: 0; color: var(--text); background: #e7e5de; font: 14px/1.45 Arial, Helvetica, sans-serif; }
    .utility { min-height: 34px; padding: 8px 14px; color: #333; background: linear-gradient(#fafafa, #dfddd5); border-bottom: 1px solid #aaa79e; font-size: 12px; }
    .utility strong { color: var(--accent); }
    .utility .right { float: right; }
    .layout { width: 100%; border-collapse: collapse; table-layout: fixed; }
    .layout > tbody > tr > td { vertical-align: top; }
    .nav-cell { width: 184px; background: var(--nav); }
    .content-cell { background: #fff; }
    nav { min-height: 526px; padding-bottom: 28px; }
    nav .menu-head { padding: 13px 14px 8px; color: #dfeae5; font-size: 10px; font-weight: 700; letter-spacing: .12em; }
    nav a, nav span { display: block; padding: 10px 14px; color: white; border-top: 1px solid rgb(255 255 255 / 13%); text-decoration: none; }
    nav a { background: rgb(0 0 0 / 18%); border-left: 4px solid #f1c85b; font-weight: 700; }
    main { min-height: 526px; padding: ${harbor ? "25px 34px 42px 27px" : "25px 31px 42px"}; }
    h1 { margin: 0 0 5px; color: #23342d; font: 700 25px/1.2 Georgia, "Times New Roman", serif; }
    h2 { color: #263c32; font: 700 18px Georgia, "Times New Roman", serif; }
    .lede { margin: 0 0 21px; color: #62645f; }
    .panel { max-width: 780px; padding: 18px 20px 20px; background: #fafaf8; border: 1px solid var(--border); border-top: 4px solid var(--accent); box-shadow: 0 2px 5px rgb(0 0 0 / 7%); }
    .form-table, .detail-table, .review-table { width: 100%; border-collapse: collapse; }
    .form-table th, .form-table td, .detail-table th, .detail-table td, .review-table th, .review-table td { padding: 10px 11px; vertical-align: top; border-bottom: 1px solid #d7d5ce; }
    .form-table th, .detail-table th, .review-table th { width: 185px; text-align: left; color: #343832; background: var(--pale); font-weight: 700; }
    label { display: inline-block; padding-top: 7px; }
    input, select { width: min(100%, 390px); min-height: 38px; padding: 7px 9px; color: #1c241e; background: white; border: 1px solid #797a74; border-radius: 1px; font: inherit; }
    input:focus, select:focus, button:focus, a:focus { outline: 3px solid #efbe3e; outline-offset: 2px; }
    input[readonly] { color: #464943; background: #eeece5; }
    .hint { display: block; margin-top: 4px; color: #686b65; font-size: 12px; }
    .actions { margin-top: 18px; }
    button, .button-link { display: inline-block; min-height: 38px; padding: 8px 17px; color: white; background: var(--accent); border: 1px solid #174832; border-radius: 2px; font: 700 14px Arial, sans-serif; text-decoration: none; cursor: pointer; }
    button.secondary, .button-link.secondary { color: #28332d; background: #eceae3; border-color: #85857e; }
    button:disabled { color: #777; background: #d7d5ce; border-color: #aaa; cursor: not-allowed; }
    .notice, .error, .success-boundary { max-width: 780px; margin: 0 0 18px; padding: 14px 16px; border: 1px solid; }
    .notice { color: #493a06; background: #fff7d8; border-color: #d8bd55; }
    .error { color: #611a16; background: #fff0ee; border-color: #c97870; }
    .success-boundary { color: #174a35; background: #edf8f1; border-color: #75a78d; }
    .notice h2, .error h2, .success-boundary h2 { margin: 0 0 6px; color: inherit; }
    .status-tag { display: inline-block; padding: 2px 7px; color: #1f593f; background: #e4f2e9; border: 1px solid #a9c9b6; font-size: 11px; font-weight: 700; text-transform: uppercase; }
    dialog { width: min(92vw, 500px); padding: 0; color: #242924; background: white; border: 1px solid #6f716b; border-top: 6px solid #b16128; box-shadow: 0 14px 42px rgb(0 0 0 / 38%); }
    dialog::backdrop { background: rgb(20 29 25 / 56%); }
    dialog .dialog-body { padding: 22px 24px 24px; }
    dialog h1 { font-size: 23px; }
    .loading { max-width: 660px; padding: 34px 30px; text-align: center; background: white; border: 1px solid var(--border); }
    .spinner { width: 38px; height: 38px; margin: 0 auto 16px; border: 5px solid #d5d5ce; border-top-color: var(--accent); border-radius: 50%; animation: spin .8s linear infinite; }
    @keyframes spin { to { transform: rotate(360deg); } }
    @media (max-width: 680px) { .nav-cell { width: 130px; } main { padding: 18px 15px 30px; } .form-table th, .detail-table th, .review-table th { width: 140px; } }
    @media (prefers-reduced-motion: reduce) { .spinner { animation: none; } }
  </style>
</head>
<body class="${escapeHtml(options.bodyClass ?? "")}">
  <div class="utility"><strong>COREBANK/7</strong> &nbsp; Member Servicing <span class="right">Tenant: ${escapeHtml(tenant)} &nbsp; | &nbsp; Training data only</span></div>
  <table class="layout" role="presentation"><tbody><tr>${cells}</tr></tbody></table>
  ${options.script ? `<script>${options.script}</script>` : ""}
</body>
</html>`;
}

function searchPage(tenant: string, previousValue = ""): string {
  const memberInputId = generatedId("member-number");
  const headingId = generatedId("member-search");
  const content = `
    <h1 id="${headingId}">Member search</h1>
    <p class="lede">Locate a member before beginning account maintenance.</p>
    <section class="panel" aria-labelledby="${headingId}">
      <form method="get" action="/workspace/member">
        ${hiddenInput("tenant", tenant)}
        <table class="form-table"><tbody><tr>
          <th><label for="${memberInputId}">Member number</label></th>
          <td><input id="${memberInputId}" name="memberNumber" value="${escapeHtml(previousValue)}" autocomplete="off" spellcheck="false" required aria-describedby="${memberInputId}-hint"><span class="hint" id="${memberInputId}-hint">Use the synthetic member number supplied for this run.</span></td>
        </tr></tbody></table>
        <div class="actions"><button type="submit">Search</button></div>
      </form>
    </section>`;
  return workspaceDocument(tenant, "Member search", content);
}

function notFoundPage(tenant: string, memberNumber: string): string {
  const errorHeading = generatedId("not-found-heading");
  const content = `
    <h1>Member not found</h1>
    <p class="lede">The search completed without a matching business record.</p>
    <section class="error" role="alert" aria-labelledby="${errorHeading}">
      <h2 id="${errorHeading}">No matching member</h2>
      <p>Member number <strong data-sensitive="member-number">${escapeHtml(memberNumber)}</strong> was not found. Confirm the number and search again.</p>
    </section>
    <a class="button-link secondary" href="${escapeHtml(workspaceUrl("/workspace/search", tenant, { memberNumber }))}">Return to member search</a>`;
  return workspaceDocument(tenant, "Member not found", content);
}

function permissionPage(tenant: string, memberNumber: string): string {
  const errorHeading = generatedId("permission-heading");
  const content = `
    <h1>Permission required</h1>
    <p class="lede">Core Banking could not open this restricted relationship.</p>
    <section class="error" role="alert" aria-labelledby="${errorHeading}">
      <h2 id="${errorHeading}">Permission denied</h2>
      <p>Your training operator does not have permission to view <strong data-sensitive="member-number">${escapeHtml(memberNumber)}</strong>. No member data was disclosed.</p>
    </section>
    <a class="button-link secondary" href="${escapeHtml(workspaceUrl("/workspace/search", tenant))}">Return to member search</a>`;
  return workspaceDocument(tenant, "Permission denied", content);
}

function expiredSessionPage(tenant: string, memberNumber: string): string {
  const dialogId = generatedId("expired-dialog");
  const dialogHeadingId = generatedId("expired-heading");
  const content = `
    <h1>Member details</h1>
    <p class="lede">The workspace needs a training-session handoff before it can display this member.</p>
    <div class="panel" aria-hidden="true"><p>Member information unavailable while the session is paused.</p></div>
    <dialog id="${dialogId}" open aria-labelledby="${dialogHeadingId}" aria-describedby="${dialogHeadingId}-description">
      <div class="dialog-body">
        <h1 id="${dialogHeadingId}">Session expired</h1>
        <p id="${dialogHeadingId}-description">Your synthetic training session expired during the lookup. Restore it to continue safely.</p>
        <form method="get" action="/workspace/member">
          ${hiddenInput("tenant", tenant)}
          ${hiddenInput("memberNumber", memberNumber)}
          ${hiddenInput("restored", "1")}
          <button type="submit">Restore training session</button>
        </form>
      </div>
    </dialog>`;
  return workspaceDocument(tenant, "Session expired", content);
}

function slowLoadingPage(tenant: string, memberNumber: string): string {
  const destination = workspaceUrl("/workspace/member", tenant, {
    memberNumber,
    ready: "1",
  });
  const statusId = generatedId("loading-status");
  const content = `
    <section id="${statusId}" class="loading" role="status" aria-live="polite" aria-busy="true">
      <div class="spinner" aria-hidden="true"></div>
      <h1>Loading member</h1>
      <p>Core Banking is retrieving <strong data-sensitive="member-number">${escapeHtml(memberNumber)}</strong>. Please wait…</p>
    </section>
    <noscript><p><a href="${escapeHtml(destination)}">Continue after loading</a></p></noscript>`;
  const script = `window.setTimeout(function () { window.location.replace(${JSON.stringify(destination)}); }, 900);`;
  return workspaceDocument(tenant, "Loading member", content, { script });
}

function trainingNotice(memberNumber: string): { readonly html: string; readonly script: string } {
  const noticeId = generatedId("training-notice");
  const noticeHeadingId = generatedId("notice-heading");
  const buttonId = generatedId("dismiss-notice");
  return {
    html: `<aside id="${noticeId}" class="notice" role="status" aria-labelledby="${noticeHeadingId}">
      <h2 id="${noticeHeadingId}">Training notice</h2>
      <p><span data-sensitive="member-number">${escapeHtml(memberNumber)}</span> is a synthetic notice scenario. Verify the member context before continuing.</p>
      <button id="${buttonId}" class="secondary" type="button">Dismiss training notice</button>
    </aside>`,
    script: `document.getElementById(${JSON.stringify(buttonId)}).addEventListener("click", function () { document.getElementById(${JSON.stringify(noticeId)}).hidden = true; });`,
  };
}

function memberDetailPage(tenant: string, member: Member, showNotice: boolean): string {
  const headingId = generatedId("member-details-heading");
  const notice = showNotice ? trainingNotice(member.number) : undefined;
  const content = `
    ${notice?.html ?? ""}
    <h1 id="${headingId}">Member details</h1>
    <p class="lede">Review the relationship before beginning account maintenance.</p>
    <section class="panel" aria-labelledby="${headingId}">
      <p><span class="status-tag">Active member</span></p>
      <table class="detail-table"><tbody>
        <tr><th scope="row">Member name</th><td data-sensitive="member-name">${escapeHtml(member.name)}</td></tr>
        <tr><th scope="row">Member number</th><td data-sensitive="member-number">${escapeHtml(member.number)}</td></tr>
        <tr><th scope="row">Relationship</th><td data-sensitive="relationship">${escapeHtml(member.relationship)}</td></tr>
        <tr><th scope="row">Primary account</th><td data-sensitive="account-number">${escapeHtml(member.primaryAccount)}</td></tr>
      </tbody></table>
      <form method="get" action="/workspace/sub-account/new" class="actions">
        ${hiddenInput("tenant", tenant)}
        ${hiddenInput("memberNumber", member.number)}
        <button type="submit">Open sub-account</button>
      </form>
    </section>`;
  return workspaceDocument(tenant, "Member details", content, {
    ...(notice ? { script: notice.script } : {}),
  });
}

function subAccountFormPage(
  tenant: string,
  member: Member,
  values: { readonly accountType?: string; readonly nickname?: string; readonly initialDeposit?: string } = {},
  error?: string,
): string {
  const headingId = generatedId("new-sub-account");
  const memberInputId = generatedId("sub-member-number");
  const typeInputId = generatedId("account-type");
  const nicknameInputId = generatedId("nickname");
  const depositInputId = generatedId("initial-deposit");
  const harbor = tenant.toLowerCase() === "harbor";
  const memberRow = `<tr><th><label for="${memberInputId}">Member number</label></th><td><input id="${memberInputId}" name="memberNumber" value="${escapeHtml(member.number)}" readonly></td></tr>`;
  const typeRow = `<tr><th><label for="${typeInputId}">Account type</label></th><td><select id="${typeInputId}" name="accountType" required><option value="">Select an account type</option><option value="Savings"${values.accountType === "Savings" ? " selected" : ""}>Savings</option><option value="Money market"${values.accountType === "Money market" ? " selected" : ""}>Money market</option></select></td></tr>`;
  const nicknameRow = `<tr><th><label for="${nicknameInputId}">Nickname</label></th><td><input id="${nicknameInputId}" name="nickname" value="${escapeHtml(values.nickname ?? "")}" maxlength="40" required autocomplete="off"><span class="hint">Visible to the member in online banking.</span></td></tr>`;
  const depositRow = `<tr><th><label for="${depositInputId}">Initial deposit</label></th><td><input id="${depositInputId}" name="initialDeposit" value="${escapeHtml(values.initialDeposit ?? "")}" inputmode="decimal" required autocomplete="off" pattern="[0-9]+([.][0-9]{1,2})?" aria-describedby="${depositInputId}-hint"><span class="hint" id="${depositInputId}-hint">Enter an amount without a currency symbol, for example 250.00.</span></td></tr>`;
  const rows = harbor
    ? `${memberRow}${nicknameRow}${depositRow}${typeRow}`
    : `${memberRow}${typeRow}${nicknameRow}${depositRow}`;
  const content = `
    <h1 id="${headingId}">New sub-account</h1>
    <p class="lede">Enter the requested product details. Nothing is created until a later approval step.</p>
    ${error ? `<div class="error" role="alert"><strong>Check the form:</strong> ${escapeHtml(error)}</div>` : ""}
    <section class="panel" aria-labelledby="${headingId}">
      <form method="get" action="/workspace/sub-account/review">
        ${hiddenInput("tenant", tenant)}
        <table class="form-table"><tbody>${rows}</tbody></table>
        <div class="actions"><button type="submit">Review sub-account</button></div>
      </form>
    </section>`;
  return workspaceDocument(tenant, "New sub-account", content);
}

function reviewPage(
  tenant: string,
  member: Member,
  accountType: string,
  nickname: string,
  initialDeposit: string,
): string {
  const headingId = generatedId("review-sub-account");
  const boundaryId = generatedId("training-boundary");
  const formattedDeposit = /^\d+(?:\.\d{1,2})?$/.test(initialDeposit)
    ? `$${Number(initialDeposit).toFixed(2)}`
    : initialDeposit;
  const content = `
    <h1 id="${headingId}">Review sub-account</h1>
    <p class="lede">Confirm the proposed details. This demonstration intentionally stops before creation.</p>
    <section class="panel" aria-labelledby="${headingId}">
      <table class="review-table"><tbody>
        <tr><th scope="row">Member name</th><td data-sensitive="member-name"><output aria-label="Member name">${escapeHtml(member.name)}</output></td></tr>
        <tr><th scope="row">Member number</th><td data-sensitive="member-number"><output aria-label="Member number">${escapeHtml(member.number)}</output></td></tr>
        <tr><th scope="row">Account type</th><td data-sensitive="account-type"><output aria-label="Account type">${escapeHtml(accountType)}</output></td></tr>
        <tr><th scope="row">Nickname</th><td data-sensitive="nickname"><output aria-label="Nickname">${escapeHtml(nickname)}</output></td></tr>
        <tr><th scope="row">Initial deposit</th><td data-sensitive="initial-deposit"><output aria-label="Initial deposit">${escapeHtml(formattedDeposit)}</output></td></tr>
      </tbody></table>
      <div id="${boundaryId}" class="success-boundary" role="status">
        <h2>Review ready</h2>
        <p>Training boundary reached. No account has been created and no financial transaction occurred.</p>
      </div>
      <div class="actions">
        <button type="button" disabled aria-describedby="${boundaryId}">Create sub-account</button>
        <a class="button-link secondary" href="${escapeHtml(workspaceUrl("/workspace/sub-account/new", tenant, { memberNumber: member.number, accountType, nickname, initialDeposit }))}">Edit details</a>
      </div>
    </section>`;
  return workspaceDocument(tenant, "Review sub-account", content);
}

function resolveMember(memberNumber: string): Member | undefined {
  return MEMBERS[memberNumber] ?? RECOVERABLE_MEMBERS[memberNumber];
}

function normalizedMemberNumber(url: URL): string {
  return (url.searchParams.get("memberNumber") ?? url.searchParams.get("member") ?? "")
    .trim()
    .toUpperCase();
}

function handleWorkspaceMember(url: URL, response: ServerResponse): void {
  const tenant = tenantFrom(url);
  const memberNumber = normalizedMemberNumber(url);

  if (!memberNumber || memberNumber === SPECIAL_MEMBER_IDS.missing) {
    sendHtml(response, notFoundPage(tenant, memberNumber || SPECIAL_MEMBER_IDS.missing));
    return;
  }
  if (memberNumber === SPECIAL_MEMBER_IDS.denied) {
    sendHtml(response, permissionPage(tenant, memberNumber), 403);
    return;
  }
  if (memberNumber === SPECIAL_MEMBER_IDS.handoff && url.searchParams.get("restored") !== "1") {
    sendHtml(response, expiredSessionPage(tenant, memberNumber));
    return;
  }
  if (memberNumber === SPECIAL_MEMBER_IDS.slow && url.searchParams.get("ready") !== "1") {
    sendHtml(response, slowLoadingPage(tenant, memberNumber));
    return;
  }

  const member = resolveMember(memberNumber);
  if (!member) {
    sendHtml(response, notFoundPage(tenant, memberNumber));
    return;
  }
  sendHtml(response, memberDetailPage(tenant, member, memberNumber === SPECIAL_MEMBER_IDS.notice));
}

function handleSubAccountForm(url: URL, response: ServerResponse): void {
  const tenant = tenantFrom(url);
  const memberNumber = normalizedMemberNumber(url);
  const member = resolveMember(memberNumber);
  if (!member) {
    sendHtml(response, notFoundPage(tenant, memberNumber || SPECIAL_MEMBER_IDS.missing));
    return;
  }
  sendHtml(
    response,
    subAccountFormPage(tenant, member, {
      accountType: url.searchParams.get("accountType") ?? "",
      nickname: url.searchParams.get("nickname") ?? "",
      initialDeposit: url.searchParams.get("initialDeposit") ?? "",
    }),
  );
}

function handleReview(url: URL, response: ServerResponse): void {
  const tenant = tenantFrom(url);
  const memberNumber = normalizedMemberNumber(url);
  const member = resolveMember(memberNumber);
  if (!member) {
    sendHtml(response, notFoundPage(tenant, memberNumber || SPECIAL_MEMBER_IDS.missing));
    return;
  }

  const accountType = (url.searchParams.get("accountType") ?? "").trim();
  const nickname = (url.searchParams.get("nickname") ?? "").trim();
  const initialDeposit = (url.searchParams.get("initialDeposit") ?? "").trim();
  let error: string | undefined;
  if (!ACCOUNT_TYPES.has(accountType)) error = "Choose Savings or Money market.";
  else if (!nickname) error = "Enter a nickname.";
  else if (!/^\d+(?:\.\d{1,2})?$/.test(initialDeposit)) {
    error = "Enter the initial deposit as a non-negative amount with up to two decimal places.";
  }

  if (error) {
    sendHtml(
      response,
      subAccountFormPage(tenant, member, { accountType, nickname, initialDeposit }, error),
      400,
    );
    return;
  }
  sendHtml(response, reviewPage(tenant, member, accountType, nickname, initialDeposit));
}

function notFoundDocument(pathname: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Page not found</title></head><body><main><h1>Page not found</h1><p>No synthetic training route matches <code>${escapeHtml(pathname)}</code>.</p><p><a href="/">Open the banking demo</a></p></main></body></html>`;
}

function requestHandler(requestUrl: string | undefined, response: ServerResponse): void {
  const url = new URL(requestUrl ?? "/", "http://demo.invalid");
  if (url.pathname === "/" || url.pathname === "/index.html") {
    sendHtml(response, shellPage(tenantFrom(url)));
    return;
  }
  if (url.pathname === "/workspace" || url.pathname === "/workspace/" || url.pathname === "/workspace/search") {
    sendHtml(response, searchPage(tenantFrom(url), url.searchParams.get("memberNumber") ?? ""));
    return;
  }
  if (url.pathname === "/workspace/member") {
    handleWorkspaceMember(url, response);
    return;
  }
  if (url.pathname === "/workspace/sub-account/new") {
    handleSubAccountForm(url, response);
    return;
  }
  if (url.pathname === "/workspace/sub-account/review") {
    handleReview(url, response);
    return;
  }
  sendHtml(response, notFoundDocument(url.pathname), 404);
}

/**
 * Starts the synthetic legacy-banking surface on an ephemeral port by default.
 * The returned close function is idempotent, which keeps test teardown simple.
 */
export async function startDemoServer(options: DemoServerOptions = {}): Promise<DemoServer> {
  const port = options.port ?? 0;
  const host = options.host ?? "127.0.0.1";
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new RangeError(`Invalid demo server port: ${port}`);
  }

  const server: Server = createServer((request, response) => {
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.writeHead(405, { allow: "GET, HEAD", "content-type": "text/plain; charset=utf-8" });
      response.end("Method not allowed");
      return;
    }
    try {
      requestHandler(request.url, response);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown server error";
      sendHtml(response, `<!doctype html><html lang="en"><body><h1>Demo server error</h1><p>${escapeHtml(message)}</p></body></html>`, 500);
    }
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => reject(error);
    server.once("error", onError);
    server.listen(port, host, () => {
      server.off("error", onError);
      resolve();
    });
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Demo server did not bind to a TCP address");
  }
  const urlHost = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  const baseUrl = `http://${urlHost}:${address.port}`;
  let closePromise: Promise<void> | undefined;

  return {
    baseUrl,
    close(): Promise<void> {
      closePromise ??= new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
        server.closeIdleConnections();
      });
      return closePromise;
    },
  };
}
