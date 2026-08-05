// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import { beforeEach, describe, expect, it } from "vitest";
import {
  browserCredentialHeaders,
  CREDENTIAL_KEY_HEADER,
  getBrowserCredentialKey,
  getOrCreateBrowserCredentialKey,
} from "./browser-credential-key";

const STORAGE_KEY = "archestra_mcp_credential_key";

beforeEach(() => {
  localStorage.clear();
});

describe("getOrCreateBrowserCredentialKey", () => {
  it("produces base64url of 32 random bytes, without padding", () => {
    const key = getOrCreateBrowserCredentialKey();

    // base64url alphabet only, and no '=' padding (the wire format the
    // backend parses).
    expect(key).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(Buffer.from(key, "base64url")).toHaveLength(32);
  });

  it("persists one key per browser and reuses it on later calls", () => {
    const first = getOrCreateBrowserCredentialKey();

    // The SAME single key is reused for every protected credential.
    expect(getOrCreateBrowserCredentialKey()).toBe(first);
    expect(localStorage.getItem(STORAGE_KEY)).toBe(first);
  });

  it("adopts a key already present in storage", () => {
    localStorage.setItem(STORAGE_KEY, "pre-existing-key");

    expect(getOrCreateBrowserCredentialKey()).toBe("pre-existing-key");
  });
});

describe("getBrowserCredentialKey", () => {
  it("returns null when this browser has no key", () => {
    expect(getBrowserCredentialKey()).toBeNull();
  });

  it("returns the stored key", () => {
    const key = getOrCreateBrowserCredentialKey();

    expect(getBrowserCredentialKey()).toBe(key);
  });
});

describe("browserCredentialHeaders", () => {
  it("builds request headers only when a key is stored", () => {
    expect(browserCredentialHeaders()).toBeUndefined();

    const key = getOrCreateBrowserCredentialKey();
    expect(browserCredentialHeaders()).toEqual({
      [CREDENTIAL_KEY_HEADER]: key,
    });
  });
});
