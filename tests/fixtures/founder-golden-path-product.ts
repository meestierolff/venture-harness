import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import type { CommandInvocation, CommandResult, CommandRunner } from "@/lib/credentials";
import {
  CHILD_DEPENDENCY_INSTALL_ARGS,
  type BuildAgentHost,
  type BuildAgentHostInspection,
  type BuildAgentRequest,
  type BuildAgentResult,
} from "@/lib/runtime";

const REPOSITORY_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const COMMAND_TIMEOUT_MS = 180_000;

function traceArchive(
  origin: string,
  steps: readonly string[],
  phase: "journey" | "cleanup",
): Buffer {
  const name = Buffer.from("test.trace");
  const events: Record<string, unknown>[] = [];
  for (const [index, step] of (phase === "journey"
    ? steps
    : ["verified cleanup read-back"]
  ).entries()) {
    const stepId = `step@${index}`;
    const actionId = `pw:api@${index}`;
    const expectId = `expect@${index}`;
    events.push(
      { type: "before", callId: stepId, title: step },
      {
        type: "before",
        callId: actionId,
        parentId: stepId,
        title: "page.goto",
        params: { url: origin },
      },
      { type: "after", callId: actionId },
      { type: "before", callId: expectId, parentId: stepId, title: "expect.toBeVisible" },
      { type: "after", callId: expectId },
    );
  }
  const body = Buffer.from(
    `${events.map((event) => JSON.stringify(event)).join("\n")}\n`.repeat(4),
  );
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt32LE(body.length, 18);
  local.writeUInt32LE(body.length, 22);
  local.writeUInt16LE(name.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt32LE(body.length, 20);
  central.writeUInt32LE(body.length, 24);
  central.writeUInt16LE(name.length, 28);
  const centralOffset = local.length + name.length + body.length;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + name.length, 12);
  end.writeUInt32LE(centralOffset, 16);
  return Buffer.concat([local, name, body, central, name, end]);
}

function installedRootStore(): string {
  const modules = parse(
    readFileSync(resolve(REPOSITORY_ROOT, "node_modules/.modules.yaml"), "utf8"),
  ) as { storeDir?: unknown };
  if (typeof modules.storeDir !== "string" || modules.storeDir.length === 0) {
    throw new Error("The Golden Path requires the pnpm store recorded by the root frozen install");
  }
  return modules.storeDir;
}

function runChildPnpm(invocation: CommandInvocation, root: string): CommandResult {
  const result = spawnSync(invocation.command, [...invocation.args], {
    cwd: root,
    env: {
      ...process.env,
      ...invocation.env,
      CI: "1",
      NEXT_TELEMETRY_DISABLED: "1",
      npm_config_offline: "true",
      npm_config_store_dir: installedRootStore(),
    },
    encoding: "utf8",
    timeout: COMMAND_TIMEOUT_MS,
    maxBuffer: 10 * 1024 * 1024,
  });
  const stderr = [result.error?.message, result.stderr].filter(Boolean).join("\n");
  return {
    exitCode: result.status ?? 1,
    stdout: `fixtureProvenance=local_product_command_boundary\n${result.stdout ?? ""}`,
    stderr,
  };
}

const FIXTURE_LIMITATION =
  "Synthetic Golden Path fixture: local product behavior is tested, but no customer, market, or live-provider outcome is claimed.";

const FOUNDER_CONTRACT = `${JSON.stringify(
  {
    schemaVersion: 1,
    fixture: true,
    venture: "exception-desk",
    audience: "Small service-business operators reconciling recurring client work",
    journey: [
      "sign_in_fixture_operator",
      "import_labeled_fixture",
      "review_exceptions",
      "confirm_invoice_draft",
    ],
    successSignal: "invoice_draft_confirmed",
    limitations: [
      "The included records are labeled synthetic samples.",
      "Authentication is a local fixture state, not a live identity-provider integration.",
      "Invoice confirmation creates a local draft only; it does not send or charge anything.",
    ],
  },
  null,
  2,
)}\n`;

const FOUNDER_SCAFFOLD_TEST = `import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("founder scaffold binds the labeled fixture journey to the managed manifest", () => {
  const contract = JSON.parse(readFileSync("src/product/founder-contract.json", "utf8"));
  const lock = readFileSync("harness.lock", "utf8");
  assert.equal(contract.fixture, true);
  assert.equal(contract.venture, "exception-desk");
  assert.equal(contract.successSignal, "invoice_draft_confirmed");
  assert.match(lock, /agentic-web-saas/);
  assert.equal(JSON.stringify(contract).includes("cred:" + "//"), false);
});
`;

const DESIGN_RECORD = `# Exception Desk design direction

## Thesis

Exception Desk is a calm reconciliation surface, not a generic dashboard. A ledger-like grid,
warm paper background, ink typography, and one vermilion action colour make discrepancies easy
to scan while keeping all labeled synthetic samples distinct from customer data.

## System

- Display: Georgia for terse editorial headings; system sans for dense operational copy.
- Colour: paper, ink, ruled borders, moss confirmation, and vermilion action states.
- Spacing: an 8px base rhythm with a deliberately asymmetric desktop workbench.
- Signature moment: exceptions visibly collapse into a confirmed invoice-draft seal.

## Responsive and accessibility constraints

The two-column workbench collapses below 760px, controls remain at least 44px tall, focus rings
are always visible, colour is never the only status cue, and reduced-motion preferences disable
transitions. Text and action colours use high-contrast pairs on the paper surface.

## Anti-template audit

No gradient hero, floating glass card, testimonial, fabricated metric, or stock illustration is
used. The product surface is shaped around one reconciliation journey and labels every sample.
`;

const THEME_CSS = `:root {
  --venture-name: "Exception Desk";
  --paper: #f5efe3;
  --paper-raised: #fffaf0;
  --ink: #17201d;
  --ink-muted: #5b625e;
  --rule: #a9a18f;
  --accent: #a82f1f;
  --accent-strong: #742014;
  --confirmation: #285b44;
  --focus: #135f83;
  --motif-step: 8px;
  --shadow-hard: 6px 6px 0 #17201d;
}
`;

const GLOBAL_CSS = `* { box-sizing: border-box; }
html { background: var(--paper); color: var(--ink); }
body { margin: 0; min-height: 100vh; font-family: Inter, ui-sans-serif, system-ui, sans-serif; }
button, input { font: inherit; }
button { min-height: 44px; }
button:focus-visible, a:focus-visible { outline: 3px solid var(--focus); outline-offset: 3px; }
.deskShell { min-height: 100vh; padding: clamp(1.25rem, 4vw, 4.5rem); }
.deskHeader { display: grid; grid-template-columns: minmax(0, 1.2fr) minmax(15rem, .55fr); gap: 2rem; align-items: end; border-bottom: 2px solid var(--ink); padding-bottom: 1.5rem; }
.eyebrow { color: var(--accent-strong); font-size: .76rem; font-weight: 850; letter-spacing: .13em; text-transform: uppercase; }
h1, h2 { font-family: Georgia, "Times New Roman", serif; font-weight: 500; letter-spacing: -.035em; margin: 0; text-wrap: balance; }
h1 { font-size: clamp(3rem, 9vw, 7rem); line-height: .9; max-width: 10ch; }
h2 { font-size: clamp(1.55rem, 3vw, 2.45rem); }
.lede { color: var(--ink-muted); font-size: 1.08rem; line-height: 1.6; max-width: 42rem; }
.fixtureFlag { background: var(--ink); color: var(--paper-raised); display: inline-block; font-weight: 800; padding: .55rem .75rem; }
.deskGrid { display: grid; grid-template-columns: minmax(15rem, .45fr) minmax(0, 1fr); gap: clamp(1.5rem, 4vw, 4rem); padding-top: 2rem; }
.journeySteps { list-style: none; margin: 1.5rem 0 0; padding: 0; counter-reset: desk-step; }
.journeySteps li { border-top: 1px solid var(--rule); color: var(--ink-muted); counter-increment: desk-step; padding: .85rem 0; }
.journeySteps li::before { content: "0" counter(desk-step); color: var(--accent-strong); font-weight: 850; margin-right: .75rem; }
.journeySteps li[data-current="true"] { color: var(--ink); font-weight: 800; }
.workbench { background: var(--paper-raised); border: 2px solid var(--ink); box-shadow: var(--shadow-hard); padding: clamp(1.25rem, 3vw, 2.5rem); }
.sampleTable { border-collapse: collapse; margin: 1.5rem 0; width: 100%; }
.sampleTable th, .sampleTable td { border-bottom: 1px solid var(--rule); padding: .8rem .35rem; text-align: left; }
.sampleTable th { color: var(--ink-muted); font-size: .72rem; letter-spacing: .08em; text-transform: uppercase; }
.statusTag { border: 1px solid currentColor; display: inline-block; font-size: .75rem; font-weight: 800; padding: .25rem .45rem; text-transform: uppercase; }
.primaryAction { background: var(--accent); border: 2px solid var(--accent); color: white; cursor: pointer; font-weight: 850; padding: .8rem 1rem; }
.primaryAction:hover { background: var(--accent-strong); border-color: var(--accent-strong); }
.confirmationSeal { border: 2px solid var(--confirmation); color: var(--confirmation); font-family: Georgia, "Times New Roman", serif; font-size: 1.25rem; margin-top: 1.25rem; padding: 1rem; transform: rotate(-1deg); }
@media (max-width: 47.5rem) { .deskHeader, .deskGrid { grid-template-columns: 1fr; } .workbench { box-shadow: 4px 4px 0 var(--ink); } }
@media (prefers-reduced-motion: reduce) { *, *::before, *::after { scroll-behavior: auto !important; transition: none !important; } }
`;

const DESIGN_TEST = `import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const record = readFileSync("docs/brand/DESIGN.md", "utf8");
const theme = readFileSync("src/design/theme.css", "utf8");
const styles = readFileSync("app/globals.css", "utf8");

test("venture design is responsive, accessible, and fixture-honest", () => {
  assert.match(record, /Anti-template audit/);
  assert.match(record, /labeled synthetic samples/);
  assert.match(theme, /--focus: #135f83/);
  assert.match(styles, /focus-visible/);
  assert.match(styles, /prefers-reduced-motion/);
  assert.match(styles, /max-width: 47\\.5rem/);
});
`;

const JOURNEY_MODULE = `export const LABELED_SAMPLE_ROWS = Object.freeze([
  Object.freeze({ id: "sample-001", clientLabel: "Sample account A", deliveredUnits: 8, invoiceUnits: 6, exception: "2 delivered units missing" }),
  Object.freeze({ id: "sample-002", clientLabel: "Sample account B", deliveredUnits: 4, invoiceUnits: 5, exception: "1 invoice unit needs review" }),
]);

export function createExceptionDeskState() {
  return Object.freeze({ stage: "signed_out", sampleLabel: null, rows: Object.freeze([]), invoiceDraftConfirmed: false });
}

export function signInFixtureOperator(state) {
  if (state.stage !== "signed_out") throw new Error("Fixture sign-in is only available from signed_out");
  return Object.freeze({ ...state, stage: "ready_for_import" });
}

export function importLabeledFixture(state) {
  if (state.stage !== "ready_for_import") throw new Error("Sign in to the fixture operator session before importing");
  return Object.freeze({ ...state, stage: "fixture_imported", sampleLabel: "SYNTHETIC SAMPLE — NOT CUSTOMER DATA", rows: LABELED_SAMPLE_ROWS });
}

export function reviewExceptions(state) {
  if (state.stage !== "fixture_imported" || state.rows.length === 0) throw new Error("Import the labeled fixture before review");
  return Object.freeze({ ...state, stage: "exceptions_reviewed" });
}

export function confirmInvoiceDraft(state) {
  if (state.stage !== "exceptions_reviewed") throw new Error("Review every exception before confirmation");
  return Object.freeze({ ...state, stage: "invoice_draft_confirmed", invoiceDraftConfirmed: true });
}
`;

const JOURNEY_TYPES = `export interface ExceptionRow { readonly id: string; readonly clientLabel: string; readonly deliveredUnits: number; readonly invoiceUnits: number; readonly exception: string; }
export interface ExceptionDeskState { readonly stage: "signed_out" | "ready_for_import" | "fixture_imported" | "exceptions_reviewed" | "invoice_draft_confirmed"; readonly sampleLabel: string | null; readonly rows: readonly ExceptionRow[]; readonly invoiceDraftConfirmed: boolean; }
export declare const LABELED_SAMPLE_ROWS: readonly ExceptionRow[];
export declare function createExceptionDeskState(): ExceptionDeskState;
export declare function signInFixtureOperator(state: ExceptionDeskState): ExceptionDeskState;
export declare function importLabeledFixture(state: ExceptionDeskState): ExceptionDeskState;
export declare function reviewExceptions(state: ExceptionDeskState): ExceptionDeskState;
export declare function confirmInvoiceDraft(state: ExceptionDeskState): ExceptionDeskState;
`;

const HOME_PAGE = `import { ExceptionDeskClient } from "./exception-desk-client";

export default function Home() {
  return (
    <main className="deskShell">
      <header className="deskHeader" aria-labelledby="venture-title">
        <div><p className="eyebrow">Exception Desk · synthetic launch fixture</p><h1 id="venture-title">Reconcile before you invoice.</h1></div>
        <p className="lede">Review deterministic sample discrepancies and confirm a local invoice draft. No customer data, message, payment, or email leaves this fixture.</p>
      </header>
      <ExceptionDeskClient />
    </main>
  );
}
`;

const JOURNEY_TEST = `import assert from "node:assert/strict";
import test from "node:test";
import { confirmInvoiceDraft, createExceptionDeskState, importLabeledFixture, reviewExceptions, signInFixtureOperator } from "../src/product/exception-desk.mjs";

test("founder primary journey reaches invoice_draft_confirmed using labeled samples", () => {
  const signedIn = signInFixtureOperator(createExceptionDeskState());
  const imported = importLabeledFixture(signedIn);
  assert.equal(imported.sampleLabel, "SYNTHETIC SAMPLE — NOT CUSTOMER DATA");
  assert.equal(imported.rows.length, 2);
  const reviewed = reviewExceptions(imported);
  const confirmed = confirmInvoiceDraft(reviewed);
  assert.equal(confirmed.stage, "invoice_draft_confirmed");
  assert.equal(confirmed.invoiceDraftConfirmed, true);
  assert.equal(JSON.stringify(confirmed).includes("@"), false);
});

test("confirmation cannot bypass review", () => {
  assert.throws(() => confirmInvoiceDraft(createExceptionDeskState()), /Review every exception/);
});
`;

const PRODUCT_E2E_TEST = `import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";

const contract = JSON.parse(readFileSync("tests/e2e/primary-journey.contract.json", "utf8"));
const runId = process.env.VH_PRIMARY_JOURNEY_RUN_ID;
const nonce = process.env.VH_PRIMARY_JOURNEY_NONCE;
const identityLabel = process.env.VH_PRIMARY_JOURNEY_TEST_IDENTITY;
if (!runId || !nonce || identityLabel !== contract.production.identity.label) {
  throw new Error("Primary journey requires exact run, nonce, and labeled test identity bindings");
}

test("fixture operator completes the product-specific Exception Desk journey", async ({ page, request }, testInfo) => {
  const runtimeErrors: string[] = [];
  page.on("pageerror", (error) => runtimeErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") runtimeErrors.push(message.text());
  });
  await page.route("**/*", async (route) => {
    const method = route.request().method();
    if (method === "GET" || method === "HEAD") await route.continue();
    else await route.abort("blockedbyclient");
  });

  const action = page.getByRole("button");
  await test.step(contract.steps[0], async () => {
    const smoke = await request.get("/", { failOnStatusCode: false });
    expect(smoke.status()).toBeGreaterThanOrEqual(200);
    expect(smoke.status()).toBeLessThan(400);
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { level: 1, name: "Reconcile before you invoice." })).toBeVisible();
    await expect(action).toHaveText("Sign in to fixture session");
    await action.click();
    await expect(action).toHaveText("Import labeled fixture");
  });
  await test.step(contract.steps[1], async () => {
    await action.click();
    await expect(page.getByText("SYNTHETIC SAMPLE — NOT CUSTOMER DATA")).toBeVisible();
  });
  await test.step(contract.steps[2], async () => {
    await action.click();
    await expect(action).toHaveText("Confirm invoice draft");
  });
  await test.step(contract.steps[3], async () => {
    await action.click();
    await expect(page.getByText("Draft confirmed locally · nothing sent or charged")).toBeVisible();
    await expect(page.getByRole("status")).toContainText("invoice_draft_confirmed");
  });
  expect(runtimeErrors).toEqual([]);
  console.log("VH_PRIMARY_JOURNEY_RESULT " + JSON.stringify({
    schemaVersion: 1,
    phase: "journey",
    runId,
    nonce,
    journeyId: contract.journeyId,
    steps: contract.steps,
    project: testInfo.project.name,
    identity: contract.production.identity,
    observedEffects: [],
    recipientCount: 0,
    recipientsAllMatchTestIdentity: true,
    forbiddenEffectsObserved: [],
  }));
});
`;

const PRODUCT_E2E_CLEANUP_TEST = `import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";

const contract = JSON.parse(readFileSync("tests/e2e/primary-journey.contract.json", "utf8"));
const runId = process.env.VH_PRIMARY_JOURNEY_RUN_ID;
const nonce = process.env.VH_PRIMARY_JOURNEY_NONCE;
const identityLabel = process.env.VH_PRIMARY_JOURNEY_TEST_IDENTITY;
if (!runId || !nonce || identityLabel !== contract.production.identity.label) {
  throw new Error("Primary journey cleanup requires exact run, nonce, and labeled identity bindings");
}

test("fixture cleanup verifies no labeled external writes remain", async ({ page }, testInfo) => {
  await test.step("verified cleanup read-back", async () => {
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await expect(page).toHaveURL(new RegExp("/$"));
  });
  console.log("VH_PRIMARY_JOURNEY_RESULT " + JSON.stringify({
    schemaVersion: 1,
    phase: "cleanup",
    runId,
    nonce,
    journeyId: contract.journeyId,
    steps: contract.steps,
    project: testInfo.project.name,
    identity: contract.production.identity,
    observedEffects: [],
    recipientCount: 0,
    recipientsAllMatchTestIdentity: true,
    forbiddenEffectsObserved: [],
    cleanup: { state: "verified", removedWrites: 0, remainingWrites: 0 },
  }));
});
`;

const FORBIDDEN_PRIMARY_JOURNEY_EFFECTS = [
  "customer_charge",
  "checkout",
  "external_delete",
  "dns_or_provider_configuration",
  "bulk_or_cold_send",
  "recipient_outside_test_identity",
  "irreversible_publication",
] as const;

function primaryJourneyContract(root: string): string {
  const launchContractPath = resolve(root, "config/launch-contract.yaml");
  const launchContract = existsSync(launchContractPath)
    ? (parse(readFileSync(launchContractPath, "utf8")) as {
        product: { primaryJourney: string[] };
        decision: { primarySuccessSignal: string };
      })
    : {
        product: { primaryJourney: JSON.parse(FOUNDER_CONTRACT).journey as string[] },
        decision: { primarySuccessSignal: JSON.parse(FOUNDER_CONTRACT).successSignal as string },
      };
  return `${JSON.stringify(
    {
      schemaVersion: 1,
      scope: "product_specific_end_to_end",
      journeyId: launchContract.decision.primarySuccessSignal,
      steps: launchContract.product.primaryJourney,
      specPath: "tests/e2e/primary-journey.spec.ts",
      cleanupSpecPath: "tests/e2e/primary-journey-cleanup.spec.ts",
      launchContractPath: "config/launch-contract.yaml",
      production: {
        effect: "reversible_external_write",
        identity: { kind: "labeled_test_identity", label: "FIXTURE — exception-desk-run" },
        cleanup: "required_and_verified",
        readBack: {
          method: "GET",
          path: "/api/venture-harness-primary-journey",
          protocol: "venture_harness_primary_journey_v1",
        },
        allowedEffects: ["reversible_external_write"],
        forbiddenEffects: FORBIDDEN_PRIMARY_JOURNEY_EFFECTS,
      },
    },
    null,
    2,
  )}\n`;
}

const EVENT_MODULE = `export const EXCEPTION_DESK_SUCCESS_SIGNAL = "invoice_draft_confirmed";

export function invoiceDraftConfirmedEvent(state) {
  if (state.stage !== EXCEPTION_DESK_SUCCESS_SIGNAL || state.invoiceDraftConfirmed !== true) {
    throw new Error("Verified invoice draft confirmation is required before instrumentation");
  }
  return Object.freeze({
    name: "core_journey_completed",
    properties: Object.freeze({
      journey_id: "exception_desk_reconciliation",
      outcome_id: EXCEPTION_DESK_SUCCESS_SIGNAL,
      release_version: "fixture-v0.2",
    }),
  });
}
`;

const EVENT_TYPES = `import type { ExceptionDeskState } from "../product/exception-desk.mjs";
export declare const EXCEPTION_DESK_SUCCESS_SIGNAL: "invoice_draft_confirmed";
export interface ExceptionDeskCompletionEvent { readonly name: "core_journey_completed"; readonly properties: Readonly<{ journey_id: "exception_desk_reconciliation"; outcome_id: "invoice_draft_confirmed"; release_version: "fixture-v0.2"; }>; }
export declare function invoiceDraftConfirmedEvent(state: ExceptionDeskState): ExceptionDeskCompletionEvent;
`;

const JOURNEY_CLIENT_INSTRUMENTED = `"use client";

import { useState } from "react";
import { invoiceDraftConfirmedEvent } from "../src/analytics/exception-desk-events.mjs";
import {
  confirmInvoiceDraft,
  createExceptionDeskState,
  importLabeledFixture,
  reviewExceptions,
  signInFixtureOperator,
  type ExceptionDeskState,
} from "../src/product/exception-desk.mjs";

const steps = ["Sign in", "Import labeled fixture", "Review exceptions", "Confirm invoice draft"];

function advance(state: ExceptionDeskState): ExceptionDeskState {
  if (state.stage === "signed_out") return signInFixtureOperator(state);
  if (state.stage === "ready_for_import") return importLabeledFixture(state);
  if (state.stage === "fixture_imported") return reviewExceptions(state);
  if (state.stage === "exceptions_reviewed") return confirmInvoiceDraft(state);
  return state;
}

function actionLabel(stage: ExceptionDeskState["stage"]): string {
  if (stage === "signed_out") return "Sign in to fixture session";
  if (stage === "ready_for_import") return "Import labeled fixture";
  if (stage === "fixture_imported") return "Mark exceptions reviewed";
  if (stage === "exceptions_reviewed") return "Confirm invoice draft";
  return "Invoice draft confirmed";
}

export function ExceptionDeskClient() {
  const [state, setState] = useState<ExceptionDeskState>(() => createExceptionDeskState());
  const [lastSafeEvent, setLastSafeEvent] = useState<string | null>(null);
  const stepIndex = ["signed_out", "ready_for_import", "fixture_imported", "exceptions_reviewed", "invoice_draft_confirmed"].indexOf(state.stage);
  const advanceJourney = () => setState((current) => {
    const next = advance(current);
    if (next.stage === "invoice_draft_confirmed") setLastSafeEvent(invoiceDraftConfirmedEvent(next).properties.outcome_id);
    return next;
  });
  return (
    <div className="deskGrid">
      <aside aria-labelledby="journey-heading"><h2 id="journey-heading">Reconciliation run</h2><ol className="journeySteps">{steps.map((step, index) => <li data-current={stepIndex === index} key={step}>{step}</li>)}</ol></aside>
      <section className="workbench" aria-live="polite">
        <p className="fixtureFlag">{state.sampleLabel ?? "LOCAL FIXTURE — NO LIVE ACCOUNT"}</p><h2>Invoice exceptions</h2>
        {state.rows.length === 0 ? <p className="lede">Sign in locally, then import the labeled sample to inspect two deterministic exceptions.</p> : <table className="sampleTable"><thead><tr><th>Account</th><th>Delivered</th><th>Draft</th><th>Exception</th></tr></thead><tbody>{state.rows.map((row) => <tr key={row.id}><td>{row.clientLabel}</td><td>{row.deliveredUnits}</td><td>{row.invoiceUnits}</td><td><span className="statusTag">{row.exception}</span></td></tr>)}</tbody></table>}
        <button className="primaryAction" disabled={state.invoiceDraftConfirmed} onClick={advanceJourney} type="button">{actionLabel(state.stage)}</button>
        {state.invoiceDraftConfirmed ? <p className="confirmationSeal">Draft confirmed locally · nothing sent or charged</p> : null}
        {lastSafeEvent ? <p role="status">Allowlisted outcome recorded: <code>{lastSafeEvent}</code>. No sample fields were included.</p> : null}
      </section>
    </div>
  );
}
`;

const EVENT_TEST = `import assert from "node:assert/strict";
import test from "node:test";
import { invoiceDraftConfirmedEvent } from "../src/analytics/exception-desk-events.mjs";
import { confirmInvoiceDraft, createExceptionDeskState, importLabeledFixture, reviewExceptions, signInFixtureOperator } from "../src/product/exception-desk.mjs";

test("success instrumentation is allowlisted and free of sample content", () => {
  const state = confirmInvoiceDraft(reviewExceptions(importLabeledFixture(signInFixtureOperator(createExceptionDeskState()))));
  const event = invoiceDraftConfirmedEvent(state);
  assert.deepEqual(event, { name: "core_journey_completed", properties: { journey_id: "exception_desk_reconciliation", outcome_id: "invoice_draft_confirmed", release_version: "fixture-v0.2" } });
  const propertyNames = Object.keys(event.properties);
  for (const forbidden of ["email", "name", "message", "search_text", "form_value", "clientLabel", "exception"]) assert.equal(propertyNames.includes(forbidden), false);
});
`;

function nodeCheck(root: string, files: readonly string[]): string {
  const result = spawnSync(process.execPath, ["--test", ...files], {
    cwd: root,
    env: { ...process.env, CI: "1" },
    encoding: "utf8",
    timeout: 30_000,
  });
  const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
  if (result.error || result.status !== 0) {
    throw new Error(
      [`node --test ${files.join(" ")} failed`, result.error?.message, output]
        .filter(Boolean)
        .join("\n"),
    );
  }
  return output.trim();
}

function result(
  changedFiles: string[],
  artifacts: NonNullable<BuildAgentResult["completion"]>["artifacts"],
  checkCommand: string,
  evidence: string,
  eventTypes: string[] = [],
): BuildAgentResult {
  return {
    status: "completed",
    summary:
      changedFiles.length > 0
        ? `Created ${changedFiles.length} fixture-labeled venture artifact(s).`
        : "Verified the existing fixture-labeled venture artifacts without changing them.",
    changedFiles,
    checks: [{ command: checkCommand, status: "passed", evidence }],
    limitations: [FIXTURE_LIMITATION],
    eventTypes,
    completion: {
      outcome: changedFiles.length > 0 ? "changed" : "already_compliant",
      artifacts,
      validator: { checkCommand },
    },
  };
}

export class FounderGoldenPathBuildAgentFixture implements BuildAgentHost {
  readonly id = "founder-golden-path-build-fixture";
  readonly invocations: string[] = [];
  readonly #root: string;

  constructor(root: string) {
    this.#root = resolve(root);
  }

  async inspect(): Promise<BuildAgentHostInspection> {
    return {
      host: this.id,
      status: "available",
      readIsolation: "fixture_no_model_execution",
      version: "fixture-v1",
      billingMode: "fixture_no_model_execution",
      billingEvidence: "fixture_attestation",
      nextAction: null,
    };
  }

  async run(request: BuildAgentRequest): Promise<BuildAgentResult> {
    this.invocations.push(request.nodeId);
    if (request.nodeId === "prepare-repository") return this.#prepareRepository();
    if (request.nodeId === "review-product") return this.#reviewProduct();
    throw new Error(`Unexpected founder fixture build task: ${request.nodeId}`);
  }

  #prepareRepository(): BuildAgentResult {
    const changed = this.#write({
      "src/product/founder-contract.json": FOUNDER_CONTRACT,
      "tests/founder-scaffold.test.mjs": FOUNDER_SCAFFOLD_TEST,
      "docs/brand/DESIGN.md": DESIGN_RECORD,
      "src/design/theme.css": THEME_CSS,
      "app/globals.css": GLOBAL_CSS,
      "tests/design-contract.test.mjs": DESIGN_TEST,
      "src/product/exception-desk.mjs": JOURNEY_MODULE,
      "src/product/exception-desk.d.mts": JOURNEY_TYPES,
      "app/page.tsx": HOME_PAGE,
      "tests/exception-desk-journey.test.mjs": JOURNEY_TEST,
      "tests/e2e/primary-journey.spec.ts": PRODUCT_E2E_TEST,
      "tests/e2e/primary-journey-cleanup.spec.ts": PRODUCT_E2E_CLEANUP_TEST,
      "tests/e2e/primary-journey.contract.json": primaryJourneyContract(this.#root),
      "src/analytics/exception-desk-events.mjs": EVENT_MODULE,
      "src/analytics/exception-desk-events.d.mts": EVENT_TYPES,
      "app/exception-desk-client.tsx": JOURNEY_CLIENT_INSTRUMENTED,
      "tests/exception-desk-events.test.mjs": EVENT_TEST,
    });
    const files = [
      "tests/founder-scaffold.test.mjs",
      "tests/design-contract.test.mjs",
      "tests/exception-desk-journey.test.mjs",
      "tests/exception-desk-events.test.mjs",
    ];
    const command = `node --test ${files.join(" ")}`;
    return result(
      changed,
      [
        { path: "src/product/founder-contract.json", role: "repository_scaffold" },
        { path: "harness.lock", role: "managed_manifest" },
        { path: "docs/brand/DESIGN.md", role: "design_record" },
        { path: "src/design/theme.css", role: "design_implementation" },
        { path: "app/exception-desk-client.tsx", role: "core_journey" },
        { path: "tests/exception-desk-journey.test.mjs", role: "affected_test" },
        { path: "tests/e2e/primary-journey.spec.ts", role: "affected_test" },
        { path: "tests/e2e/primary-journey-cleanup.spec.ts", role: "affected_test" },
        { path: "tests/e2e/primary-journey.contract.json", role: "affected_test" },
        { path: "src/analytics/exception-desk-events.mjs", role: "event_contract" },
        { path: "app/exception-desk-client.tsx", role: "event_instrumentation" },
      ],
      command,
      nodeCheck(this.#root, files),
      ["core_journey_completed"],
    );
  }

  #reviewProduct(): BuildAgentResult {
    const files = [
      "tests/design-contract.test.mjs",
      "tests/exception-desk-journey.test.mjs",
      "tests/exception-desk-events.test.mjs",
    ];
    const command = `node --test ${files.join(" ")}`;
    return result(
      [],
      [
        { path: "src/design/theme.css", role: "design_implementation" },
        { path: "app/exception-desk-client.tsx", role: "core_journey" },
        { path: "tests/exception-desk-journey.test.mjs", role: "affected_test" },
        { path: "tests/e2e/primary-journey.spec.ts", role: "affected_test" },
        { path: "tests/e2e/primary-journey-cleanup.spec.ts", role: "affected_test" },
        { path: "tests/e2e/primary-journey.contract.json", role: "affected_test" },
        { path: "app/exception-desk-client.tsx", role: "event_instrumentation" },
      ],
      command,
      nodeCheck(this.#root, files),
      ["core_journey_completed"],
    );
  }

  #write(files: Readonly<Record<string, string>>): string[] {
    const changed: string[] = [];
    for (const [path, content] of Object.entries(files)) {
      const target = this.#target(path);
      if (existsSync(target) && readFileSync(target, "utf8") === content) continue;
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, content, { encoding: "utf8", mode: 0o600 });
      changed.push(path);
    }
    return changed;
  }

  #target(path: string): string {
    if (!path || path.startsWith("/") || path.includes("\\") || path.split("/").includes("..")) {
      throw new Error(`Unsafe founder fixture path: ${path}`);
    }
    const target = resolve(this.#root, path);
    const child = relative(this.#root, target);
    if (!child || child === ".." || child.startsWith(`..${sep}`)) {
      throw new Error(`Founder fixture path escapes child root: ${path}`);
    }
    return target;
  }
}

export interface FounderGoldenPathProductInvocation {
  command: string;
  args: string[];
  cwd: string | null;
  deploymentUrl: string | null;
  fixtureProvenance: "local_product_command_boundary";
}

export class FounderGoldenPathProductCommandFixture implements CommandRunner {
  readonly invocations: FounderGoldenPathProductInvocation[] = [];
  readonly #root: string;

  constructor(root: string) {
    this.#root = resolve(root);
  }

  async run(invocation: CommandInvocation): Promise<CommandResult> {
    const cwd = resolve(invocation.cwd ?? ".");
    if (cwd !== this.#root || invocation.command !== "pnpm") {
      throw new Error("Founder product fixture accepts only child-local direct pnpm commands");
    }
    const deploymentUrl = invocation.env?.PLAYWRIGHT_BASE_URL ?? null;
    this.invocations.push({
      command: invocation.command,
      args: [...invocation.args],
      cwd,
      deploymentUrl,
      fixtureProvenance: "local_product_command_boundary",
    });
    const tests = [
      "tests/founder-scaffold.test.mjs",
      "tests/design-contract.test.mjs",
      "tests/exception-desk-journey.test.mjs",
      "tests/exception-desk-events.test.mjs",
    ];
    if (
      invocation.args.join("\u0000") === CHILD_DEPENDENCY_INSTALL_ARGS.join("\u0000") ||
      (invocation.args.length === 1 &&
        (invocation.args[0] === "verify:fast" || invocation.args[0] === "build"))
    ) {
      return runChildPnpm(invocation, this.#root);
    }
    if (invocation.args.length === 1 && invocation.args[0] === "verify:mvp") {
      for (const path of [
        "tests/e2e/primary-journey.spec.ts",
        "tests/e2e/primary-journey-cleanup.spec.ts",
        "tests/e2e/primary-journey.contract.json",
      ]) {
        if (!existsSync(resolve(this.#root, path))) {
          throw new Error(`Synthetic fixture MVP is missing ${path}`);
        }
      }
      return {
        exitCode: 0,
        stdout:
          "fixtureProvenance=local_product_command_boundary\nfixtureState=fixture\nprimaryJourneyContractChecked=true\n",
        stderr: "",
      };
    }
    if (
      invocation.args.join("\u0000") ===
      ["exec", "playwright", "test", "tests/e2e/post-deploy-readonly.spec.ts", "--retries=0"].join(
        "\u0000",
      )
    ) {
      if (!deploymentUrl || !/^https:\/\/[^/]+\.fixture\.vercel\.app$/u.test(deploymentUrl)) {
        throw new Error("Post-deploy fixture requires the verified fixture Vercel origin");
      }
      if (
        !readFileSync(resolve(this.#root, "app/page.tsx"), "utf8").includes("ExceptionDeskClient")
      ) {
        throw new Error("Post-deploy fixture could not read back the primary product surface");
      }
      const observerPhase = invocation.env?.VH_PRIMARY_JOURNEY_OBSERVER_PHASE;
      if (observerPhase) {
        const contract = JSON.parse(
          readFileSync(resolve(this.#root, "tests/e2e/primary-journey.contract.json"), "utf8"),
        ) as { journeyId: string; steps: string[]; production: { identity: { label: string } } };
        const writes =
          observerPhase === "journey_readback"
            ? [
                {
                  id: "fixture-write-1",
                  label: contract.production.identity.label,
                  state: "verified",
                },
              ]
            : [];
        return {
          exitCode: 0,
          stdout: ["desktop-chromium", "mobile-chromium"]
            .map(
              (project) =>
                `VH_PRIMARY_JOURNEY_OBSERVER_RESULT ${JSON.stringify({
                  schemaVersion: 1,
                  phase: observerPhase,
                  runId: invocation.env?.VH_PRIMARY_JOURNEY_RUN_ID,
                  nonce: invocation.env?.VH_PRIMARY_JOURNEY_NONCE,
                  journeyId: contract.journeyId,
                  identityLabel: contract.production.identity.label,
                  completedSteps: contract.steps,
                  project,
                  writes,
                  removedWriteIds: observerPhase === "cleanup_readback" ? ["fixture-write-1"] : [],
                  remainingWrites: writes.length,
                })}`,
            )
            .join("\n"),
          stderr: "",
        };
      }
      return {
        exitCode: 0,
        stdout: `fixtureProvenance=local_product_command_boundary\nread_only_origin=${deploymentUrl}\n${[
          "desktop-chromium",
          "mobile-chromium",
        ]
          .map(
            (project) =>
              `VH_DEPLOYMENT_SURFACE_RESULT ${JSON.stringify({
                schemaVersion: 1,
                project,
                rawServerHtml: true,
                accessibilityAxe: true,
                accessibleNamesAndLandmarks: true,
                keyboardFocus: true,
                responsiveOverflow: true,
              })}`,
          )
          .join("\n")}\n${nodeCheck(this.#root, tests.slice(2))}`,
        stderr: "",
      };
    }
    const journeySpec = invocation.args[3];
    if (
      invocation.args.slice(0, 3).join("\u0000") ===
        ["exec", "playwright", "test"].join("\u0000") &&
      ["tests/e2e/primary-journey.spec.ts", "tests/e2e/primary-journey-cleanup.spec.ts"].includes(
        journeySpec ?? "",
      ) &&
      invocation.args[4] === "--retries=0"
    ) {
      const contract = JSON.parse(
        readFileSync(resolve(this.#root, "tests/e2e/primary-journey.contract.json"), "utf8"),
      ) as {
        journeyId: string;
        steps: string[];
        production: { identity: { kind: "labeled_test_identity"; label: string } };
      };
      const runId = invocation.env?.VH_PRIMARY_JOURNEY_RUN_ID;
      const nonce = invocation.env?.VH_PRIMARY_JOURNEY_NONCE;
      if (
        !runId ||
        !nonce ||
        invocation.env?.VH_PRIMARY_JOURNEY_TEST_IDENTITY !== contract.production.identity.label
      ) {
        throw new Error("Fixture product journey requires exact runtime evidence bindings");
      }
      const phase = journeySpec.includes("cleanup") ? "cleanup" : "journey";
      const traceRoot = invocation.env?.PLAYWRIGHT_OUTPUT_DIR;
      if (!traceRoot)
        throw new Error("Fixture journey requires a run-scoped Playwright output dir");
      for (const project of ["desktop-chromium", "mobile-chromium"]) {
        const directory = resolve(this.#root, traceRoot, project);
        mkdirSync(directory, { recursive: true });
        writeFileSync(
          resolve(directory, "trace.zip"),
          traceArchive(deploymentUrl ?? "", contract.steps, phase),
        );
      }
      const markers = ["desktop-chromium", "mobile-chromium"].map((project) => ({
        schemaVersion: 1,
        phase,
        runId,
        nonce,
        journeyId: contract.journeyId,
        steps: contract.steps,
        project,
        identity: contract.production.identity,
        observedEffects: [],
        recipientCount: 0,
        recipientsAllMatchTestIdentity: true,
        forbiddenEffectsObserved: [],
        ...(phase === "cleanup"
          ? { cleanup: { state: "verified", removedWrites: 0, remainingWrites: 0 } }
          : {}),
      }));
      return {
        exitCode: 0,
        stdout: markers
          .map((marker) => `VH_PRIMARY_JOURNEY_RESULT ${JSON.stringify(marker)}`)
          .join("\n"),
        stderr: "",
      };
    }
    throw new Error(`Unexpected founder product command: pnpm ${invocation.args.join(" ")}`);
  }
}
