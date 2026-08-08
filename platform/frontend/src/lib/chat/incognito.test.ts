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
    const key = generateIncognitoKey();
    storeIncognitoKey("conv-1", key);

    expect(getIncognitoKey("conv-1")).toBe(key);
    expect(getIncognitoKey("conv-2")).toBeNull();
    // Stored under the conversationStorageKeys registry entry so the
    // delete-conversation cleanup sweeps it.
    expect(
      localStorage.getItem(conversationStorageKeys("conv-1").incognitoKey),
    ).toBe(key);
  });

  it("builds request headers only when a key is stored", () => {
    expect(incognitoRequestHeaders("conv-1")).toBeUndefined();
    expect(incognitoRequestHeaders(undefined)).toBeUndefined();

    const key = generateIncognitoKey();
    storeIncognitoKey("conv-1", key);
    expect(incognitoRequestHeaders("conv-1")).toEqual({
      [INCOGNITO_KEY_HEADER]: key,
    });
  });

  it("discards a malformed stored key so the chat gets the tombstone, not a 400", () => {
    const storageKey = conversationStorageKeys("conv-1").incognitoKey;
    // e.g. localStorage corrupted, or a stringified undefined written by a bug
    localStorage.setItem(storageKey, "undefined");

    expect(getIncognitoKey("conv-1")).toBeNull();
    expect(incognitoRequestHeaders("conv-1")).toBeUndefined();
    // Self-heals: the garbage entry is removed.
    expect(localStorage.getItem(storageKey)).toBeNull();
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
