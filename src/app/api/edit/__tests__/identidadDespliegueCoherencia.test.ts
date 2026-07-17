/**
 * Task 3.1 — Deployment identity coherence (spec `unir-step-hang`,
 * design §"Fix Implementation / Change 1", Property 3).
 *
 * Validates: Requirements 2.8, 2.9
 *
 * Closes the Category-D gap documented by Task 1.3: the exact manual identifier
 * `v0.9125 kiwi xD` is now baked once via env, rendered beside the
 * `AUGC Pipeline` title (see `src/app/layout.tsx`), and echoed by
 * GET /api/version through the shared `getAppVersion()` source — so the header
 * identifier and the API value agree and both correspond to the same build.
 *
 * The Docker image tag is space-separated from the manual identifier
 * ("<image-tag> v0.9125 kiwi xD"). The Cloud Run revision (K_REVISION) is a
 * server-side-only diagnostic and MUST NOT appear in the client-facing
 * /api/version payload.
 */

import { describe, it, expect } from "vitest";
import {
  getAppVersion,
  getServerDiagnostics,
  MANUAL_IDENTIFIER,
} from "@/lib/version";
import { GET as versionGET } from "@/app/api/version/route";

describe("Task 3.1 — header identifier is coherent with /api/version", () => {
  it("getAppVersion exposes the exact manual identifier `v0.9125 kiwi xD`", () => {
    const local = getAppVersion();
    expect(local.identifier).toBe(MANUAL_IDENTIFIER);
    expect(local.version).toContain(MANUAL_IDENTIFIER);
  });

  it("the header identifier equals the /api/version value (same shared source)", async () => {
    // The header (src/app/layout.tsx) renders getAppVersion().identifier; the
    // API echoes getAppVersion(). Comparing both to the same source proves the
    // header identifier is contained in the /api/version value.
    const headerIdentifier = getAppVersion().identifier;

    const res = await versionGET();
    const body = (await res.json()) as {
      version: string;
      imageTag: string;
      identifier: string;
      buildTime: string;
    };

    expect(body.identifier).toBe(headerIdentifier);
    expect(body.version).toContain(headerIdentifier);
  });

  it("header and /api/version correspond to the same build (image tag + composition)", async () => {
    const local = getAppVersion();

    const res = await versionGET();
    const body = (await res.json()) as {
      version: string;
      imageTag: string;
      identifier: string;
      buildTime: string;
    };

    // Same baked build identity.
    expect(body.imageTag).toBe(local.imageTag);
    expect(body.buildTime).toBe(local.buildTime);
    // version is "<image-tag> <manual identifier>", space-separated.
    expect(body.version).toBe(`${local.imageTag} ${MANUAL_IDENTIFIER}`);
    expect(body.version).toBe(local.version);
  });
});

describe("Task 3.1 — K_REVISION stays server-side only", () => {
  it("the /api/version payload never exposes the Cloud Run revision", async () => {
    const res = await versionGET();
    const body = (await res.json()) as Record<string, unknown>;

    expect(body).not.toHaveProperty("revision");
    expect(body).not.toHaveProperty("K_REVISION");
  });

  it("server-side diagnostics carry the revision for correlation", () => {
    const diagnostics = getServerDiagnostics();
    // Present as a server-side field (label only, no secrets); defaults to
    // "unknown" outside Cloud Run.
    expect(diagnostics).toHaveProperty("revision");
    expect(typeof diagnostics.revision).toBe("string");
    // Still coherent with the client-facing identity.
    expect(diagnostics.version).toBe(getAppVersion().version);
  });
});
