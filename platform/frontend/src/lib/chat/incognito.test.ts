// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import { beforeEach, describe, expect, it } from "vitest";
import { conversationStorageKeys } from "@/lib/chat/chat-utils";
import {
  generateIncognitoKey,
  getIncognitoKey,
  INCOGNITO_KEY_HEADER,
  incognitoRequestHeaders,
  isActionAvailableForConversation,
  storeIncognitoKey,
} from "./incognito";

describe("generateIncognitoKey", () => {
  it("produces base64url of 32 random bytes, without padding", () => {
    const key = generateIncognitoKey();

    // base64url alphabet only, and no '=' padding (the wire format the
    // backend parses).
    expect(key).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(Buffer.from(key, "base64url")).toHaveLength(32);
  });

  it("produces a fresh key per call", () => {
    expect(generateIncognitoKey()).not.toBe(generateIncognitoKey());
  });
});

describe("key storage", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("round-trips a key per conversation under the registered storage key", () => {
    storeIncognitoKey("conv-1", "key-1");

    expect(getIncognitoKey("conv-1")).toBe("key-1");
    expect(getIncognitoKey("conv-2")).toBeNull();
    // Stored under the conversationStorageKeys registry entry so the
    // delete-conversation cleanup sweeps it.
    expect(
      localStorage.getItem(conversationStorageKeys("conv-1").incognitoKey),
    ).toBe("key-1");
  });

  it("builds request headers only when a key is stored", () => {
    expect(incognitoRequestHeaders("conv-1")).toBeUndefined();
    expect(incognitoRequestHeaders(undefined)).toBeUndefined();

    storeIncognitoKey("conv-1", "key-1");
    expect(incognitoRequestHeaders("conv-1")).toEqual({
      [INCOGNITO_KEY_HEADER]: "key-1",
    });
  });
});

describe("isActionAvailableForConversation", () => {
  it("blocks the incognito-rejected actions only on incognito conversations", () => {
    expect(isActionAvailableForConversation({ incognito: true }, "share")).toBe(
      false,
    );
    expect(
      isActionAvailableForConversation({ incognito: false }, "share"),
    ).toBe(true);
    // Not-yet-loaded conversations don't hide anything prematurely.
    expect(isActionAvailableForConversation(null, "attachments")).toBe(true);
    expect(isActionAvailableForConversation(undefined, "fork")).toBe(true);
  });
});
