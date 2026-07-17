/**
 * Task 1.3 — Reproducible bug-condition diagnostic (Property 1): deployment
 * identity ambiguity (Category D) for the opaque 25% stall
 * (spec `unir-step-hang`, design §"Examples / Category D",
 * §"Exploratory Bug Condition Checking" case 4).
 *
 * Validates: Requirements 1.6, 1.8
 *
 * Methodology (bug-condition, order is mandatory)
 * ------------------------------------------------
 * This exploratory check documents the gap that lets a STALE bundle (Category D)
 * go unnoticed: today there is NO in-product coherence check tying the manual
 * identifier shown next to the `AUGC Pipeline` title to `GET /api/version`, and
 * the exact human identifier `v0.9123 banana xD` is not exposed at all. So a
 * "nothing changed after deploy" symptom cannot be attributed to a stale/mismatched
 * revision. The coherence assertion is EXPECTED TO FAIL on the current code; it
 * is closed by Task 3.1 (which bakes the identifier and renders it beside the
 * title) and re-run at Task 3.11. Do NOT fix production code or this test here.
 *
 * Reproduced counterexamples on the CURRENT code (the documented gap)
 * -------------------------------------------------------------------
 * 1. `getAppVersion()` returns only `{ version, buildTime }` sourced from
 *    `NEXT_PUBLIC_APP_VERSION` / `NEXT_PUBLIC_BUILD_TIME` (fallbacks "dev"/"unknown").
 *    It does NOT expose the manual identifier `v0.9123 banana xD`, so the header
 *    chip and `/api/version` cannot be checked for agreement in-product.
 * 2. `GET /api/version` echoes exactly `getAppVersion()` — so it inherits the
 *    same gap: there is no field a browser/curl can compare against the header
 *    identifier to detect a stale bundle (Category D).
 */

import { describe, it, expect } from "vitest";
import { getAppVersion } from "@/lib/version";
import { GET as versionGET } from "@/app/api/version/route";

/**
 * The exact manual identifier that MUST appear next to the `AUGC Pipeline` title
 * and be echoed by `/api/version` for the same build/revision (Req 2.8, 2.9).
 * Task 3.1 bakes this via env; today it is absent.
 */
const MANUAL_IDENTIFIER = "v0.9123 banana xD";

describe("Task 1.3 — deployment identity baseline (build-time only)", () => {
  it("GET /api/version echoes getAppVersion() (shared source, build-time coherence)", async () => {
    const res = await versionGET();
    const body = (await res.json()) as { version?: unknown; buildTime?: unknown };
    const local = getAppVersion();
    expect(body.version).toBe(local.version);
    expect(body.buildTime).toBe(local.buildTime);
  });

  it("today the version fields are the generic build identity, not a human identifier", () => {
    // Documents the current shape: only {version, buildTime}. There is no manual
    // human identifier — this is the ambiguity Category D exploits.
    const local = getAppVersion();
    expect(local).toHaveProperty("version");
    expect(local).toHaveProperty("buildTime");
  });
});

describe("Task 1.3 — no in-product identifier coherence (EXPECTED FAIL on current code)", () => {
  it("exposes the manual identifier `v0.9123 banana xD` coherently via /api/version", async () => {
    // GAP: there is no in-product way to confirm the live build/revision because
    // the manual identifier that sits beside `AUGC Pipeline` is not exposed by
    // getAppVersion()/`/api/version`. A stale bundle (Category D) is therefore
    // easy to misread. Task 3.1 bakes `v0.9123 banana xD` and makes header and
    // `/api/version` coherent for the same build/revision.
    const local = getAppVersion();
    const res = await versionGET();
    const body = (await res.json()) as { version?: unknown };

    expect(
      String(local.version),
      "getAppVersion().version must expose the manual identifier so the header " +
        "chip and /api/version can be checked for agreement (category D detection)",
    ).toContain(MANUAL_IDENTIFIER);

    // And the API must echo the same identifier for the same build/revision.
    expect(String(body.version)).toContain(MANUAL_IDENTIFIER);
    expect(body.version).toBe(local.version);
  });
});
