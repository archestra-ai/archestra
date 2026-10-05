import { describe, expect, it } from "vitest";
import {
  ENCRYPTED_CHAT_REDACTED_MARKER,
  encryptedChatSealedContent,
  isEncryptedChatRedactedContent,
  isEncryptedChatSealedContent,
  isEncryptedChatUnavailableContent,
} from "./encrypted-chat-content";
import { logContentNotStored } from "./log-content";

describe("redacted content", () => {
  it("recognizes content the Log Content setting kept out of storage", () => {
    // Outside any locked chat, but it means the same to a reader: never
    // stored. Missing it would render the marker as a provider payload.
    const marker = logContentNotStored({ isError: true });

    expect(isEncryptedChatRedactedContent(marker)).toBe(true);
    expect(isEncryptedChatUnavailableContent(marker)).toBe(true);
    expect(isEncryptedChatSealedContent(marker)).toBe(false);
  });

  it("recognizes the marker it writes", () => {
    expect(isEncryptedChatRedactedContent(ENCRYPTED_CHAT_REDACTED_MARKER)).toBe(
      true,
    );
  });

  it.each([
    "locked_chat",
    "incognito",
  ])("still recognizes rows redacted as %s before the feature was renamed", (legacy) => {
    // Those rows are still on disk, and misreading one would render it as
    // real content rather than as unavailable.
    expect(isEncryptedChatRedactedContent({ __redacted: legacy })).toBe(true);
    expect(isEncryptedChatUnavailableContent({ __redacted: legacy })).toBe(
      true,
    );
  });

  it("does not treat other redaction markers as its own", () => {
    expect(
      isEncryptedChatRedactedContent({ __redacted: "something-else" }),
    ).toBe(false);
    expect(isEncryptedChatRedactedContent({ text: "hello" })).toBe(false);
    expect(isEncryptedChatRedactedContent(null)).toBe(false);
  });
});

describe("sealed content", () => {
  it("carries the conversation id so break-glass knows which key opens it", () => {
    const sealed = encryptedChatSealedContent("conv-1");

    expect(sealed).toEqual({ __encryptedChatSealed: "conv-1" });
    expect(isEncryptedChatSealedContent(sealed)).toBe(true);
    expect(isEncryptedChatUnavailableContent(sealed)).toBe(true);
    // Distinct from redacted: sealed content is recoverable, redacted is not.
    expect(isEncryptedChatRedactedContent(sealed)).toBe(false);
  });

  it("rejects shapes that are not the sealed marker", () => {
    expect(isEncryptedChatSealedContent({ __encryptedChatSealed: 1 })).toBe(
      false,
    );
    expect(isEncryptedChatSealedContent({})).toBe(false);
    expect(isEncryptedChatSealedContent(null)).toBe(false);
  });
});
