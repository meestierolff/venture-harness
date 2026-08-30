import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { readBoundedJson } from "@/lib/bounded-json";

const evidenceStore = vi.hoisted(() => ({
  persistEvidence: vi.fn(),
  persistSubmission: vi.fn(),
}));
const rateLimit = vi.hoisted(() => ({
  allowRequest: vi.fn(() => true),
  clientRateLimitKey: vi.fn(() => "test-client"),
}));

vi.mock("@/lib/evidence-store", () => evidenceStore);
vi.mock("@/lib/rate-limit", () => rateLimit);

import { POST as postEvidence } from "@/app/api/evidence/route";
import { POST as postLead } from "@/app/api/lead/route";

function jsonRequest(path: string, body: unknown, headers: Record<string, string> = {}) {
  return new NextRequest(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

const validLead = {
  form_id: "qualification-application",
  visitor_id: "10000000-0000-4000-8000-000000000001",
  role: "Founder",
  company_size: "1-10",
  budget_band: "reviewed",
  timeline: "now",
  contact: "fixture@example.test",
  notes: "TEST only",
  website: "",
};

beforeEach(() => {
  evidenceStore.persistEvidence.mockReset().mockResolvedValue(undefined);
  evidenceStore.persistSubmission.mockReset().mockResolvedValue(undefined);
  rateLimit.allowRequest.mockReset().mockReturnValue(true);
  rateLimit.clientRateLimitKey.mockReset().mockReturnValue("test-client");
});

describe("bounded API request handling", () => {
  it("stops a streamed body as soon as the byte limit is exceeded", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(17));
        controller.close();
      },
    });
    const request = new Request("http://localhost/api/test", {
      method: "POST",
      body: stream,
      duplex: "half",
    } as RequestInit & { duplex: "half" });

    await expect(readBoundedJson(request, 16)).resolves.toEqual({
      ok: false,
      error: "payload_too_large",
    });
  });

  it("returns 413 before parsing an oversized declared request", async () => {
    const lead = await postLead(jsonRequest("/api/lead", validLead, { "content-length": "9000" }));
    const evidence = await postEvidence(
      jsonRequest(
        "/api/evidence",
        {
          event: "consent_granted",
          visitor_id: "10000000-0000-4000-8000-000000000002",
          props: {},
        },
        { "content-length": "20000" },
      ),
    );

    expect(lead.status).toBe(413);
    expect(evidence.status).toBe(413);
    expect(evidenceStore.persistSubmission).not.toHaveBeenCalled();
    expect(evidenceStore.persistEvidence).not.toHaveBeenCalled();
  });

  it("requires application/json before reading either public POST body", async () => {
    const lead = await postLead(
      jsonRequest("/api/lead", validLead, { "content-type": "text/plain" }),
    );
    const evidence = await postEvidence(
      new NextRequest("http://localhost/api/evidence", {
        method: "POST",
        body: JSON.stringify({
          event: "consent_granted",
          visitor_id: validLead.visitor_id,
          props: {},
        }),
      }),
    );

    expect(lead.status).toBe(415);
    expect(evidence.status).toBe(415);
    expect(evidenceStore.persistSubmission).not.toHaveBeenCalled();
    expect(evidenceStore.persistEvidence).not.toHaveBeenCalled();
  });

  it("accepts a same-origin Origin and rejects a cross-origin Origin before persistence", async () => {
    const accepted = await postLead(
      jsonRequest("/api/lead", validLead, {
        "content-type": "application/json; charset=utf-8",
        origin: "http://localhost",
      }),
    );
    expect(accepted.status).toBe(200);
    expect(evidenceStore.persistSubmission).toHaveBeenCalledTimes(1);

    evidenceStore.persistSubmission.mockClear();
    evidenceStore.persistEvidence.mockClear();
    const rejected = await postLead(
      jsonRequest("/api/lead", validLead, { origin: "https://cross-origin.example" }),
    );
    expect(rejected.status).toBe(403);
    expect(evidenceStore.persistSubmission).not.toHaveBeenCalled();
    expect(evidenceStore.persistEvidence).not.toHaveBeenCalled();
  });

  it("rejects unknown lead fields and excessive evidence property cardinality", async () => {
    const lead = await postLead(
      jsonRequest("/api/lead", { ...validLead, unreviewed_private_field: "fixture" }),
    );
    const props = Object.fromEntries(
      Array.from({ length: 33 }, (_, index) => [`fixture_${index}`, true]),
    );
    const evidence = await postEvidence(
      jsonRequest("/api/evidence", {
        event: "consent_granted",
        visitor_id: "10000000-0000-4000-8000-000000000003",
        props,
      }),
    );

    expect(lead.status).toBe(400);
    expect(evidence.status).toBe(400);
  });

  it("rejects caller-chosen form ids before private or analytics persistence", async () => {
    const response = await postLead(
      jsonRequest("/api/lead", { ...validLead, form_id: "jane@example.test" }),
    );

    expect(response.status).toBe(400);
    expect(evidenceStore.persistSubmission).not.toHaveBeenCalled();
    expect(evidenceStore.persistEvidence).not.toHaveBeenCalled();
  });

  it("rejects an unknown evidence property instead of silently dropping it", async () => {
    const evidence = await postEvidence(
      jsonRequest("/api/evidence", {
        event: "consent_granted",
        visitor_id: validLead.visitor_id,
        props: { unregistered_fixture: true },
      }),
    );

    expect(evidence.status).toBe(400);
    expect(evidenceStore.persistEvidence).not.toHaveBeenCalled();
  });

  it("keeps the analytics visitor id out of the personal submission record", async () => {
    const response = await postLead(jsonRequest("/api/lead", validLead));

    expect(response.status).toBe(200);
    expect(evidenceStore.persistSubmission).toHaveBeenCalledWith(
      expect.not.objectContaining({ visitor_id: expect.anything() }),
    );
    expect(evidenceStore.persistEvidence).toHaveBeenCalledWith(
      expect.objectContaining({ visitor_id: validLead.visitor_id }),
    );
  });

  it("rejects non-UUID visitor ids and private evidence values", async () => {
    const lead = await postLead(
      jsonRequest("/api/lead", { ...validLead, visitor_id: "fixture@example.test" }),
    );
    const evidence = await postEvidence(
      jsonRequest("/api/evidence", {
        event: "consent_granted",
        visitor_id: validLead.visitor_id,
        props: { to_state: "fixture@example.test" },
      }),
    );

    expect(lead.status).toBe(400);
    expect(evidence.status).toBe(400);
    expect(evidenceStore.persistSubmission).not.toHaveBeenCalled();
    expect(evidenceStore.persistEvidence).not.toHaveBeenCalled();
  });

  it.each(["Jane Founder", "jane", "+31612345678", "31612345678", "12 Main Street"])(
    "rejects free-form private evidence value %s before persistence",
    async (privateValue) => {
      const evidence = await postEvidence(
        jsonRequest("/api/evidence", {
          event: "hero_variant_exposed",
          visitor_id: validLead.visitor_id,
          props: {
            experiment_id: privateValue,
            variant_key: "control",
            route: "/",
          },
        }),
      );

      expect(evidence.status).toBe(400);
      expect(evidenceStore.persistEvidence).not.toHaveBeenCalled();
    },
  );

  it("accepts only the finite public consent event registry", async () => {
    const response = await postEvidence(
      jsonRequest("/api/evidence", {
        event: "consent_changed",
        visitor_id: validLead.visitor_id,
        props: { from_state: "accepted", to_state: "declined" },
      }),
    );

    expect(response.status).toBe(200);
    expect(evidenceStore.persistEvidence).toHaveBeenCalledWith({
      event: "consent_changed",
      visitor_id: validLead.visitor_id,
      props: { from_state: "accepted", to_state: "declined" },
    });
  });

  it("logs only a static category when persistence rejects", async () => {
    const canary = "private-persistence-canary";
    evidenceStore.persistSubmission.mockRejectedValueOnce(new Error(canary));
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const response = await postLead(jsonRequest("/api/lead", validLead));
      expect(response.status).toBe(503);
      expect(error).toHaveBeenCalledWith("lead_submission_persistence_failed");
      expect(JSON.stringify(error.mock.calls)).not.toContain(canary);
    } finally {
      error.mockRestore();
    }
  });
});

describe("private local evidence fallback", () => {
  async function withLocalFallback(
    run: (store: typeof import("@/lib/evidence-store"), root: string) => Promise<void>,
  ) {
    const root = mkdtempSync(join(tmpdir(), "vh-local-evidence-"));
    const cwd = vi.spyOn(process, "cwd").mockReturnValue(root);
    const environment = process.env as Record<string, string | undefined>;
    const previousFallback = process.env.EVIDENCE_LOCAL_FALLBACK;
    const previousDatabaseUrl = process.env.DATABASE_URL;
    const previousNodeEnv = process.env.NODE_ENV;
    environment.EVIDENCE_LOCAL_FALLBACK = "true";
    delete environment.DATABASE_URL;
    environment.NODE_ENV = "test";
    try {
      const store =
        await vi.importActual<typeof import("@/lib/evidence-store")>("@/lib/evidence-store");
      await run(store, root);
    } finally {
      cwd.mockRestore();
      if (previousFallback === undefined) delete environment.EVIDENCE_LOCAL_FALLBACK;
      else environment.EVIDENCE_LOCAL_FALLBACK = previousFallback;
      if (previousDatabaseUrl === undefined) delete environment.DATABASE_URL;
      else environment.DATABASE_URL = previousDatabaseUrl;
      if (previousNodeEnv === undefined) delete environment.NODE_ENV;
      else environment.NODE_ENV = previousNodeEnv;
      rmSync(root, { recursive: true, force: true });
    }
  }

  it("creates a 0700 directory and a 0600 single-link regular append file", async () => {
    await withLocalFallback(async (store, root) => {
      await store.persistEvidence({
        event: "consent_granted",
        visitor_id: validLead.visitor_id,
        props: {},
      });

      const directory = statSync(join(root, ".data"));
      const file = statSync(join(root, ".data", "evidence.jsonl"));
      expect(directory.mode & 0o777).toBe(0o700);
      expect(file.mode & 0o777).toBe(0o600);
      expect(file.isFile()).toBe(true);
      expect(file.nlink).toBe(1);
    });
  });

  it("refuses symlink and hard-link fallback targets without appending", async () => {
    await withLocalFallback(async (store, root) => {
      const data = join(root, ".data");
      mkdirSync(data, { mode: 0o700 });
      const canary = join(root, "canary.jsonl");
      writeFileSync(canary, "unchanged\n", { mode: 0o600 });

      symlinkSync(canary, join(data, "evidence.jsonl"));
      await expect(
        store.persistEvidence({
          event: "consent_granted",
          visitor_id: validLead.visitor_id,
          props: {},
        }),
      ).rejects.toBeInstanceOf(Error);
      expect(readFileSync(canary, "utf8")).toBe("unchanged\n");

      rmSync(join(data, "evidence.jsonl"));
      linkSync(canary, join(data, "evidence.jsonl"));
      await expect(
        store.persistEvidence({
          event: "consent_granted",
          visitor_id: validLead.visitor_id,
          props: {},
        }),
      ).rejects.toThrow(/one owned regular file with one link/u);
      expect(readFileSync(canary, "utf8")).toBe("unchanged\n");
    });
  });
});
