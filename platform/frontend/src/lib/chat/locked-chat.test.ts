import { beforeEach, describe, expect, it } from "vitest";
import { conversationStorageKeys } from "@/lib/chat/chat-utils";
import {
  generateLockedChatKey,
  getLockedChatKey,
  isActionAvailableForConversation,
  LOCKED_CHAT_KEY_HEADER,
  lockedChatRequestHeaders,
  storeLockedChatKey,
} from "./locked-chat";

describe("generateLockedChatKey", () => {
  it("produces base64url of 32 random bytes, without padding", () => {
    const key = generateLockedChatKey();

    // base64url alphabet only, and no '=' padding (the wire format the
    // backend parses).
    expect(key).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(Buffer.from(key, "base64url")).toHaveLength(32);
  });

  it("produces a fresh key per call", () => {
    expect(generateLockedChatKey()).not.toBe(generateLockedChatKey());
  });
});

describe("key storage", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("round-trips a key per conversation under the registered storage key", () => {
    const key = generateLockedChatKey();
    storeLockedChatKey("conv-1", key);

    expect(getLockedChatKey("conv-1")).toBe(key);
    expect(getLockedChatKey("conv-2")).toBeNull();
    // Stored under the conversationStorageKeys registry entry so the
    // delete-conversation cleanup sweeps it.
    expect(
      localStorage.getItem(conversationStorageKeys("conv-1").lockedChatKey),
    ).toBe(key);
  });

  it("builds request headers only when a key is stored", () => {
    expect(lockedChatRequestHeaders("conv-1")).toBeUndefined();
    expect(lockedChatRequestHeaders(undefined)).toBeUndefined();

    const key = generateLockedChatKey();
    storeLockedChatKey("conv-1", key);
    expect(lockedChatRequestHeaders("conv-1")).toEqual({
      [LOCKED_CHAT_KEY_HEADER]: key,
    });
  });

  it("adopts a key written under the pre-rename storage key", () => {
    const key = generateLockedChatKey();
    const keys = conversationStorageKeys("conv-1");
    localStorage.setItem(keys.legacyLockedChatKey, key);

    // The browser holds the only copy outside escrow, so a chat created
    // before the rename has to keep opening.
    expect(getLockedChatKey("conv-1")).toBe(key);
    // Moved rather than copied, so the old entry stops shadowing it.
    expect(localStorage.getItem(keys.lockedChatKey)).toBe(key);
    expect(localStorage.getItem(keys.legacyLockedChatKey)).toBeNull();
  });

  it("prefers the current storage key over a stale legacy one", () => {
    const current = generateLockedChatKey();
    const stale = generateLockedChatKey();
    const keys = conversationStorageKeys("conv-1");
    localStorage.setItem(keys.lockedChatKey, current);
    localStorage.setItem(keys.legacyLockedChatKey, stale);

    expect(getLockedChatKey("conv-1")).toBe(current);
  });

  it("discards a malformed stored key so the chat gets the tombstone, not a 400", () => {
    const storageKey = conversationStorageKeys("conv-1").lockedChatKey;
    // e.g. localStorage corrupted, or a stringified undefined written by a bug
    localStorage.setItem(storageKey, "undefined");

    expect(getLockedChatKey("conv-1")).toBeNull();
    expect(lockedChatRequestHeaders("conv-1")).toBeUndefined();
    // Self-heals: the garbage entry is removed.
    expect(localStorage.getItem(storageKey)).toBeNull();
  });
});

describe("isActionAvailableForConversation", () => {
  it("blocks the locked-chat-rejected actions only on locked chats", () => {
    expect(
      isActionAvailableForConversation({ lockedChat: true }, "share"),
    ).toBe(false);
    expect(
      isActionAvailableForConversation({ lockedChat: false }, "share"),
    ).toBe(true);
    // Not-yet-loaded conversations don't hide anything prematurely.
    expect(isActionAvailableForConversation(null, "attachments")).toBe(true);
    expect(isActionAvailableForConversation(undefined, "fork")).toBe(true);
  });
});
