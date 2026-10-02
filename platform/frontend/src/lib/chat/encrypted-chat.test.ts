import { beforeEach, describe, expect, it } from "vitest";
import { conversationStorageKeys } from "@/lib/chat/chat-utils";
import {
  ENCRYPTED_CHAT_KEY_HEADER,
  encryptedChatRequestHeaders,
  generateEncryptedChatKey,
  getEncryptedChatKey,
  isActionAvailableForConversation,
  storeEncryptedChatKey,
} from "./encrypted-chat";

describe("generateEncryptedChatKey", () => {
  it("produces base64url of 32 random bytes, without padding", () => {
    const key = generateEncryptedChatKey();

    // base64url alphabet only, and no '=' padding (the wire format the
    // backend parses).
    expect(key).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(Buffer.from(key, "base64url")).toHaveLength(32);
  });

  it("produces a fresh key per call", () => {
    expect(generateEncryptedChatKey()).not.toBe(generateEncryptedChatKey());
  });
});

describe("key storage", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("round-trips a key per conversation under the registered storage key", () => {
    const key = generateEncryptedChatKey();
    storeEncryptedChatKey("conv-1", key);

    expect(getEncryptedChatKey("conv-1")).toBe(key);
    expect(getEncryptedChatKey("conv-2")).toBeNull();
    // Stored under the conversationStorageKeys registry entry so the
    // delete-conversation cleanup sweeps it.
    expect(
      localStorage.getItem(conversationStorageKeys("conv-1").encryptedChatKey),
    ).toBe(key);
  });

  it("builds request headers only when a key is stored", () => {
    expect(encryptedChatRequestHeaders("conv-1")).toBeUndefined();
    expect(encryptedChatRequestHeaders(undefined)).toBeUndefined();

    const key = generateEncryptedChatKey();
    storeEncryptedChatKey("conv-1", key);
    expect(encryptedChatRequestHeaders("conv-1")).toEqual({
      [ENCRYPTED_CHAT_KEY_HEADER]: key,
    });
  });

  it.each([
    0, 1,
  ])("adopts a key written under pre-rename storage key #%i", (index) => {
    const key = generateEncryptedChatKey();
    const keys = conversationStorageKeys("conv-1");
    const legacyKey = keys.legacyEncryptedChatKeys[index];
    localStorage.setItem(legacyKey, key);

    // The browser holds the only copy outside escrow, so a chat created
    // before the rename has to keep opening.
    expect(getEncryptedChatKey("conv-1")).toBe(key);
    // Moved rather than copied, so the old entry stops shadowing it.
    expect(localStorage.getItem(keys.encryptedChatKey)).toBe(key);
    expect(localStorage.getItem(legacyKey)).toBeNull();
  });

  it("prefers the current storage key over a stale legacy one", () => {
    const current = generateEncryptedChatKey();
    const stale = generateEncryptedChatKey();
    const keys = conversationStorageKeys("conv-1");
    localStorage.setItem(keys.encryptedChatKey, current);
    localStorage.setItem(keys.legacyEncryptedChatKeys[0], stale);

    expect(getEncryptedChatKey("conv-1")).toBe(current);
  });

  it("discards a malformed stored key so the chat gets the tombstone, not a 400", () => {
    const storageKey = conversationStorageKeys("conv-1").encryptedChatKey;
    // e.g. localStorage corrupted, or a stringified undefined written by a bug
    localStorage.setItem(storageKey, "undefined");

    expect(getEncryptedChatKey("conv-1")).toBeNull();
    expect(encryptedChatRequestHeaders("conv-1")).toBeUndefined();
    // Self-heals: the garbage entry is removed.
    expect(localStorage.getItem(storageKey)).toBeNull();
  });
});

describe("isActionAvailableForConversation", () => {
  it("blocks the encrypted-chat-rejected actions only on encrypted chats", () => {
    expect(
      isActionAvailableForConversation({ encryptedChat: true }, "share"),
    ).toBe(false);
    expect(
      isActionAvailableForConversation({ encryptedChat: false }, "share"),
    ).toBe(true);
    // Not-yet-loaded conversations don't hide anything prematurely.
    expect(isActionAvailableForConversation(null, "sandboxCommands")).toBe(
      true,
    );
    expect(isActionAvailableForConversation(undefined, "fork")).toBe(true);
    expect(
      isActionAvailableForConversation({ encryptedChat: true }, "rename"),
    ).toBe(true);
  });
});
