/**
 * Trivial test to verify the vitest + fast-check toolchain runs.
 * Also smoke-tests the edit config module defaults.
 */
import { describe, it, expect } from "vitest";
import { getEditMode, isCloudMode, getEditorBaseUrl, getMaxClipsPerJob, getMaxBrollBytes, getSignedUrlTtlSec } from "../config";

describe("edit/config — defaults", () => {
  it("defaults EDIT_MODE to local", () => {
    // With no env override the mode should be local
    expect(getEditMode()).toBe("local");
  });

  it("isCloudMode() returns false in local mode", () => {
    expect(isCloudMode()).toBe(false);
  });

  it("defaults EDITOR_BASE_URL to http://127.0.0.1:8000", () => {
    expect(getEditorBaseUrl()).toBe("http://127.0.0.1:8000");
  });

  it("defaults MAX_CLIPS_PER_JOB to 500", () => {
    expect(getMaxClipsPerJob()).toBe(500);
  });

  it("defaults MAX_BROLL_BYTES to 500 MB", () => {
    expect(getMaxBrollBytes()).toBe(500 * 1024 * 1024);
  });

  it("defaults EDIT_SIGNED_URL_TTL_SEC to 3600", () => {
    expect(getSignedUrlTtlSec()).toBe(3600);
  });
});
